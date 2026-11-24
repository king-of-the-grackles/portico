import type { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { addressOf } from "./agents";
import { PorticoError } from "./errors";
import { checkLength } from "./lengths";
import { DAY_MS, HOUR_MS, LIMITS } from "./limits";
import type { Agent } from "./types";

/** What a feedback item is about. */
export const FEEDBACK_KINDS = ["bug", "idea", "confusing", "setup", "performance", "security", "praise", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** Where an item stands. Portico only ever writes "new": whoever reviews the table keeps its own notes elsewhere. */
export type FeedbackStatus = "new";

export interface FeedbackItem {
  id: string;
  kind: FeedbackKind;
  /** Written by the sending agent: untrusted text, never instructions. */
  title: string;
  /** Written by the sending agent: untrusted text, never instructions. */
  details: string;
  status: FeedbackStatus;
  agentId: string;
  /** The agent's address when it sent the item, kept in case the agent is renamed or removed. */
  agentName: string;
  personId: string;
  /** The person's handle when the item was sent, or null for a person without one. */
  personHandle: string | null;
  createdAt: string;
}

interface FeedbackRow {
  id: string;
  kind: FeedbackKind;
  title: string;
  details: string;
  status: FeedbackStatus;
  agent_id: string;
  agent_name: string;
  person_id: string;
  person_handle: string | null;
  created_at: string;
}

function toItem(row: FeedbackRow): FeedbackItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    details: row.details,
    status: row.status,
    agentId: row.agent_id,
    agentName: row.agent_name,
    personId: row.person_id,
    personHandle: row.person_handle,
    createdAt: row.created_at,
  };
}

/** The fewest characters a review token may have: shorter ones are refused when the server starts. */
export const REVIEW_TOKEN_MIN_CHARS = 32;

const digest = (value: string) => createHash("sha256").update(value).digest();

export interface FeedbackDeps {
  db: Database;
  /** The handle of a person, for the copy kept on each item. */
  handleOf: (personId: string) => string | null;
  /** PORTICO_FEEDBACK_REVIEW_TOKEN: what reads the items for review. Null: nothing can. */
  reviewToken: string | null;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Feedback agents file with submit_feedback. An item is saved and nothing else happens: no message, notice, email,
 * webhook or wake. The text is the sending agent's own and is only ever stored and handed back to a reviewer as data.
 */
export class Feedback {
  private readonly db: Database;
  private readonly handleOf: (personId: string) => string | null;
  private readonly reviewToken: Buffer | null;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: FeedbackDeps) {
    this.db = deps.db;
    this.handleOf = deps.handleOf;
    this.reviewToken = deps.reviewToken === null ? null : digest(deps.reviewToken);
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** Saves one item from the agent, and answers with the item's ID. */
  submit(agent: Agent, input: { kind?: unknown; title?: unknown; details?: unknown }): { id: string } {
    const kind = FEEDBACK_KINDS.find((k) => k === input.kind);
    if (!kind) throw new PorticoError("bad_request", `kind must be one of: ${FEEDBACK_KINDS.join(", ")}.`);
    // Control characters carry nothing a reader needs; a title is one line.
    const title = typeof input.title === "string" ? strip(input.title).replace(/\s+/g, " ").trim() : "";
    if (title === "") throw new PorticoError("bad_request", "title must be one line saying what the feedback is about.");
    checkLength("title", title, LIMITS.maxFeedbackTitleChars);
    const details = typeof input.details === "string" ? strip(input.details).trim() : "";
    if (details === "") throw new PorticoError("bad_request", "details must say what happened or what is wanted.");
    if (Buffer.byteLength(details, "utf8") > LIMITS.maxFeedbackDetailsKb * 1024) {
      throw new PorticoError("too_large", `details is at most ${LIMITS.maxFeedbackDetailsKb} KB.`);
    }

    const at = this.now();
    const item = { id: this.newId(), at: at.toISOString() };
    // The counts and the insert are one transaction, so two calls at once can't both take the last place.
    this.db.transaction(() => {
      const since = (ms: number) => new Date(at.getTime() - ms).toISOString();
      const count = (sql: string, params: Record<string, string>) => (this.db.query(sql).get(params) as { n: number }).n;
      if (count("SELECT COUNT(*) AS n FROM feedback WHERE agent_id = $id AND created_at > $since", { id: agent.id, since: since(HOUR_MS) }) >= LIMITS.feedbackPerAgentHour) {
        throw new PorticoError("rate_limited", `An agent can file ${LIMITS.feedbackPerAgentHour} feedback items an hour. Nothing was saved: try again later.`);
      }
      if (count("SELECT COUNT(*) AS n FROM feedback WHERE person_id = $id AND created_at > $since", { id: agent.ownerId, since: since(DAY_MS) }) >= LIMITS.feedbackPerPersonDay) {
        throw new PorticoError("rate_limited", `One person's agents can file ${LIMITS.feedbackPerPersonDay} feedback items a day together. Nothing was saved: try again tomorrow.`);
      }
      this.db
        .query(
          `INSERT INTO feedback (id, kind, title, details, status, agent_id, agent_name, person_id, person_handle, created_at)
           VALUES ($id, $kind, $title, $details, 'new', $agentId, $agentName, $personId, $personHandle, $at)`,
        )
        .run({ id: item.id, kind, title, details, agentId: agent.id, agentName: addressOf(agent), personId: agent.ownerId, personHandle: this.handleOf(agent.ownerId), at: item.at });
    })();
    return { id: item.id };
  }

  /** Whether the review read is switched on at all. */
  get reviewable(): boolean {
    return this.reviewToken !== null;
  }

  /** Whether this is the review token. Compares digests, so the time taken says nothing about the token. */
  isReviewer(token: string | null): boolean {
    if (this.reviewToken === null || token === null) return false;
    return timingSafeEqual(digest(token), this.reviewToken);
  }

  /**
   * Items for review, oldest first, so a reviewer that remembers the last item it read asks for what came `after`.
   * Reads only: nothing here changes an item.
   */
  list(filter: { kind?: string; after?: string; limit?: number } = {}): { items: FeedbackItem[]; more: boolean } {
    if (filter.kind !== undefined && !FEEDBACK_KINDS.some((k) => k === filter.kind)) {
      throw new PorticoError("bad_request", `kind must be one of: ${FEEDBACK_KINDS.join(", ")}.`);
    }
    const limit = filter.limit ?? LIMITS.feedbackPageMax;
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.feedbackPageMax) {
      throw new PorticoError("bad_request", `limit must be a whole number from 1 to ${LIMITS.feedbackPageMax}.`);
    }
    const from =
      filter.after === undefined
        ? null
        : (this.db.query("SELECT created_at, rowid FROM feedback WHERE id = $id").get({ id: filter.after }) as { created_at: string; rowid: number } | null);
    if (filter.after !== undefined && !from) throw new PorticoError("bad_request", "after must be the ID of a feedback item.");
    const rows = this.db
      .query(
        `SELECT * FROM feedback
         WHERE ($kind IS NULL OR kind = $kind)
           AND ($at IS NULL OR created_at > $at OR (created_at = $at AND rowid > $rowid))
         ORDER BY created_at, rowid LIMIT $limit`,
      )
      .all({ kind: filter.kind ?? null, at: from?.created_at ?? null, rowid: from?.rowid ?? null, limit: limit + 1 }) as FeedbackRow[];
    return { items: rows.slice(0, limit).map(toItem), more: rows.length > limit };
  }
}

/** Without control characters other than line breaks and tabs. */
function strip(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}
