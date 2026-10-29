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
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** One entry. `detail` holds names and choices, never message text or anything secret. */
export interface ActivityEntry {
  id: string;
  at: string;
  kind: ActivityKind;
  /** The agent it's about; null once the agent is removed. */
  agentId: string | null;
  /** The other agent: the sender of a decided message, or the sender taken off an allow list. */
  otherId: string | null;
  /** The person who did it, when a person did. */
  personId: string | null;
  detail: Record<string, string | boolean | null>;
}

interface ActivityRow {
  id: string;
  at: string;
  kind: string;
  agent_id: string | null;
  other_id: string | null;
  person_id: string | null;
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
    id: row.id,
    at: row.at,
    kind: row.kind as ActivityKind,
    agentId: row.agent_id,
    otherId: row.other_id,
    personId: row.person_id,
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
    fields: { agentId?: string | null; otherId?: string | null; personId?: string | null; detail?: ActivityEntry["detail"] } = {},
  ): void {
    this.db
      .query(
        `INSERT INTO activity (id, at, kind, agent_id, other_id, person_id, detail)
         VALUES ($id, $at, $kind, $agentId, $otherId, $personId, $detail)`,
      )
      .run({
        id: this.newId(),
        at: this.now().toISOString(),
        kind,
        agentId: fields.agentId ?? null,
        otherId: fields.otherId ?? null,
        personId: fields.personId ?? null,
        detail: JSON.stringify(fields.detail ?? {}),
      });
    this.changes.emit("activity");
  }

  /**
   * Newest first. With `agentIds`, only entries about those agents (as the agent or the other one), plus entries about
   * no agent at all when `withUnattached` is set (a computer joining).
   */
  list(filter: { agentIds?: string[]; withUnattached?: boolean; before?: string; limit?: number } = {}): ActivityEntry[] {
    const clauses: string[] = [];
    const bindings: Record<string, string | number> = { limit: Math.min(Math.max(filter.limit ?? 100, 1), 500) };
    if (filter.agentIds) {
      const names = filter.agentIds.map((id, i) => {
        bindings[`a${i}`] = id;
        return `$a${i}`;
      });
      const about = names.length > 0 ? `agent_id IN (${names.join(", ")}) OR other_id IN (${names.join(", ")})` : "0";
      clauses.push(filter.withUnattached ? `(${about} OR (agent_id IS NULL AND other_id IS NULL))` : `(${about})`);
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

  /** Deletes entries older than the history window. Returns how many. */
  prune(): number {
    const cutoff = new Date(this.now().getTime() - LIMITS.historyDays * DAY_MS).toISOString();
    return this.db.query("DELETE FROM activity WHERE at < $cutoff").run({ cutoff }).changes;
  }
}
