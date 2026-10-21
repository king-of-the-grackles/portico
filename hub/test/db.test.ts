import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION, SchemaTooNewError, Store } from "../src/db";
import { NetworkStore } from "../src/network-store";
import type { Machine, SessionRecord, Task } from "../src/core/types";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    fromAgent: "grok-bot",
    toAgent: "claude-code",
    instructions: "do it",
    status: "queued",
    result: null,
    reason: null,
    parentTaskId: null,
    chainLength: 1,
    eventId: null,
    triggerName: null,
    senderNotifiedAt: null,
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-20T12:00:00.000Z",
    expiresAt: "2026-10-21T12:00:00.000Z",
    idempotencyKey: null,
    ...overrides,
  };
}

let store: Store;
beforeEach(() => {
  store = new Store(openDb(":memory:"));
});

describe("Store: tasks", () => {
  test("hasWaitingFor sees queued tasks for the agent and unseen results it sent", () => {
    const now = "2026-10-20T12:30:00.000Z";
    expect(store.hasWaitingFor("claude-code", now)).toBe(false);
    store.insertTask(task());
    expect(store.hasWaitingFor("claude-code", now)).toBe(true);
    expect(store.hasWaitingFor("grok-bot", now)).toBe(false);
    store.updateTask("t1", { status: "done", result: "ok" });
    expect(store.hasWaitingFor("claude-code", now)).toBe(false);
    expect(store.hasWaitingFor("grok-bot", now)).toBe(true);
    store.updateTask("t1", { senderNotifiedAt: "2026-10-20T13:00:00.000Z" });
    expect(store.hasWaitingFor("grok-bot", now)).toBe(false);
  });

  test("hasWaitingFor and countWaitingFor see pending messages until they're delivered or expire", () => {
    const message = {
      id: "m1",
      fromAgent: "muse",
      toAgent: "claude-code",
      text: "hi",
      replyTo: null,
      createdAt: "2026-10-20T12:00:00.000Z",
      expiresAt: "2026-10-21T12:00:00.000Z",
      deliveredAt: null,
    };
    store.insertMessage(message);
    store.insertTask(task());
    expect(store.getMessage("m1")).toEqual(message);
    expect(store.countWaitingFor("claude-code", "2026-10-20T12:30:00.000Z")).toBe(2);
    expect(store.countWaitingFor("claude-code", "2026-10-21T12:00:00.000Z")).toBe(1); // the message expired
    store.updateTask("t1", { status: "working" });
    expect(store.hasWaitingFor("claude-code", "2026-10-20T12:30:00.000Z")).toBe(true);
    expect(store.hasWaitingFor("claude-code", "2026-10-21T12:00:00.000Z")).toBe(false);
    expect(store.markMessagesDelivered("claude-code", ["m1"], "2026-10-20T12:31:00.000Z")).toBe(1);
    expect(store.hasWaitingFor("claude-code", "2026-10-20T12:32:00.000Z")).toBe(false);
  });

  test("round-trips a task", () => {
    const t = task({ parentTaskId: "p1", chainLength: 2, eventId: "e1", triggerName: "trig" });
    store.insertTask(t);
    expect(store.getTask("t1")).toEqual(t);
    expect(store.getTask("missing")).toBeNull();
  });

  test("updates only the given fields", () => {
    store.insertTask(task());
    const updated = store.updateTask("t1", { status: "done", result: "ok", updatedAt: "2026-10-20T13:00:00.000Z" });
    expect(updated.status).toBe("done");
    expect(updated.result).toBe("ok");
    expect(updated.reason).toBeNull();
    expect(updated.updatedAt).toBe("2026-10-20T13:00:00.000Z");
    expect(updated.instructions).toBe("do it");
  });

  test("lists queued tasks for a receiver, oldest first", () => {
    store.insertTask(task({ id: "b", createdAt: "2026-10-20T12:00:02.000Z" }));
    store.insertTask(task({ id: "a", createdAt: "2026-10-20T12:00:01.000Z" }));
    store.insertTask(task({ id: "w", status: "working" }));
    store.insertTask(task({ id: "other", toAgent: "muse" }));
    expect(store.listQueuedFor("claude-code").map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("lists finished tasks the sender hasn't seen", () => {
    store.insertTask(task({ id: "done", status: "done" }));
    store.insertTask(task({ id: "seen", status: "done", senderNotifiedAt: "2026-10-20T12:30:00.000Z" }));
    store.insertTask(task({ id: "denied", status: "denied" }));
    store.insertTask(task({ id: "open", status: "working" }));
    expect(store.listUnseenResultsFor("grok-bot").map((t) => t.id).sort()).toEqual(["denied", "done"]);
  });

  test("finds the receiver's most recently picked-up working task", () => {
    store.insertTask(task({ id: "old", status: "working", updatedAt: "2026-10-20T12:01:00.000Z" }));
    store.insertTask(task({ id: "new", status: "working", updatedAt: "2026-10-20T12:02:00.000Z" }));
    store.insertTask(task({ id: "q", status: "queued", updatedAt: "2026-10-20T12:03:00.000Z" }));
    expect(store.latestWorkingFor("claude-code")?.id).toBe("new");
    expect(store.latestWorkingFor("muse")).toBeNull();
  });

  test("counts tasks a sender created since a time", () => {
    store.insertTask(task({ id: "1", createdAt: "2026-10-20T10:00:00.000Z" }));
    store.insertTask(task({ id: "2", createdAt: "2026-10-20T11:30:00.000Z" }));
    store.insertTask(task({ id: "3", createdAt: "2026-10-20T11:45:00.000Z" }));
    expect(store.countTasksFromSince("grok-bot", "2026-10-20T11:00:00.000Z")).toBe(2);
    expect(store.countTasksFromSince("muse", "2026-10-20T11:00:00.000Z")).toBe(0);
  });

  test("lists active tasks whose expiry has passed", () => {
    store.insertTask(task({ id: "late", status: "queued", expiresAt: "2026-10-20T11:00:00.000Z" }));
    store.insertTask(task({ id: "fresh", status: "queued", expiresAt: "2026-10-20T13:00:00.000Z" }));
    store.insertTask(task({ id: "finished", status: "done", expiresAt: "2026-10-20T11:00:00.000Z" }));
    expect(store.listExpirable("2026-10-20T12:00:00.000Z").map((t) => t.id)).toEqual(["late"]);
  });

  test("deletes finished tasks older than a cutoff", () => {
    store.insertTask(task({ id: "old-done", status: "done", updatedAt: "2026-09-01T00:00:00.000Z" }));
    store.insertTask(task({ id: "old-open", status: "queued", updatedAt: "2026-09-01T00:00:00.000Z" }));
    store.insertTask(task({ id: "new-done", status: "done", updatedAt: "2026-10-20T00:00:00.000Z" }));
    expect(store.deleteFinishedBefore("2026-10-01T00:00:00.000Z")).toBe(1);
    expect(store.getTask("old-done")).toBeNull();
    expect(store.getTask("old-open")).not.toBeNull();
    expect(store.getTask("new-done")).not.toBeNull();
  });

  test("transaction rolls back when the function throws", () => {
    expect(() =>
      store.transaction(() => {
        store.insertTask(task());
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getTask("t1")).toBeNull();
  });
});

describe("Store: events", () => {
  test("inserts, reads, counts and deletes events", () => {
    store.insertEvent({ id: "e1", agent: "muse", name: "x", details: "d", createdAt: "2026-09-01T00:00:00.000Z" });
    store.insertEvent({ id: "e2", agent: "muse", name: "x", details: "d", createdAt: "2026-10-20T11:30:00.000Z" });
    expect(store.getEvent("e2")?.details).toBe("d");
    expect(store.countEventsFromSince("muse", "2026-10-20T11:00:00.000Z")).toBe(1);
    expect(store.deleteEventsBefore("2026-10-01T00:00:00.000Z")).toBe(1);
    expect(store.getEvent("e1")).toBeNull();
  });
});

describe("openDb on a file", () => {
  const path = join(tmpdir(), `bridge-test-${crypto.randomUUID()}.db`);
  afterEach(() => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  });

  test("creates the schema once and keeps data across reopen", () => {
    new Store(openDb(path)).insertTask(task());
    const reopened = new Store(openDb(path));
    expect(reopened.getTask("t1")?.instructions).toBe("do it");
  });
});

describe("Store: idempotency keys and updates", () => {
  test("finds a task by sender and idempotency key", () => {
    store.insertTask(task({ idempotencyKey: "k1" }));
    expect(store.findByIdempotencyKey("grok-bot", "k1")?.id).toBe("t1");
    expect(store.findByIdempotencyKey("muse", "k1")).toBeNull();
    expect(store.findByIdempotencyKey("grok-bot", "k2")).toBeNull();
  });

  test("an idempotency key is unique per sender, and tasks without a key don't collide", () => {
    store.insertTask(task({ idempotencyKey: "k1" }));
    expect(() => store.insertTask(task({ id: "t2", idempotencyKey: "k1" }))).toThrow();
    store.insertTask(task({ id: "t3", fromAgent: "muse", idempotencyKey: "k1" }));
    store.insertTask(task({ id: "t4" }));
    store.insertTask(task({ id: "t5" }));
    expect(store.getTask("t5")?.idempotencyKey).toBeNull();
  });

  test("updateTask ignores undefined values instead of clearing the column", () => {
    store.insertTask(task({ reason: "original reason" }));
    const updated = store.updateTask("t1", { reason: undefined, status: "failed" });
    expect(updated.reason).toBe("original reason");
    expect(updated.status).toBe("failed");
  });

  test("updateTask on a missing task throws", () => {
    expect(() => store.updateTask("missing", { status: "done" })).toThrow("task missing not found");
  });
});

describe("openDb migration", () => {
  test("adds idempotency_key to a database created before it existed", () => {
    const path = join(tmpdir(), `bridge-migrate-${crypto.randomUUID()}.db`);
    const old = new Database(path, { create: true, strict: true });
    old.run(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, instructions TEXT NOT NULL,
      status TEXT NOT NULL, result TEXT, reason TEXT, parent_task_id TEXT, chain_length INTEGER NOT NULL,
      event_id TEXT, trigger_name TEXT, sender_notified_at TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, expires_at TEXT NOT NULL)`);
    old.run(`INSERT INTO tasks VALUES ('old', 'grok-bot', 'claude-code', 'hi', 'queued', NULL, NULL, NULL, 1,
      NULL, NULL, NULL, '2026-10-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z', '2026-10-21T12:00:00.000Z')`);
    old.close();
    const db = openDb(path);
    try {
      const migrated = new Store(db);
      expect(migrated.getTask("old")?.idempotencyKey).toBeNull();
      migrated.insertTask(task({ id: "new", idempotencyKey: "k" }));
      expect(migrated.findByIdempotencyKey("grok-bot", "k")?.id).toBe("new");
    } finally {
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });
});

describe("Store: lists for the hub page", () => {
  test("listTasks filters by agent and status, newest first", () => {
    store.insertTask(task({ id: "a", createdAt: "2026-10-20T12:00:00.000Z" }));
    store.insertTask(
      task({ id: "b", fromAgent: "muse", toAgent: "codex", status: "done", createdAt: "2026-10-20T12:01:00.000Z" }),
    );
    store.insertTask(task({ id: "c", createdAt: "2026-10-20T12:02:00.000Z" }));
    expect(store.listTasks({ limit: 10 }).map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(store.listTasks({ agent: "codex", limit: 10 }).map((t) => t.id)).toEqual(["b"]);
    expect(store.listTasks({ status: "queued", limit: 10 }).map((t) => t.id)).toEqual(["c", "a"]);
    expect(store.listTasks({ agent: "grok-bot", status: "queued", limit: 1 }).map((t) => t.id)).toEqual(["c"]);
  });

  test("listEvents filters by agent, newest first", () => {
    store.insertEvent({ id: "e1", agent: "muse", name: "a", details: "", createdAt: "2026-10-20T12:00:00.000Z" });
    store.insertEvent({ id: "e2", agent: "grok-bot", name: "b", details: "", createdAt: "2026-10-20T12:01:00.000Z" });
    expect(store.listEvents({ limit: 10 }).map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(store.listEvents({ agent: "muse", limit: 10 }).map((e) => e.id)).toEqual(["e1"]);
  });
});

// A frozen copy of the v1 schema as deployed (hub/src/db.ts at v1), so later edits to db.ts can't change it.
const V1_SCHEMA_SQL = [
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
  `CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency
  ON tasks (from_agent, idempotency_key) WHERE idempotency_key IS NOT NULL`,
];

// The same, from before idempotency keys: no idempotency_key column and no index on it.
const V1_PRE_IDEMPOTENCY_SQL = [
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
    expires_at TEXT NOT NULL
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

const v1Dirs: string[] = [];
afterEach(() => {
  for (const dir of v1Dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function v1Database(statements: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ab-db-"));
  v1Dirs.push(dir);
  const path = join(dir, "bridge.db");
  const db = new Database(path, { create: true });
  for (const s of statements) db.run(s);
  db.run(`INSERT INTO tasks (id, from_agent, to_agent, instructions, status, chain_length, created_at, updated_at, expires_at)
          VALUES ('t-1', 'muse', 'claude-code-dialog', 'old work', 'done', 1, '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z')`);
  db.close();
  return path;
}
const version = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);

describe("versioned migrations", () => {
  test("upgrades a deployed v1 database in place, keeping its tasks", () => {
    const db = openDb(v1Database(V1_SCHEMA_SQL));
    try {
      expect(new Store(db).getTask("t-1")?.instructions).toBe("old work");
      expect(version(db)).toBe(SCHEMA_VERSION);
      expect(tables(db)).toEqual(
        expect.arrayContaining(["tasks", "events", "machines", "sessions", "assistants", "join_codes", "messages"]),
      );
    } finally {
      db.close();
    }
  });

  test("keeps v1 tasks and events exactly as they were", () => {
    const path = v1Database(V1_SCHEMA_SQL);
    const raw = new Database(path);
    raw.run(`INSERT INTO tasks (id, from_agent, to_agent, instructions, status, chain_length, created_at, updated_at, expires_at, idempotency_key)
             VALUES ('t-2', 'muse', 'claude-code-dialog', 'keyed work', 'queued', 1, '2026-10-20T01:00:00Z', '2026-10-20T01:00:00Z', '2026-10-21T01:00:00Z', 'k-1')`);
    raw.run(`INSERT INTO events (id, agent, name, details, created_at)
             VALUES ('e-1', 'muse', 'bug_report_received', 'the login page is down', '2026-10-20T00:30:00Z')`);
    const rows = (db: Database) => ({
      tasks: db.query("SELECT * FROM tasks ORDER BY id").all(),
      events: db.query("SELECT * FROM events ORDER BY id").all(),
    });
    const before = rows(raw);
    raw.close();
    expect(before.tasks).toHaveLength(2);
    const db = openDb(path);
    try {
      expect(rows(db)).toEqual(before);
      const store = new Store(db);
      expect(store.findByIdempotencyKey("muse", "k-1")?.id).toBe("t-2");
      expect(store.getEvent("e-1")?.details).toBe("the login page is down");
    } finally {
      db.close();
    }
  });

  test("upgrades a v1 database from before idempotency keys", () => {
    const db = openDb(v1Database(V1_PRE_IDEMPOTENCY_SQL));
    try {
      const store = new Store(db);
      expect(store.getTask("t-1")?.idempotencyKey).toBeNull();
      expect(version(db)).toBe(SCHEMA_VERSION);
      const indexes = db.query("PRAGMA index_list(tasks)").all() as { name: string; unique: number }[];
      expect(indexes).toContainEqual(expect.objectContaining({ name: "tasks_idempotency", unique: 1 }));
      store.insertTask(task({ id: "a", idempotencyKey: "k" }));
      expect(() => store.insertTask(task({ id: "b", idempotencyKey: "k" }))).toThrow();
    } finally {
      db.close();
    }
  });

  test("a migration step that fails leaves the database at the version before it, without its changes", () => {
    const path = v1Database(V1_SCHEMA_SQL);
    const raw = new Database(path);
    raw.run("PRAGMA user_version = 1");
    // Migration 2 creates machines, then fails on sessions: SQLite refuses a table named like an existing index.
    raw.run("CREATE INDEX sessions ON tasks (status)");
    raw.close();
    expect(() => openDb(path)).toThrow("there is already an index named sessions");
    const after = new Database(path, { strict: true });
    try {
      expect(version(after)).toBe(1);
      expect(tables(after)).not.toContain("machines");
      expect(new Store(after).getTask("t-1")?.instructions).toBe("old work");
    } finally {
      after.close();
    }
  });

  test("opening an upgraded database again changes nothing", () => {
    const path = v1Database(V1_SCHEMA_SQL);
    openDb(path).close();
    const db = openDb(path);
    try {
      expect(version(db)).toBe(SCHEMA_VERSION);
      expect(new Store(db).getTask("t-1")).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("a database from a newer hub is refused", () => {
    const path = v1Database(V1_SCHEMA_SQL);
    const raw = new Database(path);
    raw.run("PRAGMA user_version = 99");
    raw.close();
    expect(() => openDb(path)).toThrow(SchemaTooNewError);
  });

  test("a new database starts at the current version", () => {
    const db = openDb(":memory:");
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(2);
  });
});

describe("NetworkStore", () => {
  const at = "2026-10-20T12:00:00.000Z";
  const machine = (id: string, name: string): Machine => ({ id, owner: "owner", name, createdAt: at, lastSeenAt: null });
  const session = (id: string, machineId: string, name: string, key: string): SessionRecord => ({
    id, owner: "owner", machineId, machine: "", name, key, folder: "dialog", folderId: "f".repeat(64), createdAt: at, lastSeenAt: at,
  });

  test("session reads fill in the machine's name", () => {
    const network = new NetworkStore(openDb(":memory:"));
    network.insertMachine(machine("m1", "macbook"), "hash-1");
    network.insertSession(session("s1", "m1", "dialog-claude", "key-1"));
    expect(network.sessionByKey("m1", "key-1")).toMatchObject({ id: "s1", machine: "macbook", name: "dialog-claude" });
    expect(network.sessionByAddress("dialog-claude", "macbook")?.id).toBe("s1");
    expect(network.sessionByAddress("dialog-claude", "studio")).toBeNull();
    expect(network.machineByTokenHash("hash-1")?.name).toBe("macbook");
    expect(network.listMachines()).toEqual([expect.objectContaining({ name: "macbook", sessions: 1 })]);
  });

  test("deleting a machine deletes its sessions too, and returns them", () => {
    const network = new NetworkStore(openDb(":memory:"));
    network.insertMachine(machine("m1", "macbook"), "hash-1");
    network.insertMachine(machine("m2", "studio"), "hash-2");
    network.insertSession(session("s1", "m1", "dialog-claude", "key-1"));
    network.insertSession(session("s2", "m2", "dialog-claude", "key-2"));
    expect(network.deleteMachine("m1").map((s) => s.id)).toEqual(["s1"]);
    expect(network.machineByName("macbook")).toBeNull();
    expect(network.listSessions().map((s) => s.id)).toEqual(["s2"]);
  });

  test("a session row needs its machine", () => {
    const network = new NetworkStore(openDb(":memory:"));
    expect(() => network.insertSession(session("s1", "missing", "dialog-claude", "key-1"))).toThrow();
  });

  test("updateSession changes only the given fields; listSessions can keep only recent ones", () => {
    const network = new NetworkStore(openDb(":memory:"));
    network.insertMachine(machine("m1", "macbook"), "hash-1");
    network.insertSession(session("s1", "m1", "dialog-claude", "key-1"));
    network.insertSession({ ...session("s2", "m1", "api-claude", "key-2"), lastSeenAt: "2026-10-19T12:00:00.000Z" });
    const later = "2026-10-20T13:00:00.000Z";
    expect(network.updateSession("s1", { key: "key-3", lastSeenAt: later, folder: undefined })).toMatchObject({
      key: "key-3",
      folder: "dialog",
      lastSeenAt: later,
      machine: "macbook",
    });
    expect(() => network.updateSession("missing", { lastSeenAt: later })).toThrow("session missing not found");
    expect(network.listSessions().map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(network.listSessions("2026-10-20T00:00:00.000Z").map((s) => s.id)).toEqual(["s1"]);
  });

  test("deleteSessionsSeenBefore spares the sessions keep() accepts", () => {
    const network = new NetworkStore(openDb(":memory:"));
    network.insertMachine(machine("m1", "macbook"), "hash-1");
    const old = "2026-10-10T12:00:00.000Z";
    network.insertSession({ ...session("s1", "m1", "dialog-claude", "key-1"), lastSeenAt: old });
    network.insertSession({ ...session("s2", "m1", "api-claude", "key-2"), lastSeenAt: old });
    network.insertSession(session("s3", "m1", "web-claude", "key-3"));
    const kept: string[] = [];
    const deleted = network.deleteSessionsSeenBefore("2026-10-13T12:00:00.000Z", (address) => {
      kept.push(address);
      return address === "api-claude@macbook";
    });
    expect(deleted).toBe(1);
    expect(kept.sort()).toEqual(["api-claude@macbook", "dialog-claude@macbook"]);
    expect(network.listSessions().map((s) => s.id).sort()).toEqual(["s2", "s3"]);
  });

  test("deleteJoinCodesBefore deletes codes that expired, or were used, before the cutoff", () => {
    const network = new NetworkStore(openDb(":memory:"));
    const code = (id: string, expiresAt: string, usedAt: string | null) =>
      network.insertJoinCode({ id, owner: "owner", createdAt: at, expiresAt, usedAt }, `hash-${id}`);
    code("expired", "2026-10-19T00:00:00.000Z", null);
    code("used", "2026-10-21T12:00:00.000Z", "2026-10-19T00:00:00.000Z");
    code("used-recently", "2026-10-21T12:00:00.000Z", "2026-10-20T11:00:00.000Z");
    code("fresh", "2026-10-21T12:00:00.000Z", null);
    expect(network.deleteJoinCodesBefore("2026-10-20T00:00:00.000Z")).toBe(2);
    expect(network.joinCodeByHash("hash-expired")).toBeNull();
    expect(network.joinCodeByHash("hash-used")).toBeNull();
    expect(network.joinCodeByHash("hash-used-recently")).not.toBeNull();
    expect(network.joinCodeByHash("hash-fresh")).not.toBeNull();
  });

  test("a join code is marked used once", () => {
    const network = new NetworkStore(openDb(":memory:"));
    network.insertJoinCode({ id: "j1", owner: "owner", createdAt: at, expiresAt: "2026-10-21T12:00:00.000Z", usedAt: null }, "code-hash");
    expect(network.markJoinCodeUsed("j1", at)).toBe(true);
    expect(network.markJoinCodeUsed("j1", at)).toBe(false);
    expect(network.joinCodeByHash("code-hash")?.usedAt).toBe(at);
  });
});
