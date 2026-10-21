import { describe, expect, test } from "bun:test";
import { addSession, BASE_YAML, HOUR, errorCode, makeService, testConfig } from "./helpers";

describe("listAgents", () => {
  test("lists everyone but the caller, pull members before offline push members", () => {
    const { service } = makeService();
    expect(service.listAgents("grok-bot").map((a) => a.name)).toEqual(["codex", "muse", "claude-code"]);
  });
});

describe("sendTask", () => {
  test("an allowed pair is queued and the receiver is notified", () => {
    const { service, notices } = makeService();
    const task = service.sendTask("grok-bot", { to: "claude-code", instructions: "Add rate limiting" });
    expect(task).toMatchObject({
      id: "id-1",
      fromAgent: "grok-bot",
      toAgent: "claude-code",
      instructions: "Add rate limiting",
      status: "queued",
      chainLength: 1,
      parentTaskId: null,
      senderNotifiedAt: null,
      createdAt: "2026-10-20T12:00:00.000Z",
      expiresAt: "2026-10-21T12:00:00.000Z",
    });
    expect(notices).toEqual([{ kind: "queued", task }]);
  });

  test("an ask pair waits for approval", () => {
    const { service, notices } = makeService();
    const task = service.sendTask("grok-bot", { to: "muse", instructions: "Summarize my inbox" });
    expect(task.status).toBe("waiting_approval");
    expect(notices).toEqual([{ kind: "approval_needed", task }]);
  });

  test("a blocked pair is denied immediately and counts as already seen", () => {
    const { service, notices } = makeService();
    const task = service.sendTask("codex", { to: "claude-code", instructions: "x" });
    expect(task).toMatchObject({
      status: "denied",
      reason: "blocked by rule",
      senderNotifiedAt: "2026-10-20T12:00:00.000Z",
    });
    expect(notices).toEqual([]);
  });

  test("a pair with no rule is denied", () => {
    const { service } = makeService();
    expect(service.sendTask("muse", { to: "codex", instructions: "x" })).toMatchObject({
      status: "denied",
      reason: "no rule allows muse → codex",
    });
  });

  test("rejects unknown receivers, self-sends and bad text", () => {
    const { service } = makeService();
    expect(errorCode(() => service.sendTask("grok-bot", { to: "nobody", instructions: "x" }))).toBe("unknown_agent");
    expect(errorCode(() => service.sendTask("grok-bot", { to: "grok-bot", instructions: "x" }))).toBe("bad_request");
    expect(errorCode(() => service.sendTask("grok-bot", { to: "claude-code", instructions: "   " }))).toBe(
      "bad_request",
    );
    expect(
      errorCode(() => service.sendTask("grok-bot", { to: "claude-code", instructions: "x".repeat(20 * 1024 + 1) })),
    ).toBe("too_large");
  });

  test("the unknown-receiver message lists the valid agents", () => {
    const { service } = makeService();
    expect(() => service.sendTask("grok-bot", { to: "nobody", instructions: "x" })).toThrow(
      'No agent named "nobody". Valid agents: claude-code, muse, codex.',
    );
  });

  test("a kind pattern rule lets a session receive a task, addressed by its short name", () => {
    const yaml = BASE_YAML.replace("rules:\n", 'rules:\n  - { from: grok-bot, to: "kind:claude-code", action: allow }\n');
    const ctx = makeService(testConfig(yaml));
    addSession(ctx, { name: "dialog-claude", machine: "macbook" });
    const task = ctx.service.sendTask("grok-bot", { to: "dialog-claude", instructions: "Fix the login bug" });
    expect(task).toMatchObject({ status: "queued", toAgent: "dialog-claude@macbook" });
    expect(ctx.notices).toEqual([{ kind: "queued", task }]);
    // Without a rule naming the session, its kind or a matching glob, the pair stays blocked.
    expect(ctx.service.sendTask("muse", { to: "dialog-claude", instructions: "x" })).toMatchObject({
      status: "denied",
      reason: "no rule allows muse → dialog-claude@macbook",
    });
  });

  test("a session can't send a task to itself by its short name", () => {
    const ctx = makeService();
    const { address } = addSession(ctx, { name: "dialog-claude", machine: "macbook" });
    expect(errorCode(() => ctx.service.sendTask(address, { to: "dialog-claude", instructions: "x" }))).toBe("bad_request");
  });

  test("send_task refuses broadcasts", () => {
    const { service } = makeService();
    for (const to of ["*", "kind:claude-code", "claude-*"]) {
      expect(errorCode(() => service.sendTask("grok-bot", { to, instructions: "x" }))).toBe("bad_request");
    }
  });

  test("rate-limits each sender per hour", () => {
    const { service, clock } = makeService();
    for (let i = 0; i < 30; i++) service.sendTask("grok-bot", { to: "claude-code", instructions: `task ${i}` });
    expect(errorCode(() => service.sendTask("grok-bot", { to: "claude-code", instructions: "one more" }))).toBe(
      "rate_limited",
    );
    expect(service.sendTask("muse", { to: "claude-code", instructions: "other sender" }).status).toBe("queued");
    clock.advance(HOUR + 1);
    expect(service.sendTask("grok-bot", { to: "claude-code", instructions: "next hour" }).status).toBe("queued");
  });
});

