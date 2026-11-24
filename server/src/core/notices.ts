import type { Database } from "bun:sqlite";
import { DAY_MS, LIMITS } from "./limits";

/** Something Portico itself tells an agent: who came into or left a Portico the agent is in. */
export interface AgentNotice {
  id: string;
  agentId: string;
  at: string;
  /** Portico's own sentence. Names other people typed are quoted in it. */
  text: string;
  /**
   * The agent is waiting on this notice (how its question ended): a stopped session starts a turn for it, and it is
   * never left out of a batch by older notices. False for every other notice.
   */
  wake: boolean;
}

interface Row {
  id: string;
  agent_id: string;
  at: string;
  text: string;
  rowid: number;
}

const toNotice = (row: Row, wake: boolean): AgentNotice => ({ id: row.id, agentId: row.agent_id, at: row.at, text: row.text, wake });

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

  /** Saves a notice for the agent's next check. Returns the notice's ID. */
  add(agentId: string, text: string): string {
    const id = this.newId();
    this.db.query("INSERT INTO agent_notices (id, agent_id, at, text) VALUES ($id, $agentId, $at, $text)").run({ id, agentId, at: this.now().toISOString(), text });
    return id;
  }

  /**
   * Which of an agent's notices the agent is waiting on, by notice ID: the one place that decides what wakes. A
   * notice's own row says nothing about its kind, so this is worked out from what each notice is linked to. Set by
   * portico.ts: today, the notices that say how the agent's questions ended. A later feature whose notice an agent
   * waits on (a cancelled task) adds its notices' IDs there, and gets the mark and the place in every batch with it.
   */
  waking: (agentId: string) => string[] = () => [];

  /**
   * What the agent hasn't been told yet, oldest first, at most `limit`. Changes nothing. The notices the agent is
   * waiting on are taken into the batch first and the others fill the room that is left, oldest first: however many
   * notices about who came or went sit unread in front of an answer, the answer is in the next batch. The batch
   * itself is in time order.
   */
  waiting(agentId: string, limit = 100): AgentNotice[] {
    const columns = "id, agent_id, at, text, rowid";
    const ids = JSON.stringify(this.waking(agentId));
    const first = this.db
      .query(
        `SELECT ${columns} FROM agent_notices WHERE agent_id = $agentId AND delivered_at IS NULL
           AND id IN (SELECT value FROM json_each($ids)) ORDER BY at, rowid LIMIT $limit`,
      )
      .all({ agentId, ids, limit }) as Row[];
    const rest =
      first.length >= limit
        ? []
        : (this.db
            .query(
              `SELECT ${columns} FROM agent_notices WHERE agent_id = $agentId AND delivered_at IS NULL
                 AND id NOT IN (SELECT value FROM json_each($ids)) ORDER BY at, rowid LIMIT $limit`,
            )
            .all({ agentId, ids, limit: limit - first.length }) as Row[]);
    const waking = new Set(first.map((row) => row.id));
    return [...first, ...rest].sort((a, b) => a.at.localeCompare(b.at) || a.rowid - b.rowid).map((row) => toNotice(row, waking.has(row.id)));
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
