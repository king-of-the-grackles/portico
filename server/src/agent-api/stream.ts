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

/** What Portico knows about a stream: the session's computer and owner, and whether its plugin can show pop-ups. */
export interface StreamInfo {
  computerId: string | null;
  ownerId: string | null;
  popup: boolean;
}

interface OpenStream extends StreamInfo {
  conn: StreamConnection;
  /** Grows with every connect, so a lower number is an older connection. */
  order: number;
}

const NO_INFO: StreamInfo = { computerId: null, ownerId: null, popup: false };

/** Each agent's live stream, by agent ID. One per agent: a new stream replaces the old one. */
export class AgentStreams {
  private readonly open = new Map<string, OpenStream>();
  private readonly listeners: ((change: StreamChange) => void)[] = [];
  private connections = 0;

  /** Registers the agent's stream, closing any older one. Returns a function to call when this stream ends. */
  connect(agentId: string, conn: StreamConnection, mode: ReplaceMode = "notify", info: StreamInfo = NO_INFO): () => void {
    const entry: OpenStream = { conn, ...info, order: ++this.connections };
    const old = this.open.get(agentId);
    this.open.set(agentId, entry);
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
    this.emit({ kind: "opened", agentId, ...info });
    return () => {
      if (this.open.get(agentId) !== entry) return;
      this.open.delete(agentId);
      this.emit({ kind: "closed", agentId, computerId: entry.computerId, ownerId: entry.ownerId, popup: entry.popup });
    };
  }

  isConnected(agentId: string): boolean {
    return this.open.has(agentId);
  }

  /** Closes and forgets every named stream, then reports each closed: no listener sees one of them still open. */
  closeAll(agentIds: string[]): void {
    const removed: [string, OpenStream][] = [];
    for (const agentId of agentIds) {
      const entry = this.open.get(agentId);
      if (!entry) continue;
      this.open.delete(agentId);
      entry.conn.close();
      removed.push([agentId, entry]);
    }
    for (const [agentId, entry] of removed) {
      this.emit({ kind: "closed", agentId, computerId: entry.computerId, ownerId: entry.ownerId, popup: entry.popup });
    }
  }

  /** "The inbox has something." Returns false if the agent has no open stream. */
  nudge(agentId: string): boolean {
    return this.send(agentId, "nudge", {});
  }

  /** Sends one event. Returns false when the agent has no open stream, or the send failed and dropped it. */
  send(agentId: string, event: AgentStreamEvent, data: Record<string, unknown>): boolean {
    const entry = this.open.get(agentId);
    if (!entry) return false;
    try {
      entry.conn.send(event, data);
      return true;
    } catch {
      if (this.open.get(agentId) === entry) {
        this.open.delete(agentId);
        this.emit({ kind: "closed", agentId, computerId: entry.computerId, ownerId: entry.ownerId, popup: entry.popup });
      }
      return false;
    }
  }

  /** The computer's pop-up sessions, oldest connection first. */
  popupSessions(computerId: string): string[] {
    return [...this.open]
      .filter(([, entry]) => entry.popup && entry.computerId === computerId)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([agentId]) => agentId);
  }

  /** The person's computers with at least one pop-up session, sorted. */
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
 * a new key registers the session. Apps and connectors check their inbox instead.
 */
export function streamRoutes(deps: StreamRouteDeps): Hono {
  const { agents, messages, streams } = deps;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const route = new Hono();

  route.get("/", (c) => {
    const principal = deps.resolver.principal(c.req.header("authorization"));
    if (!principal) return unauthorized(c);
    if (principal.type !== "computer") {
      return c.json({ error: "not_allowed", message: "Only sessions on a computer open the live stream." }, 403);
    }
    const computer = principal.computer;
    const reg = parseRegistration(c.req.header("x-portico-session"), c.req.header("x-portico-folder"), c.req.query("repo"));
    const { agent } = agents.registerSession(computer, reg);
    // Only a session can answer a pop-up, so only its stream may declare pop-ups.
    const info: StreamInfo = { computerId: computer.id, ownerId: computer.ownerId, popup: c.req.header("x-portico-popup") === "1" };
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
      const disconnect = streams.connect(agent.id, conn, "quiet", info);
      log("info", "stream_opened", { agent_id: agent.id });
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
        // The session shows offline now; its row remembers when it was last here.
        agents.seen(agent.id);
        log("info", "stream_closed", { agent_id: agent.id });
      }
    });
  });

  // A bad registration or a folder that's off is a PorticoError: answer it as JSON, as the rest of the API does.
  route.onError(handleError);
  return route;
}
