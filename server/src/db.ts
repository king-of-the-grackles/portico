import { Database } from "bun:sqlite";
import type { Message, PorticoEvent, Task, TaskStatus } from "./core/types";

// v1's schema, as deployed. Every statement is idempotent, because deployed v1 databases are at user_version 0
// with these tables already there.
const V1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    instructions TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    reason TEXT,
    parent_task_id TEXT,
    chain_length INTEGER NOT NULL,
    event_id TEXT,
    trigger_name TEXT,
    sender_notified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    idempotency_key TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_to_status ON tasks (to_agent, status)`,
  `CREATE INDEX IF NOT EXISTS tasks_from_created ON tasks (from_agent, created_at)`,
  `CREATE INDEX IF NOT EXISTS tasks_status_expires ON tasks (status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    name TEXT NOT NULL,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_agent_created ON events (agent, created_at)`,
];

// Created after addMissingColumns, because older databases get the column added there.
const IDEMPOTENCY_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency
  ON tasks (from_agent, idempotency_key) WHERE idempotency_key IS NOT NULL`;

// v1.1, the personal agent network. Every member record carries owner, always "owner" for now.
const NETWORK_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    machine_id TEXT NOT NULL REFERENCES machines (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key TEXT NOT NULL,
    folder TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE (machine_id, name),
    UNIQUE (machine_id, key)
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_name ON sessions (name)`,
  `CREATE TABLE IF NOT EXISTS assistants (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    description TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS join_codes (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    code_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    delivered_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS messages_to_pending ON messages (to_agent, delivered_at, expires_at)`,
  `CREATE INDEX IF NOT EXISTS messages_pair_created ON messages (from_agent, to_agent, created_at)`,
];

/** Databases created before a column existed get it added here. */
function addMissingColumns(db: Database): void {
  const columns = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((column) => column.name);
  if (!columns.includes("idempotency_key")) db.run("ALTER TABLE tasks ADD COLUMN idempotency_key TEXT");
}

/** Migration n + 1 takes a database from user_version n to n + 1. Append only: never edit a shipped migration. */
const MIGRATIONS: ((db: Database) => void)[] = [
  // 1: the v1 schema.
  (db) => {
    for (const statement of V1_SCHEMA) db.run(statement);
    addMissingColumns(db);
    db.run(IDEMPOTENCY_INDEX);
  },
  // 2: v1.1, the personal agent network.
  (db) => {
    for (const statement of NETWORK_SCHEMA) db.run(statement);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** The database was written by a newer hub, whose schema this one doesn't know. */
export class SchemaTooNewError extends Error {
  constructor(readonly found: number) {
    super(`database schema version ${found} is newer than this hub's version ${SCHEMA_VERSION}`);
    this.name = "SchemaTooNewError";
  }
}

function migrate(db: Database): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current > SCHEMA_VERSION) throw new SchemaTooNewError(current);
  for (let v = current; v < SCHEMA_VERSION; v++) {
    // Each step and its version bump commit together, so a failed step leaves the database as it was.
    db.transaction(() => {
      MIGRATIONS[v]!(db);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export function openDb(path: string): Database {
  // strict: true lets us bind { id } to $id without writing the "$" prefix in JS.
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    // Off by default in SQLite, and a no-op inside a transaction: removing a machine cascades to its sessions.
    db.run("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

interface TaskRow {
  id: string;
  from_agent: string;
  to_agent: string;
  instructions: string;
  status: string;
  result: string | null;
  reason: string | null;
  parent_task_id: string | null;
  chain_length: number;
  event_id: string | null;
  trigger_name: string | null;
  sender_notified_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  idempotency_key: string | null;
}

interface EventRow {
  id: string;
  agent: string;
  name: string;
  details: string;
  created_at: string;
}

interface MessageRow {
  id: string;
  from_agent: string;
  to_agent: string;
  text: string;
  reply_to: string | null;
  created_at: string;
  expires_at: string;
  delivered_at: string | null;
}

type Bindings = Record<string, string | number | null>;

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    instructions: row.instructions,
    status: row.status as TaskStatus,
    result: row.result,
    reason: row.reason,
    parentTaskId: row.parent_task_id,
    chainLength: row.chain_length,
    eventId: row.event_id,
    triggerName: row.trigger_name,
    senderNotifiedAt: row.sender_notified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    idempotencyKey: row.idempotency_key,
  };
}

function toEvent(row: EventRow): PorticoEvent {
  return { id: row.id, agent: row.agent, name: row.name, details: row.details, createdAt: row.created_at };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    text: row.text,
    replyTo: row.reply_to,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deliveredAt: row.delivered_at,
  };
}

function taskBindings(t: Task): Bindings {
  return {
    id: t.id,
    fromAgent: t.fromAgent,
    toAgent: t.toAgent,
    instructions: t.instructions,
    status: t.status,
    result: t.result,
    reason: t.reason,
    parentTaskId: t.parentTaskId,
    chainLength: t.chainLength,
    eventId: t.eventId,
    triggerName: t.triggerName,
    senderNotifiedAt: t.senderNotifiedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    expiresAt: t.expiresAt,
    idempotencyKey: t.idempotencyKey,
  };
}

export type TaskChanges = Partial<Pick<Task, "status" | "result" | "reason" | "senderNotifiedAt" | "updatedAt">>;

const CHANGE_COLUMNS: Record<keyof TaskChanges, string> = {
  status: "status",
  result: "result",
  reason: "reason",
  senderNotifiedAt: "sender_notified_at",
  updatedAt: "updated_at",
};

const FINAL = "('done', 'failed', 'denied', 'expired')";
const ACTIVE = "('waiting_approval', 'queued', 'working')";
/** A message to $agent not yet delivered and not expired at $now. */
const PENDING_MESSAGE = "to_agent = $agent AND delivered_at IS NULL AND expires_at > $now";

export class Store {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  insertTask(task: Task): void {
    this.db
      .query(
        `INSERT INTO tasks (id, from_agent, to_agent, instructions, status, result, reason, parent_task_id,
           chain_length, event_id, trigger_name, sender_notified_at, created_at, updated_at, expires_at, idempotency_key)
         VALUES ($id, $fromAgent, $toAgent, $instructions, $status, $result, $reason, $parentTaskId,
           $chainLength, $eventId, $triggerName, $senderNotifiedAt, $createdAt, $updatedAt, $expiresAt, $idempotencyKey)`,
      )
      .run(taskBindings(task));
  }

  getTask(id: string): Task | null {
    const row = this.db.query("SELECT * FROM tasks WHERE id = $id").get({ id }) as TaskRow | null;
    return row ? toTask(row) : null;
  }

  updateTask(id: string, changes: TaskChanges): Task {
    // Skip undefined values: an optional field left out must not clear the column.
    const keys = (Object.keys(changes) as (keyof TaskChanges)[]).filter((key) => changes[key] !== undefined);
    if (keys.length > 0) {
      const assignments = keys.map((key) => `${CHANGE_COLUMNS[key]} = $${key}`).join(", ");
      const bindings: Bindings = { id };
      for (const key of keys) bindings[key] = changes[key] ?? null;
      this.db.query(`UPDATE tasks SET ${assignments} WHERE id = $id`).run(bindings);
    }
    const task = this.getTask(id);
    if (!task) throw new Error(`task ${id} not found`);
    return task;
  }

  findByIdempotencyKey(fromAgent: string, key: string): Task | null {
    const row = this.db
      .query("SELECT * FROM tasks WHERE from_agent = $fromAgent AND idempotency_key = $key")
      .get({ fromAgent, key }) as TaskRow | null;
    return row ? toTask(row) : null;
  }

  /** Oldest first. The default `limit` of -1 means no limit. */
  listQueuedFor(agent: string, limit = -1): Task[] {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE to_agent = $agent AND status = 'queued' ORDER BY created_at, rowid LIMIT $limit")
      .all({ agent, limit }) as TaskRow[];
    return rows.map(toTask);
  }

  /** Oldest first. The default `limit` of -1 means no limit. */
  listUnseenResultsFor(agent: string, limit = -1): Task[] {
    const rows = this.db
      .query(
        `SELECT * FROM tasks WHERE from_agent = $agent AND status IN ${FINAL} AND sender_notified_at IS NULL
         ORDER BY updated_at, rowid LIMIT $limit`,
      )
      .all({ agent, limit }) as TaskRow[];
    return rows.map(toTask);
  }

  /** Moves each listed task that is queued for the agent to working, one guarded update per ID. Run inside the caller's transaction. */
  claimQueued(agent: string, ids: string[], at: string): Task[] {
    const claim = this.db.query(
      "UPDATE tasks SET status = 'working', updated_at = $at WHERE id = $id AND to_agent = $agent AND status = 'queued'",
    );
    const claimed: Task[] = [];
    for (const id of ids) {
      if (claim.run({ id, agent, at }).changes === 1) claimed.push(this.getTask(id)!);
    }
    return claimed;
  }

  /** Marks each listed final task the agent sent, and hasn't seen yet, as seen. Run inside the caller's transaction. */
  markResultsSeen(agent: string, ids: string[], at: string): number {
    const mark = this.db.query(
      `UPDATE tasks SET sender_notified_at = $at
       WHERE id = $id AND from_agent = $agent AND status IN ${FINAL} AND sender_notified_at IS NULL`,
    );
    let marked = 0;
    for (const id of ids) marked += mark.run({ id, agent, at }).changes;
    return marked;
  }

  /** Moves every task the agent is working on back to queued, for a new session inheriting its address. */
  requeueWorkingFor(agent: string, at: string): Task[] {
    const rows = this.db
      .query(
        `UPDATE tasks SET status = 'queued', updated_at = $at WHERE to_agent = $agent AND status = 'working'
         RETURNING *`,
      )
      .all({ agent, at }) as TaskRow[];
    return rows.map(toTask);
  }

  /** True if the agent has queued tasks, finished results it sent and hasn't seen, or pending messages. */
  hasWaitingFor(agent: string, now: string): boolean {
    const row = this.db
      .query(
        `SELECT EXISTS (
           SELECT 1 FROM tasks
           WHERE (to_agent = $agent AND status = 'queued')
              OR (from_agent = $agent AND status IN ${FINAL} AND sender_notified_at IS NULL)
         ) OR EXISTS (SELECT 1 FROM messages WHERE ${PENDING_MESSAGE}) AS waiting`,
      )
      .get({ agent, now }) as { waiting: number };
    return row.waiting === 1;
  }

  /** Queued tasks for the agent, unseen results it sent, and its pending messages: its unread count. */
  countWaitingFor(agent: string, now: string): number {
    const row = this.db
      .query(
        `SELECT (SELECT COUNT(*) FROM tasks WHERE to_agent = $agent AND status = 'queued')
              + (SELECT COUNT(*) FROM tasks WHERE from_agent = $agent AND status IN ${FINAL} AND sender_notified_at IS NULL)
              + (SELECT COUNT(*) FROM messages WHERE ${PENDING_MESSAGE}) AS n`,
      )
      .get({ agent, now }) as { n: number };
    return row.n;
  }

  latestWorkingFor(agent: string): Task | null {
    const row = this.db
      .query(
        `SELECT * FROM tasks WHERE to_agent = $agent AND status = 'working'
         ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
      )
      .get({ agent }) as TaskRow | null;
    return row ? toTask(row) : null;
  }

  countTasksFromSince(agent: string, since: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM tasks WHERE from_agent = $agent AND created_at >= $since")
      .get({ agent, since }) as { n: number };
    return row.n;
  }

  listExpirable(now: string): Task[] {
    const rows = this.db
      .query(`SELECT * FROM tasks WHERE status IN ${ACTIVE} AND expires_at <= $now ORDER BY expires_at, rowid`)
      .all({ now }) as TaskRow[];
    return rows.map(toTask);
  }

  deleteFinishedBefore(cutoff: string): number {
    return this.db.query(`DELETE FROM tasks WHERE status IN ${FINAL} AND updated_at < $cutoff`).run({ cutoff })
      .changes;
  }

  /** Newest first, or oldest first with `oldestFirst`. With an agent, the tasks it sent or received. */
  listTasks(filter: { agent?: string; status?: TaskStatus; limit: number; oldestFirst?: boolean }): Task[] {
    const clauses: string[] = [];
    const bindings: Bindings = { limit: filter.limit };
    if (filter.agent) {
      clauses.push("(from_agent = $agent OR to_agent = $agent)");
      bindings.agent = filter.agent;
    }
    if (filter.status) {
      clauses.push("status = $status");
      bindings.status = filter.status;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const order = filter.oldestFirst ? "created_at ASC, rowid ASC" : "created_at DESC, rowid DESC";
    const rows = this.db
      .query(`SELECT * FROM tasks ${where} ORDER BY ${order} LIMIT $limit`)
      .all(bindings) as TaskRow[];
    return rows.map(toTask);
  }

  insertEvent(event: PorticoEvent): void {
    this.db
      .query("INSERT INTO events (id, agent, name, details, created_at) VALUES ($id, $agent, $name, $details, $createdAt)")
      .run({ id: event.id, agent: event.agent, name: event.name, details: event.details, createdAt: event.createdAt });
  }

  getEvent(id: string): PorticoEvent | null {
    const row = this.db.query("SELECT * FROM events WHERE id = $id").get({ id }) as EventRow | null;
    return row ? toEvent(row) : null;
  }

  /** Newest first. */
  listEvents(filter: { agent?: string; limit: number }): PorticoEvent[] {
    const where = filter.agent ? "WHERE agent = $agent" : "";
    const bindings: Bindings = filter.agent ? { agent: filter.agent, limit: filter.limit } : { limit: filter.limit };
    const rows = this.db
      .query(`SELECT * FROM events ${where} ORDER BY created_at DESC, rowid DESC LIMIT $limit`)
      .all(bindings) as EventRow[];
    return rows.map(toEvent);
  }

  countEventsFromSince(agent: string, since: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM events WHERE agent = $agent AND created_at >= $since")
      .get({ agent, since }) as { n: number };
    return row.n;
  }

  deleteEventsBefore(cutoff: string): number {
    return this.db.query("DELETE FROM events WHERE created_at < $cutoff").run({ cutoff }).changes;
  }

  insertMessage(m: Message): void {
    this.db
      .query(
        `INSERT INTO messages (id, from_agent, to_agent, text, reply_to, created_at, expires_at, delivered_at)
         VALUES ($id, $fromAgent, $toAgent, $text, $replyTo, $createdAt, $expiresAt, $deliveredAt)`,
      )
      .run({
        id: m.id,
        fromAgent: m.fromAgent,
        toAgent: m.toAgent,
        text: m.text,
        replyTo: m.replyTo,
        createdAt: m.createdAt,
        expiresAt: m.expiresAt,
        deliveredAt: m.deliveredAt,
      });
  }

  getMessage(id: string): Message | null {
    const row = this.db.query("SELECT * FROM messages WHERE id = $id").get({ id }) as MessageRow | null;
    return row ? toMessage(row) : null;
  }

  /**
   * One page of messages, newest first (ties broken by insert order). With `before`, only those strictly older than
   * that message; an unknown ID is ignored and the first page comes back.
   */
  listMessages(filter: { before?: string; limit: number }): Message[] {
    const anchor = filter.before
      ? (this.db.query("SELECT created_at, rowid AS rid FROM messages WHERE id = $id").get({ id: filter.before }) as {
          created_at: string;
          rid: number;
        } | null)
      : null;
    const rows = anchor
      ? this.db
          .query(
            `SELECT * FROM messages WHERE created_at < $at OR (created_at = $at AND rowid < $rid)
             ORDER BY created_at DESC, rowid DESC LIMIT $limit`,
          )
          .all({ at: anchor.created_at, rid: anchor.rid, limit: filter.limit })
      : this.db.query("SELECT * FROM messages ORDER BY created_at DESC, rowid DESC LIMIT $limit").all({ limit: filter.limit });
    return (rows as MessageRow[]).map(toMessage);
  }

  /** Undelivered, unexpired messages to the address, oldest first. The default `limit` of -1 means no limit. */
  listPendingMessagesFor(address: string, now: string, limit = -1): Message[] {
    const rows = this.db
      .query(`SELECT * FROM messages WHERE ${PENDING_MESSAGE} ORDER BY created_at, rowid LIMIT $limit`)
      .all({ agent: address, now, limit }) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * Marks each listed message to the address delivered, if it's still undelivered and unexpired. Run inside the
   * caller's transaction.
   */
  markMessagesDelivered(address: string, ids: string[], at: string): number {
    const mark = this.db.query(
      `UPDATE messages SET delivered_at = $at
       WHERE id = $id AND to_agent = $address AND delivered_at IS NULL AND expires_at > $at`,
    );
    let marked = 0;
    for (const id of ids) marked += mark.run({ id, address, at }).changes;
    return marked;
  }

  /** When each message between the two was sent, either way, after `since`: oldest first. For the loop guard's window. */
  messageTimesBetween(a: string, b: string, since: string): string[] {
    const rows = this.db
      .query(
        `SELECT created_at FROM messages
         WHERE ((from_agent = $a AND to_agent = $b) OR (from_agent = $b AND to_agent = $a)) AND created_at > $since
         ORDER BY created_at, rowid`,
      )
      .all({ a, b, since }) as { created_at: string }[];
    return rows.map((row) => row.created_at);
  }

  countMessagesFromSince(address: string, since: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM messages WHERE from_agent = $address AND created_at >= $since")
      .get({ address, since }) as { n: number };
    return row.n;
  }

  /** Deletes messages sent before the cutoff, delivered or not. */
  deleteMessagesBefore(cutoff: string): number {
    return this.db.query("DELETE FROM messages WHERE created_at < $cutoff").run({ cutoff }).changes;
  }
}
