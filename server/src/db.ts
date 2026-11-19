import { Database } from "bun:sqlite";
import { CONTENT_MIGRATIONS, DIRECTORY_MIGRATIONS, type Migration } from "./migrations";

/**
 * The directory, `<data folder>/portico.db`: who is on Portico and who reaches whom. People, sign-ins, computers,
 * agents and their credentials, workspaces and who is in each, shares, Always allow, activity, wake and event settings,
 * and uploads waiting to be attached. No message subject or text: those live in each workspace's own content database.
 * Each module owns the queries for its own tables; this file only creates them.
 */
const DIRECTORY_SCHEMA = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

  // A name is what other people read, so two people can share one; the handle tells people apart. `handle_key` is the
  // handle with look-alike characters folded. `external_id` is the person's account with an outside sign-in service.
  `CREATE TABLE people (
    id TEXT PRIMARY KEY,
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
    email TEXT
  )`,
  `CREATE UNIQUE INDEX people_one_owner ON people (role) WHERE role = 'owner'`,
  `CREATE UNIQUE INDEX people_external_id ON people (external_id) WHERE external_id IS NOT NULL`,
  `CREATE UNIQUE INDEX people_handle ON people (handle) WHERE handle IS NOT NULL`,
  `CREATE UNIQUE INDEX people_handle_key ON people (handle_key) WHERE handle_key IS NOT NULL`,
  `CREATE INDEX people_name ON people (name)`,

  // A handle let go stays held back for the person who had it.
  `CREATE TABLE released_handles (
    handle_key TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    person_id TEXT NOT NULL,
    released_at TEXT NOT NULL
  )`,

  `CREATE TABLE web_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
  )`,
  `CREATE INDEX web_sessions_person ON web_sessions (person_id)`,

  `CREATE TABLE setup_links (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,

  `CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  )`,

  `CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    secret_box TEXT,
    created_by TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    claimed_at TEXT,
    revoked_at TEXT
  )`,

  `CREATE TABLE computers (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  )`,
  `CREATE UNIQUE INDEX computers_owner_name ON computers (owner_id, name)`,
  `CREATE INDEX computers_name ON computers (name)`,

  `CREATE TABLE folders (
    computer_id TEXT NOT NULL REFERENCES computers (id) ON DELETE CASCADE,
    folder_id TEXT NOT NULL,
    name TEXT NOT NULL,
    joins INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (computer_id, folder_id)
  )`,

  // One agent per folder and coding agent: each process start is a run in agent_runs. An app's or connector's name is
  // unique among its owner's agents.
  `CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('session', 'app', 'connector')),
    description TEXT NOT NULL,
    computer_id TEXT REFERENCES computers (id) ON DELETE CASCADE,
    folder TEXT,
    folder_id TEXT,
    approval_required INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    doing TEXT,
    doing_at TEXT
  )`,
  `CREATE UNIQUE INDEX agents_app_name ON agents (owner_id, name) WHERE computer_id IS NULL`,
  `CREATE UNIQUE INDEX agents_session_name ON agents (computer_id, name) WHERE computer_id IS NOT NULL`,
  `CREATE UNIQUE INDEX agents_session_folder ON agents (computer_id, folder_id, kind)
     WHERE type = 'session' AND folder_id IS NOT NULL`,
  `CREATE INDEX agents_name ON agents (name)`,
  `CREATE INDEX agents_owner ON agents (owner_id)`,

  `CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    computer_id TEXT NOT NULL REFERENCES computers (id) ON DELETE CASCADE,
    session_key TEXT NOT NULL,
    client TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE (computer_id, session_key)
  )`,
  `CREATE INDEX agent_runs_agent ON agent_runs (agent_id, started_at)`,

  `CREATE TABLE agent_tokens (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('api', 'access', 'refresh')),
    token_hash TEXT NOT NULL UNIQUE,
    client_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT
  )`,
  `CREATE INDEX agent_tokens_agent ON agent_tokens (agent_id)`,

  `CREATE TABLE join_lines (
    id TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    computer_id TEXT REFERENCES computers (id) ON DELETE SET NULL,
    agent_id TEXT REFERENCES agents (id) ON DELETE SET NULL
  )`,

  `CREATE TABLE sign_in_requests (
    id TEXT PRIMARY KEY,
    join_line_id TEXT NOT NULL REFERENCES join_lines (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    poll_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    agent_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    issued_at TEXT
  )`,

  `CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE oauth_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,

  `CREATE TABLE always_allow (
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, sender_id)
  )`,

  // Joins, decisions and settings changes. Never a message's subject or text.
  `CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    agent_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
    other_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
    person_id TEXT REFERENCES people (id) ON DELETE SET NULL,
    detail TEXT NOT NULL
  )`,
  `CREATE INDEX activity_at ON activity (at)`,
  `CREATE INDEX activity_agent ON activity (agent_id, at)`,

  // Both keep the secret Portico sends or signs with, so neither can be hashed.
  `CREATE TABLE wake_urls (
    agent_id TEXT PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    key TEXT NOT NULL,
    set_by TEXT REFERENCES people (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    last_at TEXT,
    last_status TEXT
  )`,
  `CREATE TABLE event_subscriptions (
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
  )`,
  `CREATE INDEX event_subscriptions_agent ON event_subscriptions (agent_id)`,

  // A workspace is a list of people and agents; its messages live in its own content database. `location` says where
  // that database is kept (only `local` for now). A deleted workspace is archived: nobody reaches through it, and its
  // row goes once its content has been pruned away. The owner is plain text, so an archived workspace outlives a
  // removed owner until then.
  `CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT 'local',
    archived_at TEXT
  )`,
  `CREATE UNIQUE INDEX workspaces_personal ON workspaces (owner_id) WHERE kind = 'personal' AND archived_at IS NULL`,
  `CREATE INDEX workspaces_owner ON workspaces (owner_id)`,
  `CREATE TABLE workspace_people (
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, person_id)
  )`,
  `CREATE INDEX workspace_people_person ON workspace_people (person_id)`,
  // A row with `left_at` records past membership: the agent reaches nobody through the workspace any more, and the
  // conversations the agent had there stay readable.
  `CREATE TABLE workspace_agents (
    workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    left_at TEXT,
    PRIMARY KEY (workspace_id, agent_id)
  )`,
  `CREATE INDEX workspace_agents_agent ON workspace_agents (agent_id)`,

  `CREATE TABLE shares (
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
  )`,
  `CREATE INDEX shares_workspace ON shares (workspace_id)`,
  `CREATE TABLE share_requests (
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
  )`,
  `CREATE INDEX share_requests_share ON share_requests (share_id)`,
  `CREATE INDEX share_requests_agent ON share_requests (agent_id)`,
  `CREATE TABLE workspace_asks (
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
  )`,
  `CREATE INDEX workspace_asks_person ON workspace_asks (person_id, status)`,
  `CREATE TABLE share_mails (
    id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    sent_by TEXT NOT NULL,
    email TEXT NOT NULL,
    number INTEGER NOT NULL,
    status TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    UNIQUE (share_id, number)
  )`,
  `CREATE INDEX share_mails_by ON share_mails (sent_by, sent_at)`,
  `CREATE INDEX share_mails_workspace ON share_mails (workspace_id, sent_at)`,
  `CREATE TABLE mail_blocks (
    email TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    at TEXT NOT NULL
  )`,

  // A file an agent has started but no message carries yet. A send copies the file into the workspace the message
  // goes through; the upload itself is swept by age. The bytes are at the key `uploads/<id>`.
  `CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    uploader_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('uploading', 'ready')),
    checksum TEXT,
    created_at TEXT NOT NULL,
    upload_expires_at TEXT,
    attached_at TEXT
  )`,
  `CREATE INDEX uploads_uploader ON uploads (uploader_id)`,
];