describe("checkInbox", () => {
  test("hands queued tasks to the receiver once, moving them to working", () => {
    const { service, clock } = makeService();
    const sent = service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
    clock.advance(1000);
    const first = service.checkInbox("claude-code");
    expect(first.tasks.map((t) => t.id)).toEqual([sent.id]);
    expect(first.tasks[0]).toMatchObject({ status: "working", updatedAt: "2026-10-20T12:00:01.000Z" });
    expect(service.checkInbox("claude-code").tasks).toEqual([]);
  });

  test("doesn't hand over tasks still waiting for approval", () => {
    const { service } = makeService();
    service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    expect(service.checkInbox("muse").tasks).toEqual([]);
  });

  test("gives the sender each finished result once", () => {
    const { service } = makeService();
    const sent = service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
    service.checkInbox("claude-code");
    service.finishTask("claude-code", { taskId: sent.id, result: "done!" });
    const inbox = service.checkInbox("grok-bot");
    expect(inbox.results.map((t) => [t.id, t.status, t.result])).toEqual([[sent.id, "done", "done!"]]);
    expect(service.checkInbox("grok-bot").results).toEqual([]);
  });

  test("records when an agent last checked in", () => {
    const { service } = makeService();
    expect(service.lastCheckIn("muse")).toBeNull();
    service.checkInbox("muse");
    expect(service.lastCheckIn("muse")).toBe("2026-10-20T12:00:00.000Z");
  });
});

describe("finishTask", () => {
  function pickedUp() {
    const ctx = makeService();
    const sent = ctx.service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
    ctx.service.checkInbox("claude-code");
    ctx.notices.length = 0;
    return { ...ctx, id: sent.id };
  }

  test("records a result and tells the sender", () => {
    const { service, notices, id } = pickedUp();
    const done = service.finishTask("claude-code", { taskId: id, result: "Shipped." });
    expect(done).toMatchObject({ status: "done", result: "Shipped.", reason: null });
    expect(notices).toEqual([{ kind: "result_ready", task: done }]);
  });

  test("records a failure reason", () => {
    const { service, id } = pickedUp();
    expect(service.finishTask("claude-code", { taskId: id, failedReason: "No access." })).toMatchObject({
      status: "failed",
      reason: "No access.",
      result: null,
    });
  });

  test("requires exactly one of result and failed_reason", () => {
    const { service, id } = pickedUp();
    expect(errorCode(() => service.finishTask("claude-code", { taskId: id }))).toBe("bad_request");
    expect(errorCode(() => service.finishTask("claude-code", { taskId: id, result: "a", failedReason: "b" }))).toBe(
      "bad_request",
    );
  });

  test("only the receiver can finish, and only from working", () => {
    const { service, id } = pickedUp();
    expect(errorCode(() => service.finishTask("grok-bot", { taskId: id, result: "x" }))).toBe("not_allowed");
    expect(errorCode(() => service.finishTask("claude-code", { taskId: "nope", result: "x" }))).toBe("not_found");
    const queued = service.sendTask("grok-bot", { to: "claude-code", instructions: "y" });
    expect(errorCode(() => service.finishTask("claude-code", { taskId: queued.id, result: "x" }))).toBe(
      "wrong_status",
    );
  });

  test("finishing twice returns the task unchanged", () => {
    const { service, notices, id } = pickedUp();
    const first = service.finishTask("claude-code", { taskId: id, result: "one" });
    const second = service.finishTask("claude-code", { taskId: id, result: "two" });
    expect(second).toEqual(first);
    expect(notices).toHaveLength(1);
  });
});

