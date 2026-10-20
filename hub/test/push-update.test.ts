import { describe, expect, test } from "bun:test";
import {
  approvalPush,
  permissionAnsweredPush,
  permissionPush,
  taskApprovedPush,
  taskDeniedPush,
  taskExpiredPush,
} from "../src/approvals/messages";
import { makePusher, type PushMessage } from "../src/approvals/ntfy";
import { PermissionRelay } from "../src/core/permissions";
import { HOUR, flush, makeApp, makeService, signIn } from "./helpers";

const PRONOUNS = /\b(i|me|my|we|us|our|you|your|it|its|they|them|their)\b/i;
const PROMPT = { request_id: "abcde", tool_name: "Bash", description: "Run the tests", input_preview: "bun test" };

async function askTask(ctx: ReturnType<typeof makeApp>) {
  const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "Summarize the inbox" });
  await flush();
  return task;
}

describe("ntfy sequence ids", () => {
  test("the JSON body carries sequence_id when set, and omits it otherwise", async () => {
    const bodies: Record<string, unknown>[] = [];
    const push = makePusher(
      { url: "https://ntfy.test", topic: "t", token: null },
      { fetch: async (_url, init) => (bodies.push(JSON.parse(String(init.body))), new Response("{}")) },
    );
    const base: PushMessage = { title: "a", message: "b", priority: 3, tags: [], actions: [] };
    await push({ ...base, sequenceId: "task-1" });
    await push(base);
    expect(bodies[0]!.sequence_id).toBe("task-1");
    expect(bodies[1]).not.toHaveProperty("sequence_id");
  });
});

describe("task push updates", () => {
  test("an approval push carries task-<id>", async () => {
    const ctx = makeApp();
    const task = await askTask(ctx);
    expect(ctx.pushes).toHaveLength(1);
    expect(ctx.pushes[0]!.sequenceId).toBe(`task-${task.id}`);
  });

  test("approving via the signed link sends one Approved follow-up with the same sequence id", async () => {
    const ctx = makeApp();
    const task = await askTask(ctx);
    const path = new URL(ctx.pushes[0]!.actions[0]!.url).pathname;
    expect((await ctx.app.request(path, { method: "POST" })).status).toBe(200);
    await flush();
    expect(ctx.pushes).toHaveLength(2);
    expect(ctx.pushes[1]).toMatchObject({
      sequenceId: `task-${task.id}`,
      title: "Approved: grok-bot → muse",
      message: "Task queued for muse.",
      priority: 3,
      actions: [],
      tags: ["white_check_mark"],
    });
    expect(ctx.pushes[1]).not.toHaveProperty("click");
    // Repeating the used link changes nothing and sends nothing.
    expect((await ctx.app.request(path, { method: "POST" })).status).toBe(200);
    await flush();
    expect(ctx.pushes).toHaveLength(2);
  });

  test("approving via the hub page sends exactly one Approved follow-up", async () => {
    const ctx = makeApp();
    const task = await askTask(ctx);
    const cookie = await signIn(ctx.app);
    const res = await ctx.app.request(`/hub/tasks/${task.id}/approve`, {
      method: "POST",
      headers: { cookie, origin: "https://bridge.test" },
    });
    expect(res.status).toBe(200);
    await flush();
    expect(ctx.pushes.map((push) => push.title)).toEqual(["grok-bot → muse", "Approved: grok-bot → muse"]);
  });

  test("the Approved follow-up still goes out when the task moves on before the notifier runs", async () => {
    const ctx = makeApp();
    const task = await askTask(ctx);
    ctx.service.approveTask(task.id);
    ctx.store.updateTask(task.id, { status: "working", updatedAt: ctx.clock.now().toISOString() });
    await flush();
    expect(ctx.pushes.map((push) => push.title)).toEqual(["grok-bot → muse", "Approved: grok-bot → muse"]);
  });

  test("denying via the hub page sends the Denied follow-up", async () => {
    const ctx = makeApp();
    const task = await askTask(ctx);
    const cookie = await signIn(ctx.app);
    await ctx.app.request(`/hub/tasks/${task.id}/deny`, { method: "POST", headers: { cookie } });
    await flush();
    expect(ctx.pushes).toHaveLength(2);
    expect(ctx.pushes[1]).toMatchObject({
      sequenceId: `task-${task.id}`,
      title: "Denied: grok-bot → muse",
      message: "Task not sent.",
      actions: [],
      tags: ["x"],
    });
  });

  test("an expiring waiting_approval task sends the Expired follow-up", async () => {
    const ctx = makeApp();
    const task = await askTask(ctx);
    ctx.clock.advance(100 * HOUR);
    ctx.service.expireDue();
    await flush();
    expect(ctx.pushes).toHaveLength(2);
    expect(ctx.pushes[1]).toMatchObject({
      sequenceId: `task-${task.id}`,
      title: "Expired: grok-bot → muse",
      message: "No answer before the deadline.",
      actions: [],
      tags: ["x"],
    });
  });

  test("no follow-up for tasks that never needed approval", async () => {
    const ctx = makeApp();
    const task = ctx.service.sendTask("grok-bot", { to: "claude-code", instructions: "Hi" });
    ctx.clock.advance(100 * HOUR);
    ctx.service.expireDue();
    await flush();
    expect(task.status).toBe("queued");
    expect(ctx.pushes).toHaveLength(0);
  });
});

