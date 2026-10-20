import { Database } from "bun:sqlite";
import type { BridgeEvent, Task, TaskStatus } from "./core/types";

const SCHEMA = [
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

/** Databases created before a column existed get it added here. */
function addMissingColumns(db: Database): void {
  const columns = (db.query("PRAGMA table_info(tasks)").all() as { name: string }[]).map((column) => column.name);
  if (!columns.includes("idempotency_key")) db.run("ALTER TABLE tasks ADD COLUMN idempotency_key TEXT");
}

export function openDb(path: string): Database {
  // strict: true lets us bind { id } to $id without writing the "$" prefix in JS.
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  for (const statement of SCHEMA) db.run(statement);
  addMissingColumns(db);
  db.run(IDEMPOTENCY_INDEX);
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

function toEvent(row: EventRow): BridgeEvent {
  return { id: row.id, agent: row.agent, name: row.name, details: row.details, createdAt: row.created_at };
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

  listQueuedFor(agent: string): Task[] {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE to_agent = $agent AND status = 'queued' ORDER BY created_at, rowid")
      .all({ agent }) as TaskRow[];
    return rows.map(toTask);
  }

  listUnseenResultsFor(agent: string): Task[] {
    const rows = this.db
      .query(
        `SELECT * FROM tasks WHERE from_agent = $agent AND status IN ${FINAL} AND sender_notified_at IS NULL
         ORDER BY updated_at, rowid`,
      )
      .all({ agent }) as TaskRow[];
    return rows.map(toTask);
  }

  /** True if the agent has queued tasks, or finished results it sent and hasn't seen. */
  hasWaitingFor(agent: string): boolean {
    const row = this.db
      .query(
        `SELECT EXISTS (
           SELECT 1 FROM tasks
           WHERE (to_agent = $agent AND status = 'queued')
              OR (from_agent = $agent AND status IN ${FINAL} AND sender_notified_at IS NULL)
         ) AS waiting`,
      )
      .get({ agent }) as { waiting: number };
    return row.waiting === 1;
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

  insertEvent(event: BridgeEvent): void {
    this.db
      .query("INSERT INTO events (id, agent, name, details, created_at) VALUES ($id, $agent, $name, $details, $createdAt)")
      .run({ id: event.id, agent: event.agent, name: event.name, details: event.details, createdAt: event.createdAt });
  }

  getEvent(id: string): BridgeEvent | null {
    const row = this.db.query("SELECT * FROM events WHERE id = $id").get({ id }) as EventRow | null;
    return row ? toEvent(row) : null;
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
}
