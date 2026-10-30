import type { Database } from "bun:sqlite";
import type { Activity } from "./activity";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import { HOUR_MS, MINUTE_MS } from "./limits";
import type { Agent } from "./types";
import { cleanWebhookUrl, laterTimer, postWithRetry, type WebhookPost } from "./webhooks";

/** After a wake that went through, the next waits for the agent to check in, or this long. */
export const REWAKE_MS = 10 * MINUTE_MS;
/** The most wakes Portico sends one agent in an hour: well under Grok Bot's 200 runs an hour per routine. */
export const MAX_WAKES_PER_HOUR = 30;
const MAX_KEY_CHARS = 512;

/** What the agent page shows. The key never leaves Portico once saved. */
export interface WakeUrlView {
  host: string;
  createdAt: string;
  /** When the last wake was sent. */
  lastAt: string | null;
  /** "ok", "http_401", "timeout", "unreachable", "blocked_address": how the last wake went. */
  lastStatus: string | null;
}

interface WakeRow {
  agent_id: string;
  url: string;
  key: string;
  created_at: string;
  last_at: string | null;
  last_status: string | null;
}

/** What a wake says: who it's for, how many messages wait, and the newest one's ID and sender. Never message text. */
export interface WakeInfo {
  agentName: string;
  waiting: number;
  messageId: string;
  from: string;
  /** When the agent last checked the inbox, or null. */
  lastCheckIn: string | null;
}

export interface WakeUrlsDeps {
  db: Database;
  post: WebhookPost;
  changes: Changes;
  activity: Activity;
  /** Accepts http:// and private addresses: local development only. */
  allowPrivate?: boolean;
  now?: () => Date;
  schedule?: (fn: () => void, ms: number) => void;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Wake URLs: an app's webhook trigger, such as a Grok Bot routine's, that the agent's manager gives Portico. When a
 * message for the agent arrives, Portico posts to it with the key as a bearer token, and the app starts a run that
 * checks the inbox. One wake that went through covers every message until the agent checks in.
 */
export class WakeUrls {
  private readonly db: Database;
  private readonly post: WebhookPost;
  private readonly changes: Changes;
  private readonly activity: Activity;
  private readonly allowPrivate: boolean;
  private readonly now: () => Date;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  /** Agents with a wake on its way, retries included. */
  private readonly sending = new Set<string>();
  /** Recent wake times by agent, for the hourly cap. */
  private readonly recent = new Map<string, number[]>();
  /** Bumped when the manager sets or removes the wake URL, so a chain of retries for the old one stops. */
  private readonly generation = new Map<string, number>();

  constructor(deps: WakeUrlsDeps) {
    this.db = deps.db;
    this.post = deps.post;
    this.changes = deps.changes;
    this.activity = deps.activity;
    this.allowPrivate = deps.allowPrivate ?? false;
    this.now = deps.now ?? (() => new Date());
    this.schedule = deps.schedule ?? laterTimer;
    this.log = deps.log ?? (() => {});
  }

  private row(agentId: string): WakeRow | null {
    return this.db.query("SELECT * FROM wake_urls WHERE agent_id = $agentId").get({ agentId }) as WakeRow | null;
  }

  view(agentId: string): WakeUrlView | null {
    const row = this.row(agentId);
    if (!row) return null;
    return { host: new URL(row.url).host, createdAt: row.created_at, lastAt: row.last_at, lastStatus: row.last_status };
  }

  has(agentId: string): boolean {
    return this.db.query("SELECT 1 FROM wake_urls WHERE agent_id = $agentId").get({ agentId }) !== null;
  }

  /** A new or removed wake URL starts over: no chain of retries for the old one, and a fresh hourly count. */
  private reset(agentId: string): void {
    this.generation.set(agentId, (this.generation.get(agentId) ?? 0) + 1);
    this.sending.delete(agentId);
    this.recent.delete(agentId);
  }