describe("permission push updates", () => {
  test("a prompt's push and its answer follow-up share perm-<id>; reused request ids differ", async () => {
    const ctx = makeApp();
    await ctx.call("claude-code", "POST", "/api/permission-requests", PROMPT);
    await flush();
    const first = ctx.relay.get("claude-code", "abcde")!;
    expect(ctx.pushes[0]!.sequenceId).toBe(`perm-${first.id}`);
    const cookie = await signIn(ctx.app);
    await ctx.app.request("/hub/permissions/claude-code/abcde/allow", { method: "POST", headers: { cookie } });
    await flush();
    expect(ctx.pushes).toHaveLength(2);
    expect(ctx.pushes[1]).toMatchObject({
      sequenceId: `perm-${first.id}`,
      title: "Allowed: Bash",
      message: "Answered.",
      actions: [],
      tags: ["white_check_mark"],
    });

    await ctx.call("claude-code", "POST", "/api/permission-requests", PROMPT);
    await flush();
    const second = ctx.relay.get("claude-code", "abcde")!;
    expect(second.id).not.toBe(first.id);
    expect(ctx.pushes[2]!.sequenceId).toBe(`perm-${second.id}`);
  });

  test("denying via the signed link sends the Denied follow-up", async () => {
    const ctx = makeApp();
    await ctx.call("claude-code", "POST", "/api/permission-requests", PROMPT);
    await flush();
    const row = ctx.relay.get("claude-code", "abcde")!;
    const denyPath = new URL(ctx.pushes[0]!.actions[1]!.url).pathname;
    await ctx.app.request(denyPath, { method: "POST" });
    await flush();
    expect(ctx.pushes[1]).toMatchObject({ sequenceId: `perm-${row.id}`, title: "Denied: Bash", tags: ["x"] });
  });
});

describe("permission answer hook", () => {
  test("a throwing onAnswered still records the answer and returns normally", () => {
    const relay = new PermissionRelay({
      maxTextKb: 20,
      deliver: () => true,
      onAnswered: () => {
        throw new Error("boom");
      },
    });
    relay.add("claude-code", { requestId: "abcde", toolName: "Bash" });
    expect(relay.answer("claude-code", "abcde", "allow").answer).toBe("allow");
    expect(relay.get("claude-code", "abcde")?.answer).toBe("allow");
  });
});

describe("follow-up copy", () => {
  test("no push text uses a pronoun", () => {
    const { service, config } = makeService();
    const task = service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    const request = {
      id: "r1", agent: "claude-code", requestId: "abcde", toolName: "Bash", description: "", inputPreview: "",
      createdAt: "", expiresAt: "", answer: null, answeredAt: null, delivered: false,
    };
    const pushes = [
      taskApprovedPush(task),
      taskDeniedPush(task),
      taskExpiredPush(task),
      permissionAnsweredPush(request, "allow"),
      permissionAnsweredPush(request, "deny"),
    ];
    for (const push of pushes) {
      expect(`${push.title}\n${push.message}`).not.toMatch(PRONOUNS);
      expect(push.actions).toEqual([]);
    }
    expect(approvalPush(config, task).sequenceId).toBe(`task-${task.id}`);
    expect(permissionPush(config, request).sequenceId).toBe("perm-r1");
  });
});
