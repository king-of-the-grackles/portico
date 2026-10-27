import { describe, expect, test } from "bun:test";
import type { AgentView, HeldCard, MessageView, PersonView, SignInView, ThreadView } from "../src/api/views";
import { agentState, esc, expiresIn } from "../src/web/client/render/common";
import { homeState, messageStatus, renderHome } from "../src/web/client/render/home";
import type { AddState, HomeState } from "../src/web/client/render/types";
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

// ---- fixtures shaped like the person API's views, after the canvas's sample data ----

/** Local times, so clock labels read the same in any time zone. */
const NOW = new Date(2026, 9, 27, 12, 0).getTime();
const at = (h: number, m: number, daysAgo = 0) => new Date(2026, 9, 27 - daysAgo, h, m).toISOString();

const CHRIS = { id: "p-chris", name: "Chris" };
const MAYA = { id: "p-maya", name: "Maya Okafor" };
const PRIYA = { id: "p-priya", name: "Priya Shah" };

function person(p: { id: string; name: string }, role: "owner" | "member", agentCount = 0): PersonView {
  return { ...p, role, status: "active", isMe: true, agentCount };
}

function agent(o: Partial<AgentView> & { id: string; name: string }): AgentView {
  return {
    address: o.name,
    display: o.name,
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
    checkInMinutes: 10,
    approvalRequired: false,
    createdAt: at(9, 0, 5),
    ...o,
  };
}

function session(o: Partial<AgentView> & { id: string; name: string; computer: { id: string; name: string } }): AgentView {
  return agent({ kind: "claude-code", type: "session", checkInMinutes: null, joinFromFolder: true, status: "idle", ...o });
}

const GROK_DESC =
  "Web research, long errands and anything that needs a browser for a while. Good at comparing prices, finding primary sources and summarizing long threads on X into a few lines.";

const MACBOOK = { id: "c-macbook", name: "macbook" };
const STUDIO = { id: "c-studio", name: "studio" };
const LINUX = { id: "c-linux", name: "maya-linux" };

const dialog = session({ id: "a-dialog", name: "dialog-claude", computer: MACBOOK, repo: "dialog", branch: "fix/webhook-retry", status: "busy", doing: "Fixing webhook retries: adding a backoff test" });
const api = session({ id: "a-api", name: "api-claude", computer: MACBOOK, repo: "api", branch: "billing-v2", status: "waiting", doing: "Billing migration: stopped at a permission prompt" });
const MUSE_DESC =
  "Personal assistant with access to email, calendar, texts, and Facebook and Instagram messages. Handles scheduling, inbox triage and quick replies. Asks before sending anything or sharing personal details with anyone outside the family.";
const muse = agent({ id: "a-muse", name: "muse", description: MUSE_DESC, approvalRequired: true, lastSeen: at(11, 56) });
const grok = agent({ id: "a-grok", name: "grok", kind: "grok-bot", description: GROK_DESC, lastSeen: at(11, 48) });
const duet = agent({ id: "a-duet", name: "duet", kind: "claude-duet", type: "connector", lastSeen: at(11, 59) });
const mayaCodex = session({ id: "a-codex", name: "maya-codex", kind: "codex", owner: MAYA, mine: false, computer: LINUX, repo: "portico", branch: "join-page", status: "busy", doing: "Rewriting the join page for agents" });
const mayaDot = agent({ id: "a-dot", name: "maya-dot", kind: "dots", type: "connector", owner: MAYA, mine: false, checkInMinutes: 15, lastSeen: at(11, 58) });
const web = session({ id: "a-web", name: "web-claude", computer: STUDIO, repo: "web", branch: "redesign", status: "offline", lastSeen: at(18, 4, 1) });
const AGENTS = [dialog, api, muse, grok, duet, mayaCodex, mayaDot, web];

const ref = (a: AgentView) => ({ id: a.id, display: a.display, kind: a.kind });

function message(o: Partial<MessageView> & { id: string; from: AgentView; to: AgentView; text: string }): MessageView {
  return {
    threadId: "t-api-muse",
    subject: "A subject",
    replyTo: null,
    status: "delivered",
    createdAt: at(10, 18),
    expiresAt: at(10, 18, -1),
    deliveredAt: at(10, 19),
    decision: null,
    decidedAt: null,
    decidedBy: null,
    ...o,
    from: ref(o.from),
    to: ref(o.to),
  };
}

