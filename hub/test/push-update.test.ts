import { describe, expect, test } from "bun:test";
import {
  approvalPush,
  permissionAnsweredPush,
  permissionNoLongerWaitingPush,
  permissionRepeatPush,
  permissionPush,
  taskApprovedPush,
  taskDeniedPush,
  taskExpiredPush,
  taskRepeatPush,
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
    // Repeating the used link changes nothing; the only extra push is the "Already decided" one (tested below).
    expect((await ctx.app.request(path, { method: "POST" })).status).toBe(200);
    await flush();
    expect(ctx.pushes.slice(0, 2).map((push) => push.title)).toEqual(["grok-bot → muse", "Approved: grok-bot → muse"]);
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

describe("taps on an already-decided push", () => {
  const post = (ctx: ReturnType<typeof makeApp>, path: string) => ctx.app.request(path, { method: "POST" });

  test("repeating an approve link sends Already decided with the same sequence id; the page is unchanged", async () => {
    const ctx = makeApp();
    const task = await askTask(ctx);
    const path = new URL(ctx.pushes[0]!.actions[0]!.url).pathname;
    await post(ctx, path);
    await flush();
    expect(ctx.pushes).toHaveLength(2);
    const again = await post(ctx, path);
    await flush();
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("This task is no longer waiting for approval.");
    expect(ctx.pushes).toHaveLength(3);
    expect(ctx.pushes[2]).toMatchObject({
      sequenceId: `task-${task.id}`,
      title: "Already decided: grok-bot → muse",
      message: "Approved earlier.",
      priority: 3,
      actions: [],
      tags: ["white_check_mark"],
    });
    expect(ctx.pushes[2]).not.toHaveProperty("click");
  });

  test("approve link after a deny says Denied earlier", async () => {
    const ctx = makeApp();
    const task = await askTask(ctx);
    const approve = new URL(ctx.pushes[0]!.actions[0]!.url).pathname;
    const deny = new URL(ctx.pushes[0]!.actions[1]!.url).pathname;
    await post(ctx, deny);
    await flush();
    await post(ctx, approve);
    await flush();
    expect(ctx.pushes).toHaveLength(3);
    expect(ctx.pushes[2]).toMatchObject({
      sequenceId: `task-${task.id}`,
      title: "Already decided: grok-bot → muse",
      message: "Denied earlier.",
      tags: ["x"],
    });
  });

  test("a task that expired while the link was still valid says Expired earlier", async () => {
    const ctx = makeApp();
    const task = await askTask(ctx);
    const path = new URL(ctx.pushes[0]!.actions[0]!.url).pathname;
    ctx.store.updateTask(task.id, { status: "expired", updatedAt: ctx.clock.now().toISOString() });
    await post(ctx, path);
    await flush();
    expect(ctx.pushes).toHaveLength(2);
    expect(ctx.pushes[1]).toMatchObject({ title: "Already decided: grok-bot → muse", message: "Expired earlier.", tags: ["x"] });
  });

  test("a link past its own expiry gets the page but no push", async () => {
    const ctx = makeApp();
    await askTask(ctx);
    const path = new URL(ctx.pushes[0]!.actions[0]!.url).pathname;
    ctx.clock.advance(100 * HOUR);
    ctx.service.expireDue();
    await flush();
    expect(ctx.pushes).toHaveLength(2);
    await post(ctx, path);
    await flush();
    expect(ctx.pushes).toHaveLength(2);
  });

  test("a tampered or invalid link sends no push", async () => {
    const ctx = makeApp();
    await askTask(ctx);
    const path = new URL(ctx.pushes[0]!.actions[0]!.url).pathname;
    await post(ctx, path);
    await flush();
    const before = ctx.pushes.length;
    await post(ctx, `${path.slice(0, -2)}xx`);
    await post(ctx, "/approve/not-a-token");
    await flush();
    expect(ctx.pushes).toHaveLength(before);
  });

  test("repeating a permission link sends Already answered with the same sequence id", async () => {
    const ctx = makeApp();
    await ctx.call("claude-code", "POST", "/api/permission-requests", PROMPT);
    await flush();
    const row = ctx.relay.get("claude-code", "abcde")!;
    const path = new URL(ctx.pushes[0]!.actions[0]!.url).pathname;
    await post(ctx, path);
    await flush();
    expect(ctx.pushes).toHaveLength(2);
    const again = await post(ctx, path);
    await flush();
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Already answered: allowed.");
    expect(ctx.pushes).toHaveLength(3);
    expect(ctx.pushes[2]).toMatchObject({
      sequenceId: `perm-${row.id}`,
      title: "Already answered: Bash",
      message: "Allowed earlier.",
      priority: 3,
      actions: [],
      tags: ["white_check_mark"],
    });
    expect(ctx.pushes[2]).not.toHaveProperty("click");
    // The opposite button after an allow reports the standing answer.
    await post(ctx, new URL(ctx.pushes[0]!.actions[1]!.url).pathname);
    await flush();
    expect(ctx.pushes[3]).toMatchObject({ message: "Allowed earlier." });
  });

  test("a denied permission says Denied earlier", async () => {
    const ctx = makeApp();
    await ctx.call("claude-code", "POST", "/api/permission-requests", PROMPT);
    await flush();
    const deny = new URL(ctx.pushes[0]!.actions[1]!.url).pathname;
    await post(ctx, deny);
    await flush();
    await post(ctx, deny);
    await flush();
    expect(ctx.pushes[2]).toMatchObject({ title: "Already answered: Bash", message: "Denied earlier.", tags: ["x"] });
  });

  test("a permission no longer pending sends No longer waiting, without a sequence id", async () => {
    const ctx = makeApp();
    await ctx.call("claude-code", "POST", "/api/permission-requests", PROMPT);
    await flush();
    const path = new URL(ctx.pushes[0]!.actions[0]!.url).pathname;
    ctx.clock.advance(HOUR / 2);
    // Drop the prompt without passing the link's expiry.
    (ctx.relay as unknown as { requests: Map<string, unknown> }).requests.clear();
    const res = await post(ctx, path);
    await flush();
    expect(res.status).toBe(404);
    expect(ctx.pushes).toHaveLength(2);
    expect(ctx.pushes[1]).toMatchObject({
      title: "No longer waiting",
      message: "This prompt was answered or expired.",
      priority: 3,
      actions: [],
      tags: ["x"],
    });
    expect(ctx.pushes[1]).not.toHaveProperty("sequenceId");
    expect(ctx.pushes[1]).not.toHaveProperty("click");
  });

  test("the hub page does not send repeat pushes", async () => {
    const ctx = makeApp();
    const task = await askTask(ctx);
    const cookie = await signIn(ctx.app);
    const origin = "https://bridge.test";
    await ctx.app.request(`/hub/tasks/${task.id}/approve`, { method: "POST", headers: { cookie, origin } });
    await ctx.app.request(`/hub/tasks/${task.id}/approve`, { method: "POST", headers: { cookie, origin } });
    await flush();
    expect(ctx.pushes).toHaveLength(2);
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
      ...(["queued", "working", "done", "failed", "denied", "expired"] as const).map((status) => taskRepeatPush({ ...task, status })),
      permissionRepeatPush({ ...request, answer: "allow" }),
      permissionRepeatPush({ ...request, answer: "deny" }),
      permissionNoLongerWaitingPush(),
    ];
    for (const push of pushes) {
      expect(`${push.title}\n${push.message}`).not.toMatch(PRONOUNS);
      expect(push.actions).toEqual([]);
    }
    expect(approvalPush(config, task).sequenceId).toBe(`task-${task.id}`);
    expect(permissionPush(config, request).sequenceId).toBe("perm-r1");
  });
});
