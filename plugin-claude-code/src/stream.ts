import { errorName, type Logger } from "./log";
import { SseParser } from "./sse";

/** Why the stream stopped for good. `code` is the error code Portico sent with a refusal, such as `folder_off`. */
export type StreamStop = { reason: "replaced" } | { reason: "rejected"; status: number; code: string | null; message: string };

export interface StreamClientOptions {
  /** Opens GET /api/agent/stream (PorticoClient.openStream). */
  open: (signal: AbortSignal) => Promise<Response>;
  /** Every event except `replaced`, with its data parsed as JSON. */
  onEvent: (event: string, data: unknown) => void;
  /** Called once, when the client stops for good: another connection took over, or Portico refused the stream. */
  onStop: (stop: StreamStop) => void;
  /** Called whenever a connection that reached Portico ends, however it ends. Not for a refused or failed open. */
  onDisconnect?: () => void;
  log: Logger;
  /** A connection open this long counts as healthy, and the backoff starts over. Default 30 s, longer than Portico's 25 s heartbeat. */
  healthyMs?: number;
  /** Reconnect after this long with no bytes at all. Portico sends a comment every 25 s. Default 60 s. */
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
 * Holds Portico's live stream open. It reconnects with backoff when the stream fails or ends,
 * and when it goes silent: a half-open connection can look alive for a long time. It stops for good on
 * `replaced`, so two connections for one session don't fight, and when Portico refuses the stream (401, 403) or answers that
 * it has no stream at that address (a 404 carrying Portico's own `not_found` error).
 * Any other 404 may come from a proxy in front of Portico, say during a redeploy, so it is retried like a 5xx.
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

  /** Drops the current connection. The loop reconnects, and Portico nudges on connect if messages are waiting. */
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
    let connected = false;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.opts.log("warn", "stream_silent", { after_ms: silenceMs });
        controller.abort();
      }, silenceMs);
    };
    try {
      arm(); // Portico must answer within the window too
      const res = await this.opts.open(controller.signal);
      // 401 and 403 are final. A 404 is final only when Portico itself sent it ({"error":"not_found"}): the address in
      // computer.json then points at the wrong path. A proxy may answer 404 briefly during a redeploy, and that is retried.
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        const { code, message } = await readError(res);
        if (res.status !== 404 || code === "not_found") {
          // A folder that's off is expected, not an error: this one line is all the log says about it.
          const level = code === "folder_off" ? "info" : "error";
          this.opts.log(level, "stream_refused", { status: res.status, ...(code ? { code: code.slice(0, 40) } : {}) });
          this.opts.onStop({ reason: "rejected", status: res.status, code: code ?? null, message });
          return "stopped";
        }
      }
      if (!res.ok || !res.body) {
        this.opts.log("warn", "stream_failed", { status: res.status });
        await res.body?.cancel().catch(() => {});
        return "retry";
      }
      this.opts.log("info", "stream_connected", {});
      connected = true;
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
      if (connected) this.opts.onDisconnect?.();
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

/** Reads the error body once: Portico's error code and message, with the message falling back to `HTTP <status>`. */
async function readError(res: Response): Promise<{ code: string | undefined; message: string }> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    return {
      code: typeof body.error === "string" ? body.error : undefined,
      message: typeof body.message === "string" ? body.message : `HTTP ${res.status}`,
    };
  } catch {
    return { code: undefined, message: `HTTP ${res.status}` };
  }
}
