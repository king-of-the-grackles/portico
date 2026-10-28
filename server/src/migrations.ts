import type { Database } from "bun:sqlite";

/** One step from a schema version to the next. It runs inside a transaction; db.ts sets the version. */
export type Migration = (db: Database) => void;

const newId = "lower(hex(randomblob(16)))";

/**
 * Moves everything of one session agent onto another, then deletes it: its runs, messages, threads (merged into the
 * keeper's thread with the same agent, so each pair keeps one thread), Always allow entries and join line links.
 */
function mergeAgent(db: Database, fromId: string, toId: string): void {
  db.query("UPDATE agent_runs SET agent_id = $toId WHERE agent_id = $fromId").run({ fromId, toId });
  const threads = db
    .query("SELECT id, a_id, b_id, started_by, created_at, last_message_at FROM threads WHERE a_id = $fromId OR b_id = $fromId")
    .all({ fromId }) as { id: string; a_id: string; b_id: string; started_by: string; created_at: string; last_message_at: string }[];
  for (const thread of threads) {
    const other = thread.a_id === fromId ? thread.b_id : thread.a_id;
    const [a, b] = toId < other ? [toId, other] : [other, toId];
    const startedBy = thread.started_by === fromId ? toId : thread.started_by;
    const existing = db.query("SELECT id, created_at, last_message_at FROM threads WHERE a_id = $a AND b_id = $b").get({ a, b }) as {
      id: string;
      created_at: string;
      last_message_at: string;
    } | null;
    if (!existing) {
      db.query("UPDATE threads SET a_id = $a, b_id = $b, started_by = $startedBy WHERE id = $id").run({ id: thread.id, a, b, startedBy });
      continue;
    }
    db.query("UPDATE messages SET thread_id = $to WHERE thread_id = $from").run({ from: thread.id, to: existing.id });
    db.query(
      `UPDATE threads SET last_message_at = MAX(last_message_at, $last),
         started_by = CASE WHEN $created < created_at THEN $startedBy ELSE started_by END,
         created_at = MIN(created_at, $created)
       WHERE id = $id`,
    ).run({ id: existing.id, last: thread.last_message_at, created: thread.created_at, startedBy });
    db.query("DELETE FROM threads WHERE id = $id").run({ id: thread.id });
  }
  db.query("UPDATE messages SET from_id = $toId WHERE from_id = $fromId").run({ fromId, toId });
  db.query("UPDATE messages SET to_id = $toId WHERE to_id = $fromId").run({ fromId, toId });
  db.query(
    `INSERT OR IGNORE INTO always_allow (agent_id, sender_id, added_by, created_at)
     SELECT $toId, sender_id, added_by, created_at FROM always_allow WHERE agent_id = $fromId AND sender_id != $toId`,
  ).run({ fromId, toId });
  db.query(
    `INSERT OR IGNORE INTO always_allow (agent_id, sender_id, added_by, created_at)
     SELECT agent_id, $toId, added_by, created_at FROM always_allow WHERE sender_id = $fromId AND agent_id != $toId`,
  ).run({ fromId, toId });
  db.query("DELETE FROM always_allow WHERE agent_id = $fromId OR sender_id = $fromId").run({ fromId });
  db.query("UPDATE join_lines SET agent_id = $toId WHERE agent_id = $fromId").run({ fromId, toId });
  db.query("UPDATE sign_in_requests SET agent_id = $toId WHERE agent_id = $fromId").run({ fromId, toId });
  // Approval stays on if either had it: merging never drops a protection.
  db.query(
    `UPDATE agents SET
       last_seen_at = (SELECT MAX(COALESCE(last_seen_at, created_at)) FROM agents WHERE id IN ($fromId, $toId)),
       created_at = (SELECT MIN(created_at) FROM agents WHERE id IN ($fromId, $toId)),
       approval_required = (SELECT MAX(approval_required) FROM agents WHERE id IN ($fromId, $toId))
     WHERE id = $toId`,
  ).run({ fromId, toId });
  db.query("DELETE FROM agents WHERE id = $fromId").run({ fromId });
}

/**
 * 101: one agent per folder and coding agent. Each process start is a run in agent_runs, so a restart reuses the
 * folder's agent instead of making a `-2`. Sessions that already split one folder merge into the shortest-named one;
 * one with a thread to that agent keeps its history but leaves the folder.
 */
const folderAgents: Migration = (db) => {
  db.run(`CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    computer_id TEXT NOT NULL REFERENCES computers (id) ON DELETE CASCADE,
    session_key TEXT NOT NULL,
    client TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE (computer_id, session_key)
  )`);
  db.run("CREATE INDEX agent_runs_agent ON agent_runs (agent_id, started_at)");
  db.run(
    `INSERT INTO agent_runs (id, agent_id, computer_id, session_key, client, started_at, last_seen_at, ended_at)
     SELECT ${newId}, id, computer_id, session_key, kind, created_at, COALESCE(last_seen_at, created_at),
       COALESCE(last_seen_at, created_at)
     FROM agents WHERE type = 'session' AND computer_id IS NOT NULL AND session_key IS NOT NULL`,
  );

  const groups = db
    .query(
      `SELECT computer_id, folder_id, kind FROM agents WHERE type = 'session' AND folder_id IS NOT NULL
       GROUP BY computer_id, folder_id, kind HAVING COUNT(*) > 1`,
    )
    .all() as { computer_id: string; folder_id: string; kind: string }[];
  for (const group of groups) {
    const [keeper, ...rest] = db
      .query(
        `SELECT id FROM agents WHERE type = 'session' AND computer_id = $computer_id AND folder_id = $folder_id AND kind = $kind
         ORDER BY LENGTH(name), COALESCE(last_seen_at, created_at) DESC, id`,
      )
      .all(group) as { id: string }[];
    for (const { id } of rest) {
      const [a, b] = id < keeper!.id ? [id, keeper!.id] : [keeper!.id, id];
      const talked = db.query("SELECT 1 FROM threads WHERE a_id = $a AND b_id = $b").get({ a, b });
      if (talked) db.query("UPDATE agents SET folder_id = NULL WHERE id = $id").run({ id });
      else mergeAgent(db, id, keeper!.id);
    }
  }

  db.run("DROP INDEX agents_session_key");
  db.run("UPDATE agents SET session_key = NULL");
  db.run(
    `CREATE UNIQUE INDEX agents_session_folder ON agents (computer_id, folder_id, kind)
     WHERE type = 'session' AND folder_id IS NOT NULL`,
  );
};

/** Every change since the first schema (version 100), oldest first: the first is version 101. Never edit a shipped one. */
export const MIGRATIONS: readonly Migration[] = [folderAgents];
