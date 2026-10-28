import { describe, expect, test } from "bun:test";
import { checkSummary } from "../src/core/messages";
import type { Task } from "../src/core/tasks";
import {
  addAppAgent,
  addComputer,
  addMember,
  addOwner,
  addSession,
  callAs,
  callPerson,
  DAY,
  errorCode,
  HOUR,
  makePortico,
  MINUTE,
  signIn,
} from "./helpers";

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const maya = await addMember(p);
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  const muse = addAppAgent(p, chris, "muse", { approvalRequired: true });
  const dot = addAppAgent(p, maya, "maya-dot", { kind: "dots" });
  const { computer } = addComputer(p, chris);
  const claude = addSession(p, computer, { repo: "portico" }).agent;
  return { p, chris, maya, grok: grok.agent, muse: muse.agent, dot: dot.agent, claude };
}

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

describe("a task's outcome", () => {
  test("a new question is queued, then delivered; both are in progress", async () => {
    const { p, grok, claude } = await setup();
    const { message } = p.messages.send(grok, { to: claude.name, subject: "Review the export", text: "Please review." });
    expect(p.tasks.get(message.id)!.task).toMatchObject({ state: "queued", outcome: "in_progress", subject: "Review the export" });
    p.messages.inbox(claude);
    const { task } = p.tasks.get(message.id)!;
    expect(task).toMatchObject({ state: "delivered", outcome: "in_progress", endedAt: null });
    expect(task.steps.map((s) => s.kind)).toEqual(["asked", "seen"]);
  });

  test("an answer from the agent asked makes it done, with the answer's summary", async () => {
    const { p, grok, claude } = await setup();
    const ask = p.messages.send(grok, { to: claude.name, subject: "Review the export", text: "Please review." }).message;
    p.messages.inbox(claude);
    p.clock.advance(8 * MINUTE);
    const reply = p.messages.send(claude, {
      replyTo: ask.id,
      subject: "Review done",
      text: "Long findings…",
      summary: "  Two bugs found, both fixed  ",
    }).message;
    expect(reply.rootId).toBe(ask.id);
    p.messages.inbox(grok);
    const { task, messageIds } = p.tasks.get(ask.id)!;
    expect(task).toMatchObject({
      state: "answered",
      outcome: "done",
      endedAt: reply.createdAt,
      answer: { id: reply.id, subject: "Review done", summary: "Two bugs found, both fixed" },
      messageCount: 2,
    });
    expect(task.steps.map((s) => s.kind)).toEqual(["asked", "seen", "answered", "answer_seen"]);
    expect(messageIds).toEqual([ask.id, reply.id]);
    // A reply to the reply stays in the same task.
    const thanks = p.messages.send(grok, { replyTo: reply.id, subject: "Thanks", text: "!" }).message;
    expect(thanks.rootId).toBe(ask.id);
    expect(p.tasks.get(ask.id)!.task.messageCount).toBe(3);
  });

  test("a held message needs a decision; Don't allow makes it not go through; Allow once moves it on", async () => {
    const { p, chris, grok, muse } = await setup();
    const denied = p.messages.send(grok, { to: "muse", subject: "Post this", text: "Now" }).message;
    expect(p.tasks.get(denied.id)!.task).toMatchObject({ state: "needs_approval", outcome: "decide", heldMessageId: denied.id });
    p.approvals.decide(chris.id, denied.id, "deny");
    expect(p.tasks.get(denied.id)!.task).toMatchObject({ state: "denied", outcome: "failed", heldMessageId: null });
    const allowed = p.messages.send(grok, { to: "muse", subject: "Find a time", text: "With Sam" }).message;
    p.approvals.decide(chris.id, allowed.id, "allow_once");
    const { task } = p.tasks.get(allowed.id)!;
    expect(task.state).toBe("queued");
    expect(task.steps.find((s) => s.kind === "allowed")).toMatchObject({ personId: chris.id, decision: "allow_once" });
    expect(muse.id).toBeDefined();
  });

  test("an unanswered question goes through as no answer a day after delivery; an unread one expires", async () => {
    const { p, grok, claude, dot } = await setup();
    const unanswered = p.messages.send(grok, { to: claude.name, subject: "Status?", text: "?" }).message;
    p.messages.inbox(claude);
    const unread = p.messages.send(grok, { to: "maya-dot", subject: "Churn?", text: "?" }).message;
    p.clock.advance(DAY + MINUTE);
    p.messages.expireDue();
    expect(p.tasks.get(unanswered.id)!.task).toMatchObject({ state: "no_answer", outcome: "failed" });
    expect(p.tasks.get(unread.id)!.task).toMatchObject({ state: "expired", outcome: "failed", endedAt: unread.expiresAt });
    expect(dot.id).toBeDefined();
  });

  test("lists filter by agent, project and outcome, count every outcome, and page by start time", async () => {
    const { p, chris, grok, claude, dot } = await setup();
    const sent: Task["id"][] = [];
    for (const subject of ["One", "Two", "Three"]) {
      sent.push(p.messages.send(grok, { to: claude.name, subject, text: "t" }).message.id);
      p.clock.advance(MINUTE);
    }
    p.messages.send(dot, { to: "grok", subject: "Other", text: "t" });
    p.messages.send(grok, { to: "muse", subject: "Held", text: "t" });
    const all = p.tasks.list({ visible: null });
    expect(all.tasks.map((t) => t.subject)).toEqual(["Held", "Other", "Three", "Two", "One"]);
    expect(all.counts).toEqual({ decide: 1, in_progress: 4, done: 0, failed: 0 });
    expect(p.tasks.list({ visible: null, outcome: "decide" }).tasks.map((t) => t.subject)).toEqual(["Held"]);
    expect(p.tasks.list({ visible: null, agentId: claude.id }).tasks).toHaveLength(3);
    expect(p.tasks.list({ visible: null, anyOf: [claude.id] }).tasks).toHaveLength(3);
    const first = p.tasks.list({ visible: null, agentId: claude.id, limit: 2 });
    expect(first).toMatchObject({ more: true });
    const next = p.tasks.list({ visible: null, agentId: claude.id, limit: 2, before: first.tasks.at(-1)!.startedAt });
    expect(next.tasks.map((t) => t.subject)).toEqual(["One"]);
    // A member sees only tasks with one of their own agents.
    expect(p.tasks.list({ visible: [dot.id] }).tasks.map((t) => t.subject)).toEqual(["Other"]);
    expect(chris.id).toBeDefined();
  });

  test("a task is pruned whole, once its newest message is past the history window, and keeps its ID", async () => {
    const { p, grok, claude } = await setup();
    const ask = p.messages.send(grok, { to: claude.name, subject: "Ask", text: "?" }).message;
    p.clock.advance(2 * DAY);
    p.messages.send(claude, { replyTo: ask.id, subject: "Answer", text: "!" });
    p.clock.advance(29 * DAY);
    p.messages.expireDue();
    // 31 days after the question, 29 after the answer: the task stays, question included.
    expect(p.messages.prune().messages).toBe(0);
    expect(p.tasks.get(ask.id)!.messageIds).toHaveLength(2);
    p.clock.advance(2 * DAY);
    p.messages.expireDue();
    expect(p.messages.prune().messages).toBe(2);
    expect(p.tasks.get(ask.id)).toBeNull();
  });

  test("a task whose first message an earlier Portico pruned still opens under the first message's ID", async () => {
    const { p, grok, claude } = await setup();
    const ask = p.messages.send(grok, { to: claude.name, subject: "Ask", text: "?" }).message;
    const reply = p.messages.send(claude, { replyTo: ask.id, subject: "Answer", text: "!" }).message;
    p.db.run("PRAGMA foreign_keys = OFF");
    p.db.query("DELETE FROM messages WHERE id = $id").run({ id: ask.id });
    p.db.run("PRAGMA foreign_keys = ON");
    const listed = p.tasks.list({ visible: null }).tasks;
    expect(listed.map((t) => t.id)).toEqual([ask.id]);
    expect(p.tasks.get(ask.id)!.messageIds).toEqual([reply.id]);
  });

  test("a summary is optional, one line, at most 120 characters", () => {
    expect(checkSummary(undefined)).toBeNull();
    expect(checkSummary("   ")).toBeNull();
    expect(checkSummary(" Done ")).toBe("Done");
    expect(errorCode(() => checkSummary("two\nlines"))).toBe("bad_request");
    expect(errorCode(() => checkSummary("x".repeat(121)))).toBe("bad_request");
    expect(errorCode(() => checkSummary(42))).toBe("bad_request");
  });

  test("agents send a summary through the API", async () => {
    const { p, grok, claude } = await setup();
    const token = p.agents.issueToken(grok.id, "api");
    const ask = p.messages.send(claude, { to: "grok", subject: "Look into it", text: "?" }).message;
    const res = await callAs(p, { token }, "POST", "/api/agent/messages", {
      reply_to: ask.id,
      subject: "Findings",
      text: "Long",
      summary: "Nothing broken",
    });
    expect(res.status).toBe(201);
    expect(p.tasks.get(ask.id)!.task.answer?.summary).toBe("Nothing broken");
  });
});

