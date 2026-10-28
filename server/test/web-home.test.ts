import { describe, expect, test } from "bun:test";
import type { AgentPageData } from "../src/api/agents";
import type { TaskListData, TodayData } from "../src/api/tasks";
import type { ActivityView, AgentView, HeldCard, MessageView, PersonView, SignInView, TaskView } from "../src/api/views";
import { agentState, clock, dayHeading, duration, esc, expiresIn, longDate } from "../src/web/client/render/common";
import { homeState, renderHome } from "../src/web/client/render/home";
import { taskLine } from "../src/web/client/render/tasks";
import type { HomeState } from "../src/web/client/render/types";
import {
  addAppAgent,
  addComputer,
  addMember,
  addOwner,
  addSession,
  copyProblems,
  makePortico,
  signIn,
  visibleCopy,
} from "./helpers";

// ---- fixtures shaped like the person API's views ----

/** Local times, so clock labels read the same in any time zone. Tuesday, October 27, 2026 at noon. */
const NOW = new Date(2026, 9, 27, 12, 0).getTime();
const at = (h: number, m: number, daysAgo = 0) => new Date(2026, 9, 27 - daysAgo, h, m).toISOString();

const CHRIS = { id: "p-chris", name: "Chris" };
const MAYA = { id: "p-maya", name: "Maya Okafor" };
const ME: PersonView = { ...CHRIS, role: "owner", status: "active", isMe: true, agentCount: 3 };

function agent(o: Partial<AgentView> & { id: string; name: string }): AgentView {
  return {
    address: o.name,
    display: o.name,
    label: o.name,
    liveRuns: 0,
    kind: "muse",
    type: "app",
    description: "",
    owner: CHRIS,
    mine: true,
    computer: null,
    folder: null,
    joinFromFolder: null,
    status: null,
    doing: null,
    repo: null,
    branch: null,
    lastSeen: at(11, 56),
    checkInMinutes: null,
    approvalRequired: false,
    createdAt: at(9, 0, 5),
    ...o,
  };
}

const grok = agent({ id: "a-grok", name: "chris-grokbot", label: "Grok Bot", kind: "grok-bot", type: "connector" });
const codex = agent({ id: "a-codex", name: "codex", label: "Codex", kind: "codex" });
const claude = agent({
  id: "a-claude",
  name: "portico-claude",
  label: "Claude Code (portico)",
  kind: "claude-code",
  type: "session",
  computer: { id: "c1", name: "macbook" },
  folder: "portico",
  repo: "portico",
  branch: "main",
  joinFromFolder: true,
  status: "busy",
  doing: "Running the tests",
  liveRuns: 2,
});
const asking = agent({
  id: "a-ask",
  name: "portico-codex",
  label: "Codex (portico)",
  kind: "codex",
  type: "session",
  computer: { id: "c1", name: "macbook" },
  folder: "portico",
  status: "waiting",
  doing: "Which migration path",
});
const gone = agent({ id: "a-gone", name: "api-claude", label: "Claude Code (api)", kind: "claude-code", type: "session", status: "offline", lastSeen: at(18, 4, 1) });
const mayaDot = agent({ id: "a-dot", name: "maya-dot", label: "Dots", kind: "dots", owner: MAYA, mine: false });
const AGENTS = [claude, asking, grok, codex, gone, mayaDot];

const ref = (a: AgentView) => ({ id: a.id, display: a.display, label: a.label, kind: a.kind });

function message(o: Partial<MessageView> & { id: string; from: AgentView; to: AgentView }): MessageView {
  return {
    threadId: "t1",
    subject: "A subject",
    text: "The text",
    replyTo: null,
    status: "delivered",
    createdAt: at(11, 0),
    expiresAt: at(11, 0, -1),
    deliveredAt: at(11, 1),
    decision: null,
    decidedAt: null,
    decidedBy: null,
    ...o,
    from: ref(o.from),
    to: ref(o.to),
  };
}

const HELD: HeldCard = {
  ...message({ id: "m-held", from: grok, to: claude, subject: "Deploy the People export to staging", status: "held", deliveredAt: null, createdAt: at(11, 58), expiresAt: at(18, 0) }),
  facts: { managedBy: CHRIS, replyToRecipient: false, earlier: [] },
};
const SIGN_IN: SignInView = { id: "s1", kind: "muse", name: "muse-work", code: "4821", status: "pending", createdAt: at(11, 58), expiresAt: at(12, 8) };

