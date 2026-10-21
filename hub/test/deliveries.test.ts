import { describe, expect, test } from "bun:test";
import { makeApp } from "./helpers";

const json = async (res: Response) => (await res.json()) as any;

describe("deliveries for push agents", () => {
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

  test("pull agents are refused, and the ack body is validated", async () => {
    const ctx = makeApp();
    expect((await ctx.call("grok-bot", "GET", "/api/deliveries")).status).toBe(403);
    expect((await ctx.call("grok-bot", "POST", "/api/deliveries/ack", { tasks: [] })).status).toBe(403);
    expect((await ctx.call("claude-code", "POST", "/api/deliveries/ack", { tasks: "x" })).status).toBe(400);
    expect((await ctx.call(null, "GET", "/api/deliveries")).status).toBe(401);
  });
});
