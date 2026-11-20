import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Changes } from "./changes";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./limits";
import { SECRET_UNREADABLE, type SecretPlace, type Secrets } from "./secrets";
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
/**
 * A verification makes Portico post to an address the agent names, so an agent gets this many an hour, one at a time:
 * subscribing can't be used to make Portico post to other people's servers over and over.
 */
const VERIFICATIONS_PER_HOUR = 10;

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
    readonly kind: "invalid_params" | "callback" | "limited",
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
  /** Encrypts each subscription's secret before it is stored. */
  secrets: Secrets;
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
  private readonly secrets: Secrets;
  private readonly changes: Changes;
  private readonly allowPrivate: boolean;
  private readonly now: () => Date;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly newNonce: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  /** Agents with a verification on its way, and each agent's recent verification times, in memory. */
  private readonly verifying = new Set<string>();
  private readonly verified = new Map<string, number[]>();

  constructor(deps: EventSubscriptionsDeps) {
    this.db = deps.db;
    this.post = deps.post;
    this.secrets = deps.secrets;
    this.changes = deps.changes;
    this.allowPrivate = deps.allowPrivate ?? false;
    this.now = deps.now ?? (() => new Date());
    this.schedule = deps.schedule ?? laterTimer;
    this.newNonce = deps.newNonce ?? (() => randomBytes(24).toString("base64url"));
    this.log = deps.log ?? (() => {});
  }

  /** Where a subscription's secret, or the one before a rotation, is stored: what its encrypted form is bound to. */
  static place(subscriptionId: string, column: "secret" | "previous_secret" = "secret"): SecretPlace {
    return { table: "event_subscriptions", column, row: subscriptionId };
  }

  /**
   * The stored secret can't be read (another secrets key, or not what Portico stored): nothing is delivered until the
   * agent subscribes again. Returns whether this is news, so the caller tells the agent once.
   */
  unreadable(subscriptionId: string, reason: string): boolean {
    const changed = this.db
      .query("UPDATE event_subscriptions SET last_at = $at, last_status = $status WHERE id = $id AND last_status IS NOT $status")
      .run({ id: subscriptionId, at: this.now().toISOString(), status: SECRET_UNREADABLE }).changes;
    if (changed === 0) return false;
    this.log("event_secret_unreadable", { subscription_id: subscriptionId, reason });
    this.changes.emit("agents");
    return true;
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
    if (!verified) {
      this.startVerification(agent.id);
      try {
        await this.verify(id, url, secret);
      } finally {
        this.verifying.delete(agent.id);
      }
    }

    const refreshBefore = new Date(now.getTime() + this.grantMs(params.ttlMs)).toISOString();
    // The secret held until now signs alongside the new one for a while. One Portico can't read any more is dropped:
    // subscribing again is how a subscription gets a secret Portico can use.
    const held = existing ? await this.secrets.open(EventSubscriptions.place(id), existing.secret) : null;
    const rotating = held !== null && held.ok && held.value !== secret;
    const lost = held !== null && !held.ok;
    const previous = rotating && held.ok ? await this.secrets.seal(EventSubscriptions.place(id, "previous_secret"), held.value) : null;
    const sealed = await this.secrets.seal(EventSubscriptions.place(id), secret);
    this.db
      .query(
        `INSERT INTO event_subscriptions (id, agent_id, name, arguments, url, secret, refresh_before, verified_at, created_at)
         VALUES ($id, $agentId, $name, $args, $url, $secret, $refreshBefore, $at, $at)
         ON CONFLICT (id) DO UPDATE SET
           secret = $secret,
           previous_secret = CASE WHEN $rotating THEN $previous WHEN $lost THEN NULL ELSE event_subscriptions.previous_secret END,
           previous_until = CASE WHEN $rotating THEN $previousUntil WHEN $lost THEN NULL ELSE event_subscriptions.previous_until END,
           last_status = CASE WHEN $lost THEN NULL ELSE event_subscriptions.last_status END,
           refresh_before = $refreshBefore,
           verified_at = CASE WHEN $verifiedNow THEN $at ELSE event_subscriptions.verified_at END`,
      )
      .run({
        id,
        agentId: agent.id,
        name,
        args,
        url,
        secret: sealed,
        previous,
        lost: lost ? 1 : 0,
        refreshBefore,
        at,
        rotating: rotating ? 1 : 0,
        previousUntil: new Date(now.getTime() + ROTATION_MS).toISOString(),
        verifiedNow: verified ? 0 : 1,
      });
    this.log("event_subscribed", { agent_id: agent.id, subscription_id: id, refresh: Boolean(existing) });
    this.changes.about({ agents: [agent.id] }, "agents");
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

  /** Counts a verification for the agent, or throws EventsError("limited"): one at a time, VERIFICATIONS_PER_HOUR an hour. */
  private startVerification(agentId: string): void {
    const now = this.now().getTime();
    const recent = (this.verified.get(agentId) ?? []).filter((at) => now - at < HOUR_MS);
    if (this.verifying.has(agentId)) {
      throw new EventsError("limited", "Portico is still checking another callback URL for this agent. Try again once that check is done.");
    }
    if (recent.length >= VERIFICATIONS_PER_HOUR) {
      throw new EventsError("limited", `Portico checks at most ${VERIFICATIONS_PER_HOUR} callback URLs an hour for one agent. Try again later.`);
    }
    this.verified.set(agentId, [...recent, now]);
    this.verifying.add(agentId);
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
      this.changes.about({ agents: [agent.id] }, "agents");
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
        request: async () => {
          const current = this.get(id);
          const now = this.now().toISOString();
          if (!current || current.refresh_before <= now) return null;
          const secret = await this.secrets.open(EventSubscriptions.place(id), current.secret);
          if (!secret.ok) {
            this.unreadable(id, secret.reason);
            return null;
          }
          const secrets = [secret.value];
          if (current.previous_secret && current.previous_until && current.previous_until > now) {
            // The secret before a rotation only signs alongside: one that can't be read is left out.
            const before = await this.secrets.open(EventSubscriptions.place(id, "previous_secret"), current.previous_secret);
            if (before.ok) secrets.push(before.value);
          }
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
    const now = this.now().getTime();
    for (const [agentId, times] of this.verified) if (times.every((at) => now - at >= HOUR_MS)) this.verified.delete(agentId);
    const removed = this.db.query("DELETE FROM event_subscriptions WHERE refresh_before <= $now").run({ now: this.now().toISOString() }).changes;
    if (removed > 0) this.changes.emit("agents");
    return removed;
  }
}