const first = message({ id: "m1", from: api, to: muse, text: "Please find a time with Sam this week for the billing review.", decision: "allow_once", decidedAt: at(10, 19), decidedBy: CHRIS });
const reply = message({ id: "m2", from: muse, to: api, subject: "Thursday 2pm confirmed", text: "Sam confirmed Thursday 2pm for the billing review. Calendar invite sent.", createdAt: at(10, 23), deliveredAt: at(10, 24), replyTo: { id: "m1", from: ref(api), subject: "A subject", text: "Please find a time with Sam this week for the billing review.", createdAt: at(10, 18) } });
const heldMessage = message({
  id: "m3",
  from: api,
  to: muse,
  subject: "Add the migration doc link to Thursday's billing review invite",
  text: "Thanks. Please add the migration doc link to the invite: docs/billing-v2.md",
  status: "held",
  createdAt: at(11, 58),
  expiresAt: at(11, 58, -1),
  deliveredAt: null,
});
const HELD: HeldCard = {
  ...heldMessage,
  replyTo: { id: "m2", from: ref(muse), subject: "Thursday 2pm confirmed", text: reply.text, createdAt: at(10, 23) },
  facts: { managedBy: CHRIS, replyToRecipient: true, earlier: [{ decision: "allow_once", at: at(10, 19) }] },
};

function thread(id: string, a: AgentView, b: AgentView, last: MessageView, extra: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    a: { ...ref(a), owner: a.owner },
    b: { ...ref(b), owner: b.owner },
    startedBy: a.id,
    lastMessageAt: last.createdAt,
    last: { from: last.from, subject: last.subject, text: last.text, status: last.status },
    count: 3,
    held: 0,
    ...extra,
  };
}

const grokDialogLast = message({ id: "m9", threadId: "t-grok-dialog", from: dialog, to: grok, text: "Thanks. Adding an alert for anything older than an hour in that table.", createdAt: at(10, 42), status: "pending", deliveredAt: null });
const THREADS = [
  thread("t-grok-dialog", grok, dialog, grokDialogLast),
  thread("t-api-muse", api, muse, heldMessage, { held: 1 }),
  thread("t-codex-portico", mayaCodex, dialog, message({ id: "m7", threadId: "t-codex-portico", from: mayaCodex, to: dialog, text: "The join page copy is ready for review on the join-page branch.", createdAt: at(9, 47) })),
];

const SIGN_IN: SignInView = { id: "s1", kind: "muse", name: "muse-work", code: "4821", status: "pending", createdAt: at(11, 58), expiresAt: at(12, 8) };

function home(o: Partial<HomeState> = {}): HomeState {
  const base = homeState({
    me: person(CHRIS, "owner", 6),
    publicUrl: "https://portico.example.com",
    agents: AGENTS,
    approvals: { held: [HELD], signIns: [] },
    threads: THREADS,
    open: null,
    now: NOW,
  });
  return { ...base, ...o };
}

function addState(o: Partial<AddState> = {}): AddState {
  return {
    pick: "claude-code",
    lines: { "claude-code": { id: "j1", kind: "claude-code", line: "Join Portico: https://portico.example.com/join#T4mWq8Zr2LpX6Kd1", expiresAt: at(12, 0, -1) } },
    lineError: "",
    copied: false,
    stage: "pick",
    signIn: null,
    reqName: "",
    reqError: "",
    joined: null,
    busy: false,
    ...o,
  };
}

/** Renders Home and checks the copy rules on what a reader sees. */
function render(state: HomeState): string {
  const html = renderHome(state);
  expect(copyProblems(visibleCopy(html))).toEqual([]);
  return html;
}

