import type { Database } from "bun:sqlite";

/** One step from a schema version to the next. It runs inside a transaction; db.ts sets the version. */
export type Migration = ((db: Database) => void) & {
  /**
   * The migration rebuilds a table other tables refer to. It runs with foreign keys off, so dropping the old table
   * deletes nothing by cascade; db.ts still checks every foreign key before the migration commits.
   */
  rebuilds?: true;
};

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

/**
 * 105: names let go. A removed or renamed agent's bare name and a removed computer's name stay with the person who had
 * them for the history window, so a name that reached one person's agent can't start reaching another person's. Each
 * person's release of a name is its own row, so one person letting a name go never clears another's hold on it.
 */
const releasedNames: Migration = (db) => {
  db.run(`CREATE TABLE released_names (
    scope TEXT NOT NULL CHECK (scope IN ('agent', 'computer')),
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    released_at TEXT NOT NULL,
    PRIMARY KEY (scope, name, owner_id)
  )`);
};

/**
 * 106: files on messages. A file is uploaded first and then attached; `message_files` says which messages carry it, so
 * one file can be passed along a chain without being uploaded again. A file no message carries is swept. The size is
 * the one the agent stated when the upload started, which is what the storage cap counts.
 */
const messageFiles: Migration = (db) => {
  db.run(`CREATE TABLE files (
    id TEXT PRIMARY KEY,
    uploader_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('uploading', 'ready')),
    checksum TEXT,
    created_at TEXT NOT NULL,
    upload_expires_at TEXT
  )`);
  db.run(`CREATE TABLE message_files (
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (message_id, file_id)
  )`);
  db.run("CREATE INDEX message_files_file ON message_files (file_id)");
};

/**
 * 107: a person's account with an outside sign-in service. Hosted Portico signs people in on the base domain, and each
 * workspace finds its own person by that account. Null for everyone who signs in with a password.
 */
const outsideAccounts: Migration = (db) => {
  db.run("ALTER TABLE people ADD COLUMN external_id TEXT");
  db.run("CREATE UNIQUE INDEX people_external_id ON people (external_id) WHERE external_id IS NOT NULL");
};

/**
 * 108: workspaces, handles and email. A workspace is a list of people and agents: each person's personal one holds only
 * that person's agents, and a shared one bridges to other people's. Two agents reach each other only while both are in
 * one workspace (core/workspaces.ts). A thread records the workspace it runs through. A person's handle is the prefix
 * other people's agents address that person's agents by; `handle_key` is the handle with look-alike characters folded,
 * so two handles that read the same can't both exist, and a handle let go stays held back. An app's or connector's name
 * is now unique among its owner's agents; where Portico has no workspaces, the code keeps names unique across everyone.
 */
const workspaces: Migration = (db) => {
  db.run("ALTER TABLE people ADD COLUMN handle TEXT");
  db.run("ALTER TABLE people ADD COLUMN handle_key TEXT");
  db.run("ALTER TABLE people ADD COLUMN email TEXT");
  db.run("CREATE UNIQUE INDEX people_handle ON people (handle) WHERE handle IS NOT NULL");
  db.run("CREATE UNIQUE INDEX people_handle_key ON people (handle_key) WHERE handle_key IS NOT NULL");
  db.run(`CREATE TABLE released_handles (
    handle_key TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    person_id TEXT NOT NULL,
    released_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
    owner_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  )`);
  db.run("CREATE UNIQUE INDEX workspaces_personal ON workspaces (owner_id) WHERE kind = 'personal'");
  db.run(`CREATE TABLE workspace_people (
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, person_id)
  )`);
  db.run("CREATE INDEX workspace_people_person ON workspace_people (person_id)");
  db.run(`CREATE TABLE workspace_agents (
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, agent_id)
  )`);
  db.run("CREATE INDEX workspace_agents_agent ON workspace_agents (agent_id)");
  db.run("ALTER TABLE threads ADD COLUMN workspace_id TEXT REFERENCES workspaces (id) ON DELETE SET NULL");
  db.run("DROP INDEX agents_app_name");
  db.run("CREATE UNIQUE INDEX agents_app_name ON agents (owner_id, name) WHERE computer_id IS NULL");
};

