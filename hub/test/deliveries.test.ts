import { describe, expect, test } from "bun:test";
import type { Task } from "../src/core/types";
import { addSession, BASE_YAML, makeApp, testConfig } from "./helpers";

const json = async (res: Response) => (await res.json()) as any;

describe("deliveries for push agents", () => {
  test("a session is a push member: its plugin reads the session's own deliveries", async () => {
    const yaml = BASE_YAML.replace("rules:\n", 'rules:\n  - { from: grok-bot, to: "kind:claude-code", action: allow }\n');
    const ctx = makeApp(testConfig(yaml));
    const { token } = ctx.networkService.redeemJoinCode(ctx.networkService.createJoinCode().code, "macbook");
    addSession(ctx, { name: "dialog-claude", machine: "macbook", key: "key-12345678" });
    const task = ctx.service.sendTask("grok-bot", { to: "dialog-claude", instructions: "Fix the login bug" });
    const res = await ctx.app.request("/api/deliveries", {
      headers: { authorization: `Bearer ${token}`, "x-bridge-session": "key-12345678" },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).tasks.map((t: any) => t.id)).toEqual([task.id]);
  });

  test("list queued tasks and unseen results with framed messages, and change nothing", async () => {
    const ctx = makeApp();
    const task = ctx.service.sendTask("grok-bot", { to: "claude-code", instructions: "Write the changelog" });
    const first = await json(await ctx.call("claude-code", "GET", "/api/deliveries"));
    expect(first.tasks.map((t: any) => t.id)).toEqual([task.id]);
    expect(first.tasks[0].framed_message).toStartWith(`<bridge-task id="${task.id}" from="grok-bot">`);
    expect(first.results).toEqual([]);
    expect(first.messages).toEqual([]);
    expect(ctx.service.findTask(task.id)?.status).toBe("queued");
    expect((await json(await ctx.call("claude-code", "GET", "/api/deliveries"))).tasks).toHaveLength(1);
  });

  test("an ack claims the tasks and marks the results seen", async () => {
    const ctx = makeApp();
    const incoming = ctx.service.sendTask("grok-bot", { to: "claude-code", instructions: "Do it" });
    const sent = ctx.service.sendTask("claude-code", { to: "grok-bot", instructions: "Look it up" });
    ctx.service.checkInbox("grok-bot");
    ctx.service.finishTask("grok-bot", { taskId: sent.id, result: "Found: Friday" });
    const d = await json(await ctx.call("claude-code", "GET", "/api/deliveries"));
    expect(d.results[0].framed_message).toStartWith(`<bridge-result task_id="${sent.id}" from="grok-bot" status="done">`);
    const res = await ctx.call("claude-code", "POST", "/api/deliveries/ack", { tasks: [incoming.id], results: [sent.id] });
    expect(await json(res)).toEqual({ acked: { tasks: 1, results: 1, messages: 0 } });
    expect(ctx.service.findTask(incoming.id)?.status).toBe("working");
    expect(ctx.service.findTask(sent.id)?.senderNotifiedAt).not.toBeNull();
    expect(await json(await ctx.call("claude-code", "GET", "/api/deliveries"))).toEqual({ tasks: [], results: [], messages: [] });
  });

  test("an ack ignores IDs that aren't the caller's or aren't in the right state, and a repeat ack is harmless", async () => {
    const ctx = makeApp();
    const other = ctx.service.sendTask("claude-code", { to: "grok-bot", instructions: "For grok" });
    const mine = ctx.service.sendTask("grok-bot", { to: "claude-code", instructions: "Mine" });
    const ack = { tasks: [other.id, mine.id, "missing"], results: [other.id] };
    expect((await json(await ctx.call("claude-code", "POST", "/api/deliveries/ack", ack))).acked).toEqual({ tasks: 1, results: 0, messages: 0 });
    expect((await json(await ctx.call("claude-code", "POST", "/api/deliveries/ack", ack))).acked).toEqual({ tasks: 0, results: 0, messages: 0 });
    expect(ctx.service.findTask(other.id)?.status).toBe("queued");
  });

  test("the list holds at most 500 of each kind, so one ack always covers it", async () => {
    const ctx = makeApp();
    const at = "2026-10-20T12:00:00.000Z";
    const base: Omit<Task, "id" | "fromAgent" | "toAgent" | "status"> = {
      instructions: "x",
      result: null,
      reason: null,
      parentTaskId: null,
      chainLength: 1,
      eventId: null,
      triggerName: null,
      senderNotifiedAt: null,
      createdAt: at,
      updatedAt: at,
      expiresAt: "2026-10-21T12:00:00.000Z",
      idempotencyKey: null,
    };
    ctx.store.transaction(() => {
      for (let i = 0; i < 501; i++) {
        ctx.store.insertTask({ ...base, id: `in-${i}`, fromAgent: "grok-bot", toAgent: "claude-code", status: "queued" });
        ctx.store.insertTask({ ...base, id: `out-${i}`, fromAgent: "claude-code", toAgent: "grok-bot", status: "done", result: "ok" });
      }
    });
    const d = await json(await ctx.call("claude-code", "GET", "/api/deliveries"));
    expect(d.tasks).toHaveLength(500);
    expect(d.results).toHaveLength(500);
    const ack = { tasks: d.tasks.map((t: any) => t.id), results: d.results.map((t: any) => t.id) };
    const res = await ctx.call("claude-code", "POST", "/api/deliveries/ack", ack);
    expect(res.status).toBe(200);
    expect((await json(res)).acked).toEqual({ tasks: 500, results: 500, messages: 0 });
    const rest = await json(await ctx.call("claude-code", "GET", "/api/deliveries"));
    expect(rest.tasks.map((t: any) => t.id)).toEqual(["in-500"]);
    expect(rest.results.map((t: any) => t.id)).toEqual(["out-500"]);
  });

  test("pull agents are refused, and the ack body is validated", async () => {
    const ctx = makeApp();
    expect((await ctx.call("grok-bot", "GET", "/api/deliveries")).status).toBe(403);
    expect((await ctx.call("grok-bot", "POST", "/api/deliveries/ack", { tasks: [] })).status).toBe(403);
    expect((await ctx.call("claude-code", "POST", "/api/deliveries/ack", { tasks: "x" })).status).toBe(400);
    expect((await ctx.call(null, "GET", "/api/deliveries")).status).toBe(401);
  });
});