/**
 * One workspace's content, `<data folder>/porticos/<workspace ID>/content.db`: the threads between pairs of agents,
 * their messages, and the files those messages carry. Nothing here refers to the directory: agent IDs are plain text,
 * and the workspace is the database itself.
 */
const CONTENT_SCHEMA = [
  // One thread per pair of agents in a workspace. `a_id` sorts before `b_id`.
  `CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    a_id TEXT NOT NULL,
    b_id TEXT NOT NULL,
    started_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_message_at TEXT NOT NULL,
    UNIQUE (a_id, b_id),
    CHECK (a_id < b_id)
  )`,
  `CREATE INDEX threads_b ON threads (b_id)`,
  `CREATE INDEX threads_last ON threads (last_message_at)`,

  // `root_id` is the first message of the conversation (the reply_to chain): a task is every message with one root.
  // `final` is 0 for a reply that says more is coming. `send_key` is the sender's own key for the message.
  `CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to TEXT,
    root_id TEXT NOT NULL,
    summary TEXT,
    final INTEGER NOT NULL DEFAULT 1,
    send_key TEXT,
    status TEXT NOT NULL CHECK (status IN ('held', 'pending', 'delivered', 'declined', 'expired')),
    held_at TEXT,
    decision TEXT,
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    delivered_at TEXT,
    sender_notified_at TEXT
  )`,
  `CREATE INDEX messages_to_status ON messages (to_id, status, expires_at)`,
  `CREATE INDEX messages_from_created ON messages (from_id, created_at)`,
  `CREATE INDEX messages_thread_created ON messages (thread_id, created_at)`,
  `CREATE INDEX messages_status_expires ON messages (status, expires_at)`,
  `CREATE INDEX messages_root ON messages (root_id, created_at)`,
  `CREATE UNIQUE INDEX messages_send_key ON messages (from_id, send_key) WHERE send_key IS NOT NULL`,

  // A file a message in this workspace carries. While `source` is set, the bytes are still at that key (an upload, or
  // the file's copy in another workspace) and a copy into this workspace is on the way; afterwards the bytes are at
  // `porticos/<workspace ID>/files/<id>`.
  `CREATE TABLE files (
    id TEXT PRIMARY KEY,
    uploader_id TEXT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    checksum TEXT,
    created_at TEXT NOT NULL,
    source TEXT
  )`,
  `CREATE TABLE message_files (
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (message_id, file_id)
  )`,
  `CREATE INDEX message_files_file ON message_files (file_id)`,
];