/** The text a reader sees, tags dropped and whitespace squeezed. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

function inOrder(html: string, ...parts: string[]): void {
  let from = -1;
  for (const part of parts) {
    const i = html.indexOf(part, from + 1);
    expect(i, `"${part}" after position ${from}`).toBeGreaterThan(from);
    from = i;
  }
}

// ---- the render states on the canvas ----

describe("Home renders every board state", () => {
  test("A2: no agents yet", () => {
    const html = render(home({ me: person(CHRIS, "owner"), agents: [], held: [], threads: [] }));
    const t = text(html);
    expect(t).toContain("Add your first agent");
    expect(t).toContain("Connect Claude Code, Codex or a chat app like Muse with one line.");
    expect(t).toContain("No threads yet. Threads show up here when agents message each other.");
    expect(html).not.toContain("Needs approval");
    // The primary action sits far right: the row reverses, so Add agent comes first in the source.
    inOrder(html, 'class="first-actions"', "Add agent", "Invite a person");
  });

  test("A2 for a member who joins after others: agents from others are already here", () => {
    const html = render(home({ me: { ...person(PRIYA, "member"), id: PRIYA.id }, agents: AGENTS.map((a) => ({ ...a, mine: false })), held: [] }));
    expect(text(html)).toContain("Agents from Chris and Maya Okafor are already on Portico. Each new agent can message every agent here.");
    expect(html).not.toContain("Invite a person");
  });

  test("B1: Add agent with Claude Code picked shows the join line", () => {
    const html = render(home({ add: addState() }));
    const t = text(html);
    expect(t).toContain("One line connects any agent to Portico.");
    expect(t).toContain("Paste this into Claude Code on the computer that should join.");
    expect(html).toContain('value="Join Portico: https://portico.example.com/join#T4mWq8Zr2LpX6Kd1"');
    expect(t).toContain("Single use. Expires in 24 h.");
    expect(html).toContain('role="radio" aria-checked="true" class="tile is-selected" data-action="add-pick" data-id="claude-code"');
    for (const label of ["Claude Code", "Codex", "Muse", "Grok Bot", "dots", "Claude Duet", "Other"]) expect(t).toContain(label);
    expect(html).not.toContain("Waiting for");
  });

  test("B2: after Copy the sheet waits", () => {
    const t = text(render(home({ add: addState({ copied: true }) })));
    expect(t).toContain("Copied");
    expect(t).toContain("Waiting for Claude Code to connect");
  });

  test("B4: the sheet confirms the join", () => {
    const joined = session({ id: "a-new", name: "dialog-claude", computer: MACBOOK, status: "idle" });
    const html = render(home({ add: addState({ stage: "joined", joined }) }));
    const t = text(html);
    expect(t).toContain("dialog-claude joined.");
    expect(t).toContain("From macbook. Other Claude Code sessions started there join automatically.");
    inOrder(html, "Add another agent", ">Done<");
    expect(html).not.toContain("Pick an agent");
  });

  test("B5: the new agent's details open with a notice", () => {
    const fresh = session({ id: "a-dialog", name: "dialog-claude", computer: MACBOOK, repo: "dialog", branch: "main", status: "idle" });
    const html = render(
      home({
        agents: [fresh],
        held: [],
        threads: [],
        open: { kind: "agent", id: fresh.id, data: { agent: fresh, allowList: [] } },
        filter: fresh.id,
        notice: { text: "dialog-claude joined from macbook." },
      }),
    );
    const t = text(html);
    expect(t).toContain("dialog-claude joined from macbook.");
    expect(t).toContain("Showing dialog-claude");
    expect(t).toContain("Doing Nothing in progress Folder dialog on main Computer macbook");
    expect(t).toContain("Join from the dialog folder");
    expect(t).toContain("New sessions in dialog on macbook join Portico automatically.");
    expect(t).toContain("No threads with dialog-claude yet.");
  });

  test("C1: Muse picked and copied waits for the sign in request", () => {
    const add = addState({ pick: "muse", copied: true, lines: { muse: { id: "j2", kind: "muse", line: "Join Portico: https://portico.example.com/join#R8vNc3Lq7TbW1yZe", expiresAt: at(12, 0, -1) } } });
    const t = text(render(home({ add })));
    expect(t).toContain("Send this to Muse in a chat, then approve the sign in request here.");
    expect(t).toContain("Waiting for the sign in request from Muse");
  });

  test("Codex joins like an app agent in this release", () => {
    const add = addState({ pick: "codex", copied: true, lines: { codex: { id: "j3", kind: "codex", line: "Join Portico: https://portico.example.com/join#x", expiresAt: at(12, 0, -1) } } });
    const t = text(render(home({ add })));
    expect(t).toContain("Send this to Codex, then approve the sign in request here.");
    expect(t).toContain("Waiting for the sign in request from Codex");
  });

  test("C3: the sign in request arrives in the sheet with its code", () => {
    const add = addState({ pick: "muse", copied: true, stage: "request", signIn: SIGN_IN, reqName: "muse-work" });
    const html = render(home({ add }));
    const t = text(html);
    expect(t).toContain("Sign in request from Muse");
    expect(t).toContain("Expires in 8 min.");
    expect(t).toContain("Code 4821");
    expect(t).toContain("Approve only if Muse shows the same code.");
    expect(html).toContain('value="muse-work"');
    expect(t).toContain("Other agents use this name when sending messages.");
    inOrder(html, 'class="req-card', ">Deny<", ">Approve<");
    expect(html).not.toContain("Pick an agent");
  });

  test("C4: approved, muse-work joins", () => {
    const work = agent({ id: "a-work", name: "muse-work", lastSeen: null, checkInMinutes: null, createdAt: at(11, 59, 0) });
    const t = text(render(home({ add: addState({ pick: "muse", stage: "joined", joined: work }) })));
    expect(t).toContain("muse-work joined.");
    expect(t).toContain("Waiting to connect.");
  });

  test("C5: done, with a prompt to add a description", () => {
    const work = agent({ id: "a-work", name: "muse-work", checkInMinutes: 10, lastSeen: null, createdAt: at(12, 0) });
    const t = text(
      render(home({ agents: [...AGENTS, work], open: { kind: "agent", id: work.id, data: { agent: work, allowList: [] } }, filter: work.id, notice: { text: "muse-work joined." } })),
    );
    expect(t).toContain("muse-work joined.");
    expect(t).toContain("Checks in every 10 min. Joined just now");
    expect(t).toContain("Add a description so other agents know what muse-work handles.");
    expect(t).toContain("Add description");
  });

  test("D1: connectors use the /mcp address", () => {
    const html = render(home({ add: addState({ pick: "dots", copied: true }) }));
    const t = text(html);
    expect(t).toContain("Add this as a connector in ChatGPT. Portico then opens a page to approve the connection.");
    expect(html).toContain('value="https://portico.example.com/mcp"');
    expect(html).toContain(">Server address<");
    expect(t).toContain("Works only after approval.");
    expect(t).toContain("Waiting for the sign in from ChatGPT");
  });

  test("a description over 200 characters clamps behind More", () => {
    const open = { kind: "agent" as const, id: muse.id, data: { agent: muse, allowList: [] } };
    const html = render(home({ open }));
    expect(html).toContain('class="desc clamped"');
    expect(html).toContain('aria-expanded="false" data-action="desc-more">More<');
    expect(render(home({ open, expanded: true }))).toContain(">Less<");
  });

  test("E1: an agent's details", () => {
    const html = render(home({ open: { kind: "agent", id: grok.id, data: { agent: grok, allowList: [] } }, filter: grok.id }));
    const t = text(html);
    expect(t).toContain("grok Grok Bot");
    expect(t).toContain("Checks in every 10 min. Seen 12 min ago");
    expect(t).toContain("Showing grok");
    expect(html).toContain('class="desc"');
    expect(html).toContain('aria-label="Edit grok"');
    expect(html).toContain('role="switch" aria-checked="false"');
    expect(t).toContain("Remove grok");
  });

  test("E2: Approval required on, with an empty Always allow list", () => {
    const on = { ...grok, approvalRequired: true };
    const html = render(home({ agents: AGENTS.map((a) => (a.id === on.id ? on : a)), open: { kind: "agent", id: on.id, data: { agent: on, allowList: [] } } }));
    const t = text(html);
    expect(html).toContain('role="switch" aria-checked="true"');
    expect(t).toContain("Always allow These senders skip approval.");
    expect(t).toContain("None yet. Choosing Always allow on a held message adds the sender here.");
    expect(html).toContain('aria-label="Approval required"');
  });

  test("F1: the held card reads top to bottom as the board lays out", () => {
    const html = render(home());
    const card = html.slice(html.indexOf('data-key="h-m3"'));
    inOrder(
      card,
      "Add the migration doc link to Thursday&#39;s billing review invite",
      "api-claude",
      ">to<",
      "muse",
      "11:58. Expires in 24 h.",
      "Managed by Chris",
      "Reply to muse",
      "Allowed once at 10:19",
      "muse, 10:23:",
      "Sam confirmed Thursday 2pm",
      "Thanks. Please add the migration doc link",
      ">View thread<",
      ">Deny<",
      ">Always allow<",
      ">Allow once<",
    );
    expect(card).toContain('class="btn btn-link start"');
    expect(card).toContain('aria-label="Checked by Portico"');
    const t = text(html);
    expect(t).toContain("Needs approval 1");
    expect(t).toContain("1 awaiting approval");
  });

  test("F1: the quote shows the replied message's time", () => {
    expect(text(render(home()))).toContain("muse, 10:23: Sam confirmed");
  });

  test("F2: View thread opens the thread with the held message marked", () => {
    const data = { thread: THREADS[1]!, messages: [first, reply, heldMessage], more: false };
    const html = render(home({ open: { kind: "thread", id: "t-api-muse", data } }));
    const t = text(html);
    expect(t).toContain("api-claude and muse");
    expect(t).toContain("Allowed once, read 10:19");
    expect(t).toContain("Read 10:24");
    expect(html).toContain('class="msg is-held starts-conv"');
    expect(t).toContain("Awaiting approval");
    expect(t).toContain("Messages older than 30 days are deleted.");
    expect(html).toContain('aria-current="true" data-action="open-thread" data-id="t-api-muse"');
  });

  test("F3: Always allow delivers and the thread shows the decision", () => {
    const allowed = { ...heldMessage, status: "pending" as const, decision: "always_allow" as const, decidedAt: at(10, 30) };
    const data = { thread: THREADS[1]!, messages: [first, reply, allowed], more: false };
    const html = render(home({ held: [], notice: { text: "Delivered. api-claude is now always allowed.", check: true }, open: { kind: "thread", id: "t-api-muse", data } }));
    const t = text(html);
    expect(t).toContain("Delivered. api-claude is now always allowed.");
    expect(html).toContain('class="notice-strip notice-check enter"');
    expect(t).toContain("Always allowed, unread");
    expect(html).not.toContain("Needs approval");
  });

  test("F5: the thread opens at the newest, with both logos, subjects and a line where a new conversation starts", () => {
    const data = { thread: THREADS[1]!, messages: [first, reply, heldMessage], more: false };
    const html = render(home({ open: { kind: "thread", id: "t-api-muse", data } }));
    const panel = html.slice(html.indexOf('class="panel panel-thread'));
    expect(panel).toContain('<span class="pair"><img class="logo logo-md"');
    expect(panel).toContain('class="msgs-scroll"');
    expect(panel).toContain('<p class="msg-subject">Thursday 2pm confirmed</p>');
    // The first message follows a day label and the reply continues its conversation: only the held message starts one.
    expect(panel.match(/starts-conv/g)).toHaveLength(1);
    expect(panel).not.toContain("newest-btn");
    expect(render(home({ threadUp: true, open: { kind: "thread", id: "t-api-muse", data } }))).toContain('data-action="thread-newest"');
  });

  test("F6: the person who decides gets Deny, Always allow and Allow once on the held message in the thread", () => {
    const data = { thread: THREADS[1]!, messages: [first, reply, heldMessage], more: false };
    const html = render(home({ open: { kind: "thread", id: "t-api-muse", data } }));
    const panel = html.slice(html.indexOf('class="panel panel-thread'));
    expect(panel.match(/data-action="decide" data-id="m3"/g)).toHaveLength(3);
    inOrder(panel, 'data-decision="deny"', 'data-decision="always_allow"', 'data-decision="allow_once"');
    expect(panel).not.toContain("Waiting for");
  });

  test("F7: agents managed by two people: each message names its manager, and a held message says who decides", () => {
    const toMaya = message({ id: "x1", threadId: "t-api-dot", from: api, to: mayaDot, subject: "Switch checkout to discount_total", text: "Please switch the checkout page too.", status: "held", deliveredAt: null, createdAt: at(11, 40) });
    const fromMaya = message({ id: "x0", threadId: "t-api-dot", from: mayaDot, to: api, subject: "Gift card orders", text: "Totals are off for gift cards.", createdAt: at(11, 10) });
    const data = { thread: thread("t-api-dot", api, mayaDot, toMaya, { held: 1 }), messages: [fromMaya, toMaya], more: false };
    const html = render(home({ open: { kind: "thread", id: "t-api-dot", data } }));
    const panel = html.slice(html.indexOf('class="panel panel-thread'));
    const t = text(panel);
    expect(t).toContain("C Chris and M Maya Okafor");
    expect(panel.match(/class="msg-manager"/g)).toHaveLength(2);
    expect(t).toContain("Waiting for Maya Okafor to approve.");
    expect(panel).not.toContain('data-action="decide"');
  });

  test("F8: earlier pages load on request", () => {
    const data = { thread: THREADS[1]!, messages: [reply, heldMessage], more: true };
    const html = render(home({ open: { kind: "thread", id: "t-api-muse", data } }));
    expect(html).toContain('data-action="thread-earlier"');
    expect(text(html)).toContain("Show earlier messages");
    expect(text(html)).not.toContain("older than 30 days");
  });

  test("F4: the Always allow list, with Remove on each sender", () => {
    const allowList = [
      { sender: ref(dialog), addedBy: CHRIS, addedAt: at(9, 0, 5) },
      { sender: ref(api), addedBy: CHRIS, addedAt: at(10, 30) },
    ];
    const html = render(home({ held: [], open: { kind: "agent", id: muse.id, data: { agent: muse, allowList } }, filter: muse.id }));
    const t = text(html);
    expect(t).toContain("dialog-claude since Oct 22");
    expect(t).toContain("api-claude since today");
    expect(html.match(/data-action="allow-remove"/g)).toHaveLength(2);
  });

  test("G1: a thread transcript with read and unread messages", () => {
    const msgs = [
      message({ id: "g1", threadId: "t-grok-dialog", from: grok, to: dialog, text: "Does the billing webhook retry on 5xx? A customer says a payment notice never arrived.", createdAt: at(10, 31), deliveredAt: at(10, 31) }),
      grokDialogLast,
    ];
    const html = render(home({ open: { kind: "thread", id: "t-grok-dialog", data: { thread: THREADS[0]!, messages: msgs, more: false } } }));
    const t = text(html);
    expect(t).toContain("grok: checks in every 10 min");
    expect(t).toContain("dialog-claude: working");
    expect(t).toContain("Today");
    expect(t).toContain("Read 10:31");
    expect(t).toContain("Unread");
    expect(html).toContain('class="tnum msg-status tone-ochre is-strong"');
  });

  test("G2: a session that needs input", () => {
    const html = render(home({ open: { kind: "agent", id: api.id, data: { agent: api, allowList: [] } }, filter: api.id }));
    const t = text(html);
    expect(t).toContain("Needs input on macbook");
    expect(t).toContain("Doing Billing migration: stopped at a permission prompt");
    expect(t).toContain("Folder api on billing-v2");
    expect(t).toContain("Manage computers in Settings");
    expect(html).toContain('href="/settings#computers"');
    // Sessions are managed from the computer: no rename and no Remove row.
    expect(html).not.toContain('data-action="edit-start"');
    expect(html).not.toContain("Remove api-claude");
  });

  test("H1: editing the name and description", () => {
    const html = render(
      home({ open: { kind: "agent", id: grok.id, data: { agent: grok, allowList: [] } }, edit: { name: "grok-research", description: GROK_DESC, error: "" } }),
    );
    const t = text(html);
    expect(html).toContain('value="grok-research"');
    expect(t).toContain(`Shown to other agents in the directory. ${GROK_DESC.length}/500`);
    inOrder(html, 'data-form="agent-save"', ">Cancel<", ">Save<");
    expect(html).not.toContain('aria-label="Edit grok"');
  });

  test("H2: saved", () => {
    const renamed = { ...grok, name: "grok-research", display: "grok-research" };
    const t = text(render(home({ open: { kind: "agent", id: grok.id, data: { agent: renamed, allowList: [] } }, saved: true })));
    expect(t).toContain("grok-research Grok Bot");
    expect(t).toContain("Saved.");
  });

  test("I7: a member's Home, after approval", () => {
    const priyaHome = home({
      me: { ...person(PRIYA, "member"), id: PRIYA.id },
      agents: AGENTS.map((a) => ({ ...a, mine: false })),
      held: [],
      threads: [],
      notice: { text: "Welcome to Portico. Approved by Chris at 10:14." },
    });
    const html = render(priyaHome);
    const t = text(html);
    expect(t).toContain("Welcome to Portico. Approved by Chris at 10:14.");
    expect(t).toContain("Priya Shah");
    expect(html).not.toContain("Invite a person");
    // The signed-in person's group comes first, with Add agent, even with no agents yet.
    inOrder(html, "Priya Shah", "Add agent", "Chris", "Maya Okafor");
  });

  test("J1: Remove asks to confirm", () => {
    const html = render(home({ open: { kind: "agent", id: duet.id, data: { agent: duet, allowList: [] } }, confirmRemove: true }));
    const row = html.slice(html.indexOf("Remove duet"));
    inOrder(row, "Signs duet out of Portico. Adding duet back takes a new join line.", ">Cancel<", "Confirm: remove duet");
    expect(row).toContain('class="btn btn-danger"');
  });

  test("J2: removed", () => {
    const t = text(render(home({ agents: AGENTS.filter((a) => a.id !== duet.id), notice: { text: "duet removed and signed out." } })));
    expect(t).toContain("duet removed and signed out.");
  });

  test("K1: the account menu", () => {
    const html = render(home({ acctOpen: true }));
    expect(html).toContain('aria-expanded="true"');
    const menu = html.slice(html.indexOf('role="menu"'));
    inOrder(menu, "Signed in as Chris, owner", 'href="/settings"', "Settings", 'data-action="sign-out"', "Sign out");
  });

  test("L1: a sign in request waits in the agents list and under Needs approval", () => {
    const html = render(home({ signIns: [SIGN_IN], open: { kind: "signin", id: SIGN_IN.id }, filter: "signin:s1" }));
    const t = text(html);
    expect(t).toContain("muse-work Sign in request waiting");
    expect(t).toContain("Muse asks to join as muse-work");
    expect(t).toContain("Code 4821 Approve only if Muse shows the same code.");
    expect(t).toContain("Showing muse-work");
    expect(t).toContain("Finish setup");
    expect(t).toContain("Send Muse the join line.");
    expect(t).toContain("Approve the sign in request under Needs approval.");
    expect(t).toContain("muse-work shows as connected.");
    expect(t).toContain("Waiting to connect");
    // Filtered to the request: the held message to muse isn't shown.
    expect(html).not.toContain('data-key="h-m3"');
    expect(t).toContain("Needs approval 1");
  });

  test("L2: the stream dropped", () => {
    const html = render(home({ reconnecting: true }));
    expect(text(html)).toContain("Updates paused. Reconnecting.");
    expect(html.match(/role="status"/g)?.length).toBe(1);
  });

  test("L3: someone else's agent is read-only", () => {
    const html = render(home({ open: { kind: "agent", id: mayaCodex.id, data: { agent: mayaCodex, allowList: null } }, filter: mayaCodex.id }));
    const t = text(html);
    expect(t).toContain("Managed by Maya Okafor.");
    expect(html).not.toContain('data-action="edit-start"');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("Remove maya-codex");
  });

  test("L4: an offline session, from the folded Offline group", () => {
    const html = render(home({ offlineOpen: true, open: { kind: "agent", id: web.id, data: { agent: web, allowList: [] } }, filter: web.id }));
    const t = text(html);
    expect(html).toContain('aria-expanded="true" data-action="offline-toggle"');
    expect(t).toContain("Offline (1)");
    expect(t).toContain("Offline. Seen yesterday 18:04");
    expect(t).toContain("Offline sessions leave the list after 24 h.");
    expect(html).not.toContain('role="switch"');
    expect(html).toContain('class="arow is-current is-offline"');
  });

  test("L5: a name already in use", () => {
    const html = render(
      home({ open: { kind: "agent", id: grok.id, data: { agent: grok, allowList: [] } }, edit: { name: "muse", description: GROK_DESC, error: "Name already in use." } }),
    );
    expect(html).toContain('role="alert" class="field-error">Name already in use.<');
    expect(html).toContain('aria-invalid="true"');
  });

  test("L6: denied, the thread shows Declined", () => {
    const denied = { ...heldMessage, status: "declined" as const, decision: "deny" as const };
    const html = render(
      home({ held: [], notice: { text: "Declined. api-claude was notified.", check: true }, open: { kind: "thread", id: "t-api-muse", data: { thread: THREADS[1]!, messages: [first, reply, denied], more: false } } }),
    );
    expect(text(html)).toContain("Declined. api-claude was notified.");
    expect(html).toContain('tone-danger is-strong">Declined<');
  });
});

describe("Home rendering rules", () => {
  test("the agents list: the signed-in person first, others by person, offline folded last", () => {
    const html = render(home());
    inOrder(html, 'data-key="g-p-chris"', "dialog-claude", "api-claude", "muse", "grok", "duet", 'data-key="add-row"', 'data-key="g-p-maya"', "maya-codex", "maya-dot", "Offline (1)");
    expect(html).not.toContain('data-key="a-a-web"');
    const t = text(html);
    expect(t).toContain("Working on macbook");
    expect(t).toContain("Checks in every 15 min");
    expect(t).toContain("1 waiting for approval");
  });

  test("only the owner sees Invite a person", () => {
    expect(render(home())).toContain('href="/settings#people"');
    expect(render(home({ me: { ...person(MAYA, "member"), id: MAYA.id } }))).not.toContain("Invite a person");
  });

  test("agent-written and person-written text is escaped", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const bad = agent({ id: "a-bad", name: "bad", description: evil });
    const html = renderHome(
      home({
        agents: [bad],
        held: [{ ...HELD, subject: evil, text: evil }],
        threads: [thread("t-x", bad, muse, message({ id: "mx", from: bad, to: muse, text: evil }))],
        open: { kind: "agent", id: bad.id, data: { agent: bad, allowList: [] } },
        notice: { text: evil },
      }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain(esc(evil));
  });

  test("no inline event handlers: every action is a data-action", () => {
    const html = renderHome(home({ add: addState(), acctOpen: true, open: { kind: "agent", id: muse.id, data: { agent: muse, allowList: [] } } }));
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain('data-action="decide"');
  });

  test("statuses and times", () => {
    expect(agentState(web, NOW)).toMatchObject({ label: "Offline", online: false, seen: "Seen yesterday 18:04" });
    expect(agentState(agent({ id: "x", name: "x", lastSeen: null, checkInMinutes: null }), NOW).label).toBe("Waiting to connect");
    expect(expiresIn(at(12, 30), NOW)).toBe("Expires in 30 min.");
    expect(expiresIn(at(11, 0), NOW)).toBe("Expired.");
    expect(messageStatus({ ...heldMessage, status: "expired" }, NOW).text).toBe("Expired");
  });
});

// ---- the pages ----

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

describe("Home pages", () => {
  test("signed out, each Home route goes to sign in and comes back", async () => {
    const { p } = await setup();
    for (const path of ["/", "/c/t1", "/a/a1"]) {
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

  test("the page carries its first data in the person API's shapes, and the first render", async () => {
    const { p, owner, held } = await setup();
    const res = await p.app.request("/", { headers: { cookie: owner } });
    expect(res.status).toBe(200);
    const html = await res.text();
    const data = firstData(html);
    const api = async (path: string) => (await p.app.request(path, { headers: { cookie: owner } })).json();
    expect(data.page).toBe("home");
    expect(data.me).toEqual((await api("/api/me")).person);
    expect(data.agents).toEqual((await api("/api/agents")).agents);
    expect(data.approvals).toEqual(await api("/api/approvals"));
    expect(data.threads).toEqual((await api("/api/threads")).threads);
    expect(data.open).toBeNull();
    expect(data.approvals.held.map((m: { id: string }) => m.id)).toEqual([held.id]);
    expect(html).toContain('<script type="module" src="/assets/app.js">');
    expect(html).toContain('href="/assets/app.css"');
    expect(html).toContain('<div id="app">');
    expect(html).toContain("Flights to Denver");
    expect(copyProblems(visibleCopy(html))).toEqual([]);
  });

  test("/c/:threadId opens the thread; /a/:agentId opens the agent, with the allow list for its manager only", async () => {
    const { p, owner, member, held, museAgent, grokAgent } = await setup();
    const thread = firstData(await (await p.app.request(`/c/${held.threadId}`, { headers: { cookie: owner } })).text());
    expect(thread.open).toMatchObject({ kind: "thread", id: held.threadId });
    expect(thread.open.data.messages.map((m: { subject: string }) => m.subject)).toEqual(["Flights to Denver"]);
    const mine = firstData(await (await p.app.request(`/a/${museAgent.id}`, { headers: { cookie: owner } })).text());
    expect(mine.open).toMatchObject({ kind: "agent", id: museAgent.id, data: { agent: { name: "muse", mine: true }, allowList: [] } });
    const theirs = firstData(await (await p.app.request(`/a/${grokAgent.id}`, { headers: { cookie: member } })).text());
    expect(theirs.open.data).toMatchObject({ agent: { name: "grok", mine: false }, allowList: null });
    const nothing = firstData(await (await p.app.request("/a/nobody", { headers: { cookie: owner } })).text());
    expect(nothing.open).toBeNull();
  });

  test("a member sees every agent, only threads with the member's agents, and no invite link", async () => {
    const { p, member, chrisOnly, shared } = await setup();
    const html = await (await p.app.request("/", { headers: { cookie: member } })).text();
    const data = firstData(html);
    expect(data.agents.map((a: { name: string }) => a.name).sort()).toEqual(["dialog-claude", "grok", "maya-dot", "muse"].sort());
    expect(data.threads.map((t: { id: string }) => t.id)).toEqual([shared.threadId]);
    expect(data.approvals.held).toEqual([]);
    expect(html).not.toContain("Invite a person");
    // A thread the member can't see opens nothing, the same as one that doesn't exist.
    const hidden = firstData(await (await p.app.request(`/c/${chrisOnly.threadId}`, { headers: { cookie: member } })).text());
    expect(hidden.open).toBeNull();
  });

  test("Home's browser modules, styles and agent icons are served", async () => {
    const p = makePortico();
    for (const path of ["app.js", "render/common.js", "render/home.js", "render/settings.js"]) {
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
