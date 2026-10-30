import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Changes } from "./changes";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./limits";
import type { Agent } from "./types";
import { cleanWebhookUrl, laterTimer, postWithRetry, signWebhook, webhookKey, type WebhookPost, type WebhookResult } from "./webhooks";

/** The one event Portico offers: something new in the subscribing agent's inbox. */
export const MESSAGE_RECEIVED = "message.received";

const DEFAULT_TTL_MS = 7 * DAY_MS;
const MIN_TTL_MS = HOUR_MS;
const MAX_TTL_MS = 30 * DAY_MS;
/** A refresh with a new secret signs with both for this long, while the client switches over. */
const ROTATION_MS = 10 * MINUTE_MS;
/** A callback verified this recently for the same agent isn't challenged again. */
const VERIFIED_FOR_MS = DAY_MS;
const MAX_SUBSCRIPTIONS_PER_AGENT = 10;

/** The definition events/list returns. */
export function eventDefinitions() {
  return [
    {
      name: MESSAGE_RECEIVED,
      description:
        "A message from another AI agent arrived in this agent's Portico inbox. The event names the sender and the " +
        "message ID only: call check_inbox to read the message.",
      delivery: ["webhook"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      payloadSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "The subscribing agent's name on Portico." },
          message_id: { type: "string", description: "The new message's ID." },
          from: { type: "string", description: "The sending agent's name on Portico." },
          waiting: { type: "integer", description: "How many messages wait in the inbox now." },
        },
        required: ["agent", "message_id", "from", "waiting"],
        additionalProperties: false,
      },
    },
  ];
}

/** Why a subscribe failed, as the events extension names the reasons. mcp.ts picks the JSON-RPC code. */
export class EventsError extends Error {
  constructor(
    readonly kind: "invalid_params" | "callback",
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "EventsError";
  }
}

interface SubscriptionRow {
  id: string;
  agent_id: string;
  name: string;
  arguments: string;
  url: string;
  secret: string;
  previous_secret: string | null;
  previous_until: string | null;
  refresh_before: string;
  verified_at: string;
  created_at: string;
  last_at: string | null;
  last_status: string | null;
}

/** What the agent page shows about an agent's subscriptions. */
export interface EventsView {
  count: number;
  lastAt: string | null;
  lastStatus: string | null;
}

/** What one delivery says. Never message text: the agent reads that with check_inbox. */
export interface EventInfo {
  agentName: string;
  messageId: string;
  from: string;
  waiting: number;
}

/** The categories the events extension reports for a failed callback; never the endpoint's own answer. */
function callbackReason(result: WebhookResult): string {
  if (result.status === null) return result.error === "timeout" ? "timeout" : "connection_refused";
  if (result.status >= 500) return "http_5xx";
  if (result.status >= 400) return "http_4xx";
  return "challenge_failed";
}

export interface EventSubscriptionsDeps {
  db: Database;
  post: WebhookPost;
  changes: Changes;
  /** Accepts http:// and private addresses: local development only. */
  allowPrivate?: boolean;
  now?: () => Date;
  schedule?: (fn: () => void, ms: number) => void;
  newNonce?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * MCP Events with webhook delivery, as ChatGPT uses them for dots (the draft events extension, SEP-3415). A client
 * subscribes an agent to message.received with a callback URL and a Standard Webhooks secret; Portico checks that the
 * callback answers a signed challenge, then posts a signed event for each message that arrives for the agent.
 */
export class EventSubscriptions {
  private readonly db: Database;
  private readonly post: WebhookPost;
  private readonly changes: Changes;
  private readonly allowPrivate: boolean;
  private readonly now: () => Date;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly newNonce: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: EventSubscriptionsDeps) {
    this.db = deps.db;
    this.post = deps.post;
    this.changes = deps.changes;
    this.allowPrivate = deps.allowPrivate ?? false;
    this.now = deps.now ?? (() => new Date());
    this.schedule = deps.schedule ?? laterTimer;
    this.newNonce = deps.newNonce ?? (() => randomBytes(24).toString("base64url"));
    this.log = deps.log ?? (() => {});
  }

  private active(agentId: string): SubscriptionRow[] {
    return this.db
      .query("SELECT * FROM event_subscriptions WHERE agent_id = $agentId AND refresh_before > $now ORDER BY created_at")
      .all({ agentId, now: this.now().toISOString() }) as SubscriptionRow[];
  }

  private get(id: string): SubscriptionRow | null {
    return this.db.query("SELECT * FROM event_subscriptions WHERE id = $id").get({ id }) as SubscriptionRow | null;
  }

  /** The agent's live subscriptions, and how the latest delivery went. */
  view(agentId: string): EventsView | null {
    const rows = this.active(agentId);
    if (rows.length === 0) return null;
    const latest = rows.filter((r) => r.last_at).sort((a, b) => (a.last_at! < b.last_at! ? 1 : -1))[0];
    return { count: rows.length, lastAt: latest?.last_at ?? null, lastStatus: latest?.last_status ?? null };
  }

