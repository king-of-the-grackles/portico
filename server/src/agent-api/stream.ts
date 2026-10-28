import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type Agents, parseRegistration } from "../core/agents";
import type { Messages } from "../core/messages";
import type { Agent } from "../core/types";
import type { StreamChange } from "../desk";
import { errorName, log } from "../log";
import { type Resolver, unauthorized } from "./auth";
import { handleError } from "./rest";

export type AgentStreamEvent = "hello" | "nudge" | "replaced" | "renamed" | "approval_request" | "approval_closed";

/** "notify" tells the old stream it was `replaced`; "quiet" just closes it (a session's own reconnect). */
export type ReplaceMode = "notify" | "quiet";

/** The first event on every stream, and `renamed` after a rename: who Portico takes the caller for. */
export interface HelloEvent {
  address: string;
  /** The short name when it alone resolves to the address, otherwise the address. */
  name: string;
  /** The computer's name for a session, otherwise null. */
  computer: string | null;
}

export interface StreamConnection {
  /** Throws if the stream has closed. */
  send(event: AgentStreamEvent, data: Record<string, unknown>): void;
  close(): void;
}

/**
 * What Portico knows about a stream: the session's computer and owner, whether its plugin can show pop-ups, and whether
 * it can start a turn when a message arrives (a Codex conversation its bridge can wake).
 */
export interface StreamInfo {
  computerId: string | null;
  ownerId: string | null;
  popup: boolean;
  wake: boolean;
}

interface OpenStream extends StreamInfo {
  agentId: string;
  conn: StreamConnection;
  /** Grows with every connect, so a lower number is an older connection. */
  order: number;
}

const NO_INFO: StreamInfo = { computerId: null, ownerId: null, popup: false, wake: false };

/**
 * The live streams, one per run: each process of a session agent (a terminal, a Codex conversation) has its own. A
 * run that reconnects replaces its older stream. Events for the agent go to its newest run, so two terminals in one
 * folder never both take the same delivery.
 */
export class AgentStreams {
  private readonly open = new Map<string, OpenStream>();
  private readonly byAgent = new Map<string, Set<string>>();
  private readonly listeners: ((change: StreamChange) => void)[] = [];
  private connections = 0;

  /** Registers the run's stream, closing any older one of the same run. Returns a function to call when this stream ends. */
  connect(
    agentId: string,
    runId: string,
    conn: StreamConnection,
    mode: ReplaceMode = "notify",
    info: StreamInfo = NO_INFO,
  ): () => void {
    const entry: OpenStream = { agentId, conn, ...info, order: ++this.connections };
    const old = this.open.get(runId);
    this.open.set(runId, entry);
    const runs = this.byAgent.get(agentId) ?? new Set<string>();
    runs.add(runId);
    this.byAgent.set(agentId, runs);
    if (old) {
      if (mode === "notify") {
        try {
          old.conn.send("replaced", {});
        } catch {
          // already gone
        }
      }
      old.conn.close();
    }
    this.emit({ kind: "opened", agentId, runId, ...info });
    return () => {
      if (this.open.get(runId) !== entry) return;
      this.drop(runId, entry);
    };
  }

  /** Whether any of the agent's runs has a stream open. */
  isConnected(agentId: string): boolean {
    return (this.byAgent.get(agentId)?.size ?? 0) > 0;
  }

  isRunConnected(runId: string): boolean {
    return this.open.has(runId);
  }

  /** How many of the agent's runs are open. */
  liveRuns(agentId: string): number {
    return this.byAgent.get(agentId)?.size ?? 0;
  }

  /** Closes and forgets every stream of the named agents, then reports each closed: no listener sees one still open. */
  closeAll(agentIds: string[]): void {
    const removed: [string, OpenStream][] = [];
    for (const agentId of agentIds) {
      for (const runId of this.byAgent.get(agentId) ?? []) {
        const entry = this.open.get(runId);
        if (!entry) continue;
        this.open.delete(runId);
        entry.conn.close();
        removed.push([runId, entry]);
      }
      this.byAgent.delete(agentId);
    }
    for (const [runId, entry] of removed) this.emitClosed(runId, entry);
  }

  /** Whether one of the agent's open runs can start a turn when a message arrives. */
  canWake(agentId: string): boolean {
    return this.newestFirst(agentId).some((runId) => this.open.get(runId)?.wake);
  }

  /**
   * "The inbox has something." Goes to the newest run that can wake, so a Codex conversation starts a turn with it;
   * otherwise to the newest run. Returns false if the agent has no open stream.
   */
  nudge(agentId: string): boolean {
    const runs = this.newestFirst(agentId);
    const waking = runs.filter((runId) => this.open.get(runId)?.wake);
    for (const runId of [...waking, ...runs.filter((runId) => !waking.includes(runId))]) {
      if (this.sendRun(runId, "nudge", {})) return true;
    }
    return false;
  }

  /** Sends one event to the agent's newest run, or the next newest if that send fails. False when none took it. */
  send(agentId: string, event: AgentStreamEvent, data: Record<string, unknown>): boolean {
    for (const runId of this.newestFirst(agentId)) {
      if (this.sendRun(runId, event, data)) return true;
    }
    return false;
  }

  /** Sends one event to every open run of the agent, e.g. its new name. Returns how many took it. */
  sendAll(agentId: string, event: AgentStreamEvent, data: Record<string, unknown>): number {
    return this.newestFirst(agentId).filter((runId) => this.sendRun(runId, event, data)).length;
  }

  /** Sends one event to one run. Returns false when it has no open stream, or the send failed and dropped it. */
  sendRun(runId: string, event: AgentStreamEvent, data: Record<string, unknown>): boolean {
    const entry = this.open.get(runId);
    if (!entry) return false;
    try {
      entry.conn.send(event, data);
      return true;
    } catch {
      if (this.open.get(runId) === entry) this.drop(runId, entry);
      return false;
    }
  }

