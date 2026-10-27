import { describe, expect, test } from "bun:test";
import { BASE_YAML, HOUR, errorCode, makeService, testConfig } from "./helpers";

describe("reportEvent", () => {
  test("stores the event and runs matching triggers as the reporting agent", () => {
    const { service, store } = makeService();
    const { event, tasks } = service.reportEvent("muse", { name: "bug_report_received", details: "Login 500s" });
    expect(store.getEvent(event.id)).toEqual(event);
    expect(tasks.map((t) => [t.triggerName, t.fromAgent, t.toAgent, t.instructions, t.status, t.eventId])).toEqual([
      ["bug-to-claude", "muse", "claude-code", "Investigate: Login 500s", "queued", event.id],
      ["bug-to-grok", "muse", "grok-bot", "Research: Login 500s", "denied", event.id],
    ]);
    expect(tasks[1]?.reason).toBe("no rule allows muse → grok-bot");
  });

  test("an event with no matching trigger creates no tasks", () => {
    const { service } = makeService();
    expect(service.reportEvent("grok-bot", { name: "bug_report_received", details: "" }).tasks).toEqual([]);
  });

  test("validates the name and the details size", () => {
    const { service } = makeService();
    expect(errorCode(() => service.reportEvent("muse", { name: "has spaces", details: "" }))).toBe("bad_request");
    expect(errorCode(() => service.reportEvent("muse", { name: "", details: "" }))).toBe("bad_request");
    expect(errorCode(() => service.reportEvent("muse", { name: "x", details: "d".repeat(20 * 1024 + 1) }))).toBe(
      "too_large",
    );
  });

  test("rate-limits events per agent per hour", () => {
    const { service } = makeService();
    for (let i = 0; i < 60; i++) service.reportEvent("grok-bot", { name: "ping", details: "" });
    expect(errorCode(() => service.reportEvent("grok-bot", { name: "ping", details: "" }))).toBe("rate_limited");
  });

  test("triggered tasks count against the reporter's task limit, all or nothing", () => {
    const { service, store } = makeService(testConfig(`${BASE_YAML}\nlimits:\n  tasks_per_hour_per_agent: 3\n`));
    service.sendTask("muse", { to: "claude-code", instructions: "one" });
    service.sendTask("muse", { to: "claude-code", instructions: "two" });
    // The event would create 2 tasks, but only 1 is left in the budget, so nothing is created.
    expect(errorCode(() => service.reportEvent("muse", { name: "bug_report_received", details: "x" }))).toBe(
      "rate_limited",
    );
    expect(store.countEventsFromSince("muse", "2000-01-01T00:00:00.000Z")).toBe(0);
  });

  test("a trigger fired while the reporter is busy is denied as chained", () => {
    const { service } = makeService();
    const forMuse = service.sendTask("grok-bot", { to: "muse", instructions: "check mail" });
    service.approveTask(forMuse.id);
    service.checkInbox("muse");
    const { tasks } = service.reportEvent("muse", { name: "bug_report_received", details: "x" });
    expect(tasks.map((t) => [t.status, t.parentTaskId])).toEqual([
      ["denied", forMuse.id],
      ["denied", forMuse.id],
    ]);
    expect(tasks[0]?.reason).toBe(`chained tasks are off; finish task ${forMuse.id} first`);
  });
});