describe("getTask", () => {
  test("the sender and receiver can read a task; others can't", () => {
    const { service } = makeService();
    const sent = service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
    expect(service.getTask("grok-bot", sent.id).id).toBe(sent.id);
    expect(service.getTask("claude-code", sent.id).id).toBe(sent.id);
    expect(errorCode(() => service.getTask("muse", sent.id))).toBe("not_allowed");
    expect(errorCode(() => service.getTask("muse", "nope"))).toBe("not_found");
  });

  test("a sender reading a finished task marks it seen", () => {
    const { service } = makeService();
    const sent = service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
    service.checkInbox("claude-code");
    service.finishTask("claude-code", { taskId: sent.id, result: "ok" });
    expect(service.getTask("claude-code", sent.id).senderNotifiedAt).toBeNull();
    expect(service.getTask("grok-bot", sent.id).senderNotifiedAt).toBe("2026-10-20T12:00:00.000Z");
    expect(service.checkInbox("grok-bot").results).toEqual([]);
  });
});

describe("getTask with expectedReceiver", () => {
  test("a mismatched receiver is not_found and does not mark the result seen", () => {
    const { service } = makeService();
    const sent = service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
    service.checkInbox("claude-code");
    service.finishTask("claude-code", { taskId: sent.id, result: "ok" });
    expect(errorCode(() => service.getTask("grok-bot", sent.id, { expectedReceiver: "someone-else" }))).toBe("not_found");
    expect(service.getTask("claude-code", sent.id).senderNotifiedAt).toBeNull();
    expect(service.getTask("grok-bot", sent.id, { expectedReceiver: "claude-code" }).senderNotifiedAt).not.toBeNull();
  });
});

describe("chains", () => {
  test("a task sent while working on another is denied by default", () => {
    const { service } = makeService();
    const first = service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
    service.checkInbox("claude-code");
    const chained = service.sendTask("claude-code", { to: "grok-bot", instructions: "help me" });
    expect(chained).toMatchObject({
      status: "denied",
      parentTaskId: first.id,
      chainLength: 2,
      reason: `chained tasks are off; finish task ${first.id} first`,
    });
  });

  test("once the parent is finished, sending works again", () => {
    const { service } = makeService();
    const first = service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
    service.checkInbox("claude-code");
    service.finishTask("claude-code", { taskId: first.id, result: "ok" });
    expect(service.sendTask("claude-code", { to: "grok-bot", instructions: "new" })).toMatchObject({
      status: "queued",
      parentTaskId: null,
      chainLength: 1,
    });
  });

  test("with a higher limit, a chained task asks instead of passing straight through", () => {
    const { service } = makeService(testConfig(`${BASE_YAML}\nlimits:\n  max_chain_length: 2\n`));
    const first = service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
    service.checkInbox("claude-code");
    expect(service.sendTask("claude-code", { to: "grok-bot", instructions: "help" })).toMatchObject({
      status: "waiting_approval",
      chainLength: 2,
      parentTaskId: first.id,
    });
  });
});

