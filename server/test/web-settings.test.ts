import { describe, expect, test } from "bun:test";
import type { AgentView, ComputerView, InviteView, PasskeyView, PersonView } from "../src/api/views";
import { renderSettings, settingsState } from "../src/web/client/render/settings";
import type { PersonRow, SettingsState } from "../src/web/client/render/types";
import {
  addAppAgent,
  addComputer,
  addMember,
  addOwner,
  addSession,
  callPerson,
  copyProblems,
  makePortico,
  signIn,
  visibleCopy,
} from "./helpers";

// ---- fixtures shaped like GET /api/people, /api/computers and /api/passkeys, after the canvas's sample data ----

const NOW = new Date(2026, 9, 27, 12, 0).getTime();
const at = (h: number, m: number, daysAgo = 0) => new Date(2026, 9, 27 - daysAgo, h, m).toISOString();

const ME: PersonView = { id: "p-chris", name: "Chris", role: "owner", status: "active", isMe: true, agentCount: 9 };
const PEOPLE: PersonRow[] = [
  { ...ME, joinedAt: at(9, 0, 8) },
  { id: "p-maya", name: "Maya Okafor", role: "member", status: "active", isMe: false, agentCount: 2, joinedAt: at(9, 0, 4) },
];

function sessionOn(id: string, computer: { id: string; name: string }, status: AgentView["status"], owner = { id: "p-chris", name: "Chris" }): AgentView {
  return {
    id,
    name: "dialog-claude",
    address: `dialog-claude@${computer.name}`,
    display: "dialog-claude",
    label: "Claude Code (dialog)",
    liveRuns: 0,
    kind: "claude-code",
    type: "session",
    description: "",
    owner,
    mine: owner.id === ME.id,
    computer,
    folder: "dialog",
    joinFromFolder: true,
    status,
    doing: null,
    repo: "dialog",
    branch: null,
    lastSeen: at(11, 50),
    checkInMinutes: null,
    approvalRequired: false,
    createdAt: at(9, 0, 8),
  };
}

const MACBOOK = { id: "c-macbook", name: "macbook" };
const STUDIO = { id: "c-studio", name: "studio" };
const COMPUTERS: ComputerView[] = [
  { ...MACBOOK, lastSeen: at(12, 0), sessions: [sessionOn("s1", MACBOOK, "busy"), sessionOn("s2", MACBOOK, "idle"), sessionOn("s3", MACBOOK, "waiting")] },
  { ...STUDIO, lastSeen: at(18, 4, 1), sessions: [sessionOn("s4", STUDIO, "idle"), sessionOn("s5", STUDIO, "offline")] },
];
const PASSKEYS: PasskeyView[] = [{ id: "k1", name: "MacBook Touch ID", createdAt: at(9, 0, 8), lastUsedAt: at(8, 30) }];
const INVITE: InviteView = { id: "i-priya", name: "Priya", createdAt: at(10, 0), expiresAt: at(10, 0, -6), status: "open", link: "https://portico.example.com/invite#q7Rk2mVb9XaP4tLw" };

function settings(o: Partial<SettingsState> = {}): SettingsState {
  const base = settingsState({
    me: ME,
    publicUrl: "https://portico.example.com",
    agents: [],
    people: { people: PEOPLE, invites: [], claims: [] },
    computers: COMPUTERS,
    passkeys: PASSKEYS,
    now: NOW,
  });
  return { ...base, passkeysSupported: true, ...o };
}

function render(state: SettingsState): string {
  const html = renderSettings(state);
  expect(copyProblems(visibleCopy(html))).toEqual([]);
  return html;
}

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

