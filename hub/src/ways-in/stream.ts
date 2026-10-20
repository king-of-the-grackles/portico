import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { BridgeService } from "../core/service";
import { type BridgeConfig, isPushAgent } from "../core/types";
import { errorName, log } from "../log";
import { type AgentEnv, type AgentResolver, requireAgent } from "./auth";

export type StreamEvent = "nudge" | "permission" | "replaced";

export interface StreamConnection {
  /** Throws if the stream has closed. */
  send(event: StreamEvent, data: Record<string, unknown>): void;
  close(): void;
}

/** Each push agent's live stream. One per agent: a new stream replaces the old one (spec §9.4). */
export class StreamHub {
  private readonly open = new Map<string, StreamConnection>();

  /** Registers the agent's stream, telling and closing any older one. Returns a function to call when this stream ends. */
  connect(agent: string, conn: StreamConnection): () => void {
    const old = this.open.get(agent);
    this.open.set(agent, conn);
    if (old) {
      try {
        old.send("replaced", {});
      } catch {
        // already gone
      }
      old.close();
    }
    return () => {
      if (this.open.get(agent) === conn) this.open.delete(agent);
    };
  }

  isConnected(agent: string): boolean {
    return this.open.has(agent);
  }

  /** "Your inbox has something." Returns false if the agent has no open stream. */
  nudge(agent: string): boolean {
    return this.deliver(agent, "nudge", {});
  }

  sendPermissionAnswer(agent: string, requestId: string, behavior: "allow" | "deny"): boolean {
    return this.deliver(agent, "permission", { request_id: requestId, behavior });
  }

  private deliver(agent: string, event: StreamEvent, data: Record<string, unknown>): boolean {
    const conn = this.open.get(agent);
    if (!conn) return false;
    try {
      conn.send(event, data);
      return true;
    } catch {
      this.open.delete(agent);
      return false;
    }
  }
}

/** Below the server's 60-second idle timeout, so quiet streams stay open through proxies. */
export const HEARTBEAT_MS = 25_000;

export interface StreamRouteDeps {
  service: BridgeService;
  config: BridgeConfig;
  streams: StreamHub;
  resolveAgent: AgentResolver;
  heartbeatMs?: number;
  /** Runs after a stream opens, e.g. to re-send permission answers given while it was disconnected. */
  onConnect?: (agent: string) => void;
}

export function streamRoutes(deps: StreamRouteDeps): Hono<AgentEnv> {
  const { service, config, streams } = deps;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const route = new Hono<AgentEnv>();
  route.use("*", requireAgent(deps.resolveAgent));

  route.get("/", (c) => {
    const agent = c.get("agent");
    if (!isPushAgent(config, agent)) {
      return c.json({ error: "not_allowed", message: "Only push agents can open the live stream." }, 403);
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
      const conn: StreamConnection = {
        send: (event, data) => {
          if (!open) throw new Error("stream closed");
          stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => end());
        },
        close: () => end(),
      };
      stream.onAbort(() => end());
      const disconnect = streams.connect(agent, conn);
      log("info", "stream_opened", { agent });
      try {
        // Flushes the response headers now; otherwise a client's fetch() waits for the first event or heartbeat.
        await stream.write(": connected\n\n");
        if (open && service.hasWaiting(agent)) conn.send("nudge", {});
        deps.onConnect?.(agent);
        while (open) {
          await Promise.race([stream.sleep(heartbeatMs), ended]);
          if (open) await stream.write(": ping\n\n").catch(() => end());
        }
      } catch (err) {
        log("error", "stream_failed", { agent, error: errorName(err) });
      } finally {
        disconnect();
        log("info", "stream_closed", { agent });
      }
    });
  });

  return route;
}