describe("sendTask with an idempotency key", () => {
  const send = (key?: string, to = "claude-code", instructions = "Add rate limiting") => ({
    to,
    instructions,
    idempotencyKey: key,
  });

  test("a retry with the same key returns the first task and creates nothing", () => {
    const { service, notices } = makeService();
    const first = service.sendTask("grok-bot", send("k-1"));
    const again = service.sendTask("grok-bot", send("k-1"));
    expect(again).toEqual(first);
    expect(first.idempotencyKey).toBe("k-1");
    expect(notices).toHaveLength(1);
  });

  test("the same key for a different task is refused", () => {
    const { service } = makeService();
    service.sendTask("grok-bot", send("k-1", "claude-code", "one"));
    expect(errorCode(() => service.sendTask("grok-bot", send("k-1", "claude-code", "two")))).toBe("bad_request");
    expect(errorCode(() => service.sendTask("grok-bot", send("k-1", "muse", "one")))).toBe("bad_request");
  });

  test("a retry by a session's short name returns the first task", () => {
    const yaml = BASE_YAML.replace("rules:\n", 'rules:\n  - { from: grok-bot, to: "kind:claude-code", action: allow }\n');
    const ctx = makeService(testConfig(yaml));
    addSession(ctx, { name: "dialog-claude", machine: "macbook" });
    const first = ctx.service.sendTask("grok-bot", { to: "dialog-claude", instructions: "x", idempotencyKey: "k1" });
    const retry = ctx.service.sendTask("grok-bot", { to: "dialog-claude", instructions: "x", idempotencyKey: "k1" });
    expect(retry.id).toBe(first.id);
    expect(ctx.service.sendTask("grok-bot", { to: "dialog-claude@macbook", instructions: "x", idempotencyKey: "k1" }).id).toBe(first.id);
  });

  test("a retry by short name still returns the first task once the name is ambiguous or the session is gone", () => {
    const yaml = BASE_YAML.replace("rules:\n", 'rules:\n  - { from: grok-bot, to: "kind:claude-code", action: allow }\n');
    const ctx = makeService(testConfig(yaml));
    addSession(ctx, { name: "dialog-claude", machine: "macbook" });
    const send = (to = "dialog-claude") => ctx.service.sendTask("grok-bot", { to, instructions: "x", idempotencyKey: "k1" });
    const first = send();
    addSession(ctx, { name: "dialog-claude", machine: "studio" });
    expect(send().id).toBe(first.id); // ambiguous now
    ctx.network.deleteMachine("m-macbook");
    expect(send().id).toBe(first.id); // resolves to studio now
    ctx.network.deleteMachine("m-studio");
    expect(send().id).toBe(first.id); // resolves to nothing now
    expect(errorCode(() => send("dialog"))).toBe("bad_request"); // another name is another task
  });

  test("keys are per sender", () => {
    const { service } = makeService();
    const a = service.sendTask("grok-bot", send("k-1"));
    const b = service.sendTask("muse", send("k-1"));
    expect(a.id).not.toBe(b.id);
  });

  test("a retry doesn't count against the rate limit", () => {
    const { service } = makeService(testConfig(`${BASE_YAML}\nlimits:\n  tasks_per_hour_per_agent: 1\n`));
    const first = service.sendTask("grok-bot", send("k-1"));
    expect(service.sendTask("grok-bot", send("k-1")).id).toBe(first.id);
    expect(errorCode(() => service.sendTask("grok-bot", send(undefined, "claude-code", "another")))).toBe(
      "rate_limited",
    );
  });

  test("rejects a key that is too long or holds control characters", () => {
    const { service } = makeService();
    expect(errorCode(() => service.sendTask("grok-bot", send("k".repeat(101))))).toBe("bad_request");
    expect(errorCode(() => service.sendTask("grok-bot", send("bad\nkey")))).toBe("bad_request");
    expect(errorCode(() => service.sendTask("grok-bot", send("k".repeat(100))))).toBeNull();
  });

  test("tasks sent without a key, or created by triggers, have no key", () => {
    const { service } = makeService();
    expect(service.sendTask("grok-bot", send()).idempotencyKey).toBeNull();
    const { tasks } = service.reportEvent("muse", { name: "bug_report_received", details: "d" });
    expect(tasks[0]?.idempotencyKey).toBeNull();
  });
});