describe("approveTask and denyTask", () => {
  test("approving queues the task and nudges the receiver", () => {
    const { service, notices } = makeService();
    const sent = service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    notices.length = 0;
    const approved = service.approveTask(sent.id);
    expect(approved.status).toBe("queued");
    expect(notices).toEqual([
      { kind: "queued", task: approved },
      { kind: "approval_decided", task: approved, outcome: "approved" },
    ]);
    expect(service.checkInbox("muse").tasks.map((t) => t.id)).toEqual([sent.id]);
  });

  test("denying records the note and tells the sender", () => {
    const { service, notices } = makeService();
    const sent = service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    notices.length = 0;
    const denied = service.denyTask(sent.id, "  Not today.  ");
    expect(denied).toMatchObject({ status: "denied", reason: "Not today." });
    expect(notices).toEqual([
      { kind: "result_ready", task: denied },
      { kind: "approval_decided", task: denied, outcome: "denied" },
    ]);
    expect(service.checkInbox("grok-bot").results.map((t) => t.reason)).toEqual(["Not today."]);
  });

  test("denying without a note uses a default reason", () => {
    const { service } = makeService();
    const sent = service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    expect(service.denyTask(sent.id).reason).toBe("denied by the user");
  });

  test("only a waiting task can be approved or denied", () => {
    const { service } = makeService();
    const queued = service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
    expect(errorCode(() => service.approveTask(queued.id))).toBe("wrong_status");
    expect(errorCode(() => service.denyTask(queued.id))).toBe("wrong_status");
    expect(errorCode(() => service.approveTask("nope"))).toBe("not_found");
  });

  test("with a higher chain limit, a chain stops at the limit", () => {
    const { service } = makeService(testConfig(`${BASE_YAML}\nlimits:\n  max_chain_length: 2\n`));
    service.sendTask("grok-bot", { to: "claude-code", instructions: "a" });
    service.checkInbox("claude-code");
    const second = service.sendTask("claude-code", { to: "grok-bot", instructions: "b" });
    service.approveTask(second.id);
    service.checkInbox("grok-bot");
    expect(service.sendTask("grok-bot", { to: "claude-code", instructions: "c" })).toMatchObject({
      status: "denied",
      chainLength: 3,
      parentTaskId: second.id,
      reason: `chain too long (limit 2); finish task ${second.id} first`,
    });
  });
});

describe("expireDue", () => {
  test("expires waiting, queued and working tasks after task_expiry_hours, each with a reason", () => {
    const { service, clock, notices } = makeService();
    const waiting = service.sendTask("grok-bot", { to: "muse", instructions: "a" });
    const working = service.sendTask("grok-bot", { to: "claude-code", instructions: "b" });
    service.checkInbox("claude-code");
    const queued = service.sendTask("muse", { to: "claude-code", instructions: "c" });
    notices.length = 0;
    clock.advance(24 * HOUR - 1);
    expect(service.expireDue()).toEqual([]);
    clock.advance(1);
    const expired = service.expireDue();
    expect(Object.fromEntries(expired.map((t) => [t.id, t.reason]))).toEqual({
      [waiting.id]: "expired: not approved in time",
      [working.id]: "expired: not finished in time",
      [queued.id]: "expired: never picked up",
    });
    expect(notices.map((n) => n.kind)).toEqual(["result_ready", "approval_decided", "result_ready", "result_ready"]);
  });

  test("finished tasks are never expired, and the sender sees expiries in the inbox", () => {
    const { service, clock } = makeService();
    const done = service.sendTask("grok-bot", { to: "claude-code", instructions: "a" });
    service.checkInbox("claude-code");
    service.finishTask("claude-code", { taskId: done.id, result: "ok" });
    const stale = service.sendTask("grok-bot", { to: "muse", instructions: "b" });
    clock.advance(25 * HOUR);
    expect(service.expireDue().map((t) => t.id)).toEqual([stale.id]);
    expect(service.checkInbox("grok-bot").results.map((t) => [t.id, t.status])).toEqual([
      [done.id, "done"],
      [stale.id, "expired"],
    ]);
  });
});

describe("deleteOldHistory", () => {
  test("removes finished tasks, events and messages older than history_days and keeps the rest", () => {
    const { service, store, clock } = makeService();
    const old = service.sendTask("codex", { to: "claude-code", instructions: "blocked" }); // denied at once
    const { event } = service.reportEvent("grok-bot", { name: "ping", details: "" });
    const open = service.sendTask("grok-bot", { to: "muse", instructions: "waiting" });
    const oldMessage = service.sendMessage("grok-bot", { to: "muse", text: "old" }).message;
    clock.advance(31 * 24 * HOUR);
    const recent = service.sendTask("codex", { to: "claude-code", instructions: "blocked again" });
    const recentMessage = service.sendMessage("grok-bot", { to: "muse", text: "recent" }).message;
    expect(service.deleteOldHistory()).toEqual({ tasks: 1, events: 1, messages: 1 });
    expect(store.getTask(old.id)).toBeNull();
    expect(store.getEvent(event.id)).toBeNull();
    expect(store.getMessage(oldMessage.id)).toBeNull();
    expect(store.getTask(open.id)).not.toBeNull();
    expect(store.getTask(recent.id)).not.toBeNull();
    expect(store.getMessage(recentMessage.id)).not.toBeNull();
  });
});
