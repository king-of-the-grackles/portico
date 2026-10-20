import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, Store } from "../src/db";
import type { Task } from "../src/core/types";

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
    expect(store.hasWaitingFor("claude-code")).toBe(false);
    store.insertTask(task());
    expect(store.hasWaitingFor("claude-code")).toBe(true);
    expect(store.hasWaitingFor("grok-bot")).toBe(false);
    store.updateTask("t1", { status: "done", result: "ok" });
    expect(store.hasWaitingFor("claude-code")).toBe(false);
    expect(store.hasWaitingFor("grok-bot")).toBe(true);
    store.updateTask("t1", { senderNotifiedAt: "2026-10-20T13:00:00.000Z" });
    expect(store.hasWaitingFor("grok-bot")).toBe(false);
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
