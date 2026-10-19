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
    ...overrides,
  };
}

let store: Store;
beforeEach(() => {
  store = new Store(openDb(":memory:"));
});

describe("Store: tasks", () => {
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