describe("the activity record", () => {
  test("records joins, decisions and settings changes, and leaves out message text", async () => {
    const { p, chris, grok, muse, claude } = await setup();
    const held = p.messages.send(grok, { to: "muse", subject: "Post this", text: "secret words" }).message;
    p.approvals.decide(chris.id, held.id, "always_allow");
    p.approvals.removeAllowed(chris.id, muse.id, grok.id);
    p.agents.update(chris.id, muse.id, { approvalRequired: false, name: "muse-work" });
    p.agents.update(chris.id, claude.id, { joinFromFolder: false });
    const kinds = p.activity.list().map((e) => e.kind);
    expect(kinds).toEqual([
      "folder_switched",
      "approval_switched",
      "renamed",
      "allow_removed",
      "decision",
      "agent_joined",
      "computer_joined",
      "agent_joined",
      "approval_switched",
      "agent_joined",
      "agent_joined",
    ]);
    const decision = p.activity.list().find((e) => e.kind === "decision")!;
    expect(decision).toMatchObject({ agentId: muse.id, otherId: grok.id, personId: chris.id, detail: { decision: "always_allow" } });
    expect(JSON.stringify(p.activity.list())).not.toContain("secret words");
    expect(p.activity.list({ agentIds: [claude.id] }).map((e) => e.kind)).toEqual(["folder_switched", "agent_joined"]);
  });

  test("a removed agent's entries stay, with its name; old entries are pruned", async () => {
    const { p, chris, grok } = await setup();
    p.agents.remove(chris.id, grok.id);
    const removed = p.activity.list().find((e) => e.kind === "agent_removed")!;
    expect(removed).toMatchObject({ agentId: null, detail: { name: "grok" } });
    p.clock.advance(31 * DAY);
    expect(p.activity.prune()).toBeGreaterThan(0);
    expect(p.activity.list()).toEqual([]);
  });
});

