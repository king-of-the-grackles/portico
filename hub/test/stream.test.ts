import { describe, expect, test } from "bun:test";
import type { PushMessage } from "../src/approvals/ntfy";
import type { Task } from "../src/core/types";
import { makeNotifier } from "../src/notifier";
import { type StreamConnection, StreamHub } from "../src/ways-in/stream";
import { captureLogs } from "../src/log";
import { T0, callAs, flush, joinMachine, makeApp, mintAssistant, openSessionStream, sseReader } from "./helpers";

const AGENT_HELLO = { event: "hello", data: { address: "claude-code", name: "claude-code", machine: null } };

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

  test("a quiet replacement closes the old stream without telling it", () => {
    const hub = new StreamHub();
    const first = fakeConnection();
    const second = fakeConnection();
    hub.connect("dialog-claude@macbook", first.conn, "quiet");
    hub.connect("dialog-claude@macbook", second.conn, "quiet");
    expect(first.sent).toEqual([]);
    expect(first.isClosed()).toBe(true);
    expect(hub.nudge("dialog-claude@macbook")).toBe(true);
    expect(second.sent).toEqual([{ event: "nudge", data: {} }]);
  });

  test("close() closes and forgets an address's stream", () => {
    const hub = new StreamHub();
    const { conn, sent, isClosed } = fakeConnection();
    hub.connect("dialog-claude@macbook", conn, "quiet");
    hub.close("dialog-claude@macbook");
    expect(isClosed()).toBe(true);
    expect(sent).toEqual([]);
    expect(hub.isConnected("dialog-claude@macbook")).toBe(false);
    hub.close("dialog-claude@macbook"); // nothing left to close
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

  test("nudges a push receiver when a message is queued, unless it was delivered first", async () => {
    const { service, streams } = makeApp();
    const claude = fakeConnection();
    streams.connect("claude-code", claude.conn);
    const muse = fakeConnection();
    streams.connect("muse", muse.conn); // a pull member: never nudged
    service.sendMessage("grok-bot", { to: "claude-code", text: "x" });
    service.sendMessage("grok-bot", { to: "muse", text: "y" });
    await flush();
    expect(claude.sent).toEqual([{ event: "nudge", data: {} }]);
    expect(muse.sent).toEqual([]);

    const { message } = service.sendMessage("grok-bot", { to: "claude-code", text: "z" });
    service.ackDeliveries("claude-code", { tasks: [], results: [], messages: [message.id] });
    await flush();
    expect(claude.sent).toHaveLength(1);
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
      expect(await events.next()).toEqual(AGENT_HELLO);
      expect(await events.next()).toEqual({ event: "nudge", data: {} });
      service.sendTask("grok-bot", { to: "claude-code", instructions: "second" });
      expect(await events.next()).toEqual({ event: "nudge", data: {} });
    } finally {
      await events.cancel();
    }
  });

  test("nudges on connect when a message is waiting", async () => {
    const { call, service } = makeApp();
    service.sendMessage("muse", { to: "claude-code", text: "While you were out" });
    const events = sseReader(await call("claude-code", "GET", "/api/stream"));
    try {
      expect(await events.next()).toEqual(AGENT_HELLO);
      expect(await events.next()).toEqual({ event: "nudge", data: {} });
    } finally {
      await events.cancel();
    }
  });

  test("stays quiet on connect when nothing is waiting, apart from the hello and heartbeats", async () => {
    const { call } = makeApp();
    const events = sseReader(await call("claude-code", "GET", "/api/stream"));
    try {
      expect(await events.next()).toEqual(AGENT_HELLO);
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
      expect(await first.next()).toEqual(AGENT_HELLO);
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

describe("session streams", () => {
  test("a machine token registers the session on connect and says hello with its address", async () => {
    const ctx = makeApp();
    const { token } = joinMachine(ctx, "macbook");
    const { hello, events } = await openSessionStream(ctx, token, { key: "key-aaaaaaaa", repo: "dialog" });
    expect(hello).toEqual({ address: "dialog-claude@macbook", name: "dialog-claude", machine: "macbook" });
    expect(ctx.streams.isConnected("dialog-claude@macbook")).toBe(true);
    await events.cancel();
  });

  test("two sessions on one machine hold separate streams, and neither is replaced", async () => {
    const ctx = makeApp();
    const { token } = joinMachine(ctx, "macbook");
    const one = await openSessionStream(ctx, token, { key: "key-aaaaaaaa", repo: "dialog", folderId: "1".repeat(64) });
    const two = await openSessionStream(ctx, token, { key: "key-bbbbbbbb", repo: "dialog", folderId: "1".repeat(64) });
    try {
      expect(one.hello.address).toBe("dialog-claude@macbook");
      expect(two.hello.address).toBe("dialog-claude-2@macbook");
      expect(ctx.streams.isConnected("dialog-claude@macbook")).toBe(true);
      expect(ctx.streams.isConnected("dialog-claude-2@macbook")).toBe(true);
      await expect(one.events.next(200)).rejects.toThrow("timed out");
      await expect(two.events.next(50)).rejects.toThrow("timed out");
    } finally {
      await one.events.cancel();
      await two.events.cancel();
    }
  });

  test("the same session reconnecting closes its old stream without a replaced event", async () => {
    const ctx = makeApp();
    const { token } = joinMachine(ctx, "macbook");
    const first = await openSessionStream(ctx, token, { key: "key-aaaaaaaa", repo: "dialog" });
    const second = await openSessionStream(ctx, token, { key: "key-aaaaaaaa", repo: "dialog" });
    try {
      expect(second.hello.address).toBe("dialog-claude@macbook");
      // Any event at all, "replaced" included, would be returned here instead of the stream ending.
      await expect(first.events.next()).rejects.toThrow("stream ended");
      expect(ctx.streams.isConnected("dialog-claude@macbook")).toBe(true);
    } finally {
      await second.events.cancel();
    }
  });

  test("a machine stream without the session or folder header is refused with 400", async () => {
    const ctx = makeApp();
    const { token } = joinMachine(ctx, "macbook");
    const noKey = await ctx.app.request("/api/stream?repo=dialog", {
      headers: { authorization: `Bearer ${token}`, "x-bridge-folder": "a".repeat(64) },
    });
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: "bad_request" });
    const noFolder = await ctx.app.request("/api/stream?repo=dialog", {
      headers: { authorization: `Bearer ${token}`, "x-bridge-session": "key-aaaaaaaa" },
    });
    expect(noFolder.status).toBe(400);
    expect(await noFolder.json()).toMatchObject({ error: "bad_request" });
    expect(ctx.network.listSessions()).toEqual([]);
  });

  test("a bridge.yaml push agent still gets hello, and is still replaced by its own second stream", async () => {
    const { call } = makeApp();
    const first = sseReader(await call("claude-code", "GET", "/api/stream"));
    expect(await first.next()).toEqual(AGENT_HELLO);
    const second = sseReader(await call("claude-code", "GET", "/api/stream"));
    try {
      expect(await second.next()).toEqual(AGENT_HELLO);
      expect(await first.next()).toEqual({ event: "replaced", data: {} });
      await expect(first.next()).rejects.toThrow("stream ended");
    } finally {
      await second.cancel();
    }
  });

  test("an assistant's token can't open a stream", async () => {
    const ctx = makeApp();
    const { token } = mintAssistant(ctx, "helper");
    const res = await callAs(ctx, { token }, "GET", "/api/stream");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_allowed", message: "Only push agents can open the live stream." });
  });

  test("REST calls with the machine token and the key act as the session; an unknown key gets 401", async () => {
    const ctx = makeApp();
    const { token } = joinMachine(ctx, "macbook");
    // Before the stream registers the key, it means nothing.
    expect((await callAs(ctx, { token, key: "key-aaaaaaaa" }, "GET", "/api/agents")).status).toBe(401);
    const { events } = await openSessionStream(ctx, token, { key: "key-aaaaaaaa", repo: "dialog" });
    try {
      const res = await callAs(ctx, { token, key: "key-aaaaaaaa" }, "GET", "/api/agents");
      expect(res.status).toBe(200);
      const { agents } = (await res.json()) as { agents: { name: string }[] };
      expect(agents.map((agent) => agent.name)).toContain("claude-code");
      expect(agents.map((agent) => agent.name)).not.toContain("dialog-claude@macbook");
      expect((await callAs(ctx, { token, key: "nope-nope-1" }, "GET", "/api/agents")).status).toBe(401);
      // A machine token alone serves only the stream.
      expect((await callAs(ctx, { token }, "GET", "/api/agents")).status).toBe(401);
    } finally {
      await events.cancel();
    }
  });

  test("closing a session's stream writes its last_seen_at", async () => {
    const ctx = makeApp();
    const { token } = joinMachine(ctx, "macbook");
    const { events } = await openSessionStream(ctx, token, { key: "key-aaaaaaaa", repo: "dialog" });
    ctx.clock.advance(5 * 60_000);
    await events.cancel();
    const deadline = Date.now() + 2000;
    while (ctx.streams.isConnected("dialog-claude@macbook") && Date.now() < deadline) await Bun.sleep(5);
    expect(ctx.streams.isConnected("dialog-claude@macbook")).toBe(false);
    expect(ctx.network.sessionByAddress("dialog-claude", "macbook")?.lastSeenAt).toBe(ctx.clock.now().toISOString());
  });
});