/** One kind of database: the schema a new one gets, and the migrations that follow that schema. */
export interface DbKind {
  name: "directory" | "content";
  /** `PRAGMA application_id`: marks the two kinds apart, so one is never opened as the other. */
  applicationId: number;
  /** The baseline schema's version. Each migration adds one. */
  baseVersion: number;
  schema: readonly string[];
  migrations: readonly Migration[];
}

/**
 * The directory. Its baseline is version 200: every database an earlier Portico made (versions up to 110, with no
 * application ID) is refused, since nothing converts one.
 */
export const DIRECTORY: DbKind = {
  name: "directory",
  applicationId: 0x50644972, // "PdIr"
  baseVersion: 200,
  schema: DIRECTORY_SCHEMA,
  migrations: DIRECTORY_MIGRATIONS,
};

/** A workspace's content. Each content database carries its own version, so a feature can arrive as one migration. */
export const CONTENT: DbKind = {
  name: "content",
  applicationId: 0x5063436f, // "PcCo"
  baseVersion: 1,
  schema: CONTENT_SCHEMA,
  migrations: CONTENT_MIGRATIONS,
};

/** The directory's current schema version: the baseline plus every migration. */
export const SCHEMA_VERSION = DIRECTORY.baseVersion + DIRECTORY.migrations.length;
/** A content database's current schema version. */
export const CONTENT_VERSION = CONTENT.baseVersion + CONTENT.migrations.length;

/** What every refusal of an earlier Portico's data says. */
export const FRESH_FOLDER =
  "The data folder was made by an earlier Portico that this version can't open. Start with a fresh data folder: set " +
  "PORTICO_DATA_DIR to an empty folder. The old folder stays as it was.";

/**
 * The database isn't one this Portico can use: made by an earlier Portico (`older`), written by a newer one (`newer`),
 * or of the other kind (`wrong_kind`: a workspace's content where the directory belongs, or the reverse).
 */
export class SchemaMismatchError extends Error {
  constructor(
    readonly found: number,
    readonly reason: "older" | "newer" | "wrong_kind",
    readonly kind: DbKind["name"] = "directory",
  ) {
    super(
      reason === "older"
        ? FRESH_FOLDER
        : reason === "newer"
          ? `The ${kind} database (schema version ${found}) was written by a newer Portico than this one.`
          : `The file isn't a Portico ${kind} database: a database of another kind is in its place.`,
    );
    this.name = "SchemaMismatchError";
  }