describe("the control plane's person API", () => {
  test("Today: decisions, in progress, and what ended since the page's midnight", async () => {
    const { p, chris, grok, claude } = await setup();
    const owner = signIn(p, chris);
    p.messages.send(grok, { to: "muse", subject: "Post this", text: "t" });
    const open = p.messages.send(grok, { to: claude.name, subject: "Open one", text: "t" }).message;
    const ask = p.messages.send(grok, { to: claude.name, subject: "Answered one", text: "t" }).message;
    p.messages.send(claude, { replyTo: ask.id, subject: "Here", text: "t", summary: "All good" });
    const since = new Date(p.now().getTime() - HOUR).toISOString();
    const today = await json<{
      counts: Record<string, number>;
      decisions: { held: { id: string }[]; signIns: unknown[]; waiting: unknown[] };
      inProgress: { id: string }[];
      done: { id: string; answer: { summary: string } }[];
    }>(callPerson(p, owner, "GET", `/api/today?since=${encodeURIComponent(since)}`));
    expect(today.counts).toEqual({ decide: 1, inProgress: 1, done: 1, failed: 0 });
    expect(today.inProgress.map((t) => t.id)).toEqual([open.id]);
    expect(today.done[0]).toMatchObject({ id: ask.id, answer: { summary: "All good" } });
    const later = new Date(p.now().getTime() + HOUR).toISOString();
    const tomorrow = await json<{ counts: Record<string, number> }>(
      callPerson(p, owner, "GET", `/api/today?since=${encodeURIComponent(later)}`),
    );
    expect(tomorrow.counts.done).toBe(0);
  });

  test("tasks: filters, the project list, one task with its messages, and a member sees only their own", async () => {
    const { p, chris, maya, grok, dot, claude } = await setup();
    const owner = signIn(p, chris);
    const member = signIn(p, maya);
    const mine = p.messages.send(grok, { to: claude.name, subject: "Review", text: "Full text" }).message;
    const theirs = p.messages.send(grok, { to: "maya-dot", subject: "Churn", text: "t" }).message;
    const list = await json<{ tasks: { id: string; project: string | null; to: { label: string } }[]; projects: string[] }>(
      callPerson(p, owner, "GET", "/api/tasks?project=portico"),
    );
    expect(list.tasks.map((t) => t.id)).toEqual([mine.id]);
    expect(list.tasks[0]).toMatchObject({ project: "portico", to: { label: "Claude Code (portico)" } });
    expect(list.projects).toEqual(["portico"]);
    expect((await callPerson(p, owner, "GET", "/api/tasks?outcome=nope")).status).toBe(400);
    const one = await json<{ task: { id: string }; messages: { text: string }[] }>(callPerson(p, owner, "GET", `/api/tasks/${mine.id}`));
    expect(one.messages.map((m) => m.text)).toEqual(["Full text"]);
    const memberList = await json<{ tasks: { id: string }[] }>(callPerson(p, member, "GET", "/api/tasks"));
    expect(memberList.tasks.map((t) => t.id)).toEqual([theirs.id]);
    expect((await callPerson(p, member, "GET", `/api/tasks/${mine.id}`)).status).toBe(404);
    expect(dot.id).toBeDefined();
  });

  test("a long session that ended recently shows its end first; a member sees no sessions of others' agents", async () => {
    const { p, chris, maya, claude } = await setup();
    const computer = p.computers.byName("macbook")!;
    const long = p.agents.registerSession(computer, { key: "key-long-0001", repo: "portico", folderId: claude.folderId! });
    for (let i = 0; i < 3; i++) {
      p.clock.advance(HOUR);
      const short = p.agents.registerSession(computer, { key: `key-short-00${i}`, repo: "portico", folderId: claude.folderId! });
      p.agents.seen(claude.id, short.runId);
    }
    p.clock.advance(HOUR);
    p.agents.seen(claude.id, long.runId);
    const owner = signIn(p, chris);
    const first = await json<{ entries: { kind: string; id: string }[] }>(callPerson(p, owner, "GET", `/api/activity?agent=${claude.id}&limit=1`));
    expect(first.entries[0]).toMatchObject({ kind: "session_ended", id: `${long.runId}-ended` });
    const member = signIn(p, maya);
    const page = await json<{ runs: unknown[]; runCount: number }>(callPerson(p, member, "GET", `/api/agents/${claude.id}`));
    expect(page).toMatchObject({ runs: [], runCount: 0 });
  });

  test("activity: sessions start and end beside the record; the agent page counts tasks and partners", async () => {
    const { p, chris, grok, claude } = await setup();
    const owner = signIn(p, chris);
    const computer = p.computers.byName("macbook")!;
    const run = p.agents.registerSession(computer, { key: "key-again-01", repo: "portico", folderId: claude.folderId! });
    p.clock.advance(5 * MINUTE);
    p.agents.seen(claude.id, run.runId);
    p.messages.send(grok, { to: claude.name, subject: "One", text: "t" });
    p.messages.send(claude, { to: "grok", subject: "Two", text: "t" });
    const activity = await json<{ entries: { kind: string; agent: { label: string } | null }[] }>(
      callPerson(p, owner, "GET", `/api/activity?agent=${claude.id}`),
    );
    expect(activity.entries.map((e) => e.kind)).toEqual(["session_ended", "session_started", "session_started", "agent_joined"]);
    expect(activity.entries[0]!.agent?.label).toBe("Claude Code (portico)");
    const page = await json<{
      taskCounts: Record<string, number>;
      worksWith: { agent: { label: string }; tasks: number }[];
      runs: { live: boolean }[];
      runCount: number;
      agent: { label: string; liveRuns: number };
    }>(callPerson(p, owner, "GET", `/api/agents/${claude.id}`));
    expect(page.taskCounts).toEqual({ decide: 0, in_progress: 2, done: 0, failed: 0 });
    expect(page.worksWith).toEqual([expect.objectContaining({ agent: expect.objectContaining({ label: "Grok Bot" }), tasks: 2 })]);
    expect(page.runCount).toBe(2);
    expect(page.agent).toMatchObject({ label: "Claude Code (portico)", liveRuns: 0 });
  });
});
