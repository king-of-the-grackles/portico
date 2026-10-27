import { describe, expect, test } from "bun:test";
import { ApprovalPanels, parseApprovalRequest } from "../src/approvals";
import { ApiError, type Decision } from "../src/portico-client";
import { captureLog, fakeRunner, waitFor } from "./helpers";

const REQUEST = {
  messageId: "m1",
  nonce: "nonce-aaaaaaaaaaaaaaaa",
  from: "grok",
  to: "muse",
  subject: "Read the inbox",
  text: "Summarize the inbox",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

type Body = { nonce: string; decision: Decision };

function setup(opts: { fail?: (attempt: number) => Error | null; runner?: boolean; retryMs?: number[] } = {}) {
  const answers: { messageId: string; body: Body }[] = [];
  let attempts = 0;
  let unavailable = 0;
  const client = {
    answerApproval: async (messageId: string, body: Body) => {
      attempts++;
      const err = opts.fail?.(attempts);
      if (err) throw err;
      answers.push({ messageId, body });
      return { message: {} as never };
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
  test("shows a panel for a request and sends Allow once with the request's nonce", async () => {
    const { panels, fake, answers } = setup();
    panels.request(REQUEST);
    expect(fake.panels.map((panel) => panel.prompt)).toEqual([
      {
        messageId: "m1",
        from: "grok",
        to: "muse",
        subject: "Read the inbox",
        text: "Summarize the inbox",
        expiresAt: REQUEST.expiresAt,
        slot: 0,
      },
    ]);
    fake.panels[0]!.answer({ kind: "answered", decision: "allow_once" });
    await waitFor(() => answers.length === 1);
    expect(answers[0]).toEqual({ messageId: "m1", body: { nonce: REQUEST.nonce, decision: "allow_once" } });
    expect(panels.openCount).toBe(0);
  });

  test("each of the three buttons sends its own decision", async () => {
    const { panels, fake, answers } = setup();
    const decisions: Decision[] = ["deny", "always_allow", "allow_once"];
    decisions.forEach((decision, i) => {
      panels.request({ ...REQUEST, messageId: `m${i}` });
      fake.panels[i]!.answer({ kind: "answered", decision });
    });
    await waitFor(() => answers.length === 3);
    expect(answers.map((answer) => [answer.messageId, answer.body.decision])).toEqual([
      ["m0", "deny"],
      ["m1", "always_allow"],
      ["m2", "allow_once"],
    ]);
  });

  test("a repeat request for the same message updates the nonce instead of opening a second panel; a second message cascades", async () => {
    const { panels, fake, answers } = setup();
    panels.request(REQUEST);
    panels.request({ ...REQUEST, nonce: "nonce-bbbbbbbbbbbbbbbb" });
    expect(fake.panels).toHaveLength(1);
    panels.request({ ...REQUEST, messageId: "m2" });
    expect(fake.panels[1]!.prompt.slot).toBe(1);
    fake.panels[0]!.answer({ kind: "answered", decision: "allow_once" });
    await waitFor(() => answers.length === 1);
    expect(answers[0]!.body.nonce).toBe("nonce-bbbbbbbbbbbbbbbb");
    // m1's slot is free again, while m2 still holds slot 1: the next panel takes the lowest free one.
    panels.request({ ...REQUEST, messageId: "m3" });
    panels.request({ ...REQUEST, messageId: "m4" });
    expect(fake.panels.slice(2).map((panel) => [panel.prompt.messageId, panel.prompt.slot])).toEqual([
      ["m3", 0],
      ["m4", 2],
    ]);
  });

  test("approval_closed kills the panel, and an answer that comes after is never sent", async () => {
    const { panels, fake, answers } = setup();
    panels.request(REQUEST);
    panels.closed({ messageId: "m1", outcome: "allowed" });
    expect(fake.panels[0]!.killed).toBe(true);
    fake.panels[0]!.answer({ kind: "answered", decision: "allow_once" });
    await Bun.sleep(20);
    expect(answers).toEqual([]);
  });

  test("at most five panels are open at once; later requests wait in order, and a closed one leaves the queue", async () => {
    const { panels, fake } = setup();
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) panels.request({ ...REQUEST, messageId: `m${n}` });
    expect(fake.panels.map((panel) => [panel.prompt.messageId, panel.prompt.slot])).toEqual([
      ["m1", 0],
      ["m2", 1],
      ["m3", 2],
      ["m4", 3],
      ["m5", 4],
    ]);
    expect(panels.openCount).toBe(5);
    panels.request({ ...REQUEST, messageId: "m6", nonce: "nonce-bbbbbbbbbbbbbbbb" }); // a repeat while queued: still one entry
    panels.closed({ messageId: "m7", outcome: "allowed" }); // decided while waiting: it never shows
    panels.closed({ messageId: "m2", outcome: "declined" });
    expect(fake.panels.slice(5).map((panel) => [panel.prompt.messageId, panel.prompt.slot])).toEqual([["m6", 1]]);
    fake.panels[0]!.answer({ kind: "dismissed" });
    await waitFor(() => fake.panels.length === 7);
    expect(fake.panels.at(-1)!.prompt).toMatchObject({ messageId: "m8", slot: 0 });
    expect(panels.openCount).toBe(5);
  });

  test("closeAll empties the queue too, so nothing opens after it", async () => {
    const { panels, fake } = setup();
    for (const n of [1, 2, 3, 4, 5, 6]) panels.request({ ...REQUEST, messageId: `m${n}` });
    panels.closeAll();
    await Bun.sleep(20);
    expect(fake.panels).toHaveLength(5);
    expect(fake.panels.every((panel) => panel.killed)).toBe(true);
    expect(panels.openCount).toBe(0);
  });

  test("a queued request is answered with its newest nonce once it shows", async () => {
    const { panels, fake, answers } = setup();
    for (const n of [1, 2, 3, 4, 5, 6]) panels.request({ ...REQUEST, messageId: `m${n}` });
    panels.request({ ...REQUEST, messageId: "m6", nonce: "nonce-cccccccccccccccc" });
    panels.closed({ messageId: "m1", outcome: "allowed" });
    fake.panels[5]!.answer({ kind: "answered", decision: "allow_once" });
    await waitFor(() => answers.length === 1);
    expect(answers[0]).toEqual({ messageId: "m6", body: { nonce: "nonce-cccccccccccccccc", decision: "allow_once" } });
  });

  test("no second panel opens for a message whose answer is on its way or being retried", async () => {
    const pending = setup({ fail: (n) => (n === 1 ? new ApiError(0, "unreachable", "x") : null), retryMs: [200] });
    pending.panels.request(REQUEST);
    pending.fake.panels[0]!.answer({ kind: "answered", decision: "allow_once" });
    await waitFor(() => pending.attempts() === 1);
    pending.panels.request({ ...REQUEST, nonce: "nonce-bbbbbbbbbbbbbbbb" }); // re-sent after a reconnect, mid-retry
    expect(pending.fake.panels).toHaveLength(1);
    await waitFor(() => pending.answers.length === 1);
    expect(pending.fake.panels).toHaveLength(1);
    expect(pending.answers[0]!.body.nonce).toBe(REQUEST.nonce);

    let land!: () => void;
    const fake = fakeRunner();
    const slow = new ApprovalPanels({
      client: { answerApproval: () => new Promise<{ message: never }>((resolve) => (land = () => resolve({ message: {} as never }))) },
      runner: fake.runner,
      log: captureLog().log,
    });
    slow.request(REQUEST);
    fake.panels[0]!.answer({ kind: "answered", decision: "deny" });
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
        answerApproval: (_messageId, body) =>
          new Promise<{ message: never }>((resolve, reject) =>
            calls.push({ nonce: body.nonce, settle: (err) => (err ? reject(err) : resolve({ message: {} as never })) }),
          ),
      },
      runner: fake.runner,
      log: captureLog().log,
      retryMs: [],
    });
    panels.request(REQUEST);
    fake.panels[0]!.answer({ kind: "answered", decision: "allow_once" });
    await waitFor(() => calls.length === 1);
    panels.request({ ...REQUEST, nonce: "nonce-bbbbbbbbbbbbbbbb" }); // a restarted Portico re-sends with a new nonce
    panels.request({ ...REQUEST, nonce: "nonce-cccccccccccccccc" }); // the latest one is kept
    expect(fake.panels).toHaveLength(1);
    calls[0]!.settle(new ApiError(403, "not_allowed", "No pop-up request for this session matches."));
    await waitFor(() => fake.panels.length === 2);
    expect(fake.panels[1]!.prompt.messageId).toBe("m1");
    fake.panels[1]!.answer({ kind: "answered", decision: "allow_once" });
    await waitFor(() => calls.length === 2);
    expect(calls[1]!.nonce).toBe("nonce-cccccccccccccccc");
    calls[1]!.settle(null);

    // A kept request is dropped when the answer lands, or when the message is closed meanwhile.
    panels.request({ ...REQUEST, messageId: "m2" });
    fake.panels[2]!.answer({ kind: "answered", decision: "allow_once" });
    await waitFor(() => calls.length === 3);
    panels.request({ ...REQUEST, messageId: "m2", nonce: "nonce-dddddddddddddddd" });
    calls[2]!.settle(null);
    panels.request({ ...REQUEST, messageId: "m3" });
    fake.panels[3]!.answer({ kind: "answered", decision: "deny" });
    await waitFor(() => calls.length === 4);
    panels.request({ ...REQUEST, messageId: "m3", nonce: "nonce-eeeeeeeeeeeeeeee" });
    panels.closed({ messageId: "m3", outcome: "allowed" });
    calls[3]!.settle(new ApiError(409, "wrong_status", "decided"));
    await Bun.sleep(20);
    expect(fake.panels).toHaveLength(4);
  });

  test("closeAll kills every panel, as when the stream drops", () => {
    const { panels, fake } = setup();
    panels.request(REQUEST);
    panels.request({ ...REQUEST, messageId: "m2" });
    expect(panels.openCount).toBe(2);
    panels.closeAll();
    expect(fake.panels.map((panel) => panel.killed)).toEqual([true, true]);
    expect(panels.openCount).toBe(0);
  });

  test("the panel is killed when the message expires, and an already expired request shows nothing", async () => {
    const { panels, fake } = setup();
    panels.request({ ...REQUEST, expiresAt: new Date(Date.now() + 30).toISOString() });
    await waitFor(() => fake.panels[0]!.killed);
    panels.request({ ...REQUEST, messageId: "m2", expiresAt: new Date(Date.now() - 1).toISOString() });
    expect(fake.panels).toHaveLength(1);
  });

  test("a dismissed panel sends nothing; a failed one is logged", async () => {
    const { panels, fake, answers, logs } = setup();
    panels.request(REQUEST);
    fake.panels[0]!.answer({ kind: "dismissed" });
    panels.request({ ...REQUEST, messageId: "m2" });
    fake.panels[1]!.answer({ kind: "failed", code: 1 });
    await Bun.sleep(20);
    expect(answers).toEqual([]);
    expect(logs.lines.find((line) => line.msg === "approval_popup_failed")?.fields).toEqual({ message_id: "m2", code: 1 });
  });

  test("a panel that fails to show turns pop-ups off for good, once, so the session stops declaring them", async () => {
    const { panels, fake, logs, unavailable } = setup();
    expect(panels.available).toBe(true);
    panels.request(REQUEST);
    panels.request({ ...REQUEST, messageId: "m2" });
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
    panels.request({ ...REQUEST, messageId: "m3" });
    expect(fake.panels).toHaveLength(2);
  });

  test("retries an answer Portico couldn't take, never a refusal; logs carry no nonce, subject or text", async () => {
    const flaky = setup({ fail: (n) => (n < 3 ? new ApiError(0, "unreachable", "x") : null) });
    flaky.panels.request(REQUEST);
    flaky.fake.panels[0]!.answer({ kind: "answered", decision: "deny" });
    await waitFor(() => flaky.answers.length === 1);
    expect(flaky.attempts()).toBe(3);
    const refused = setup({ fail: () => new ApiError(409, "wrong_status", "decided") });
    refused.panels.request(REQUEST);
    refused.fake.panels[0]!.answer({ kind: "answered", decision: "allow_once" });
    await waitFor(() => refused.logs.lines.some((line) => line.msg === "approval_answer_failed"));
    expect(refused.logs.lines.find((line) => line.msg === "approval_answer_failed")?.fields).toEqual({ message_id: "m1", status: 409 });
    expect(refused.attempts()).toBe(1);
    for (const logs of [flaky.logs, refused.logs]) {
      const text = JSON.stringify(logs.lines);
      for (const secret of [REQUEST.nonce, "Read the inbox", "Summarize"]) expect(text).not.toContain(secret);
    }
  });

  test("Portico answering 5xx is retried, and given up on after two retries", async () => {
    const down = setup({ fail: () => new ApiError(503, "http_error", "down") });
    down.panels.request(REQUEST);
    down.fake.panels[0]!.answer({ kind: "answered", decision: "allow_once" });
    await waitFor(() => down.logs.lines.some((line) => line.msg === "approval_answer_failed"));
    expect(down.attempts()).toBe(3);
    expect(down.logs.lines.find((line) => line.msg === "approval_answer_failed")?.fields).toEqual({ message_id: "m1", status: 503 });
  });

  test("the subject and the text are cleaned before they reach the panel", () => {
    const { panels, fake } = setup();
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    panels.request({ ...REQUEST, subject: `Read${rlo} the\ninbox${zwsp}`, text: `Run${rlo} this${zwsp} now\r\nok` });
    expect(fake.panels[0]!.prompt.subject).toBe("Read the inbox");
    expect(fake.panels[0]!.prompt.text).toBe("Run this now\nok");
  });

  test("an invalid request is ignored and logged; without a runner nothing shows", () => {
    const { panels, fake, logs } = setup();
    panels.request({ messageId: "m1", nonce: "short" });
    panels.request({ ...REQUEST, subject: "" });
    expect(fake.panels).toEqual([]);
    expect(logs.lines.map((line) => line.msg)).toEqual(["approval_request_invalid", "approval_request_invalid"]);
    expect(parseApprovalRequest({ ...REQUEST, taskId: "t1", messageId: undefined })).toBeNull();
    const none = setup({ runner: false });
    expect(none.panels.available).toBe(false);
    none.panels.request(REQUEST);
    none.panels.request({ ...REQUEST, messageId: "m2" });
    expect(none.fake.panels).toEqual([]);
    expect(none.panels.openCount).toBe(0);
    expect(none.logs.lines.filter((line) => line.msg === "approval_request_ignored")).toEqual([
      { level: "warn", msg: "approval_request_ignored", fields: { message_id: "m1", reason: "no_popup" } },
    ]);
  });
});
