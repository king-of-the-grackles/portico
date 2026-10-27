import { describe, expect, test } from "bun:test";
import type { Task } from "../src/core/types";
import { captureLogs } from "../src/log";
import { makeNotifier } from "../src/notifier";
import { type StreamChange, AgentStreams } from "../src/ways-in/stream";
import { T0, TOKENS, callAs, fakeConnection, flush, joinMachine, makeApp, mintAssistant, openSessionStream, sseReader } from "./helpers";

const AGENT_HELLO = { event: "hello", data: { address: "claude-code", name: "claude-code", machine: null } };

describe("AgentStreams", () => {
  test("delivers nudges to the agent's open stream", () => {
    const hub = new AgentStreams();
    expect(hub.nudge("claude-code")).toBe(false);
    const { conn, sent } = fakeConnection();
    hub.connect("claude-code", conn);
    expect(hub.isConnected("claude-code")).toBe(true);
    expect(hub.nudge("claude-code")).toBe(true);
    expect(sent).toEqual([{ event: "nudge", data: {} }]);
  });

  test("a new stream replaces the old one, which is told and closed", () => {
    const hub = new AgentStreams();
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
    const hub = new AgentStreams();
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
    const hub = new AgentStreams();
    const { conn, sent, isClosed } = fakeConnection();
    hub.connect("dialog-claude@macbook", conn, "quiet");
    hub.close("dialog-claude@macbook");
    expect(isClosed()).toBe(true);
    expect(sent).toEqual([]);
    expect(hub.isConnected("dialog-claude@macbook")).toBe(false);
    hub.close("dialog-claude@macbook"); // nothing left to close
  });

  test("a stream that fails to send is dropped", () => {
    const hub = new AgentStreams();
    const { conn } = fakeConnection();
    hub.connect("claude-code", conn);
    conn.close();
    expect(hub.nudge("claude-code")).toBe(false);
    expect(hub.isConnected("claude-code")).toBe(false);
  });

  test("popupSessions lists a machine's pop-up sessions, oldest connection first; popupMachines lists machines with one", () => {
    const hub = new AgentStreams();
    const popup = { machine: "macbook", popup: true };
    hub.connect("web-claude@macbook", fakeConnection().conn, "quiet", popup);
    hub.connect("api-claude@macbook", fakeConnection().conn, "quiet", popup);
    hub.connect("cli-claude@mini", fakeConnection().conn, "quiet", { machine: "mini", popup: false });
    hub.connect("claude-code", fakeConnection().conn);
    expect(hub.popupSessions("macbook")).toEqual(["web-claude@macbook", "api-claude@macbook"]);
    expect(hub.popupSessions("mini")).toEqual([]);
    expect(hub.popupMachines()).toEqual(["macbook"]);
    hub.connect("web-claude@macbook", fakeConnection().conn, "quiet", popup); // a reconnect is a newer connection
    expect(hub.popupSessions("macbook")).toEqual(["api-claude@macbook", "web-claude@macbook"]);
  });

  test("a stream with no machine never counts as a pop-up session, whatever it declares", () => {
    const hub = new AgentStreams();
    hub.connect("claude-code", fakeConnection().conn, "notify", { machine: null, popup: true });
    expect(hub.popupMachines()).toEqual([]);
  });

  test("onChange reports opened for every connection, and closed only when the address loses its stream", () => {
    const hub = new AgentStreams();
    const changes: StreamChange[] = [];
    hub.onChange((change) => changes.push(change));
    const info = { machine: "macbook", popup: true };
    const endFirst = hub.connect("api-claude@macbook", fakeConnection().conn, "quiet", info);
    const endSecond = hub.connect("api-claude@macbook", fakeConnection().conn, "quiet", info);
    endFirst(); // the replaced stream ending changes nothing
    endSecond();
    const dead = fakeConnection();
    hub.connect("web-claude@macbook", dead.conn, "quiet", info);
    dead.conn.close();
    expect(hub.send("web-claude@macbook", "nudge", {})).toBe(false); // a failed send drops the stream
    hub.connect("cli-claude@macbook", fakeConnection().conn, "quiet", info);
    hub.close("cli-claude@macbook");
    expect(changes.map((change) => `${change.kind} ${change.address}`)).toEqual([
      "opened api-claude@macbook",
      "opened api-claude@macbook",
      "closed api-claude@macbook",
      "opened web-claude@macbook",
      "closed web-claude@macbook",
      "opened cli-claude@macbook",
      "closed cli-claude@macbook",
    ]);
    expect(changes[0]).toEqual({ kind: "opened", address: "api-claude@macbook", machine: "macbook", popup: true });
  });

  test("closeAll forgets every stream it names before reporting any of them closed", () => {
    const hub = new AgentStreams();
    const info = { machine: "macbook", popup: true };
    const one = fakeConnection();
    const two = fakeConnection();
    hub.connect("api-claude@macbook", one.conn, "quiet", info);
    hub.connect("web-claude@macbook", two.conn, "quiet", info);
    hub.connect("notes-claude@studio", fakeConnection().conn, "quiet", { machine: "studio", popup: true });
    const seen: string[] = [];
    hub.onChange((change) => seen.push(`${change.kind} ${change.address} [${hub.popupSessions("macbook").join(", ")}]`));
    hub.closeAll(["api-claude@macbook", "web-claude@macbook", "gone-claude@macbook"]);
    expect(seen).toEqual(["closed api-claude@macbook []", "closed web-claude@macbook []"]);
    expect(one.isClosed()).toBe(true);
    expect(two.isClosed()).toBe(true);
    expect(hub.popupMachines()).toEqual(["studio"]);
  });

  test("a listener that throws is logged and never stops the others or the hub", () => {
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    try {
      const hub = new AgentStreams();
      const later: string[] = [];
      hub.onChange(() => {
        throw new TypeError("listener bug");
      });
      hub.onChange((change) => later.push(`${change.kind} ${change.address}`));
      const { conn, sent } = fakeConnection();
      hub.connect("claude-code", conn);
      expect(hub.nudge("claude-code")).toBe(true);
      expect(sent).toEqual([{ event: "nudge", data: {} }]);
      expect(later).toEqual(["opened claude-code"]);
    } finally {
      captureLogs(null);
    }
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toContainEqual(expect.objectContaining({ level: "error", msg: "stream_listener_failed", error: "TypeError" }));
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

  test("calls approvalNeeded once an ask task is committed, and approvalDecided with the outcome", async () => {
    const { service, store, directory, streams } = makeApp();
    const calls: string[] = [];
    const notify = makeNotifier({
      store,
      directory,
      streams,
      approvalNeeded: (task) => calls.push(`needed ${task.id}`),
      approvalDecided: (task, outcome) => calls.push(`${outcome} ${task.id}`),
    });
    const task = service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    notify({ kind: "approval_needed", task });
    expect(calls).toEqual([]); // only after the current transaction
    await flush();
    notify({ kind: "approval_decided", task: service.approveTask(task.id), outcome: "approved" });
    await flush();
    expect(calls).toEqual([`needed ${task.id}`, `approved ${task.id}`]);
  });

  test("skips a notice whose task isn't in the database, because its transaction rolled back", async () => {
    const { store, directory, streams } = makeApp();
    const claude = fakeConnection();
    streams.connect("claude-code", claude.conn);
    let needed = 0;
    const notify = makeNotifier({ store, directory, streams, approvalNeeded: () => needed++ });
    const at = T0.toISOString();
    const ghost: Task = {
      id: "ghost", fromAgent: "grok-bot", toAgent: "claude-code", instructions: "x", status: "queued",
      result: null, reason: null, parentTaskId: null, chainLength: 1, eventId: null, triggerName: null,
      senderNotifiedAt: null, createdAt: at, updatedAt: at, expiresAt: at, idempotencyKey: null,
    };
    notify({ kind: "queued", task: ghost });
    notify({ kind: "approval_needed", task: { ...ghost, status: "waiting_approval" } });
    await flush();
    expect(claude.sent).toEqual([]);
    expect(needed).toBe(0);
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
      headers: { authorization: `Bearer ${token}`, "x-portico-folder": "a".repeat(64) },
    });
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: "bad_request" });
    const noFolder = await ctx.app.request("/api/stream?repo=dialog", {
      headers: { authorization: `Bearer ${token}`, "x-portico-session": "key-aaaaaaaa" },
    });
    expect(noFolder.status).toBe(400);
    expect(await noFolder.json()).toMatchObject({ error: "bad_request" });
    expect(ctx.network.listSessions()).toEqual([]);
  });

  test("a portico.yaml push agent still gets hello, and is still replaced by its own second stream", async () => {
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

  test("a machine's stream opened with X-Portico-Popup: 1 counts as a pop-up session", async () => {
    const ctx = makeApp();
    const { token } = joinMachine(ctx);
    const plain = await openSessionStream(ctx, token, { key: "key-plain-0001", repo: "api" });
    const popup = await openSessionStream(ctx, token, { key: "key-popup-0001", repo: "web", folderId: "b".repeat(64), popup: true });
    try {
      expect(ctx.streams.popupSessions("macbook")).toEqual(["web-claude@macbook"]);
    } finally {
      await plain.events.cancel();
      await popup.events.cancel();
    }
  });

  test("a portico.yaml agent's X-Portico-Popup is ignored", async () => {
    const ctx = makeApp();
    const res = await ctx.app.request("/api/stream", {
      headers: { authorization: `Bearer ${TOKENS["claude-code"]}`, "x-portico-popup": "1" },
    });
    const events = sseReader(res);
    try {
      expect(await events.next()).toEqual(AGENT_HELLO);
      expect(ctx.streams.isConnected("claude-code")).toBe(true);
      expect(ctx.streams.popupMachines()).toEqual([]);
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
