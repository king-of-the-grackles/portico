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

/**
 * 102: tasks and the activity record. A message's root_id is the first message of its conversation (its reply_to
 * chain), so a task is every message with one root. A reply can carry a one-line summary. The activity table records
 * joins, decisions and settings changes; sessions come from agent_runs.
 */
const tasksAndActivity: Migration = (db) => {
  db.run("ALTER TABLE messages ADD COLUMN summary TEXT");
  db.run("ALTER TABLE messages ADD COLUMN root_id TEXT");
  // Oldest first, so each reply's original already has its root. An original pruned away makes the reply a root.
  const rows = db.query("SELECT id, reply_to FROM messages ORDER BY created_at, rowid").all() as { id: string; reply_to: string | null }[];
  const roots = new Map<string, string>();
  const set = db.query("UPDATE messages SET root_id = $root WHERE id = $id");
  for (const row of rows) {
    const root = (row.reply_to && roots.get(row.reply_to)) || row.id;
    roots.set(row.id, root);
    set.run({ id: row.id, root });
  }
  db.run("CREATE INDEX messages_root ON messages (root_id, created_at)");
  db.run(`CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    agent_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
    other_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
    person_id TEXT REFERENCES people (id) ON DELETE SET NULL,
    detail TEXT NOT NULL
  )`);
  db.run("CREATE INDEX activity_at ON activity (at)");
  db.run("CREATE INDEX activity_agent ON activity (agent_id, at)");
};

/**
 * 103: tasks for agents. A reply can say more is coming (final = 0), so the task stays in progress. A sender can give a
 * message a key: sending again with the same key returns the first message. An agent can set its own doing line.
 */
const agentTasks: Migration = (db) => {
  db.run("ALTER TABLE messages ADD COLUMN final INTEGER NOT NULL DEFAULT 1");
  db.run("ALTER TABLE messages ADD COLUMN send_key TEXT");
  db.run("CREATE UNIQUE INDEX messages_send_key ON messages (from_id, send_key) WHERE send_key IS NOT NULL");
  // Senders now hear when a message expires unread. Ones that expired before this are old news.
  db.run("UPDATE messages SET sender_notified_at = expires_at WHERE held_at IS NULL AND status = 'expired' AND sender_notified_at IS NULL");
  db.run("ALTER TABLE agents ADD COLUMN doing TEXT");
  db.run("ALTER TABLE agents ADD COLUMN doing_at TEXT");
};

/**
 * 104: waking app agents. A wake URL is an app's webhook trigger (a Grok Bot routine's, say) that the agent's manager
 * gives Portico; an event subscription is an MCP client's (ChatGPT's) callback for the message.received event. Both
 * keep the secret Portico sends or signs with, so neither can be hashed.
 */
const wakes: Migration = (db) => {
  db.run(`CREATE TABLE wake_urls (
    agent_id TEXT PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    key TEXT NOT NULL,
    set_by TEXT REFERENCES people (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    last_at TEXT,
    last_status TEXT
  )`);
  db.run(`CREATE TABLE event_subscriptions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    arguments TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    previous_secret TEXT,
    previous_until TEXT,
    refresh_before TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_at TEXT,
    last_status TEXT
  )`);
  db.run("CREATE INDEX event_subscriptions_agent ON event_subscriptions (agent_id)");
};

/** Every change since the first schema (version 100), oldest first: the first is version 101. Never edit a shipped one. */
export const MIGRATIONS: readonly Migration[] = [folderAgents, tasksAndActivity, agentTasks, wakes];
