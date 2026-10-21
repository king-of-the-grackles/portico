import { describe, expect, test } from "bun:test";
import type { PushMessage } from "../src/approvals/ntfy";
import type { Task } from "../src/core/types";
import { makeNotifier } from "../src/notifier";
import { type StreamConnection, StreamHub } from "../src/ways-in/stream";
import { captureLogs } from "../src/log";
import { T0, flush, makeApp, sseReader } from "./helpers";

function fakeConnection() {
  const sent: { event: string; data: Record<string, unknown> }[] = [];
  let closed = false;
  const conn: StreamConnection = {
    send: (event, data) => {
      if (closed) throw new Error("closed");
      sent.push({ event, data });
    },
    close: () => {
      closed = true;
    },
  };
  return { conn, sent, isClosed: () => closed };
}

describe("StreamHub", () => {
  test("delivers nudges and permission answers to the agent's open stream", () => {
    const hub = new StreamHub();
    expect(hub.nudge("claude-code")).toBe(false);
    const { conn, sent } = fakeConnection();
    hub.connect("claude-code", conn);
    expect(hub.isConnected("claude-code")).toBe(true);
    expect(hub.nudge("claude-code")).toBe(true);
    expect(hub.sendPermissionAnswer("claude-code", "abcde", "allow")).toBe(true);
    expect(sent).toEqual([
      { event: "nudge", data: {} },
      { event: "permission", data: { request_id: "abcde", behavior: "allow" } },
    ]);
  });

  test("a new stream replaces the old one, which is told and closed", () => {
    const hub = new StreamHub();
    const first = fakeConnection();
    const second = fakeConnection();
    const disconnectFirst = hub.connect("claude-code", first.conn);
    hub.connect("claude-code", second.conn);
    expect(first.sent).toEqual([{ event: "replaced", data: {} }]);
    expect(first.isClosed()).toBe(true);
    disconnectFirst(); // the old stream ending must not drop the new one
    expect(hub.nudge("claude-code")).toBe(true);
    expect(second.sent).toEqual([{ event: "nudge", data: {} }]);
  });

  test("a stream that fails to send is dropped", () => {
    const hub = new StreamHub();
    const { conn } = fakeConnection();
    hub.connect("claude-code", conn);
    conn.close();
    expect(hub.nudge("claude-code")).toBe(false);
    expect(hub.isConnected("claude-code")).toBe(false);
  });
});

describe("notifier", () => {
  test("nudges a push receiver when a task is queued, and a push sender when its result is ready", async () => {
    const { service, streams } = makeApp();
    const claude = fakeConnection();
    streams.connect("claude-code", claude.conn);
    service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
    expect(claude.sent).toEqual([]); // only after the service call has returned
    await flush();
    expect(claude.sent).toEqual([{ event: "nudge", data: {} }]);

    const sent = service.sendTask("claude-code", { to: "grok-bot", instructions: "y" });
    service.checkInbox("grok-bot");
    service.finishTask("grok-bot", { taskId: sent.id, result: "done" });
    await flush();
    expect(claude.sent).toEqual([
      { event: "nudge", data: {} },
      { event: "nudge", data: {} },
    ]);
  });

  test("sends an approval push for an ask pair", async () => {
    const { service, pushes } = makeApp();
    service.sendTask("grok-bot", { to: "muse", instructions: "Summarize the inbox" });
    expect(pushes).toEqual([]);
    await flush();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.title).toBe("grok-bot → muse");
  });

  test("skips a notice whose task isn't in the database, because its transaction rolled back", async () => {
    const { store, config, directory, streams } = makeApp();
    const pushes: PushMessage[] = [];
    const notify = makeNotifier({ store, config, directory, streams, push: async (m) => (pushes.push(m), true) });
    const at = T0.toISOString();
    const ghost: Task = {
      id: "ghost", fromAgent: "grok-bot", toAgent: "muse", instructions: "x", status: "waiting_approval",
      result: null, reason: null, parentTaskId: null, chainLength: 1, eventId: null, triggerName: null,
      senderNotifiedAt: null, createdAt: at, updatedAt: at, expiresAt: at, idempotencyKey: null,
    };
    notify({ kind: "approval_needed", task: ghost });
    await flush();
    expect(pushes).toEqual([]);
  });
});

describe("push failures", () => {
  test("a push that rejects is logged as an error and causes no unhandled rejection", async () => {
    const ctx = makeApp();
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    const notify = makeNotifier({
      store: ctx.store, config: ctx.config, directory: ctx.directory, streams: ctx.streams,
      push: async () => {
        throw new TypeError("boom SECRET");
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    try {
      notify({ kind: "approval_needed", task: ctx.store.getTask(task.id)! });
      await flush();
      await flush();
    } finally {
      captureLogs(null);
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
    const entries = lines.map((line) => JSON.parse(line));
    expect(entries).toContainEqual(
      expect.objectContaining({ level: "error", msg: "approval_push_failed", task_id: task.id, error: "TypeError" }),
    );
    expect(lines.join("\n")).not.toContain("SECRET");
  });

  test("with ntfy off, a push that sends nothing logs no failure", async () => {
    const ctx = makeApp();
    expect(ctx.config.ntfy).toBeNull();
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    const notify = makeNotifier({
      store: ctx.store, config: ctx.config, directory: ctx.directory, streams: ctx.streams, push: async () => false,
    });
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    try {
      notify({ kind: "approval_needed", task: ctx.store.getTask(task.id)! });
      await flush();
    } finally {
      captureLogs(null);
    }
    expect(lines.filter((line) => line.includes("push_failed"))).toEqual([]);
  });
});

describe("GET /api/stream", () => {
  test("needs a token and is only for push agents", async () => {
    const { call } = makeApp();
    expect((await call(null, "GET", "/api/stream")).status).toBe(401);
    const res = await call("muse", "GET", "/api/stream");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_allowed", message: "Only push agents can open the live stream." });
  });

  test("nudges on connect when something is waiting, then on each new task", async () => {
    const { call, service } = makeApp();
    service.sendTask("grok-bot", { to: "claude-code", instructions: "first" });
    const res = await call("claude-code", "GET", "/api/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = sseReader(res);
    try {
      expect(await events.next()).toEqual({ event: "nudge", data: {} });
      service.sendTask("grok-bot", { to: "claude-code", instructions: "second" });
      expect(await events.next()).toEqual({ event: "nudge", data: {} });
    } finally {
      await events.cancel();
    }
  });

  test("stays quiet on connect when nothing is waiting, apart from heartbeats", async () => {
    const { call } = makeApp();
    const events = sseReader(await call("claude-code", "GET", "/api/stream"));
    try {
      await expect(events.next(200)).rejects.toThrow("timed out");
    } finally {
      await events.cancel();
    }
  });

  test("a second stream replaces the first, which ends", async () => {
    const { call } = makeApp();
    const first = sseReader(await call("claude-code", "GET", "/api/stream"));
    await flush();
    const second = sseReader(await call("claude-code", "GET", "/api/stream"));
    try {
      expect(await first.next()).toEqual({ event: "replaced", data: {} });
      await expect(first.next()).rejects.toThrow("stream ended");
    } finally {
      await second.cancel();
    }
  });

  test("opens with a ': connected' comment, then sends ': ping' heartbeats", async () => {
    const { call } = makeApp();
    const res = await call("claude-code", "GET", "/api/stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      const deadline = Date.now() + 1000;
      while (!text.includes(": ping") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    expect(text.startsWith(": connected\n\n")).toBe(true);
    expect(text).toContain(": ping\n\n");
  });
});
