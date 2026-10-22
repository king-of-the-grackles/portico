import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Directory } from "../core/directory";
import type { BridgeService } from "../core/service";
import { parseRegistration, type SessionRegistry } from "../core/sessions";
import { errorName, log } from "../log";
import type { PrincipalResolver } from "./auth";
import { handleError } from "./rest";

export type StreamEvent = "hello" | "nudge" | "replaced";

/** "notify" tells the old stream it was `replaced` (bridge.yaml agents); "quiet" just closes it (a session's own reconnect). */
export type ReplaceMode = "notify" | "quiet";

/** The first event on every stream: who the hub took the caller for. */
export interface HelloEvent {
  address: string;
  /** The short name when it alone resolves to the address, otherwise the address. */
  name: string;
  /** The machine's name for a session, otherwise null. */
  machine: string | null;
}

export interface StreamConnection {
  /** Throws if the stream has closed. */
  send(event: StreamEvent, data: Record<string, unknown>): void;
  close(): void;
}

/** Each push member's live stream. One per address: a new stream replaces the old one (spec §9.4, §5.2). */
export class StreamHub {
  private readonly open = new Map<string, StreamConnection>();

  /** Registers the address's stream, closing any older one. Returns a function to call when this stream ends. */
  connect(address: string, conn: StreamConnection, mode: ReplaceMode = "notify"): () => void {
    const old = this.open.get(address);
    this.open.set(address, conn);
    if (old) {
      if (mode === "notify") {
        try {
          old.send("replaced", {});
        } catch {
          // already gone
        }
      }
      old.close();
    }
    return () => {
      if (this.open.get(address) === conn) this.open.delete(address);
    };
  }

  isConnected(address: string): boolean {
    return this.open.has(address);
  }

  /** Closes and forgets the address's stream, e.g. once its session is removed. */
  close(address: string): void {
    const conn = this.open.get(address);
    if (!conn) return;
    this.open.delete(address);
    conn.close();
  }

  /** "Your inbox has something." Returns false if the address has no open stream. */
  nudge(address: string): boolean {
    return this.deliver(address, "nudge", {});
  }

  private deliver(address: string, event: StreamEvent, data: Record<string, unknown>): boolean {
    const conn = this.open.get(address);
    if (!conn) return false;
    try {
      conn.send(event, data);
      return true;
    } catch {
      this.open.delete(address);
      return false;
    }
  }
}

/** Below the server's 60-second idle timeout, so quiet streams stay open through proxies. */
export const HEARTBEAT_MS = 25_000;

export interface StreamRouteDeps {
  service: BridgeService;
  directory: Directory;
  streams: StreamHub;
  /** Resolved without the session key, so a machine token stays a machine and can register a new session. */
  resolvePrincipal: PrincipalResolver;
  sessions: SessionRegistry;
  heartbeatMs?: number;
}

export function streamRoutes(deps: StreamRouteDeps): Hono {
  const { service, directory, streams } = deps;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const route = new Hono();

  route.get("/", (c) => {
    const principal = deps.resolvePrincipal(c.req.header("authorization"));
    if (!principal) {
      return c.json({ error: "unauthorized", message: "Missing or invalid bearer token." }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }
    let address: string;
    let machine: string | null = null;
    let sessionId: string | null = null;
    let mode: ReplaceMode = "notify";
    if (principal.type === "machine") {
      // A machine token registers (or finds) the session named by its key and folder (spec §5.2).
      const reg = parseRegistration(c.req.header("x-bridge-session"), c.req.header("x-bridge-folder"), c.req.query("repo"));
      const registered = deps.sessions.register(principal.machine, reg);
      address = registered.address;
      machine = principal.machine.name;
      sessionId = registered.session.id;
      mode = "quiet";
    } else {
      address = principal.address;
      if (!directory.isPush(address)) {
        return c.json({ error: "not_allowed", message: "Only push agents can open the live stream." }, 403);
      }
    }
    return streamSSE(c, async (stream) => {
      let open = true;
      let end!: () => void;
      const ended = new Promise<void>((resolve) => {
        end = () => {
          open = false;
          resolve();
        };
      });
      const write = (event: StreamEvent, data: Record<string, unknown>) => {
        stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => end());
      };
      // Until the hello is written, events wait here, so the hello is always the first event on the stream.
      let early: { event: StreamEvent; data: Record<string, unknown> }[] | null = [];
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
      const disconnect = streams.connect(address, conn, mode);
      log("info", "stream_opened", { agent: address });
      try {
        // Flushes the response headers now; otherwise a client's fetch() waits for the first event or heartbeat.
        await stream.write(": connected\n\n");
        const hello: HelloEvent = { address, name: directory.displayName(address), machine };
        write("hello", { ...hello });
        const waiting = early;
        early = null;
        for (const item of waiting) write(item.event, item.data);
        if (open && !waiting.some((item) => item.event === "nudge") && service.hasWaiting(address)) {
          conn.send("nudge", {});
        }
        while (open) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, heartbeatMs))), ended]);
          clearTimeout(timer);
          if (open) await stream.write(": ping\n\n").catch(() => end());
        }
      } catch (err) {
        log("error", "stream_failed", { agent: address, error: errorName(err) });
      } finally {
        disconnect();
        // The session shows offline now; its row remembers when it was last here.
        if (sessionId) deps.sessions.seen(sessionId);
        log("info", "stream_closed", { agent: address });
      }
    });
  });

  // A bad registration is a BridgeError: answer it as JSON, as the rest of the API does.
  route.onError(handleError);
  return route;
}
