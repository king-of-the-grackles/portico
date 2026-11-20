import type { Database } from "bun:sqlite";
import { DAY_MS, LIMITS } from "./limits";

/** Something Portico itself tells an agent: who came into or left a Portico the agent is in. */
export interface AgentNotice {
  id: string;
  agentId: string;
  at: string;
  /** Portico's own sentence. Names other people typed are quoted in it. */
  text: string;
}

interface Row {
  id: string;
  agent_id: string;
  at: string;
  text: string;
}

const toNotice = (row: Row): AgentNotice => ({ id: row.id, agentId: row.agent_id, at: row.at, text: row.text });

/**
 * Portico's own notices to agents. A notice is a row in the directory, never a message: it has no sender, lives in no
 * conversation, and reaches the agent the way the outcome of a sent message does, beside the messages in its next
 * check_inbox or its session's next delivery.
 */
export class AgentNotices {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  add(agentId: string, text: string): void {
    this.db
      .query("INSERT INTO agent_notices (id, agent_id, at, text) VALUES ($id, $agentId, $at, $text)")
      .run({ id: this.newId(), agentId, at: this.now().toISOString(), text });
  }

  /** What the agent hasn't been told yet, oldest first. Changes nothing. */
  waiting(agentId: string, limit = 100): AgentNotice[] {
    const rows = this.db
      .query("SELECT id, agent_id, at, text FROM agent_notices WHERE agent_id = $agentId AND delivered_at IS NULL ORDER BY at, rowid LIMIT $limit")
      .all({ agentId, limit }) as Row[];
    return rows.map(toNotice);
  }

  count(agentId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM agent_notices WHERE agent_id = $agentId AND delivered_at IS NULL").get({ agentId }) as { n: number }).n;
  }

  /** Marks the agent's own notices told. Returns how many were waiting. */
  ack(agentId: string, ids: string[]): number {
    const at = this.now().toISOString();
    const mark = this.db.query("UPDATE agent_notices SET delivered_at = $at WHERE id = $id AND agent_id = $agentId AND delivered_at IS NULL");
    let marked = 0;
    for (const id of new Set(ids)) marked += mark.run({ id, agentId, at }).changes;
    return marked;
  }

  /** What waits for the agent, marked told: for an agent that picks everything up in one call. */
  take(agentId: string): AgentNotice[] {
    const waiting = this.waiting(agentId);
    this.ack(
      agentId,
      waiting.map((notice) => notice.id),
    );
    return waiting;
  }

  /** Daily: notices older than the history window, told or not. */
  prune(): number {
    const cutoff = new Date(this.now().getTime() - LIMITS.historyDays * DAY_MS).toISOString();
    return this.db.query("DELETE FROM agent_notices WHERE at < $cutoff").run({ cutoff }).changes;
  }
}
