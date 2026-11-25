import type { Database } from "bun:sqlite";
import type { Changes } from "./changes";
import { DAY_MS, LIMITS } from "./limits";

/**
 * What the activity record keeps, besides tasks (messages) and sessions (runs): agents and computers joining or
 * leaving, decisions people make, and changes to an agent's settings.
 */
export const ACTIVITY_KINDS = [
  "computer_joined",
  "agent_joined",
  "agent_removed",
  "decision",
  "sign_in_denied",
  "renamed",
  "description_changed",
  "approval_switched",
  "folder_switched",
  "allow_removed",
  "wake_set",
  "wake_removed",
  "outbound_switched",
  "agent_revoked",
  // A question an agent asked its own person with request_input, and how the person ended it. Never the text.
  "input_asked",
  "input_answered",
  "input_skipped",
  // A Portico's record. Each carries the Portico.
  "portico_person_joined",
  "portico_person_left",
  "portico_agent_joined",
  "portico_agent_left",
  "portico_shared",
  "portico_share_ended",
  "portico_paused",
  "portico_resumed",
  "portico_held",
  "portico_refused",
  "portico_burst",
  "portico_refusals",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** One entry. `detail` holds names and choices, never message text or anything secret. */
export interface ActivityEntry {
  /** The entry's place in the order entries were written. */
  seq: number;
  id: string;
  at: string;
  kind: ActivityKind;
  /** The agent it's about; null once the agent is removed. */
  agentId: string | null;
  /** The other agent: the sender of a decided message, or the sender taken off an allow list. */
  otherId: string | null;
  /** The person who did it, when a person did. */
  personId: string | null;
  /** The Portico the entry belongs to, for an entry of a Portico's record. */
  workspaceId: string | null;
  /** The person the entry is about: who came in or left, or whom an alert is for. */
  subjectId: string | null;
  detail: Record<string, string | boolean | null>;
}

interface ActivityRow {
  seq: number;
  id: string;
  at: string;
  kind: string;
  agent_id: string | null;
  other_id: string | null;
  person_id: string | null;
  workspace_id: string | null;
  subject_id: string | null;
  detail: string;
}

function toEntry(row: ActivityRow): ActivityEntry {
  let detail: ActivityEntry["detail"] = {};
  try {
    detail = JSON.parse(row.detail) as ActivityEntry["detail"];
  } catch {
    // An unreadable detail shows as none.
  }
  return {
    seq: row.seq,
    id: row.id,
    at: row.at,
    kind: row.kind as ActivityKind,
    agentId: row.agent_id,
    otherId: row.other_id,
    personId: row.person_id,
    workspaceId: row.workspace_id,
    subjectId: row.subject_id,
    detail,
  };
}

export interface ActivityDeps {
  db: Database;
  changes: Changes;
  now?: () => Date;
  newId?: () => string;
}

/** The activity record: written as things happen, read newest first, kept as long as messages. */
export class Activity {
  private readonly db: Database;
  private readonly changes: Changes;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: ActivityDeps) {
    this.db = deps.db;
    this.changes = deps.changes;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  record(
    kind: ActivityKind,
    fields: {
      agentId?: string | null;
      otherId?: string | null;
      personId?: string | null;
      workspaceId?: string | null;
      subjectId?: string | null;
      detail?: ActivityEntry["detail"];
    } = {},
  ): void {
    this.db
      .query(
        `INSERT INTO activity (id, at, kind, agent_id, other_id, person_id, workspace_id, subject_id, detail)
         VALUES ($id, $at, $kind, $agentId, $otherId, $personId, $workspaceId, $subjectId, $detail)`,
      )
      .run({
        id: this.newId(),
        at: this.now().toISOString(),
        kind,
        agentId: fields.agentId ?? null,
        otherId: fields.otherId ?? null,
        personId: fields.personId ?? null,
        workspaceId: fields.workspaceId ?? null,
        subjectId: fields.subjectId ?? null,
        detail: JSON.stringify(fields.detail ?? {}),
      });
    this.changes.about({ people: [fields.personId, fields.subjectId], agents: [fields.agentId, fields.otherId], workspaces: [fields.workspaceId] }, "activity");
  }

  /**
   * Newest first. With `agentIds`, only entries about those agents (as the agent or the other one), plus entries about
   * no agent at all when `withUnattached` is set (a computer joining). With `forPerson` and `ownUnattached`, that person's own
   * entries about no agent show too: the person's computer joining, a join the person turned down.
   */
  list(filter: { agentIds?: string[]; withUnattached?: boolean; before?: string; limit?: number; forPerson?: string; ownUnattached?: boolean } = {}): ActivityEntry[] {
    const clauses: string[] = [];
    // A reader's list never says that a message of someone else's agent was held on its way out.
    const bindings: Record<string, string | number> = { limit: Math.min(Math.max(filter.limit ?? 100, 1), 500) };
    if (filter.agentIds) {
      const names = filter.agentIds.map((id, i) => {
        bindings[`a${i}`] = id;
        return `$a${i}`;
      });
      const about = names.length > 0 ? `agent_id IN (${names.join(", ")}) OR other_id IN (${names.join(", ")})` : "0";
      // What is about no agent at all (a computer joining, a join turned down) shows to the person it happened to.
      const own = filter.forPerson && filter.ownUnattached ? " OR (agent_id IS NULL AND other_id IS NULL AND person_id IS $forPerson)" : "";
      clauses.push(filter.withUnattached ? `(${about} OR (agent_id IS NULL AND other_id IS NULL))` : `(${about}${own})`);
    }
    if (filter.forPerson) {
      clauses.push("(json_extract(detail, '$.for') IS NOT 'outbound' OR subject_id IS $forPerson)");
      bindings.forPerson = filter.forPerson;
    }
    if (filter.before) {
      clauses.push("at < $before");
      bindings.before = filter.before;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.db.query(`SELECT * FROM activity ${where} ORDER BY at DESC, rowid DESC LIMIT $limit`).all(bindings) as ActivityRow[]
    ).map(toEntry);
  }

  /**
   * One Portico's record, newest first: who came in and left, shares, holds, refused sends and pauses. With `after`,
   * only the entries written after that one (its `seq`). An alert shows only to the person it is for (`forPerson`),
   * and so does anything about a message held on its way out: that is the sender's person's alone.
   */
  recordOf(workspaceId: string, opts: { forPerson?: string; after?: number; limit?: number } = {}): ActivityEntry[] {
    const rows = this.db
      .query(
        `SELECT * FROM activity WHERE workspace_id = $workspaceId AND seq > $after
           AND (kind NOT IN ('portico_burst', 'portico_refusals') OR subject_id IS $forPerson)
           AND (json_extract(detail, '$.for') IS NOT 'outbound' OR subject_id IS $forPerson)
         ORDER BY at DESC, rowid DESC LIMIT $limit`,
      )
      .all({ workspaceId, after: opts.after ?? 0, forPerson: opts.forPerson ?? null, limit: Math.min(Math.max(opts.limit ?? 50, 1), 200) }) as ActivityRow[];
    return rows.map(toEntry);
  }

  /** How many entries of a kind about one agent the record has since a time: for "told once a day". */
  count(kind: ActivityKind, fields: { agentId?: string; otherId?: string; subjectId?: string; since: string }): number {
    return (
      this.db
        .query(
          `SELECT COUNT(*) AS n FROM activity WHERE kind = $kind AND at > $since
             AND ($agentId IS NULL OR agent_id = $agentId) AND ($otherId IS NULL OR other_id = $otherId)
             AND ($subjectId IS NULL OR subject_id = $subjectId)`,
        )
        .get({ kind, since: fields.since, agentId: fields.agentId ?? null, otherId: fields.otherId ?? null, subjectId: fields.subjectId ?? null }) as { n: number }
    ).n;
  }

  /** Deletes entries older than the history window. Returns how many. */
  prune(): number {
    const cutoff = new Date(this.now().getTime() - LIMITS.historyDays * DAY_MS).toISOString();
    return this.db.query("DELETE FROM activity WHERE at < $cutoff").run({ cutoff }).changes;
  }
}