describe("Settings renders every board state", () => {
  test("the template: People, Computers and Account", () => {
    const html = render(settings());
    const t = text(html);
    inOrder(html, ">Home<", ">Settings<", 'href="#people"', 'href="#computers"', 'href="#account"');
    expect(t).toContain("Each invited person can add agents to Portico.");
    expect(t).toContain("Chris Owner. 9 agents.");
    expect(t).toContain("Maya Okafor Joined Oct 23. 2 agents.");
    expect(t).toContain("Claude Code and Codex sessions join Portico from these computers. Removing a computer signs out every session on that computer.");
    expect(t).toContain("macbook 3 sessions. Seen just now.");
    expect(t).toContain("studio 2 sessions, 1 offline. Seen yesterday 18:04.");
    expect(t).toContain("Name Chris");
    expect(t).toContain("Changing the password signs out other browsers.");
    expect(t).toContain("Passkeys Sign in without a password.");
    expect(t).toContain("MacBook Touch ID Added Oct 19. Used today.");
    expect(t).toContain("Sign out Ends the Portico session in this browser.");
    // The owner's own row has no Remove; each standalone action is a labeled row ending on the right.
    expect(html.slice(html.indexOf('data-key="p-p-chris"'), html.indexOf('data-key="p-p-maya"'))).not.toContain("Remove");
    inOrder(html, ">Sign out<", "Ends the Portico session in this browser.", 'data-action="sign-out"');
  });

  test("I1: naming the person to invite", () => {
    const html = render(settings({ invite: { name: "Priya", error: "" } }));
    const t = text(html);
    expect(html).toContain('aria-expanded="true" data-action="invite-open"');
    expect(html).toContain('value="Priya"');
    expect(t).toContain("One link per person. Single use, expires in 7 days.");
    inOrder(html, 'data-form="invite-create"', ">Cancel<", "Create invite link");
  });

  test("I1: a name is required", () => {
    expect(render(settings({ invite: { name: "", error: "Enter a name." } }))).toContain('role="alert" class="field-error">Enter a name.<');
  });

  test("I2: the invite link to copy", () => {
    const html = render(settings({ invites: [INVITE], copied: { "i-priya": true }, peopleNotice: "Invite for Priya created. Copy the link to send to Priya." }));
    const t = text(html);
    expect(t).toContain("Invite for Priya created. Copy the link to send to Priya.");
    expect(t).toContain("Invite for Priya Unclaimed. Single use, expires Nov 2.");
    expect(html).toContain('value="https://portico.example.com/invite#q7Rk2mVb9XaP4tLw"');
    expect(t).toContain("Copied");
    inOrder(html, "Invite for Priya", ">Revoke<", "Invite link for Priya", "Copied");
  });

  test("an invite without a link can still be revoked", () => {
    const html = render(settings({ invites: [{ ...INVITE, link: null }] }));
    expect(html).toContain('data-action="invite-revoke"');
    expect(html).not.toContain("Copy link");
  });

  test("I5: a claim to approve", () => {
    const html = render(settings({ claims: [{ personId: "p-priya", name: "Priya Shah", inviteName: "Priya", claimedAt: at(10, 12) }] }));
    const t = text(html);
    expect(t).toContain("Priya Shah Claimed the invite for Priya at 10:12. Approve to finish joining.");
    inOrder(html, 'class="srow srow-claim"', ">Decline<", ">Approve<");
  });

  test("I6: joined", () => {
    const priya: PersonRow = { id: "p-priya", name: "Priya Shah", role: "member", status: "active", isMe: false, agentCount: 0, joinedAt: at(10, 14) };
    const t = text(render(settings({ people: [...PEOPLE, priya], peopleNotice: "Priya Shah joined." })));
    expect(t).toContain("Priya Shah joined.");
    expect(t).toContain("Priya Shah Joined Oct 27. No agents yet.");
  });

  test("removing a member asks to confirm", () => {
    const html = render(settings({ confirmMember: "p-maya" }));
    inOrder(html, "Maya Okafor", ">Cancel<", "Confirm: remove Maya Okafor");
  });

  test("J3: removing a computer asks to confirm", () => {
    const html = render(settings({ confirmComputer: "c-studio" }));
    const row = html.slice(html.indexOf('data-key="m-c-studio"'));
    inOrder(row, "studio", ">Cancel<", "Confirm: remove studio");
    expect(row).toContain('class="btn btn-danger"');
  });

  test("J4: computer removed", () => {
    const t = text(render(settings({ computers: COMPUTERS.slice(0, 1), compNotice: "studio removed. 2 sessions disconnected." })));
    expect(t).toContain("studio removed. 2 sessions disconnected.");
    expect(t).not.toContain("studio 2 sessions");
  });

  test("a computer shared by someone else shows the owner", () => {
    const linux = { id: "c-linux", name: "maya-linux" };
    const theirs: ComputerView = { ...linux, lastSeen: null, sessions: [sessionOn("s9", linux, "busy", { id: "p-maya", name: "Maya Okafor" })] };
    expect(text(render(settings({ computers: [theirs] })))).toContain("maya-linux Maya Okafor 1 session.");
  });

  test("no computers yet", () => {
    expect(text(render(settings({ computers: [] })))).toContain("No computers yet.");
  });

  test("account: change name, with a taken name", () => {
    const html = render(settings({ nameForm: { name: "Maya Okafor", error: "Name already in use." } }));
    expect(html).toContain('value="Maya Okafor"');
    expect(html).toContain('role="alert" class="field-error">Name already in use.<');
    inOrder(html, 'data-form="name-save"', ">Cancel<", ">Save<");
  });

  test("account: change password", () => {
    const html = render(settings({ passwordForm: { current: "", next: "", error: "" } }));
    const t = text(html);
    expect(t).toContain("Current password");
    expect(t).toContain("New password");
    expect(t).toContain("At least 12 characters. Every other browser signs out.");
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('autocomplete="new-password"');
    expect(text(render(settings({ passwordChanged: true })))).toContain("Changed just now.");
  });

  test("passkeys: add asks for a name; hidden when the browser can't make one", () => {
    const html = render(settings({ passkeyForm: { name: "", error: "" } }));
    expect(text(html)).toContain("Shown in this list, such as MacBook Touch ID.");
    inOrder(html, 'data-form="passkey-add"', ">Cancel<", "Add passkey");
    expect(render(settings({ passkeysSupported: false }))).not.toContain('data-action="passkey-open"');
    expect(render(settings({ passkeys: null }))).not.toContain("Passkeys");
  });

  test("a member sees people but can't invite or remove", () => {
    const maya: PersonView = { ...PEOPLE[1]!, isMe: true };
    const html = render(settings({ me: maya, people: [{ ...PEOPLE[0]!, isMe: false }, { ...maya, joinedAt: at(9, 0, 4) }] }));
    expect(html).not.toContain("Invite a person");
    expect(html).not.toContain('data-action="member-remove"');
    expect(text(html)).toContain("Maya Okafor Joined Oct 23. 2 agents.");
  });

  test("the stream dropped", () => {
    expect(text(render(settings({ reconnecting: true })))).toContain("Updates paused. Reconnecting.");
  });

  test("names people wrote are escaped", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const html = renderSettings(settings({ people: [{ ...PEOPLE[1]!, name: evil }], invites: [{ ...INVITE, name: evil }], peopleNotice: evil }));
    expect(html).not.toContain("<img src=x");
    // No event handler attribute inside any real tag; the escaped text may still spell one out.
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
  });
});