function task(o: Partial<TaskView> & { id: string; from: AgentView; to: AgentView }): TaskView {
  return {
    subject: "A task",
    state: "delivered",
    outcome: "in_progress",
    startedAt: at(10, 0),
    updatedAt: at(10, 5),
    endedAt: null,
    answer: null,
    heldMessageId: null,
    messageCount: 1,
    project: null,
    steps: [
      { kind: "asked", at: at(10, 0), by: null, decision: null },
      { kind: "seen", at: at(10, 1), by: null, decision: null },
    ],
    ...o,
    from: ref(o.from),
    to: ref(o.to),
  };
}

const REVIEW = task({
  id: "t-review",
  from: grok,
  to: codex,
  subject: "Review request: Wingman Event Bot",
  state: "answered",
  outcome: "done",
  startedAt: at(9, 9),
  endedAt: at(9, 17),
  answer: { id: "m-answer", subject: "Review done", summary: "Two bugs found, both fixed", createdAt: at(9, 17) },
  messageCount: 2,
  steps: [
    { kind: "asked", at: at(9, 9), by: null, decision: null },
    { kind: "seen", at: at(9, 9), by: null, decision: null },
    { kind: "answered", at: at(9, 17), by: null, decision: null },
    { kind: "answer_seen", at: at(9, 21), by: null, decision: null },
  ],
});
const OPEN = task({ id: "t-open", from: asking, to: claude, subject: "Schema migration plan", startedAt: at(11, 25), project: "portico" });
const DENIED = task({
  id: "t-denied",
  from: claude,
  to: codex,
  subject: "Clean up old worktrees",
  state: "denied",
  outcome: "failed",
  startedAt: at(11, 15, 1),
  endedAt: at(11, 20, 1),
  steps: [
    { kind: "asked", at: at(11, 15, 1), by: null, decision: null },
    { kind: "held", at: at(11, 15, 1), by: null, decision: null },
    { kind: "denied", at: at(11, 20, 1), by: CHRIS, decision: "deny" },
  ],
});
const HELD_TASK = task({
  id: "m-held",
  from: grok,
  to: claude,
  subject: HELD.subject,
  state: "needs_approval",
  outcome: "decide",
  startedAt: at(11, 58),
  heldMessageId: "m-held",
  project: "portico",
  steps: [
    { kind: "asked", at: at(11, 58), by: null, decision: null },
    { kind: "held", at: at(11, 58), by: null, decision: null },
  ],
});

const TODAY: TodayData = {
  since: at(0, 0),
  counts: { decide: 3, inProgress: 1, done: 1, failed: 0 },
  decisions: { held: [HELD], signIns: [SIGN_IN], waiting: [asking] },
  inProgress: [OPEN],
  done: [REVIEW],
  failed: [],
};

const TASKS: TaskListData = {
  tasks: [HELD_TASK, OPEN, REVIEW, DENIED],
  counts: { decide: 1, in_progress: 1, done: 1, failed: 1 },
  more: false,
  projects: ["portico"],
};

function state(o: Partial<HomeState> = {}): HomeState {
  const base = homeState({
    me: ME,
    publicUrl: "https://portico.example.com",
    agents: AGENTS,
    approvals: { held: [HELD], signIns: [SIGN_IN] },
    route: { page: "today" },
    today: TODAY,
    tasks: null,
    agentPage: null,
    now: NOW,
  });
  return { ...base, ...o };
}

/** Renders a page and checks the copy rules on what a reader sees. */
function render(s: HomeState): string {
  const html = renderHome(s);
  expect(copyProblems(visibleCopy(html))).toEqual([]);
  return html;
}