  /** Saves the agent's wake URL and key, replacing any earlier one. Only for apps and connectors. */
  set(agent: Agent, personId: string, input: { url?: unknown; key?: unknown }): WakeUrlView {
    if (agent.type === "session") throw new PorticoError("not_allowed", "Sessions get messages pushed and don't use a wake URL.");
    const url = cleanWebhookUrl(input.url, this.allowPrivate);
    if (!url) throw new PorticoError("bad_request", "The wake URL must be an https:// address, without a user name or password.");
    const key = typeof input.key === "string" ? input.key.trim() : "";
    if (!key || key.length > MAX_KEY_CHARS || /\s/.test(key)) {
      throw new PorticoError("bad_request", "The key must be the routine's key: one word, no spaces.");
    }
    this.db
      .query(
        `INSERT INTO wake_urls (agent_id, url, key, set_by, created_at) VALUES ($agentId, $url, $key, $personId, $at)
         ON CONFLICT (agent_id) DO UPDATE SET url = $url, key = $key, set_by = $personId, created_at = $at,
           last_at = NULL, last_status = NULL`,
      )
      .run({ agentId: agent.id, url, key, personId, at: this.now().toISOString() });
    this.reset(agent.id);
    this.activity.record("wake_set", { agentId: agent.id, personId, detail: { host: new URL(url).host } });
    this.changes.emit("agents");
    return this.view(agent.id)!;
  }

  /** Returns whether there was one to remove. */
  clear(agent: Agent, personId: string): boolean {
    const row = this.row(agent.id);
    if (!row) return false;
    this.db.query("DELETE FROM wake_urls WHERE agent_id = $agentId").run({ agentId: agent.id });
    this.reset(agent.id);
    this.activity.record("wake_removed", { agentId: agent.id, personId, detail: { host: new URL(row.url).host } });
    this.changes.emit("agents");
    return true;
  }

  /**
   * A message for the agent is waiting: wake the agent, unless a wake already went through and the agent hasn't
   * checked in since it was sent (for less than REWAKE_MS), one is on its way, or the hourly cap is reached.
   */
  kick(agentId: string, info: WakeInfo): void {
    const row = this.row(agentId);
    if (!row || this.sending.has(agentId)) return;
    const now = this.now().getTime();
    if (row.last_status === "ok" && row.last_at) {
      const checkedInSince = info.lastCheckIn !== null && info.lastCheckIn >= row.last_at;
      if (!checkedInSince && now - Date.parse(row.last_at) < REWAKE_MS) return;
    }
    const recent = (this.recent.get(agentId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= MAX_WAKES_PER_HOUR) {
      this.log("wake_capped", { agent_id: agentId });
      return;
    }
    this.recent.set(agentId, [...recent, now]);
    this.sending.add(agentId);
    const generation = this.generation.get(agentId) ?? 0;
    const current = () => (this.generation.get(agentId) ?? 0) === generation;
    const body = JSON.stringify({
      portico: {
        event: "message.received",
        agent: info.agentName,
        waiting: info.waiting,
        latest: { message_id: info.messageId, from: info.from },
      },
    });
    postWithRetry({
      post: this.post,
      schedule: this.schedule,
      now: this.now,
      // Read again on every try: a changed or removed wake URL ends the chain.
      request: () => {
        const latest = current() ? this.row(agentId) : null;
        return latest ? { url: latest.url, headers: { authorization: `Bearer ${latest.key}` }, body } : null;
      },
      onResult: (status, sentAt, tries) => {
        this.log("wake_sent", { agent_id: agentId, status, try: tries });
        if (!current()) return;
        const before = this.row(agentId);
        const at = sentAt.toISOString();
        this.db.query("UPDATE wake_urls SET last_at = $at, last_status = $status WHERE agent_id = $agentId").run({ agentId, at, status });
        // The page shows the outcome and the minute: refresh it only when either changes.
        if (before?.last_status !== status || before?.last_at?.slice(0, 16) !== at.slice(0, 16)) this.changes.emit("agents");
      },
      onEnd: () => {
        if (current()) this.sending.delete(agentId);
      },
    });
  }
}