/** Replaces a table with one of a new shape, keeping every row and index. Only inside a `rebuilds` migration. */
function rebuild(db: Database, table: string, columns: string[], create: string, dropIndexes: string[] = []): void {
  const indexes = (
    db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = $table AND sql IS NOT NULL").all({ table }) as {
      name: string;
      sql: string;
    }[]
  ).filter((index) => !dropIndexes.includes(index.name));
  db.run(`CREATE TABLE ${table}_new (${create})`);
  db.run(`INSERT INTO ${table}_new (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM ${table}`);
  db.run(`DROP TABLE ${table}`);
  db.run(`ALTER TABLE ${table}_new RENAME TO ${table}`);
  for (const index of indexes) db.run(index.sql);
}

/**
 * 109: many accounts in one database. A person's name is what other people read, so two people can share one; the
 * handle is what tells people apart. A computer's name is unique among its owner's computers. Where Portico has no
 * workspaces, the code keeps both unique across everyone, as before.
 */
const manyAccounts: Migration = (db) => {
  rebuild(
    db,
    "people",
    ["id", "name", "role", "status", "password_hash", "invite_id", "created_at", "approved_at", "external_id", "handle", "handle_key", "email"],
    `id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'pending')),
    password_hash TEXT NOT NULL,
    invite_id TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    external_id TEXT,
    handle TEXT,
    handle_key TEXT,
    email TEXT`,
  );
  db.run("CREATE INDEX people_name ON people (name)");
  rebuild(
    db,
    "computers",
    ["id", "owner_id", "name", "token_hash", "created_at", "last_seen_at"],
    `id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT`,
  );
  db.run("CREATE UNIQUE INDEX computers_owner_name ON computers (owner_id, name)");
  db.run("CREATE INDEX computers_name ON computers (name)");
};
manyAccounts.rebuilds = true;

/**
 * 110: sharing a workspace. A share is a link for one person: whoever first confirms with it claims it, and a share
 * sent by email can be claimed only by that address. A share request is an agent asking to come in with a link: the
 * agent shows its 4-digit code and a person confirms in the browser, so the link alone lets no agent in. A workspace
 * ask is an agent asking, for its owner, to let someone in or take someone out; the owner confirms. `share_mails`
 * records each email sent for a share, and `mail_blocks` the addresses that bounced, complained or opted out.
 */
const sharing: Migration = (db) => {
  db.run(`CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL UNIQUE,
    secret_box TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    claimed_by TEXT REFERENCES people (id) ON DELETE SET NULL,
    claimed_at TEXT,
    revoked_at TEXT
  )`);
  db.run("CREATE INDEX shares_workspace ON shares (workspace_id)");
  db.run(`CREATE TABLE share_requests (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents (id) ON DELETE CASCADE,
    name TEXT,
    kind TEXT,
    code TEXT NOT NULL,
    poll_hash TEXT UNIQUE,
    tries INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    issued_at TEXT
  )`);
  db.run("CREATE INDEX share_requests_share ON share_requests (share_id)");
  db.run("CREATE INDEX share_requests_agent ON share_requests (agent_id)");
  db.run(`CREATE TABLE workspace_asks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('share', 'remove_person')),
    detail TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    result TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT
  )`);
  db.run("CREATE INDEX workspace_asks_person ON workspace_asks (person_id, status)");
  db.run(`CREATE TABLE share_mails (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    sent_by TEXT NOT NULL,
    email TEXT NOT NULL,
    number INTEGER NOT NULL,
    status TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    UNIQUE (share_id, number)
  )`);
  db.run("CREATE INDEX share_mails_by ON share_mails (sent_by, sent_at)");
  db.run("CREATE INDEX share_mails_workspace ON share_mails (workspace_id, sent_at)");
  db.run(`CREATE TABLE mail_blocks (
    email TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    at TEXT NOT NULL
  )`);
};

/** Every change since the first schema (version 100), oldest first: the first is version 101. Never edit a shipped one. */
export const MIGRATIONS: readonly Migration[] = [folderAgents, tasksAndActivity, agentTasks, wakes, releasedNames, messageFiles, outsideAccounts, workspaces, manyAccounts, sharing];
