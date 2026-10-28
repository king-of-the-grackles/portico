import { Database } from "bun:sqlite";
import { MIGRATIONS, type Migration } from "./migrations";

/**
 * The open network's first schema, version 100. Later changes are migrations (migrations.ts), which every database
 * runs in order, a new one included, so there is one path to the current schema. Each module owns the queries for its
 * own tables; this file only creates them.
 */
const SCHEMA = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

  `CREATE TABLE people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'pending')),
    password_hash TEXT NOT NULL,
    invite_id TEXT,
    created_at TEXT NOT NULL,
    approved_at TEXT
  )`,
  `CREATE UNIQUE INDEX people_one_owner ON people (role) WHERE role = 'owner'`,

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
    name TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  )`,

  `CREATE TABLE folders (
    computer_id TEXT NOT NULL REFERENCES computers (id) ON DELETE CASCADE,
    folder_id TEXT NOT NULL,
    name TEXT NOT NULL,
    joins INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (computer_id, folder_id)
  )`,

  `CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('session', 'app', 'connector')),
    description TEXT NOT NULL,
    computer_id TEXT REFERENCES computers (id) ON DELETE CASCADE,
    session_key TEXT,
    folder TEXT,
    folder_id TEXT,
    approval_required INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  )`,
  `CREATE UNIQUE INDEX agents_app_name ON agents (name) WHERE computer_id IS NULL`,
  `CREATE UNIQUE INDEX agents_session_name ON agents (computer_id, name) WHERE computer_id IS NOT NULL`,
  `CREATE UNIQUE INDEX agents_session_key ON agents (computer_id, session_key) WHERE computer_id IS NOT NULL`,
  `CREATE INDEX agents_name ON agents (name)`,
  `CREATE INDEX agents_owner ON agents (owner_id)`,

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

  `CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    a_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    b_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    started_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_message_at TEXT NOT NULL,
    UNIQUE (a_id, b_id),
    CHECK (a_id < b_id)
  )`,
  `CREATE INDEX threads_b ON threads (b_id)`,
  `CREATE INDEX threads_last ON threads (last_message_at)`,

  `CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    from_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    to_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to TEXT,
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

  `CREATE TABLE always_allow (
    agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, sender_id)
  )`,
];

/** The first schema's version. Earlier Portico versions used 1 and 2, which can't be upgraded. */
export const BASE_VERSION = 100;

/** The current schema version: the first schema plus every migration. */
export const SCHEMA_VERSION = BASE_VERSION + MIGRATIONS.length;

/** The database was written by a Portico version this one can't upgrade from: before 100, or newer than this one. */
export class SchemaMismatchError extends Error {
  constructor(readonly found: number) {
    super(`database schema version ${found} is not one this Portico (version ${SCHEMA_VERSION}) can use or upgrade`);
    this.name = "SchemaMismatchError";
  }

  /** Written by a newer Portico, e.g. before a rollback. */
  get newer(): boolean {
    return this.found > SCHEMA_VERSION;
  }
}

const userVersion = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

/** Where the copy made before upgrading a database file goes: beside it, named for the old version and the time. */
export function backupPath(path: string, version: number, at: Date): string {
  return `${path}.v${version}-${at.toISOString().replace(/[:.]/g, "-")}.bak`;
}

/**
 * Creates a new database or upgrades an older one to the current version. A database file is copied beside itself
 * before an upgrade. Each migration runs in its own transaction with a foreign key check, so a failed one leaves the
 * database at the last version that worked.
 */
export function prepare(
  db: Database,
  opts: { path?: string; migrations?: readonly Migration[]; now?: () => Date; log?: (msg: string, fields: Record<string, unknown>) => void } = {},
): void {
  const migrations = opts.migrations ?? MIGRATIONS;
  const latest = BASE_VERSION + migrations.length;
  let version = userVersion(db);
  if (version === latest) return;
  const tables = (db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
  if (version === 0 && tables === 0) {
    db.transaction(() => {
      for (const statement of SCHEMA) db.run(statement);
      db.run(`PRAGMA user_version = ${BASE_VERSION}`);
    })();
    version = BASE_VERSION;
  } else {
    if (version < BASE_VERSION || version > latest) throw new SchemaMismatchError(version);
    if (opts.path && opts.path !== ":memory:") {
      const to = backupPath(opts.path, version, opts.now?.() ?? new Date());
      db.query("VACUUM INTO $to").run({ to });
      opts.log?.("db_backed_up", { from_version: version, to_version: latest });
    }
  }
  // A row that already broke a foreign key (written with the checks off) isn't the migration's doing: only new ones fail it.
  const brokenBefore = (db.query("PRAGMA foreign_key_check").all() as unknown[]).length;
  for (let next = version + 1; next <= latest; next++) {
    const migration = migrations[next - BASE_VERSION - 1]!;
    db.transaction(() => {
      migration(db);
      const broken = (db.query("PRAGMA foreign_key_check").all() as unknown[]).length;
      if (broken > brokenBefore) throw new Error(`migration to version ${next} broke ${broken - brokenBefore} foreign keys`);
      db.run(`PRAGMA user_version = ${next}`);
    })();
    opts.log?.("db_migrated", { version: next });
  }
}

export function openDb(path: string, log?: (msg: string, fields: Record<string, unknown>) => void): Database {
  // strict: true binds { id } to $id without writing the "$" prefix in JS.
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    // Off by default in SQLite: removing a person or computer cascades to what depends on it.
    db.run("PRAGMA foreign_keys = ON");
    prepare(db, { path, log });
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export type Bindings = Record<string, string | number | null>;
