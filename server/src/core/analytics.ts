import type { AnalyticsConfig } from "./types";
import type { WebhookPost } from "./webhooks";

/** What an event may say: IDs, kinds, outcomes and timings. Never text a person or an agent wrote. */
export type AnalyticsProperties = Record<string, string | number | boolean | null | undefined>;

export interface AnalyticsEvent {
  event: string;
  distinctId: string;
  properties?: AnalyticsProperties;
}

interface Queued {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

/** The IDs of the people left out of analytics, kept where a restart finds them. */
export interface OptOutStore {
  load(): string[];
  save(personIds: string[]): void;
}

/** An anonymous browser ID, as the browser module makes one and as a link may carry one (`ph_id`). */
export const ANON_ID = /^[A-Za-z0-9_.:-]{8,128}$/;

/** A browser that sent Do Not Track or Global Privacy Control: nothing about its visit is captured. */
export function optedOut(header: (name: string) => string | undefined): boolean {
  return header("dnt") === "1" || header("sec-gpc") === "1";
}

const BATCH = 50;
const FLUSH_AFTER_MS = 10_000;
const QUEUE_MAX = 1000;
const STRING_MAX = 200;

/**
 * Product analytics, sent from this server to PostHog's capture API. No browser talks to PostHog: the pages'
 * Content-Security-Policy stays as it is, and nothing a page shows (a subject, a name, the join code, an address with
 * a secret in it) can ride along. Without a configured key every method does nothing.
 *
 * Events wait in memory and go out together: when 50 wait, or 10 seconds after the first. A post that fails is logged
 * and its events are dropped, never tried again: analytics may lose events, and must never hold a request up.
 */
export class Analytics {
  readonly on: boolean;
  private readonly config: AnalyticsConfig | null;
  private readonly post: WebhookPost;
  private readonly now: () => Date;
  private readonly log: (level: "warn", msg: string, fields: Record<string, unknown>) => void;
  private queue: Queued[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending: Promise<void> | null = null;
  private readonly optOuts: OptOutStore | null;
  /** The people left out, read from the store the first time anything asks. */
  private out: Set<string> | null = null;

  constructor(deps: {
    config: AnalyticsConfig | null;
    post: WebhookPost;
    now: () => Date;
    log?: (level: "warn", msg: string, fields: Record<string, unknown>) => void;
    /** Where the people who opted out are kept, so a restart doesn't forget them. Without one, memory only. */
    optOuts?: OptOutStore;
  }) {
    this.optOuts = deps.optOuts ?? null;
    this.config = deps.config;
    this.on = deps.config !== null;
    this.post = deps.post;
    this.now = deps.now;
    this.log = deps.log ?? (() => {});
  }

  /**
   * Queues one event. Never throws and never waits. `setOnce` holds properties PostHog keeps on the person only the
   * first time it sees them.
   */
  capture(event: string, distinctId: string, properties: AnalyticsProperties = {}, setOnce?: AnalyticsProperties): void {
    if (!this.config) return;
    try {
      if (this.leftOut().has(distinctId)) return;
      const sent: Record<string, unknown> = clean(properties);
      if (setOnce && Object.keys(clean(setOnce)).length > 0) sent.$set_once = clean(setOnce);
      // The request to PostHog comes from this server, so its address says nothing about where the person is.
      Object.assign(sent, { environment: this.config.environment, $lib: "portico-server", $geoip_disable: true });
      this.queue.push({ event, distinct_id: distinctId, timestamp: this.now().toISOString(), properties: sent });
      // PostHog is slow or away: the oldest events go first.
      if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX);
      if (this.queue.length >= BATCH) void this.flush();
      else if (this.timer === null) {
        this.timer = setTimeout(() => void this.flush(), FLUSH_AFTER_MS);
        // Waiting events never keep the process alive.
        this.timer.unref?.();
      }
    } catch {
      // An event that can't be queued is lost.
    }
  }

  /** Says that the anonymous browser ID and the person are one: what the visit did before sign-in becomes the person's. */
  identify(personId: string, anonId: string): void {
    if (!ANON_ID.test(anonId) || anonId === personId) return;
    this.capture("$identify", personId, { $anon_distinct_id: anonId });
  }

  /**
   * What the person's browser said, seen on a sign-in or a page: Do Not Track or Global Privacy Control leaves the
   * person out of every event from then on, also the ones the person's agents cause, which come with no browser. A
   * later visit without either brings the person back. Written only when it changes. Never throws.
   */
  setOptOut(personId: string, optedOut: boolean): void {
    if (!this.config) return;
    try {
      const out = this.leftOut();
      if (out.has(personId) === optedOut) return;
      if (optedOut) {
        out.add(personId);
        // What already waits about the person doesn't leave either.
        this.queue = this.queue.filter((queued) => queued.distinct_id !== personId);
      } else out.delete(personId);
      this.optOuts?.save([...out]);
    } catch {
      // The store can't be read or written: nothing changes.
    }
  }

  private leftOut(): Set<string> {
    this.out ??= new Set(this.optOuts?.load() ?? []);
    return this.out;
  }

  /**
   * Runs the lookups a capture needs, so that nothing in them reaches the request that caused the event. Skipped
   * entirely while analytics is off.
   */
  track(fn: (analytics: Analytics) => void): void {
    if (!this.on) return;
    try {
      fn(this);
    } catch {
      // The event is lost; the request goes on.
    }
  }

  /** Sends everything that waits. Never rejects. */
  flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    // One post at a time: events queued meanwhile leave with the same run.
    this.sending ??= this.drain().finally(() => {
      this.sending = null;
    });
    return this.sending;
  }

  private async drain(): Promise<void> {
    const config = this.config;
    if (!config) return;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, BATCH);
      try {
        const answer = await this.post({ url: `${config.host}/batch/`, headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: config.key, batch }) });
        if (answer.status === null) this.log("warn", "analytics_flush_failed", { error: answer.error, events: batch.length });
        else if (answer.status >= 300) this.log("warn", "analytics_flush_failed", { status: answer.status, events: batch.length });
      } catch (err) {
        this.log("warn", "analytics_flush_failed", { error: err instanceof Error ? err.name : typeof err, events: batch.length });
      }
    }
  }
}

/** Only plain values, with long strings cut: a property is an ID, a kind or a number, never a text. */
function clean(properties: AnalyticsProperties): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "string") out[key] = value.slice(0, STRING_MAX);
    else if (typeof value === "boolean" || value === null) out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}