  /** The computer's pop-up runs, oldest connection first. */
  popupSessions(computerId: string): string[] {
    return [...this.open]
      .filter(([, entry]) => entry.popup && entry.computerId === computerId)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([runId]) => runId);
  }

  /** The person's computers with at least one pop-up run, sorted. */
  popupComputers(ownerId: string): string[] {
    const computers = new Set<string>();
    for (const entry of this.open.values()) {
      if (entry.popup && entry.computerId !== null && entry.ownerId === ownerId) computers.add(entry.computerId);
    }
    return [...computers].sort();
  }

  /** Listeners run in order, synchronously. One that throws is logged and never breaks the others. */
  onChange(listener: (change: StreamChange) => void): void {
    this.listeners.push(listener);
  }

  private newestFirst(agentId: string): string[] {
    return [...(this.byAgent.get(agentId) ?? [])]
      .map((runId) => [runId, this.open.get(runId)!.order] as const)
      .sort((a, b) => b[1] - a[1])
      .map(([runId]) => runId);
  }

  private drop(runId: string, entry: OpenStream): void {
    this.open.delete(runId);
    const runs = this.byAgent.get(entry.agentId);
    runs?.delete(runId);
    if (runs?.size === 0) this.byAgent.delete(entry.agentId);
    this.emitClosed(runId, entry);
  }

  private emitClosed(runId: string, entry: OpenStream): void {
    this.emit({ kind: "closed", agentId: entry.agentId, runId, computerId: entry.computerId, ownerId: entry.ownerId, popup: entry.popup });
  }

  private emit(change: StreamChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        log("error", "stream_listener_failed", { error: errorName(err) });
      }
    }
  }
}

export function helloFor(agents: Agents, agent: Agent): HelloEvent {
  return { address: agents.address(agent), name: agents.display(agent), computer: agent.computer };
}

/** Below the server's 60-second idle timeout, so quiet streams stay open through proxies. */
export const HEARTBEAT_MS = 25_000;

export interface StreamRouteDeps {
  agents: Agents;
  messages: Messages;
  streams: AgentStreams;
  resolver: Resolver;
  heartbeatMs?: number;
}

/**
 * GET /api/agent/stream: a session's live stream, opened with its computer token and session key. The first open for
 * a new key starts a run of the folder's agent (making the agent the first time). Apps and connectors check their
 * inbox instead.
 */
export function streamRoutes(deps: StreamRouteDeps): Hono {
  const { agents, messages, streams } = deps;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const route = new Hono();

  route.get("/", (c) => {
    const principal = deps.resolver.principal(c.req.header("authorization"));
    if (!principal) return unauthorized(c, deps.resolver);
    if (principal.type !== "computer") {
      return c.json({ error: "not_allowed", message: "Only sessions on a computer open the live stream." }, 403);
    }
    const computer = principal.computer;
    const reg = parseRegistration(
      c.req.header("x-portico-session"),
      c.req.header("x-portico-folder"),
      c.req.query("repo"),
      c.req.header("x-portico-client"),
    );
    const { agent, runId } = agents.registerSession(computer, reg);
    // Only a session can answer a pop-up, so only its stream may declare pop-ups, or that it can be woken.
    const info: StreamInfo = {
      computerId: computer.id,
      ownerId: computer.ownerId,
      popup: c.req.header("x-portico-popup") === "1",
      wake: c.req.header("x-portico-wake") === "1",
    };
    return streamSSE(c, async (stream) => {
      let open = true;
      let end!: () => void;
      const ended = new Promise<void>((resolve) => {
        end = () => {
          open = false;
          resolve();
        };
      });
      const write = (event: AgentStreamEvent, data: Record<string, unknown>) => {
        stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => end());
      };
      // Until the hello is written, events wait here, so the hello is always the first event on the stream.
      let early: { event: AgentStreamEvent; data: Record<string, unknown> }[] | null = [];
      const conn: StreamConnection = {
        send: (event, data) => {
          if (!open) throw new Error("stream closed");
          if (early) early.push({ event, data });
          else write(event, data);
        },
        close: () => end(),
      };
      stream.onAbort(() => end());
      // Connected in the same tick as the registration above, so no other registration can take this session as stale.
      const disconnect = streams.connect(agent.id, runId, conn, "quiet", info);
      log("info", "stream_opened", { agent_id: agent.id, run_id: runId });
      try {
        // Flushes the response headers now; otherwise a client's fetch() waits for the first event or heartbeat.
        await stream.write(": connected\n\n");
        write("hello", { ...helloFor(agents, agents.get(agent.id) ?? agent) });
        const waiting = early;
        early = null;
        for (const item of waiting) write(item.event, item.data);
        if (open && !waiting.some((item) => item.event === "nudge") && messages.hasWaiting(agent.id)) {
          conn.send("nudge", {});
        }
        while (open) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, heartbeatMs))), ended]);
          clearTimeout(timer);
          if (open) await stream.write(": ping\n\n").catch(() => end());
        }
      } catch (err) {
        log("error", "stream_failed", { agent_id: agent.id, error: errorName(err) });
      } finally {
        disconnect();
        // The run has ended, unless it reconnected and a newer stream of it is open; the agent shows offline once
        // none of its runs are open, and its row remembers when it was last here.
        if (!streams.isRunConnected(runId)) agents.seen(agent.id, runId);
        log("info", "stream_closed", { agent_id: agent.id, run_id: runId });
      }
    });
  });

  // A bad registration or a folder that's off is a PorticoError: answer it as JSON, as the rest of the API does.
  route.onError(handleError);
  return route;
}
