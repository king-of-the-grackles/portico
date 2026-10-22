import { describe, expect, test } from "bun:test";
import { ApprovalPanels } from "../src/approvals";
import { HubError } from "../src/hub-client";
import { captureLog, fakeRunner, waitFor } from "./helpers";

const REQUEST = {
  taskId: "t1",
  nonce: "nonce-aaaaaaaaaaaaaaaa",
  from: "grok-bot",
  to: "muse",
  instructions: "Summarize the inbox",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function setup(opts: { fail?: (attempt: number) => Error | null; runner?: boolean; retryMs?: number[] } = {}) {
  const answers: { taskId: string; body: unknown }[] = [];
  let attempts = 0;
  let unavailable = 0;
  const client = {
    answerApproval: async (taskId: string, body: { nonce: string; decision: "approve" | "deny"; note?: string }) => {
      attempts++;
      const err = opts.fail?.(attempts);
      if (err) throw err;
      answers.push({ taskId, body });
      return { task: {} as never };
    },
  };
  const fake = fakeRunner();
  const logs = captureLog();
  const panels = new ApprovalPanels({
    client,
    runner: opts.runner === false ? null : fake.runner,
    log: logs.log,
    retryMs: opts.retryMs ?? [5, 5],
    onUnavailable: () => unavailable++,
  });
  return { panels, fake, answers, logs, attempts: () => attempts, unavailable: () => unavailable };
}

describe("approval panels", () => {
  test("shows a panel for a request and answers Approve with the request's nonce, never a note", async () => {
    const { panels, fake, answers } = setup();
    panels.request(REQUEST);
    expect(fake.panels.map((panel) => panel.prompt)).toEqual([
      { taskId: "t1", from: "grok-bot", to: "muse", instructions: "Summarize the inbox", expiresAt: REQUEST.expiresAt, slot: 0 },
    ]);
    fake.panels[0]!.answer({ kind: "answered", decision: "approve", note: "typed anyway" });
    await waitFor(() => answers.length === 1);
    expect(answers[0]).toEqual({ taskId: "t1", body: { nonce: REQUEST.nonce, decision: "approve" } });
    expect(panels.openCount).toBe(0);
  });

  test("Deny sends the note, trimmed and clipped to 2,000 characters", async () => {
    const { panels, fake, answers } = setup();
    panels.request(REQUEST);
    fake.panels[0]!.answer({ kind: "answered", decision: "deny", note: `  ${"n".repeat(2500)}  ` });
    await waitFor(() => answers.length === 1);
    expect(answers[0]).toEqual({ taskId: "t1", body: { nonce: REQUEST.nonce, decision: "deny", note: "n".repeat(2000) } });
  });

  test("Deny with a blank note sends no note", async () => {
    const { panels, fake, answers } = setup();
    panels.request(REQUEST);
    fake.panels[0]!.answer({ kind: "answered", decision: "deny", note: "   " });
    await waitFor(() => answers.length === 1);
    expect(answers[0]).toEqual({ taskId: "t1", body: { nonce: REQUEST.nonce, decision: "deny" } });
  });

  test("a repeat request for the same task updates the nonce instead of opening a second panel; a second task cascades", async () => {
    const { panels, fake, answers } = setup();
    panels.request(REQUEST);
    panels.request({ ...REQUEST, nonce: "nonce-bbbbbbbbbbbbbbbb" });
    expect(fake.panels).toHaveLength(1);
    panels.request({ ...REQUEST, taskId: "t2" });
    expect(fake.panels[1]!.prompt.slot).toBe(1);
    fake.panels[0]!.answer({ kind: "answered", decision: "approve", note: "" });
    await waitFor(() => answers.length === 1);
    expect((answers[0]!.body as { nonce: string }).nonce).toBe("nonce-bbbbbbbbbbbbbbbb");
    // t1's slot is free again, while t2 still holds slot 1: the next panel takes the lowest free one.
    panels.request({ ...REQUEST, taskId: "t3" });
    panels.request({ ...REQUEST, taskId: "t4" });
    expect(fake.panels.slice(2).map((panel) => [panel.prompt.taskId, panel.prompt.slot])).toEqual([
      ["t3", 0],
      ["t4", 2],
    ]);
  });

  test("approval_closed kills the panel, and an answer that comes after is never sent", async () => {
    const { panels, fake, answers } = setup();
    panels.request(REQUEST);
    panels.closed({ taskId: "t1", outcome: "approved" });
    expect(fake.panels[0]!.killed).toBe(true);
    fake.panels[0]!.answer({ kind: "answered", decision: "approve", note: "" });
    await Bun.sleep(20);
    expect(answers).toEqual([]);
  });

  test("at most five panels are open at once; later requests wait in order, and a closed one leaves the queue", async () => {
    const { panels, fake } = setup();
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) panels.request({ ...REQUEST, taskId: `t${n}` });
    expect(fake.panels.map((panel) => [panel.prompt.taskId, panel.prompt.slot])).toEqual([
      ["t1", 0],
      ["t2", 1],
      ["t3", 2],
      ["t4", 3],
      ["t5", 4],
    ]);
    expect(panels.openCount).toBe(5);
    panels.request({ ...REQUEST, taskId: "t6", nonce: "nonce-bbbbbbbbbbbbbbbb" }); // a repeat while queued: still one entry
    panels.closed({ taskId: "t7", outcome: "approved" }); // decided while waiting: it never shows
    panels.closed({ taskId: "t2", outcome: "denied" });
    expect(fake.panels.slice(5).map((panel) => [panel.prompt.taskId, panel.prompt.slot])).toEqual([["t6", 1]]);
    fake.panels[0]!.answer({ kind: "dismissed" });
    await waitFor(() => fake.panels.length === 7);
    expect(fake.panels.at(-1)!.prompt).toMatchObject({ taskId: "t8", slot: 0 });
    expect(panels.openCount).toBe(5);
  });

  test("closeAll empties the queue too, so nothing opens after it", async () => {
    const { panels, fake } = setup();
    for (const n of [1, 2, 3, 4, 5, 6]) panels.request({ ...REQUEST, taskId: `t${n}` });
    panels.closeAll();
    await Bun.sleep(20);
    expect(fake.panels).toHaveLength(5);
    expect(fake.panels.every((panel) => panel.killed)).toBe(true);
    expect(panels.openCount).toBe(0);
  });

  test("a queued request is answered with its newest nonce once it shows", async () => {
    const { panels, fake, answers } = setup();
    for (const n of [1, 2, 3, 4, 5, 6]) panels.request({ ...REQUEST, taskId: `t${n}` });
    panels.request({ ...REQUEST, taskId: "t6", nonce: "nonce-cccccccccccccccc" });
    panels.closed({ taskId: "t1", outcome: "approved" });
    fake.panels[5]!.answer({ kind: "answered", decision: "approve", note: "" });
    await waitFor(() => answers.length === 1);
    expect(answers[0]).toEqual({ taskId: "t6", body: { nonce: "nonce-cccccccccccccccc", decision: "approve" } });
  });

  test("no second panel opens for a task whose answer is on its way or being retried", async () => {
    const pending = setup({ fail: (n) => (n === 1 ? new HubError(0, "unreachable", "x") : null), retryMs: [200] });
    pending.panels.request(REQUEST);
    pending.fake.panels[0]!.answer({ kind: "answered", decision: "approve", note: "" });
    await waitFor(() => pending.attempts() === 1);
    pending.panels.request({ ...REQUEST, nonce: "nonce-bbbbbbbbbbbbbbbb" }); // re-sent after a reconnect, mid-retry
    expect(pending.fake.panels).toHaveLength(1);
    await waitFor(() => pending.answers.length === 1);
    expect(pending.fake.panels).toHaveLength(1);
    expect((pending.answers[0]!.body as { nonce: string }).nonce).toBe(REQUEST.nonce);

    let land!: () => void;
    const fake = fakeRunner();
    const slow = new ApprovalPanels({
      client: { answerApproval: () => new Promise<{ task: never }>((resolve) => (land = () => resolve({ task: {} as never }))) },
      runner: fake.runner,
      log: captureLog().log,
    });
    slow.request(REQUEST);
    fake.panels[0]!.answer({ kind: "answered", decision: "deny", note: "" });
    await waitFor(() => land !== undefined);
    slow.request(REQUEST); // the answer is in flight
    expect(fake.panels).toHaveLength(1);
    land();
    await Bun.sleep(10);
    slow.request({ ...REQUEST, nonce: "nonce-dddddddddddddddd" }); // answered and done: a request still open shows again
    expect(fake.panels).toHaveLength(2);
  });

  test("a request re-sent while an answer is on its way opens a panel with its new nonce if that answer fails", async () => {
    const calls: { nonce: string; settle(err: Error | null): void }[] = [];
    const fake = fakeRunner();
    const panels = new ApprovalPanels({
      client: {
        answerApproval: (_taskId, body) =>
          new Promise<{ task: never }>((resolve, reject) =>
            calls.push({ nonce: body.nonce, settle: (err) => (err ? reject(err) : resolve({ task: {} as never })) }),
          ),
      },
      runner: fake.runner,
      log: captureLog().log,
      retryMs: [],
    });
    panels.request(REQUEST);
    fake.panels[0]!.answer({ kind: "answered", decision: "approve", note: "" });
    await waitFor(() => calls.length === 1);
    panels.request({ ...REQUEST, nonce: "nonce-bbbbbbbbbbbbbbbb" }); // a restarted hub re-sends with a new nonce
    panels.request({ ...REQUEST, nonce: "nonce-cccccccccccccccc" }); // the latest one is kept
    expect(fake.panels).toHaveLength(1);
    calls[0]!.settle(new HubError(403, "not_allowed", "No approval request for this session matches."));
    await waitFor(() => fake.panels.length === 2);
    expect(fake.panels[1]!.prompt.taskId).toBe("t1");
    fake.panels[1]!.answer({ kind: "answered", decision: "approve", note: "" });
    await waitFor(() => calls.length === 2);
    expect(calls[1]!.nonce).toBe("nonce-cccccccccccccccc");
    calls[1]!.settle(null);

    // A kept request is dropped when the answer lands, or when the task is closed meanwhile.
    panels.request({ ...REQUEST, taskId: "t2" });
    fake.panels[2]!.answer({ kind: "answered", decision: "approve", note: "" });
    await waitFor(() => calls.length === 3);
    panels.request({ ...REQUEST, taskId: "t2", nonce: "nonce-dddddddddddddddd" });
    calls[2]!.settle(null);
    panels.request({ ...REQUEST, taskId: "t3" });
    fake.panels[3]!.answer({ kind: "answered", decision: "deny", note: "" });
    await waitFor(() => calls.length === 4);
    panels.request({ ...REQUEST, taskId: "t3", nonce: "nonce-eeeeeeeeeeeeeeee" });
    panels.closed({ taskId: "t3", outcome: "approved" });
    calls[3]!.settle(new HubError(409, "wrong_status", "decided"));
    await Bun.sleep(20);
    expect(fake.panels).toHaveLength(4);
  });

  test("closeAll kills every panel, as when the stream drops", () => {
    const { panels, fake } = setup();
    panels.request(REQUEST);
    panels.request({ ...REQUEST, taskId: "t2" });
    expect(panels.openCount).toBe(2);
    panels.closeAll();
    expect(fake.panels.map((panel) => panel.killed)).toEqual([true, true]);
    expect(panels.openCount).toBe(0);
  });

  test("the panel is killed when the task expires, and an already expired request shows nothing", async () => {
    const { panels, fake } = setup();
    panels.request({ ...REQUEST, expiresAt: new Date(Date.now() + 30).toISOString() });
    await waitFor(() => fake.panels[0]!.killed);
    panels.request({ ...REQUEST, taskId: "t2", expiresAt: new Date(Date.now() - 1).toISOString() });
    expect(fake.panels).toHaveLength(1);
  });

  test("a dismissed panel sends nothing; a failed one is logged", async () => {
    const { panels, fake, answers, logs } = setup();
    panels.request(REQUEST);
    fake.panels[0]!.answer({ kind: "dismissed" });
    panels.request({ ...REQUEST, taskId: "t2" });
    fake.panels[1]!.answer({ kind: "failed", code: 1 });
    await Bun.sleep(20);
    expect(answers).toEqual([]);
    expect(logs.lines.find((line) => line.msg === "approval_popup_failed")?.fields).toEqual({ task_id: "t2", code: 1 });
  });

  test("a panel that fails to show turns pop-ups off for good, once, so the session stops declaring them", async () => {
    const { panels, fake, logs, unavailable } = setup();
    expect(panels.available).toBe(true);
    panels.request(REQUEST);
    panels.request({ ...REQUEST, taskId: "t2" });
    fake.panels[0]!.answer({ kind: "failed", code: 1 });
    await waitFor(() => unavailable() === 1);
    expect(panels.available).toBe(false);
    expect(logs.lines.find((line) => line.msg === "approval_popup_unavailable")).toEqual({
      level: "warn",
      msg: "approval_popup_unavailable",
      fields: { platform: process.platform, reason: "failed" },
    });
    fake.panels[1]!.answer({ kind: "failed", code: 1 });
    await Bun.sleep(20);
    expect(unavailable()).toBe(1);
    panels.request({ ...REQUEST, taskId: "t3" });
    expect(fake.panels).toHaveLength(2);
  });

  test("retries an answer the hub couldn't take, never a refusal; logs carry no nonce, note or task text", async () => {
    const flaky = setup({ fail: (n) => (n < 3 ? new HubError(0, "unreachable", "x") : null) });
    flaky.panels.request(REQUEST);
    flaky.fake.panels[0]!.answer({ kind: "answered", decision: "deny", note: "SECRET-NOTE" });
    await waitFor(() => flaky.answers.length === 1);
    expect(flaky.attempts()).toBe(3);
    const refused = setup({ fail: () => new HubError(409, "wrong_status", "decided") });
    refused.panels.request(REQUEST);
    refused.fake.panels[0]!.answer({ kind: "answered", decision: "approve", note: "" });
    await waitFor(() => refused.logs.lines.some((line) => line.msg === "approval_answer_failed"));
    expect(refused.logs.lines.find((line) => line.msg === "approval_answer_failed")?.fields).toEqual({ task_id: "t1", status: 409 });
    expect(refused.attempts()).toBe(1);
    for (const logs of [flaky.logs, refused.logs]) {
      const text = JSON.stringify(logs.lines);
      for (const secret of [REQUEST.nonce, "SECRET-NOTE", "Summarize"]) expect(text).not.toContain(secret);
    }
  });

  test("a hub that answers 5xx is retried, and given up on after two retries", async () => {
    const down = setup({ fail: () => new HubError(503, "http_error", "down") });
    down.panels.request(REQUEST);
    down.fake.panels[0]!.answer({ kind: "answered", decision: "approve", note: "" });
    await waitFor(() => down.logs.lines.some((line) => line.msg === "approval_answer_failed"));
    expect(down.attempts()).toBe(3);
    expect(down.logs.lines.find((line) => line.msg === "approval_answer_failed")?.fields).toEqual({ task_id: "t1", status: 503 });
  });

  test("instructions are cleaned before they reach the panel", () => {
    const { panels, fake } = setup();
    panels.request({ ...REQUEST, instructions: "Run\u202E this\u200B now\r\nok" });
    expect(fake.panels[0]!.prompt.instructions).toBe("Run this now\nok");
  });

  test("an invalid request is ignored and logged; without a runner nothing shows", () => {
    const { panels, fake, logs } = setup();
    panels.request({ taskId: "t1", nonce: "short" });
    expect(fake.panels).toEqual([]);
    expect(logs.lines.map((line) => line.msg)).toEqual(["approval_request_invalid"]);
    const none = setup({ runner: false });
    expect(none.panels.available).toBe(false);
    none.panels.request(REQUEST);
    none.panels.request({ ...REQUEST, taskId: "t2" });
    expect(none.fake.panels).toEqual([]);
    expect(none.panels.openCount).toBe(0);
    expect(none.logs.lines.filter((line) => line.msg === "approval_request_ignored")).toEqual([
      { level: "warn", msg: "approval_request_ignored", fields: { task_id: "t1", reason: "no_popup" } },
    ]);
  });
});
