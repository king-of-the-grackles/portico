import { errorName, type Logger } from "./log";
import { SseParser } from "./sse";

export type StreamStop = { reason: "replaced" } | { reason: "rejected"; status: number; message: string };

export interface StreamClientOptions {
  /** Opens GET /api/stream (HubClient.openStream). */
  open: (signal: AbortSignal) => Promise<Response>;
  /** Every event except `replaced`, with its data parsed as JSON. */
  onEvent: (event: string, data: unknown) => void;
  /** Called once, when the client stops for good: another session took over, or the hub refused the stream. */
  onStop: (stop: StreamStop) => void;
  log: Logger;
  /** A connection open this long counts as healthy, and the backoff starts over. Default 30 s, longer than the hub's 25 s heartbeat. */
  healthyMs?: number;
  /** Reconnect after this long with no bytes at all. The hub sends a comment every 25 s. Default 60 s. */
  silenceMs?: number;
  /** First pause between attempts; it doubles after each failure. Default 1 s. */
  initialBackoffMs?: number;
  /** Longest pause between attempts. Default 60 s. */
  maxBackoffMs?: number;
  /** For tests: the jitter source, default Math.random. */
  random?: () => number;
}

export const SILENCE_MS = 60_000;
export const HEALTHY_MS = 30_000;

/**
 * Holds the hub's live stream open (spec §9.4–§9.5). It reconnects with backoff when the stream fails or ends,
 * and when it goes silent: a half-open connection can look alive for a long time. It stops for good on
 * `replaced`, so two sessions sharing a token don't fight, and when the hub refuses the stream (401 or 403).
 */
export class StreamClient {
  private running = false;
  private attempt = 0;
  private current: AbortController | null = null;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(private readonly opts: StreamClientOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Stops for good and waits for the loop to finish. */
  async stop(): Promise<void> {
    this.running = false;
    this.current?.abort();
    this.wake?.();
    await this.loop;
  }

  /** Drops the current connection. The loop reconnects, and the hub nudges on connect if work is waiting. */
  reconnect(): void {
    this.current?.abort();
  }

  private async run(): Promise<void> {
    while (this.running) {
      const outcome = await this.connectOnce();
      if (outcome === "stopped" || !this.running) break;
      await this.pause(this.nextBackoff());
    }
    this.running = false;
  }

  private async connectOnce(): Promise<"stopped" | "retry"> {
    const controller = new AbortController();
    this.current = controller;
    const silenceMs = this.opts.silenceMs ?? SILENCE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.opts.log("warn", "stream_silent", { after_ms: silenceMs });
        controller.abort();
      }, silenceMs);
    };
    try {
      arm(); // the hub must answer within the window too
      const res = await this.opts.open(controller.signal);
      if (res.status === 401 || res.status === 403) {
        const message = await errorMessage(res);
        this.opts.log("error", "stream_refused", { status: res.status });
        this.opts.onStop({ reason: "rejected", status: res.status, message });
        return "stopped";
      }
      if (!res.ok || !res.body) {
        this.opts.log("warn", "stream_failed", { status: res.status });
        await res.body?.cancel().catch(() => {});
        return "retry";
      }
      this.opts.log("info", "stream_connected", {});
      const opened = Date.now();
      const healthyMs = this.opts.healthyMs ?? HEALTHY_MS;
      let healthy = false;
      const parser = new SseParser();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        if (!healthy && Date.now() - opened >= healthyMs) {
          healthy = true;
          this.attempt = 0; // the connection stayed up, so the next failure starts the backoff over
        }
        for (const message of parser.push(value)) {
          let data: unknown = null;
          try {
            data = message.data ? JSON.parse(message.data) : null;
          } catch {
            continue;
          }
          if (message.event === "replaced") {
            this.opts.log("warn", "stream_replaced", {});
            this.opts.onStop({ reason: "replaced" });
            return "stopped";
          }
          this.opts.onEvent(message.event, data);
        }
      }
      this.opts.log("info", "stream_ended", {});
      return "retry";
    } catch (err) {
      if (this.running) this.opts.log("warn", "stream_dropped", { error: errorName(err) });
      return "retry";
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (this.current === controller) this.current = null;
    }
  }

  private nextBackoff(): number {
    const initial = this.opts.initialBackoffMs ?? 1_000;
    const max = this.opts.maxBackoffMs ?? 60_000;
    const base = Math.min(max, initial * 2 ** this.attempt);
    this.attempt++;
    const random = this.opts.random ?? Math.random;
    return Math.round(base * (0.8 + 0.4 * random()));
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