// ---- the page ----

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const maya = await addMember(p, "Maya Okafor");
  addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  addAppAgent(p, maya, "maya-dot", { kind: "dots" });
  const { computer } = addComputer(p, chris);
  addSession(p, computer, { repo: "dialog" });
  addComputer(p, maya, "maya-linux");
  return { p, chris, maya, owner: signIn(p, chris), member: signIn(p, maya) };
}

function firstData(html: string): Record<string, any> {
  const match = html.match(/<script type="application\/json" id="first-data">([\s\S]*?)<\/script>/);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

describe("the Settings page", () => {
  test("signed out goes to sign in; a claim still waiting goes to the invite page", async () => {
    const { p } = await setup();
    const res = await p.app.request("/settings");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in?next=%2Fsettings");
    const priya = await addMember(p, "Priya", "pending");
    expect((await p.app.request("/settings", { headers: { cookie: signIn(p, priya) } })).headers.get("location")).toBe("/invite");
  });

  test("the first data matches the person API, and the owner's includes invites and claims", async () => {
    const { p, owner } = await setup();
    const invite = await (await callPerson(p, owner, "POST", "/api/invites", { name: "Priya" })).json();
    const res = await p.app.request("/settings", { headers: { cookie: owner } });
    expect(res.status).toBe(200);
    const html = await res.text();
    const data = firstData(html);
    const api = async (path: string) => (await callPerson(p, owner, "GET", path)).json();
    expect(data.page).toBe("settings");
    expect(data.me).toEqual((await api("/api/me")).person);
    expect(data.people).toEqual(await api("/api/people"));
    expect(data.computers).toEqual((await api("/api/computers")).computers);
    expect(data.passkeys).toEqual((await api("/api/passkeys")).passkeys);
    expect(data.people.invites.map((i: { id: string }) => i.id)).toEqual([invite.invite.id]);
    expect(html).toContain('<script type="module" src="/assets/app.js">');
    expect(html).toContain("Invite for Priya");
    expect(html).toContain("macbook");
    expect(copyProblems(visibleCopy(html))).toEqual([]);
  });

  test("a member's Settings: own computers only, no invites, no Invite a person", async () => {
    const { p, member, owner } = await setup();
    await callPerson(p, owner, "POST", "/api/invites", { name: "Priya" });
    const html = await (await p.app.request("/settings", { headers: { cookie: member } })).text();
    const data = firstData(html);
    expect(data.people.invites).toEqual([]);
    expect(data.people.claims).toEqual([]);
    expect(data.computers.map((c: { name: string }) => c.name)).toEqual(["maya-linux"]);
    expect(html).not.toContain("Invite a person");
    expect(html).not.toContain("Invite for Priya");
    expect(copyProblems(visibleCopy(html))).toEqual([]);
  });
});