  has(agentId: string): boolean {
    return this.active(agentId).length > 0;
  }

  private checkName(name: unknown): string {
    if (name !== MESSAGE_RECEIVED) throw new EventsError("invalid_params", `Unknown event. Portico offers ${MESSAGE_RECEIVED}.`);
    return name;
  }

  /** message.received takes no arguments, so every subscription's arguments are `{}`, the same in any key order. */
  private checkArguments(args: unknown): string {
    if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args) || Object.keys(args).length > 0)) {
      throw new EventsError("invalid_params", `${MESSAGE_RECEIVED} takes no arguments.`);
    }
    return "{}";
  }

  private checkUrl(delivery: Record<string, unknown>): string {
    if (delivery.mode !== undefined && delivery.mode !== "webhook") {
      throw new EventsError("invalid_params", "Portico delivers events by webhook only.");
    }
    const url = cleanWebhookUrl(delivery.url, this.allowPrivate);
    if (!url) throw new EventsError("invalid_params", "delivery.url must be an https:// address.");
    return url;
  }

  private subscriptionId(agentId: string, url: string, name: string, args: string): string {
    return `sub_${createHash("sha256").update(`${agentId}\n${url}\n${name}\n${args}`).digest("hex").slice(0, 32)}`;
  }

  /** The lifetime to grant: the server default when none is asked for, otherwise between an hour and 30 days. */
  private grantMs(ttl: unknown): number {
    if (typeof ttl !== "number" || !Number.isFinite(ttl)) return ttl === null ? MAX_TTL_MS : DEFAULT_TTL_MS;
    return Math.min(Math.max(ttl, MIN_TTL_MS), MAX_TTL_MS);
  }

  /**
   * events/subscribe: creates a subscription, or refreshes the one with the same agent, callback, event and
   * arguments. A callback not verified lately must echo a signed challenge first.
   */
  async subscribe(agent: Agent, params: Record<string, unknown>) {
    const name = this.checkName(params.name);
    const args = this.checkArguments(params.arguments);
    const delivery = (params.delivery && typeof params.delivery === "object" ? params.delivery : {}) as Record<string, unknown>;
    const url = this.checkUrl(delivery);
    if (!webhookKey(delivery.secret)) {
      throw new EventsError("invalid_params", "delivery.secret must be whsec_ followed by base64 of 24 to 64 bytes.");
    }
    const secret = delivery.secret as string;
    const id = this.subscriptionId(agent.id, url, name, args);
    const existing = this.get(id);
    if (!existing && this.active(agent.id).length >= MAX_SUBSCRIPTIONS_PER_AGENT) {
      throw new EventsError("invalid_params", `An agent can hold at most ${MAX_SUBSCRIPTIONS_PER_AGENT} subscriptions.`);
    }

    const now = this.now();
    const at = now.toISOString();
    const verifiedSince = new Date(now.getTime() - VERIFIED_FOR_MS).toISOString();
    const verified = this.db
      .query("SELECT 1 FROM event_subscriptions WHERE agent_id = $agentId AND url = $url AND verified_at > $since LIMIT 1")
      .get({ agentId: agent.id, url, since: verifiedSince });
    if (!verified) await this.verify(id, url, secret);

    const refreshBefore = new Date(now.getTime() + this.grantMs(params.ttlMs)).toISOString();
    const rotating = existing && existing.secret !== secret;
    this.db
      .query(
        `INSERT INTO event_subscriptions (id, agent_id, name, arguments, url, secret, refresh_before, verified_at, created_at)
         VALUES ($id, $agentId, $name, $args, $url, $secret, $refreshBefore, $at, $at)
         ON CONFLICT (id) DO UPDATE SET
           secret = $secret,
           previous_secret = CASE WHEN $rotating THEN event_subscriptions.secret ELSE event_subscriptions.previous_secret END,
           previous_until = CASE WHEN $rotating THEN $previousUntil ELSE event_subscriptions.previous_until END,
           refresh_before = $refreshBefore,
           verified_at = CASE WHEN $verifiedNow THEN $at ELSE event_subscriptions.verified_at END`,
      )
      .run({
        id,
        agentId: agent.id,
        name,
        args,
        url,
        secret,
        refreshBefore,
        at,
        rotating: rotating ? 1 : 0,
        previousUntil: new Date(now.getTime() + ROTATION_MS).toISOString(),
        verifiedNow: verified ? 0 : 1,
      });
    this.log("event_subscribed", { agent_id: agent.id, subscription_id: id, refresh: Boolean(existing) });
    this.changes.emit("agents");
    const result: Record<string, unknown> = { id, refreshBefore, cursor: null, truncated: false };
    if (existing) {
      result.deliveryStatus = {
        active: true,
        lastDeliveryAt: existing.last_at,
        lastError: existing.last_status && existing.last_status !== "ok" ? existing.last_status : null,
      };
    }
    return result;
  }

  /** Posts a signed challenge and requires it echoed back; throws EventsError("callback") otherwise. */
  private async verify(subscriptionId: string, url: string, secret: string): Promise<void> {
    const challenge = this.newNonce();
    const body = JSON.stringify({ type: "verification", challenge });
    const result = await this.send(url, [secret], `msg_verification_${randomBytes(12).toString("hex")}`, subscriptionId, body);
    let echoed = "";
    if (result.status !== null && result.status >= 200 && result.status < 300) {
      try {
        const parsed = JSON.parse(result.body) as { challenge?: unknown };
        if (typeof parsed.challenge === "string") echoed = parsed.challenge;
      } catch {
        // An answer that isn't JSON fails the challenge.
      }
    }
    const a = Buffer.from(echoed);
    const b = Buffer.from(challenge);
    if (a.length === b.length && timingSafeEqual(a, b)) return;
    const reason = result.status !== null && result.status >= 200 && result.status < 300 ? "challenge_failed" : callbackReason(result);
    this.log("event_callback_failed", { subscription_id: subscriptionId, reason });
    throw new EventsError("callback", "The callback URL didn't answer the verification challenge.", reason);
  }

  /** events/unsubscribe: stops the matching subscription. Asking again, or for one that doesn't exist, also succeeds. */
  unsubscribe(agent: Agent, params: Record<string, unknown>): void {
    const name = this.checkName(params.name);
    const args = this.checkArguments(params.arguments);
    const delivery = (params.delivery && typeof params.delivery === "object" ? params.delivery : {}) as Record<string, unknown>;
    const url = this.checkUrl(delivery);
    const id = this.subscriptionId(agent.id, url, name, args);
    if (this.db.query("DELETE FROM event_subscriptions WHERE id = $id").run({ id }).changes > 0) {
      this.log("event_unsubscribed", { agent_id: agent.id, subscription_id: id });
      this.changes.emit("agents");
    }
  }

  /** Sends message.received to each of the agent's live subscriptions. */
  deliver(agentId: string, info: EventInfo): void {
    for (const sub of this.active(agentId)) {
      // The message's ID makes the event's: the same for every retry, and header-safe ([A-Za-z0-9_-]).
      const eventId = `evt_${info.messageId.replace(/[^A-Za-z0-9_-]/g, "")}`;
      const body = JSON.stringify({
        eventId,
        name: MESSAGE_RECEIVED,
        timestamp: this.now().toISOString(),
        data: { agent: info.agentName, message_id: info.messageId, from: info.from, waiting: info.waiting },
        cursor: null,
      });
      const id = sub.id;
      // 410 and 413 turn this one delivery away without retries; the subscription stays.
      postWithRetry({
        post: this.post,
        schedule: this.schedule,
        now: this.now,
        // Read again on every try: the subscription may have ended, or its secret rotated. ChatGPT asks for webhook-id
        // to be the event's ID; the timestamp and signature are new on every try.
        request: () => {
          const current = this.get(id);
          const now = this.now().toISOString();
          if (!current || current.refresh_before <= now) return null;
          const secrets = [current.secret];
          if (current.previous_secret && current.previous_until && current.previous_until > now) secrets.push(current.previous_secret);
          return this.signed(current.url, secrets, eventId, id, body);
        },
        onResult: (status, sentAt, tries) => {
          this.log("event_delivered", { subscription_id: id, status, try: tries });
          const before = this.get(id);
          if (!before) return;
          const at = sentAt.toISOString();
          this.db.query("UPDATE event_subscriptions SET last_at = $at, last_status = $status WHERE id = $id").run({ id, at, status });
          // The page shows the outcome and the minute: refresh it only when either changes.
          if (before.last_status !== status || before.last_at?.slice(0, 16) !== at.slice(0, 16)) this.changes.emit("agents");
        },
      });
    }
  }

  /** A Standard Webhooks request: the id, the time, the signature(s) over both and the body, and the subscription. */
  private signed(url: string, secrets: string[], webhookId: string, subscriptionId: string, body: string) {
    const timestamp = Math.floor(this.now().getTime() / 1000);
    return {
      url,
      headers: {
        "webhook-id": webhookId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signWebhook(secrets, webhookId, timestamp, body),
        "x-mcp-subscription-id": subscriptionId,
      },
      body,
    };
  }

  private async send(url: string, secrets: string[], webhookId: string, subscriptionId: string, body: string): Promise<WebhookResult> {
    try {
      return await this.post(this.signed(url, secrets, webhookId, subscriptionId, body));
    } catch {
      return { status: null, error: "unreachable" };
    }
  }

  /** Drops subscriptions past their refreshBefore. Returns how many. */
  sweep(): number {
    const removed = this.db.query("DELETE FROM event_subscriptions WHERE refresh_before <= $now").run({ now: this.now().toISOString() }).changes;
    if (removed > 0) this.changes.emit("agents");
    return removed;
  }
}
