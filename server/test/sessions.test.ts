import { describe, expect, test } from "bun:test";
import { sessionBaseName } from "../src/core/sessions";
import type { StreamConnection } from "../src/ways-in/stream";
import { BASE_YAML, joinMachine, makeApp, testConfig } from "./helpers";

const F1 = "1".repeat(64);
const F2 = "2".repeat(64);

// Sessions are reached through a kind rule, as on a real network.
const YAML = BASE_YAML.replace("rules:\n", 'rules:\n  - { from: grok-bot, to: "kind:claude-code", action: allow }\n');

function app() {
  return makeApp(testConfig(YAML));
}

const fakeConn = (): StreamConnection => ({ send() {}, close() {} });

describe("session names", () => {
  test.each([
    ["dialog", "dialog-claude"],
    ["My Repo.v2", "my-repo-v2-claude"],
    ["Café", "cafe-claude"],
    ["...", "session-claude"],
    ["a".repeat(60), `${"a".repeat(40)}-claude`],
  ])("%p becomes %p", (repo, name) => expect(sessionBaseName(repo)).toBe(name));
});

describe("registration", () => {
  test("a new session gets <repo>-claude@<machine>", () => {
    const ctx = app();
    const { machine } = joinMachine(ctx, "macbook");
    const out = ctx.sessions.register(machine, { key: "key-aaaaaaaa", repo: "dialog", folderId: F1 });
    expect(out).toMatchObject({ address: "dialog-claude@macbook", inherited: false });
    expect(out.session).toMatchObject({ name: "dialog-claude", machine: "macbook", key: "key-aaaaaaaa", folder: "dialog", folderId: F1 });
    expect(ctx.network.sessionByAddress("dialog-claude", "macbook")?.id).toBe(out.session.id);
  });

  test("the same key reconnecting keeps its row and name", () => {
    const ctx = app();
    const { machine } = joinMachine(ctx, "macbook");
    const first = ctx.sessions.register(machine, { key: "key-aaaaaaaa", repo: "dialog", folderId: F1 });
    ctx.clock.advance(60_000);
    const again = ctx.sessions.register(machine, { key: "key-aaaaaaaa", repo: "dialog", folderId: F1 });
    expect(again).toMatchObject({ address: "dialog-claude@macbook", inherited: false });
    expect(again.session.id).toBe(first.session.id);
    expect(again.session.lastSeenAt).toBe(ctx.clock.now().toISOString());
    expect(ctx.network.sessionsOnMachine(machine.id)).toHaveLength(1);
  });

  test("a second live session in the same folder gets -2, and a third -3", () => {
    const ctx = app();
    const { machine } = joinMachine(ctx, "macbook");
    const a = ctx.sessions.register(machine, { key: "key-aaaaaaaa", repo: "dialog", folderId: F1 });
    ctx.streams.connect(a.address, fakeConn());
    const b = ctx.sessions.register(machine, { key: "key-bbbbbbbb", repo: "dialog", folderId: F1 });
    expect(b).toMatchObject({ address: "dialog-claude-2@macbook", inherited: false });
    ctx.streams.connect(b.address, fakeConn());
    const c = ctx.sessions.register(machine, { key: "key-cccccccc", repo: "dialog", folderId: F1 });
    expect(c).toMatchObject({ address: "dialog-claude-3@macbook", inherited: false });
  });

  test("a new session in the same folder inherits the stale name, and its working tasks go back to queued", () => {
    const ctx = app();
    const { machine } = joinMachine(ctx, "macbook");
    const a = ctx.sessions.register(machine, { key: "key-aaaaaaaa", repo: "dialog", folderId: F1 });
    expect(a.address).toBe("dialog-claude@macbook");
    const task = ctx.service.sendTask("grok-bot", { to: "dialog-claude@macbook", instructions: "Look at the login bug" });
    expect(task.status).toBe("queued");
    ctx.service.ackDeliveries("dialog-claude@macbook", { tasks: [task.id], results: [], messages: [] });
    expect(ctx.store.getTask(task.id)?.status).toBe("working");

    const b = ctx.sessions.register(machine, { key: "key-bbbbbbbb", repo: "dialog", folderId: F1 });
    expect(b).toMatchObject({ address: "dialog-claude@macbook", inherited: true });
    expect(b.session.id).toBe(a.session.id);
    expect(b.session.key).toBe("key-bbbbbbbb");
    expect(ctx.network.sessionByKey(machine.id, "key-aaaaaaaa")).toBeNull();
    expect(ctx.store.getTask(task.id)?.status).toBe("queued");
  });

  test("inheritance prefers the shortest stale name in the folder", () => {
    const ctx = app();
    const { machine } = joinMachine(ctx, "macbook");
    const a = ctx.sessions.register(machine, { key: "key-aaaaaaaa", repo: "dialog", folderId: F1 });
    const closeA = ctx.streams.connect(a.address, fakeConn());
    const b = ctx.sessions.register(machine, { key: "key-bbbbbbbb", repo: "dialog", folderId: F1 });
    const closeB = ctx.streams.connect(b.address, fakeConn());
    const c = ctx.sessions.register(machine, { key: "key-cccccccc", repo: "dialog", folderId: F1 });
    const closeC = ctx.streams.connect(c.address, fakeConn());
    expect([a.address, b.address, c.address]).toEqual([
      "dialog-claude@macbook",
      "dialog-claude-2@macbook",
      "dialog-claude-3@macbook",
    ]);
    closeA();
    closeB();
    closeC();
    // -3 was seen most recently, then -2; the base name was seen longest ago but is the shortest, so it goes first.
    ctx.clock.advance(60_000);
    ctx.sessions.seen(b.session.id);
    ctx.clock.advance(60_000);
    ctx.sessions.seen(c.session.id);
    const d = ctx.sessions.register(machine, { key: "key-dddddddd", repo: "dialog", folderId: F1 });
    expect(d).toMatchObject({ address: "dialog-claude@macbook", inherited: true });
    ctx.streams.connect(d.address, fakeConn());
    // Between names of the same length, the most recently seen goes first.
    const e = ctx.sessions.register(machine, { key: "key-eeeeeeee", repo: "dialog", folderId: F1 });
    expect(e).toMatchObject({ address: "dialog-claude-3@macbook", inherited: true });
  });

  test("a stale session from a different folder with the same basename keeps its name", () => {
    const ctx = app();
    const { machine } = joinMachine(ctx, "macbook");
    const a = ctx.sessions.register(machine, { key: "key-aaaaaaaa", repo: "app", folderId: F1 });
    expect(a.address).toBe("app-claude@macbook");
    expect(ctx.streams.isConnected(a.address)).toBe(false);
    const b = ctx.sessions.register(machine, { key: "key-bbbbbbbb", repo: "app", folderId: F2 });
    expect(b).toMatchObject({ address: "app-claude-2@macbook", inherited: false });
    expect(ctx.network.sessionByAddress("app-claude", "macbook")?.key).toBe("key-aaaaaaaa");
  });

  test("the same repo on two machines gets the same name on each", () => {
    const ctx = app();
    const macbook = joinMachine(ctx, "macbook").machine;
    const studio = joinMachine(ctx, "studio").machine;
    const one = ctx.sessions.register(macbook, { key: "key-aaaaaaaa", repo: "dialog", folderId: F1 });
    ctx.streams.connect(one.address, fakeConn());
    const two = ctx.sessions.register(studio, { key: "key-aaaaaaaa", repo: "dialog", folderId: F1 });
    expect(one.address).toBe("dialog-claude@macbook");
    expect(two).toMatchObject({ address: "dialog-claude@studio", inherited: false });
  });

  test("seen() writes last_seen_at, and does nothing once the session's row is gone", () => {
    const ctx = app();
    const { machine } = joinMachine(ctx, "macbook");
    const a = ctx.sessions.register(machine, { key: "key-aaaaaaaa", repo: "dialog", folderId: F1 });
    ctx.clock.advance(60_000);
    ctx.sessions.seen(a.session.id);
    expect(ctx.network.sessionByAddress("dialog-claude", "macbook")?.lastSeenAt).toBe(ctx.clock.now().toISOString());
    ctx.networkService.removeMachine("macbook");
    expect(() => ctx.sessions.seen(a.session.id)).not.toThrow();
  });
});