  /** Written by a newer Portico, e.g. before a rollback. */
  get newer(): boolean {
    return this.reason === "newer";
  }
}

const pragma = (db: Database, name: string) => Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, number>)[0]!;

/** Where the copy made before upgrading a database file goes: beside it, named for the old version and the time. */
export function backupPath(path: string, version: number, at: Date): string {
  return `${path}.v${version}-${at.toISOString().replace(/[:.]/g, "-")}.bak`;
}

/**
 * Creates a new database of the kind, or upgrades an older one of the same kind to the current version. Anything else
 * is refused untouched: an earlier Portico's database, a newer one's, or the other kind. A database file is copied
 * beside itself before an upgrade. Each migration runs in its own transaction with a foreign key check, so a failed one
 * leaves the database at the last version that worked.
 */
export function prepare(
  db: Database,
  opts: {
    kind?: DbKind;
    path?: string;
    migrations?: readonly Migration[];
    now?: () => Date;
    log?: (msg: string, fields: Record<string, unknown>) => void;
  } = {},
): void {
  const kind = opts.kind ?? DIRECTORY;
  const migrations = opts.migrations ?? kind.migrations;
  const latest = kind.baseVersion + migrations.length;
  let version = pragma(db, "user_version");
  const applicationId = pragma(db, "application_id");
  const tables = (db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
  if (version === 0 && applicationId === 0 && tables === 0) {
    db.transaction(() => {
      for (const statement of kind.schema) db.run(statement);
      db.run(`PRAGMA application_id = ${kind.applicationId}`);
      db.run(`PRAGMA user_version = ${kind.baseVersion}`);
    })();
    version = kind.baseVersion;
  } else {
    // An earlier Portico never set an application ID; the other kind has its own.
    if (applicationId !== kind.applicationId) throw new SchemaMismatchError(version, applicationId === 0 ? "older" : "wrong_kind", kind.name);
    if (version < kind.baseVersion) throw new SchemaMismatchError(version, "older", kind.name);
    if (version > latest) throw new SchemaMismatchError(version, "newer", kind.name);
    if (version === latest) return;
    if (opts.path && opts.path !== ":memory:") {
      const to = backupPath(opts.path, version, opts.now?.() ?? new Date());
      db.query("VACUUM INTO $to").run({ to });
      opts.log?.("db_backed_up", { kind: kind.name, from_version: version, to_version: latest });
    }
  }
  // A row that already broke a foreign key (written with the checks off) isn't the migration's doing: only new ones fail it.
  const brokenBefore = (db.query("PRAGMA foreign_key_check").all() as unknown[]).length;
  for (let next = version + 1; next <= latest; next++) {
    const migration = migrations[next - kind.baseVersion - 1]!;
    // The pragma does nothing inside a transaction, so it is set around the migration's own.
    const keys = pragma(db, "foreign_keys");
    if (migration.rebuilds) db.run("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        migration(db);
        const broken = (db.query("PRAGMA foreign_key_check").all() as unknown[]).length;
        if (broken > brokenBefore) throw new Error(`migration to version ${next} broke ${broken - brokenBefore} foreign keys`);
        db.run(`PRAGMA user_version = ${next}`);
      })();
    } finally {
      if (migration.rebuilds) db.run(`PRAGMA foreign_keys = ${keys ? "ON" : "OFF"}`);
    }
    opts.log?.("db_migrated", { kind: kind.name, version: next });
  }
}

type DbLog = (msg: string, fields: Record<string, unknown>) => void;

function open(kind: DbKind, path: string, log?: DbLog): Database {
  // strict: true binds { id } to $id without writing the "$" prefix in JS.
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    // Off by default in SQLite: removing a row cascades to what depends on the row, inside the one database.
    db.run("PRAGMA foreign_keys = ON");
    prepare(db, { kind, path, log });
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Opens the directory, `portico.db`, making or upgrading the file first. */
export function openDb(path: string, log?: DbLog): Database {
  return open(DIRECTORY, path, log);
}

/** Opens one workspace's content database, making or upgrading the file first. core/content.ts is the only caller. */
export function openContentDb(path: string, log?: DbLog): Database {
  return open(CONTENT, path, log);
}

export type Bindings = Record<string, string | number | null>;
