import { errorName, type Logger } from "./log";
import { ApiError, type DeliveryAck, type Inbox, type PorticoClient } from "./portico-client";
import { type InboxSocket, SocketError } from "./socket";
import type { StreamStop } from "./stream";

export interface DeliveryItem {
  kind: "message" | "update";
  /** The message's ID; for an update, the ID of the held message it reports on. */
  id: string;
  /** Portico's framed text, posted as is. */
  text: string;
  at: string;
}

/** Messages in the order they were sent, then updates in the order they happened. */
export function deliveryItems(d: Inbox): DeliveryItem[] {
  const byTime = (a: DeliveryItem, b: DeliveryItem) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  const messages = d.messages.map((m) => ({ kind: "message" as const, id: m.id, text: m.framed_message, at: m.created_at }));
  const updates = d.updates.map((u) => ({ kind: "update" as const, id: u.message_id, text: u.framed_message, at: u.at }));
  return [...messages.sort(byTime), ...updates.sort(byTime)];
}

export interface InboxDeliveryDeps {
  client: Pick<PorticoClient, "pendingDeliveries" | "ackDeliveries">;
  socket: Pick<InboxSocket, "post">;
  log: Logger;
  /** Called when a call to Portico fails. The plugin reconnects, and Portico nudges on connect if messages are still waiting. */
  onFailure: () => void;
  /** Pauses before retrying after the socket didn't take a post. The last one repeats. */
  retryMs?: number[];
  now?: () => number;
}

const RETRY_MS = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000];
const HOUR_MS = 3_600_000;

/**
 * On each nudge: peek at what's waiting, post each item into the session's inbox socket, then ack what was posted,
 * so Portico marks delivered only what actually reached the session. When the socket doesn't take a post, nothing
 * after it is posted, the rest stays waiting, and delivery retries.
 */
export class InboxDelivery {
  private checking = false;
  private again = false;
  private stopped = false;
  private failures = 0;
  private missingLogged = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Posted but not yet acked, keyed `kind:id`, with when to forget each. */
  private readonly posted = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: InboxDeliveryDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** At most one check runs at a time. A nudge that arrives during a check asks for one more check after it. */
  async run(): Promise<void> {
    if (this.stopped) return;
    if (this.checking) {
      this.again = true;
      return;
    }
    this.checking = true;
    try {
      do {
        this.again = false;
        await this.checkOnce();
      } while (this.again && !this.stopped);
    } catch (err) {
      this.deps.log("warn", "inbox_check_failed", {
        error: errorName(err),
        ...(err instanceof ApiError ? { status: err.status } : {}),
      });
      this.deps.onFailure();
    } finally {
      this.checking = false;
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async checkOnce(): Promise<void> {
    const { client, socket, log } = this.deps;
    this.forgetExpired();
    const items = deliveryItems(await client.pendingDeliveries());
    const ack: DeliveryAck = { messages: [], updates: [] };
    const keys: string[] = [];
    let failure: SocketError | null = null;
    for (const item of items) {
      if (this.stopped) break;
      const key = `${item.kind}:${item.id}`;
      if (!this.posted.has(key)) {
        try {
          await socket.post(item.text);
        } catch (err) {
          if (!(err instanceof SocketError)) throw err;
          failure = err;
          break;
        }
        this.posted.set(key, this.now() + HOUR_MS);
        log("info", `${item.kind}_delivered`, { message_id: item.id });
      }
      ack[`${item.kind}s` as const].push(item.id);
      keys.push(key);
    }
    if (keys.length > 0) {
      // An ApiError here leaves `posted` intact, so the next check acks these again without posting them again.
      const { acked } = await client.ackDeliveries(ack);
      for (const key of keys) this.posted.delete(key);
      // Portico caps each list, so check again while acks make progress, until nothing is left.
      const progress = (acked?.messages ?? 0) + (acked?.updates ?? 0);
      if (!failure && progress > 0) this.again = true;
    }
    if (failure) {
      if (failure.code === "no_socket") {
        if (!this.missingLogged) log("warn", "inbox_socket_missing", {});
        this.missingLogged = true;
      } else {
        log("warn", "inbox_post_failed", { code: failure.code });
      }
      this.scheduleRetry();
    } else {
      this.failures = 0;
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== undefined) return;
    const delays = this.deps.retryMs ?? RETRY_MS;
    const delay = delays[Math.min(this.failures, delays.length - 1)] ?? RETRY_MS[0]!;
    this.failures++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.run();
    }, delay);
  }

  private forgetExpired(): void {
    const now = this.now();
    for (const [key, until] of this.posted) if (until <= now) this.posted.delete(key);
  }
}

/** Wraps the plugin's own notices about the connection to Portico. */
export function frameNotice(text: string): string {
  return `<portico-notice>\n${text}\n</portico-notice>`;
}

/** What the session is told when live delivery stops for good. A folder that's off stops quietly, with no notice. */
export function stopNotice(stop: StreamStop): string {
  if (stop.reason === "replaced") {
    return (
      "Portico delivery stopped: another connection took over this session's live stream. Restart this session to take " +
      "delivery back. The Portico tools still work."
    );
  }
  if (stop.status === 401) {
    return (
      "Portico delivery is off: Portico no longer accepts this computer's token (the computer may have been removed in " +
      "Settings). Join again with a new join line, then restart this session."
    );
  }
  if (stop.status === 404) {
    return (
      "Portico delivery is off: the Portico address in computer.json has no live stream (404). Join again with a new " +
      "join line, then restart this session."
    );
  }
  return `Portico delivery is off: Portico refused the live stream (${stop.message}). Restart this session to try again.`;
}