describe("registration input", () => {
  test("parseRegistration checks the key, the folder ID and the repo, defaulting the repo to session", async () => {
    const { parseRegistration } = await import("../src/core/sessions");
    expect(parseRegistration("key-aaaaaaaa", F1, undefined)).toEqual({ key: "key-aaaaaaaa", repo: "session", folderId: F1 });
    expect(parseRegistration("key-aaaaaaaa", F1, "dialog")).toEqual({ key: "key-aaaaaaaa", repo: "dialog", folderId: F1 });
    // Only the last path segment is kept, as in status reports.
    expect(parseRegistration("key-aaaaaaaa", F1, "/Users/x/dialog").repo).toBe("dialog");
    expect(parseRegistration("key-aaaaaaaa", F1, "C:\\work\\api\\").repo).toBe("api");
    expect(parseRegistration("key-aaaaaaaa", F1, "/").repo).toBe("session");
    const bad = (key: unknown, folderId: unknown, repo: unknown) => {
      try {
        parseRegistration(key, folderId, repo);
      } catch (err) {
        return (err as { code?: string }).code;
      }
      return null;
    };
    expect(bad(undefined, F1, "dialog")).toBe("bad_request");
    expect(bad("short", F1, "dialog")).toBe("bad_request");
    expect(bad("key with spaces", F1, "dialog")).toBe("bad_request");
    expect(bad("k".repeat(101), F1, "dialog")).toBe("bad_request");
    expect(bad("key-aaaaaaaa", undefined, "dialog")).toBe("bad_request");
    expect(bad("key-aaaaaaaa", "A".repeat(64), "dialog")).toBe("bad_request");
    expect(bad("key-aaaaaaaa", "1".repeat(63), "dialog")).toBe("bad_request");
    expect(bad("key-aaaaaaaa", F1, "r".repeat(201))).toBe("bad_request");
    expect(bad("key-aaaaaaaa", F1, "r".repeat(200))).toBeNull();
  });
});