/** The text a reader sees, tags dropped and whitespace squeezed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function inOrder(html: string, ...parts: string[]): void {
  let from = -1;
  for (const part of parts) {
    const i = html.indexOf(part, from + 1);
    expect(i, `"${part}" after position ${from}`).toBeGreaterThan(from);
    from = i;
  }
}

// ---- the pages ----

describe("Today", () => {
  test("the date, the counts, what needs a decision, in progress and done today", () => {
    const t = text(render(state()));
    expect(t).toContain("Today Tuesday, October 27");
    expect(t).toContain("3 need a decision");
    expect(t).toContain("1 in progress");
    expect(t).toContain("1 done");
    inOrder(t, "Needs a decision", "In progress", "Done today");
  });

  test("a held message: who wants what, why it waits, and Don't allow, Always allow <sender>, Allow once at the right", () => {
    const html = render(state());
    const t = text(html);
    expect(t).toContain("Grok Bot wants to ask Claude Code (portico): Deploy the People export to staging");
    expect(t).toContain(
      "First time Grok Bot has asked Claude Code (portico) for anything, and new contacts need approval. Expires today at 6:00 PM.",
    );
    inOrder(t, "Show message", "Don't allow", "Always allow Grok Bot", "Allow once");
    expect(html).not.toContain("The text");
    expect(text(render(state({ shownMessages: { "m-held": true } })))).toContain("The text");
  });

  test("an app asking to join shows its code; a coding agent with a question points to its terminal", () => {
    const t = text(render(state()));
    expect(t).toContain("Muse wants to join Portico as muse-work");
    expect(t).toContain("Approve only if Muse shows the code 4821 . Expires in 8 min.");
    inOrder(t, "Don't allow", "Approve muse-work");
    expect(t).toContain("Codex (portico) has a question");
    expect(t).toContain("Which migration path. Answer in the terminal on macbook.");
  });

  test("task rows read status, task, who, when; a done task shows the answer's summary and how long it took", () => {
    const t = text(render(state()));
    expect(t).toContain("In progress Schema migration plan Seen at 10:01 AM, no answer yet. Codex (portico) → Claude Code (portico) 11:25 AM");
    expect(t).toContain("Done Review request: Wingman Event Bot Two bugs found, both fixed Grok Bot → Codex 9:09 AM, 8 min");
  });

  test("the didn't go through chip counts every one today, not only those listed", () => {
    const many = { ...TODAY, counts: { ...TODAY.counts, failed: 35 }, failed: [OPEN] };
    expect(text(render(state({ today: many })))).toContain("35 didn't go through");
  });

  test("nothing yet: plain empty lines, and Add your first agent before any agent of the person's", () => {
    const empty: TodayData = {
      ...TODAY,
      counts: { decide: 0, inProgress: 0, done: 0, failed: 0 },
      decisions: { held: [], signIns: [], waiting: [] },
      inProgress: [],
      done: [],
    };
    const t = text(render(state({ today: empty, held: [], signIns: [], agents: [mayaDot] })));
    expect(t).toContain("Nothing needs a decision.");
    expect(t).toContain("Nothing in progress.");
    expect(t).toContain("Nothing done yet today.");
    expect(t).toContain("Add your first agent");
    expect(t).toContain("Agents from Maya Okafor are already on Portico.");
  });
});

describe("Activity", () => {
  const activity = (o: Partial<HomeState> = {}) => state({ route: { page: "activity" }, tasks: TASKS, ...o });

  test("status chips with counts, Agent and Project filters, and rows grouped by day", () => {
    const html = render(activity());
    const t = text(html);
    expect(t).toContain("All 4");
    inOrder(t, "Needs a decision 1", "In progress 1", "Done 1", "Didn't go through 1");
    expect(html).toContain('<option value="portico">portico</option>');
    expect(html).toContain('<option value="a-grok">Grok Bot</option>');
    inOrder(t, "Status Task Who When", "Today, Tuesday, October 27", "Deploy the People export", "Yesterday, Monday, October 26", "Clean up old worktrees");
    expect(t).toContain("Not allowed by Chris.");
  });

  test("the chosen filters show as pressed and selected", () => {
    const html = render(activity({ filter: { outcome: "done", agent: "a-grok", project: "portico" } }));
    expect(html).toMatch(/aria-pressed="true" data-action="outcome" data-id="done"/);
    expect(html).toContain('<option value="a-grok" selected>Grok Bot</option>');
    expect(html).toContain('<option value="portico" selected>portico</option>');
  });

  test("an opened row shows its steps and every message; a held one carries the decision", () => {
    const messages = [
      message({ id: "m1", from: grok, to: codex, subject: "Review request", text: "Please review the bots.", createdAt: at(9, 9) }),
      message({ id: "m2", from: codex, to: grok, subject: "Review done", text: "Two bugs, both fixed.", createdAt: at(9, 17) }),
    ];
    const t = text(render(activity({ openTasks: { "t-review": { task: REVIEW, messages }, "m-held": null } })));
    expect(t).toContain("Asked 9:09 AM Seen by Codex 9:09 AM Answered 9:17 AM Answer seen by Grok Bot 9:21 AM");
    inOrder(t, "Please review the bots.", "Two bugs, both fixed.");
    expect(t).toContain("Loading the messages.");
    inOrder(t, "Deploy the People export", "Don't allow", "Always allow Grok Bot", "Allow once");
  });

  test("joins, sessions and setting changes show among the tasks when asked, narrowed by project", () => {
    const events: ActivityView[] = [
      { id: "e1", at: at(11, 30), kind: "session_started", agent: ref(claude), other: null, person: null, detail: { client: "claude-code" } },
      { id: "e2", at: at(11, 40), kind: "approval_switched", agent: ref(grok), other: null, person: CHRIS, detail: { on: true } },
      { id: "e3", at: at(9, 0), kind: "decision", agent: ref(codex), other: ref(claude), person: CHRIS, detail: { decision: "deny" } },
    ];
    expect(text(render(activity({ events })))).not.toContain("Claude Code (portico) started");
    const t = text(render(activity({ showEvents: true, events })));
    inOrder(t, "Deploy the People export", "Setting New contacts need approval for Grok Bot: on Chris", "Session Claude Code (portico) started", "Schema migration plan");
    expect(t).toContain("Decision Not allowed: Claude Code (portico) to Codex Chris");
    const narrowed = text(render(activity({ showEvents: true, events, filter: { outcome: null, agent: null, project: "portico" } })));
    expect(narrowed).toContain("Claude Code (portico) started");
    expect(narrowed).not.toContain("for Grok Bot: on");
  });

  test("filters that match nothing say so; more tasks show a button", () => {
    const none = { ...TASKS, tasks: [], counts: { decide: 0, in_progress: 0, done: 0, failed: 0 } };
    expect(text(render(activity({ tasks: none, filter: { outcome: "done", agent: null, project: null } })))).toContain(
      "No tasks match these filters.",
    );
    expect(text(render(activity({ tasks: none })))).toContain("No tasks yet.");
    expect(text(render(activity({ tasks: { ...TASKS, more: true } })))).toContain("Show earlier tasks");
  });
});

describe("an agent's page", () => {
  const page = (a: AgentView, o: Partial<AgentPageData> = {}, s: Partial<HomeState> = {}) =>
    state({
      route: { page: "agent", id: a.id },
      agentPage: {
        agent: a,
        allowList: a.mine ? [] : null,
        taskCounts: { decide: 1, in_progress: 1, done: 1, failed: 0 },
        worksWith: [{ agent: ref(codex), tasks: 3, lastAt: at(9, 17) }],
        runs: [],
        runCount: 0,
        ...o,
      },
      tasks: { ...TASKS, tasks: [HELD_TASK, REVIEW] },
      ...s,
    });

  test("the header, what needs a decision, tasks from the agent's side, and who it works with", () => {
    const t = text(render(page(grok)));
    expect(t).toContain("Grok Bot Available. Last checked in 4 min ago");
    expect(t).toContain("No job description yet. Add a job description so other agents know what Grok Bot handles.");
    inOrder(t, "Needs a decision", "Grok Bot wants to ask Claude Code (portico)", "Tasks", "All 3", "Needs a decision 1", "In progress 1", "Done 1");
    expect(t).not.toContain("Didn't go through 0");
    expect(t).toContain("To Claude Code (portico)");
    expect(t).toContain("To Codex");
    expect(t).toContain("Codex 3 tasks, last at 9:17 AM");
  });

  test("Details and Settings open on request; a session shows its folder, branch, computer and sessions", () => {
    expect(text(render(page(claude)))).not.toContain("Folder portico");
    const runs = [
      { id: "r2", agent: ref(claude), client: "claude-code" as const, startedAt: at(11, 0), lastSeenAt: at(11, 59), endedAt: null, live: true },
      { id: "r1", agent: ref(claude), client: "claude-code" as const, startedAt: at(9, 0), lastSeenAt: at(9, 40), endedAt: at(9, 40), live: false },
    ];
    const t = text(render(page(claude, { runs, runCount: 2 }, { detailsOpen: true, settingsOpen: true })));
    expect(t).toContain("Claude Code (portico) Working");
    expect(t).toContain("Running the tests");
    expect(t).toContain("Folder portico Branch main Computer macbook Sessions 2 sessions in the last 30 days, 2 open now");
    expect(t).toContain("Started 11:00 AM, open now");
    expect(t).toContain("Started 9:00 AM, stopped 9:40 AM");
    expect(t).toContain("New contacts need approval Off. Any agent can send Claude Code (portico) a task.");
    expect(t).toContain("New sessions in portico join Portico");
    expect(t).not.toContain("Remove Claude Code");
  });

  test("an app's settings: the approval switch, Always allowed senders, and Remove with a confirmation", () => {
    const protectedGrok = { ...grok, approvalRequired: true };
    const allowList = [{ sender: ref(codex), addedBy: CHRIS, addedAt: at(9, 0, 3) }];
    const t = text(render(page(protectedGrok, { allowList }, { settingsOpen: true })));
    expect(t).toContain("New contacts need approval On.");
    expect(t).toContain("Always allowed Codex since Oct 24 Remove");
    expect(t).toContain("Remove Grok Bot Signs Grok Bot out of Portico and deletes Grok Bot's tasks.");
    expect(text(render(page(protectedGrok, { allowList }, { settingsOpen: true, confirmRemove: true })))).toContain(
      "Confirm: remove Grok Bot",
    );
  });

  test("a session agent can be removed once no terminal is open in the folder", () => {
    expect(text(render(page(claude, {}, { settingsOpen: true })))).not.toContain("Remove Claude Code");
    const stopped = { ...claude, status: "offline" as const, liveRuns: 0 };
    expect(text(render(page(stopped, {}, { settingsOpen: true })))).toContain(
      "Remove Claude Code (portico) Deletes the agent and the agent's tasks. A new session in portico adds the agent back.",
    );
  });

  test("someone else's agent shows who manages it and no Settings", () => {
    const html = render(page(mayaDot));
    expect(text(html)).toContain("Managed by Maya Okafor");
    expect(html).not.toContain('data-action="settings-toggle"');
  });
});

describe("the navigation", () => {
  test("Today with its count, Activity, the agents in plain words, quiet ones folded, others' agents by person", () => {
    const html = render(state());
    const t = text(html);
    expect(t).toContain("Today 3 waiting for a decision");
    inOrder(
      t,
      "Claude Code (portico) Working",
      "Codex (portico) Has a question",
      "Grok Bot Available",
      "Codex Available",
      "Muse (muse-work) Waiting to join",
      "Not running (1)",
      "Add agent",
      "Maya Okafor",
      "Dots",
    );
    expect(html).not.toContain('data-key="n-a-gone"');
    expect(render(state({ quietOpen: true }))).toContain('data-key="n-a-gone"');
    expect(render(state({ route: { page: "activity" }, tasks: TASKS }))).toMatch(
      /href="\/activity" data-action="go" data-href="\/activity" aria-current="page"/,
    );
  });
});

describe("rendering rules", () => {
  test("agent-written and person-written text is escaped everywhere", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const bad = { ...grok, label: evil, description: evil };
    const evilTask = { ...REVIEW, subject: evil, answer: { ...REVIEW.answer!, summary: evil } };
    for (const s of [
      state({ agents: [bad], held: [{ ...HELD, subject: evil, text: evil }], shownMessages: { "m-held": true }, notice: { text: evil } }),
      state({ route: { page: "activity" }, tasks: { ...TASKS, tasks: [evilTask], projects: [evil] } }),
      state({
        route: { page: "agent", id: bad.id },
        agents: [bad],
        agentPage: { agent: bad, allowList: [], taskCounts: { decide: 0, in_progress: 0, done: 1, failed: 0 }, worksWith: [], runs: [], runCount: 0 },
        tasks: { ...TASKS, tasks: [evilTask] },
      }),
    ]) {
      const html = renderHome(s);
      expect(html).not.toContain("<img src=x");
      expect(html).toContain(esc(evil));
    }
  });

  test("no inline event handlers: every action is a data-action", () => {
    const html = renderHome(state({ acctOpen: true, navOpen: true }));
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain('data-action="decide"');
  });

  test("12-hour times and US dates", () => {
    expect(clock(at(0, 5))).toBe("12:05 AM");
    expect(clock(at(12, 0))).toBe("12:00 PM");
    expect(clock(at(17, 9))).toBe("5:09 PM");
    expect(longDate(at(9, 0), NOW)).toBe("Tuesday, October 27");
    expect(dayHeading(at(9, 0, 1), NOW)).toBe("Yesterday, Monday, October 26");
    expect(dayHeading(at(9, 0, 4), NOW)).toBe("Friday, October 23");
    expect(expiresIn(at(12, 30), NOW)).toBe("Expires in 30 min.");
    expect(expiresIn(at(18, 0, -1), NOW)).toBe("Expires tomorrow at 6:00 PM.");
    expect(expiresIn(at(11, 0), NOW)).toBe("Expired.");
    expect(duration(at(9, 9), at(9, 17))).toBe("8 min");
    expect(duration(at(9, 0), at(11, 5))).toBe("2 h 5 min");
  });

  test("agent states in plain words", () => {
    expect(agentState(claude, NOW).label).toBe("Working");
    expect(agentState(asking, NOW).label).toBe("Has a question");
    expect(agentState({ ...claude, status: "idle" }, NOW).label).toBe("Available");
    expect(agentState(gone, NOW)).toMatchObject({ label: "Not running", online: false });
    expect(agentState({ ...grok, lastSeen: null }, NOW).label).toBe("Waiting to join");
  });

  test("each task state's line", () => {
    expect(taskLine({ ...OPEN, state: "queued" })).toBe("Queued until Claude Code (portico) checks for messages.");
    expect(taskLine({ ...OPEN, state: "no_answer" })).toBe("No answer within 24 hours.");
    expect(taskLine({ ...OPEN, state: "expired", steps: [] })).toBe("Expired before Claude Code (portico) checked for messages.");
    expect(taskLine({ ...HELD_TASK, state: "expired" })).toBe("Expired: no decision within 24 hours.");
    expect(taskLine({ ...REVIEW, answer: { ...REVIEW.answer!, summary: null } })).toBe("Review done");
  });
});

// ---- the pages the server sends ----

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const maya = await addMember(p, "Maya Okafor");
  const grokAgent = addAppAgent(p, chris, "grok", { kind: "grok-bot" }).agent;
  const museAgent = addAppAgent(p, chris, "muse", { approvalRequired: true }).agent;
  const dotAgent = addAppAgent(p, maya, "maya-dot", { kind: "dots" }).agent;
  const { computer } = addComputer(p, chris);
  const dialogSession = addSession(p, computer, { repo: "dialog" }).agent;
  const held = p.messages.send(grokAgent, { to: "muse", subject: "Flights to Denver", text: "Found three flights under $400." }).message;
  const chrisOnly = p.messages.send(dialogSession, { to: "grok", subject: "Webhook retries", text: "Three tries with backoff." }).message;
  const shared = p.messages.send(dotAgent, { to: "grok", subject: "Weekly status", text: "The status page is current." }).message;
  return { p, chris, maya, owner: signIn(p, chris), member: signIn(p, maya), grokAgent, museAgent, dotAgent, held, chrisOnly, shared };
}

function firstData(html: string): Record<string, any> {
  const match = html.match(/<script type="application\/json" id="first-data">([\s\S]*?)<\/script>/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("the pages", () => {
  test("signed out, each page goes to sign in and comes back", async () => {
    const { p } = await setup();
    for (const path of ["/", "/activity", "/a/a1", "/c/t1"]) {
      const res = await p.app.request(path);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(path === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(path)}`);
    }
  });

  test("a claim still waiting for approval goes to the invite page", async () => {
    const { p } = await setup();
    const priya = await addMember(p, "Priya", "pending");
    const res = await p.app.request("/", { headers: { cookie: signIn(p, priya) } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/invite");
  });

  test("Today carries its first data in the person API's shapes, and the first render", async () => {
    const { p, owner, held } = await setup();
    const res = await p.app.request("/", { headers: { cookie: owner } });
    expect(res.status).toBe(200);
    const html = await res.text();
    const data = firstData(html);
    const api = async (path: string) => (await p.app.request(path, { headers: { cookie: owner } })).json();
    expect(data.page).toBe("home");
    expect(data.route).toEqual({ page: "today" });
    expect(data.me).toEqual((await api("/api/me")).person);
    expect(data.agents).toEqual((await api("/api/agents")).agents);
    expect(data.approvals).toEqual(await api("/api/approvals"));
    expect(data.today).toEqual(await api(`/api/today?since=${encodeURIComponent(data.today.since)}`));
    expect(data.approvals.held.map((m: { id: string }) => m.id)).toEqual([held.id]);
    expect(html).toContain("<title>Today on Portico</title>");
    expect(html).toContain('<script type="module" src="/assets/app.js">');
    expect(html).toContain('href="/assets/app.css"');
    expect(html).toContain("Flights to Denver");
    expect(copyProblems(visibleCopy(html))).toEqual([]);
  });

  test("Activity and an agent's page carry their tasks; an unknown agent goes to Today; old thread links go to Activity", async () => {
    const { p, owner, grokAgent, chrisOnly } = await setup();
    const api = async (path: string) => (await p.app.request(path, { headers: { cookie: owner } })).json();
    const activityHtml = await (await p.app.request("/activity", { headers: { cookie: owner } })).text();
    const activity = firstData(activityHtml);
    expect(activity.route).toEqual({ page: "activity" });
    expect(activity.tasks).toEqual(await api("/api/tasks"));
    expect(activityHtml).toContain("Webhook retries");
    expect(copyProblems(visibleCopy(activityHtml))).toEqual([]);
    const agentHtml = await (await p.app.request(`/a/${grokAgent.id}`, { headers: { cookie: owner } })).text();
    const agentPage = firstData(agentHtml);
    expect(agentPage.route).toEqual({ page: "agent", id: grokAgent.id });
    expect(agentPage.agentPage).toEqual(await api(`/api/agents/${grokAgent.id}`));
    expect(agentPage.tasks).toEqual(await api(`/api/tasks?agent=${grokAgent.id}`));
    expect(agentHtml).toContain("<title>Grok Bot on Portico</title>");
    expect(copyProblems(visibleCopy(agentHtml))).toEqual([]);
    const unknown = await p.app.request("/a/nobody", { headers: { cookie: owner } });
    expect(unknown.headers.get("location")).toBe("/");
    const old = await p.app.request(`/c/${chrisOnly.threadId}`, { headers: { cookie: owner } });
    expect(old.headers.get("location")).toBe("/activity");
  });

  test("a member sees every agent, only tasks with the member's agents, and no invite link", async () => {
    const { p, member, shared } = await setup();
    const html = await (await p.app.request("/activity", { headers: { cookie: member } })).text();
    const data = firstData(html);
    expect(data.agents.map((a: { name: string }) => a.name).sort()).toEqual(["dialog-claude", "grok", "maya-dot", "muse"].sort());
    expect(data.tasks.tasks.map((t: { id: string }) => t.id)).toEqual([shared.id]);
    expect(data.approvals.held).toEqual([]);
    expect(html).not.toContain("Invite a person");
  });

  test("the browser modules, styles and agent icons are served", async () => {
    const p = makePortico();
    const modules = ["app.js", "render/common.js", "render/home.js", "render/nav.js", "render/today.js", "render/activity.js"];
    for (const path of [...modules, "render/agent.js", "render/tasks.js", "render/settings.js"]) {
      const res = await p.app.request(`/assets/${path}`);
      expect(res.headers.get("content-type")).toContain("text/javascript");
      const body = await res.text();
      // Type-only imports are erased, so the browser never asks for render/types.js.
      expect(body).not.toContain("types.js");
    }
    expect((await p.app.request("/assets/app.css")).headers.get("content-type")).toContain("text/css");
    for (const kind of ["claude-code", "codex", "muse", "grok-bot", "dots", "claude-duet", "other"]) {
      expect((await p.app.request(`/assets/icons/${kind}.svg`)).headers.get("content-type")).toBe("image/svg+xml");
    }
  });
});
