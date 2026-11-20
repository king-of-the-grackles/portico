import { describe, expect, test } from "bun:test";
import { LIMITS } from "../src/core/limits";
import { nameKey, posesAsOwnPortico, titleKey } from "../src/core/names";
import type { Agent, MailConfig } from "../src/core/types";
import { porticoKey } from "../src/core/workspaces";
import {
  acquaint,
  addAppAgent,
  addComputer,
  addMember,
  addOwner,
  addSession,
  callAs,
  callPerson,
  copyProblems,
  DAY,
  errorCode,
  fakeWebhooks,
  flush,
  makePortico,
  MINUTE,
  PUBLIC_URL,
  signIn,
  type TestPortico,
  visibleCopy,
} from "./helpers";

const MAIL: MailConfig = { apiKey: "re_test", from: "Portico <notices@mail.portico.example>", webhookSecret: null };

/**
 * Chris (muse, grok) made Launch with Robert (dots, scout) and Maya (pilot) in it, each with one agent there: muse,
 * dots and pilot. Nobody has allowed anybody yet.
 */
async function world(p: TestPortico = makePortico()) {
  const person = async (name: string, owner = false) => {
    const made = owner ? await addOwner(p, name) : await addMember(p, name);
    p.people.setEmail(made.id, `${name.toLowerCase()}@example.com`);
    return p.people.setHandle(made.id, name.toLowerCase());
  };
  const chris = await person("Chris", true);
  const robert = await person("Robert");
  const maya = await person("Maya");
  const muse = addAppAgent(p, chris, "muse");
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  const dots = addAppAgent(p, robert, "dots", { kind: "dots" });
  const scout = addAppAgent(p, robert, "scout");
  const pilot = addAppAgent(p, maya, "pilot");
  const launch = p.workspaces.create(chris.id, "Launch");
  p.workspaces.admit(launch.id, robert.id);
  p.workspaces.admit(launch.id, maya.id);
  p.workspaces.addAgent(chris.id, launch.id, muse.agent.id);
  p.workspaces.addAgent(robert.id, launch.id, dots.agent.id);
  p.workspaces.addAgent(maya.id, launch.id, pilot.agent.id);
  for (const { agent } of [muse, grok, dots, scout, pilot]) p.agentNotices.take(agent.id);
  const cookies = { chris: signIn(p, chris), robert: signIn(p, robert), maya: signIn(p, maya) };
  return { p, chris, robert, maya, muse, grok, dots, scout, pilot, launch, cookies };
}

type Body = Record<string, any>;
const json = async (res: Response | Promise<Response>) => (await (await res).json()) as Body;
const send = (p: TestPortico, from: Agent, to: string, subject = "Hello", extra: Record<string, unknown> = {}) =>
  p.messages.send(from, { to, subject, text: `${subject}: the text`, ...extra });
const page = async (p: TestPortico, path: string, cookie: string) => {
  const res = await p.app.request(path, { headers: { cookie } });
  return { status: res.status, html: await res.text() };
};
const mails = (hooks: ReturnType<typeof fakeWebhooks>) => hooks.sent.map((sent) => JSON.parse(sent.body) as { to: string[]; subject: string; text: string; html: string });

describe("first contact is asked first", () => {
  test("the first message from another person's agent is held for the person, whatever the agent's own setting, and the sender is told so", async () => {
    const { p, chris, muse, grok, dots } = await world();
    expect(muse.agent.approvalRequired).toBe(false);
    const sent = send(p, dots.agent, "chris/muse");
    expect(sent.message).toMatchObject({ status: "held", heldFor: "first_contact" });
    expect(sent.delivery).toBe("held");
    expect(sent.note).toBe(
      "Held: “Chris”, who manages chris/muse, hasn't allowed messages from “Robert”'s agents yet, so “Chris” is asked about this one first. " +
        "The message is not delivered. A person decides within 3 days; check_inbox reports whether the message was delivered, declined or expired.",
    );
    expect(p.messages.inbox(muse.agent).messages).toEqual([]);
    expect(p.approvals.heldFor(chris.id).map((m) => m.id)).toEqual([sent.message.id]);
    // Two agents of one person are never held by this rule.
    expect(send(p, grok.agent, "muse").message.status).toBe("pending");
  });

  test("over the API the sender hears held, never delivered; check_inbox reports the outcome", async () => {
    const { p, chris, muse, dots } = await world();
    const sent = await json(callAs(p, dots, "POST", "/api/agent/messages", { to: "chris/muse", subject: "Hi", text: "x" }));
    expect(sent.delivery).toBe("held");
    expect(sent.message.status).toBe("held");
    expect(sent.note).toContain("The message is not delivered.");
    const mcp = await json(callAs(p, dots, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { to: "chris/muse", subject: "Again", text: "x" } } }));
    expect(JSON.parse(mcp.result.content[0].text).delivery).toBe("held");
    expect(mcp.result.content.map((c: Body) => c.text).join("\n")).not.toContain("call check_inbox with wait");
    expect((await json(callAs(p, dots, "GET", "/api/agent/inbox"))).updates).toEqual([]);
    p.approvals.decide(chris.id, sent.message.id, "allow_once");
    expect((await json(callAs(p, muse, "GET", "/api/agent/inbox"))).messages.map((m: Body) => m.id)).toEqual([sent.message.id]);
    const updates = (await json(callAs(p, dots, "GET", "/api/agent/inbox"))).updates as Body[];
    expect(updates.map((u) => [u.message_id, u.status])).toEqual([[sent.message.id, "delivered"]]);
  });

  test("this message only: the next one is asked about again. Always for this person: that person's agents get through to this person's agents", async () => {
    const { p, chris, robert, muse, grok, dots, scout, launch } = await world();
    p.workspaces.addAgent(robert.id, launch.id, scout.agent.id);
    p.workspaces.addAgent(chris.id, launch.id, grok.agent.id);
    const first = send(p, dots.agent, "chris/muse", "One").message;
    expect(p.approvals.decide(chris.id, first.id, "allow_once").status).toBe("pending");
    const second = send(p, dots.agent, "chris/muse", "Two").message;
    const third = send(p, scout.agent, "chris/grok", "Three").message;
    expect([second.status, third.status]).toEqual(["held", "held"]);
    // One "always" answers for the person: every held first contact from Robert's agents goes through, and later ones aren't held.
    p.approvals.decide(chris.id, second.id, "always_allow");
    expect(p.messages.get({ person: chris.id }, third.id)).toMatchObject({ status: "pending", decision: "always_allow" });
    expect(p.contacts.has(chris.id, robert.id)).toBe(true);
    expect(send(p, scout.agent, "chris/muse", "Four").message.status).toBe("pending");
    // One way only: Chris's agents are still Robert's to allow.
    expect(p.contacts.has(robert.id, chris.id)).toBe(false);
    expect(send(p, grok.agent, "robert/scout", "Five").message).toMatchObject({ status: "held", heldFor: "first_contact" });
    // A reply in a conversation the receiver itself wrote in isn't a first contact.
    const fresh = await world();
    const opener = send(fresh.p, fresh.dots.agent, "chris/muse", "Opener").message;
    fresh.p.approvals.decide(fresh.chris.id, opener.id, "allow_once");
    fresh.p.messages.inbox(fresh.muse.agent);
    // Robert hasn't allowed Chris's agents, yet muse's answer isn't held: dots wrote in the conversation first.
    const answer = fresh.p.messages.send(fresh.muse.agent, { replyTo: opener.id, subject: "Re: Opener", text: "x" }).message;
    expect(answer.status).toBe("pending");
    // And dots answering muse isn't held either, though Chris allowed only the one message.
    expect(fresh.p.messages.send(fresh.dots.agent, { replyTo: answer.id, subject: "More", text: "x" }).message.status).toBe("pending");
    // A new conversation from dots is asked about again.
    expect(send(fresh.p, fresh.dots.agent, "chris/muse", "New topic").message.status).toBe("held");
  });

  test("the person can ask again: off the list, the next message is held", async () => {
    const { p, chris, robert, dots, cookies } = await world();
    acquaint(p, chris.id, robert.id);
    expect(send(p, dots.agent, "chris/muse").message.status).toBe("pending");
    expect((await callPerson(p, cookies.robert, "DELETE", `/api/contacts/${robert.id}`)).status).toBe(404);
    expect((await callPerson(p, cookies.chris, "DELETE", `/api/contacts/${robert.id}`)).status).toBe(204);
    expect((await callPerson(p, cookies.chris, "DELETE", `/api/contacts/${robert.id}`)).status).toBe(404);
    expect(send(p, dots.agent, "chris/muse").message.status).toBe("held");
  });

  test("an agent with its own approval switch still asks about each new sender, allowed person or not", async () => {
    const { p, chris, robert, muse, dots, scout, launch } = await world();
    p.workspaces.addAgent(robert.id, launch.id, scout.agent.id);
    p.agents.update(chris.id, muse.agent.id, { approvalRequired: true });
    const first = send(p, dots.agent, "chris/muse").message;
    expect(first.heldFor).toBe("first_contact");
    p.approvals.decide(chris.id, first.id, "always_allow");
    // Always for the person also answers muse's own question about this sender, and no other.
    expect(send(p, dots.agent, "chris/muse").message.status).toBe("pending");
    expect(send(p, scout.agent, "chris/muse").message).toMatchObject({ status: "held", heldFor: "approval" });
  });

  test("the held page names the sender's owner and offers this message only, always for this person, or don't allow", async () => {
    const { p, dots, cookies } = await world();
    const held = send(p, dots.agent, "chris/muse", "Budget <b>now</b>").message;
    const mine = await page(p, `/held/${held.id}`, cookies.chris);
    expect(mine.status).toBe(200);
    const copy = visibleCopy(mine.html);
    expect(copy).toContain("First message from an agent of Robert (robert).");
    expect(copy).toContain("“robert/dots”");
    expect(copy).toMatch(/Always allow\s+Robert/);
    expect(copy).toContain("Always allow covers every agent of Robert (robert).");
    expect(copy).toContain("Allow once");
    expect(copy).toContain("Don't allow");
    expect(mine.html).toContain("Budget &lt;b&gt;now&lt;/b&gt;");
    expect(copyProblems(copy.replace("Budget  b now /b", ""))).toEqual([]);
    // The sender's own person, and a bystander in the same Portico, get what an unknown address gets.
    const unknown = await page(p, "/held/no-such-message", cookies.robert);
    for (const cookie of [cookies.robert, cookies.maya]) {
      const other = await page(p, `/held/${held.id}`, cookie);
      expect(other.status).toBe(404);
      expect(other.html).toBe(unknown.html);
      expect((await callPerson(p, cookie, "POST", `/api/approvals/held/${held.id}`, { decision: "allow_once" })).status).toBe(404);
    }
    expect((await callPerson(p, cookies.chris, "POST", `/api/approvals/held/${held.id}`, { decision: "always_allow" })).status).toBe(200);
  });

  test("an unanswered request lapses, and the sender hears that", async () => {
    const { p, chris, dots } = await world();
    const held = send(p, dots.agent, "chris/muse").message;
    p.clock.advance(LIMITS.messageExpiryHours * 60 * MINUTE + 1);
    expect(p.messages.expireDue().map((m) => m.id)).toEqual([held.id]);
    expect(p.approvals.heldFor(chris.id)).toEqual([]);
    expect(errorCode(() => p.approvals.decide(chris.id, held.id, "allow_once"))).toBe("wrong_status");
    expect(p.messages.inbox(dots.agent).updates.map((m) => m.status)).toEqual(["expired"]);
  });

  test("check_inbox and list_agents say how many messages wait for the person, so an agent can say so with no email set up", async () => {
    const { p, muse, grok, dots, pilot } = await world();
    send(p, dots.agent, "chris/muse");
    send(p, pilot.agent, "chris/muse");
    const inbox = await json(callAs(p, grok, "GET", "/api/agent/inbox"));
    expect(inbox.held_for_person).toBe(2);
    expect(inbox.held_note).toBe(`2 messages wait for a decision by Chris, on Portico's page: ${PUBLIC_URL}/. Tell that person; nothing held is delivered until then.`);
    expect((await json(callAs(p, muse, "GET", "/api/agent/agents"))).held_for_person).toBe(2);
    const mcp = await json(callAs(p, muse, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_agents", arguments: {} } }));
    expect(JSON.parse(mcp.result.content[0].text)).toMatchObject({ held_for_person: 2 });
    // Only the person's own count: Robert's agents hear nothing of what waits for Chris.
    expect((await json(callAs(p, dots, "GET", "/api/agent/agents"))).held_for_person).toBe(0);
    expect((await json(callAs(p, dots, "GET", "/api/agent/agents"))).held_note).toBeUndefined();
  });
});

describe("an invitation taken up is the first-contact decision, between those two people only", () => {
  const link = (secret: string) => `${PUBLIC_URL}/share#${secret}`;
  /** Dana, who is in nothing of Chris's yet, with one agent. */
  async function withDana() {
    const w = await world();
    const made = await addMember(w.p, "Dana");
    w.p.people.setEmail(made.id, "dana@example.com");
    const dana = w.p.people.setHandle(made.id, "dana");
    const helper = addAppAgent(w.p, dana, "helper");
    return { ...w, dana, helper, danaCookie: signIn(w.p, dana) };
  }
  const enter = (p: TestPortico, cookie: string, secret: string, body: Record<string, unknown>) => callPerson(p, cookie, "POST", "/api/share-links/enter", { link: link(secret), ...body });

  test("both ticked: the inviter's agents and the invited person's agents write to each other with no hold, and a stranger is still held", async () => {
    const { p, chris, dana, muse, pilot, helper, launch, cookies, danaCookie } = await withDana();
    const made = await json(callPerson(p, cookies.chris, "POST", `/api/porticos/${launch.id}/shares`, { email: "dana@example.com", allow: true }));
    const secret = p.shares.secretFor(chris.id, made.share.id)!;
    expect((await enter(p, danaCookie, secret, { agents: [helper.agent.id], allow: true })).status).toBe(200);
    // The first exchange, each way: nothing waits.
    expect(send(p, muse.agent, "dana/helper", "Plan").message.status).toBe("pending");
    expect(send(p, helper.agent, "chris/muse", "Reply").message.status).toBe("pending");
    expect(p.approvals.heldFor(dana.id)).toHaveLength(0);
    expect(p.approvals.heldFor(chris.id)).toHaveLength(0);
    // Maya is in the same Portico, and nobody invited her to Dana or Dana to her: first contact is asked, each way.
    expect(send(p, pilot.agent, "dana/helper", "Hi").message).toMatchObject({ status: "held", heldFor: "first_contact" });
    expect(send(p, helper.agent, "maya/pilot", "Hi").message).toMatchObject({ status: "held", heldFor: "first_contact" });
    // Either side takes it back like any other allowed person.
    expect((await callPerson(p, danaCookie, "DELETE", `/api/contacts/${chris.id}`)).status).toBe(204);
    expect(send(p, muse.agent, "dana/helper", "Again").message.status).toBe("held");
  });

  test("each side decides for itself: one tick allows one direction", async () => {
    const { p, chris, muse, helper, launch, danaCookie } = await withDana();
    // Chris left his line unticked; Dana ticked hers.
    const { secret } = p.shares.create(chris.id, launch.id, { email: "dana@example.com" });
    expect((await enter(p, danaCookie, secret, { agents: [helper.agent.id], allow: true })).status).toBe(200);
    expect(send(p, muse.agent, "dana/helper", "Plan").message.status).toBe("pending");
    expect(send(p, helper.agent, "chris/muse", "Reply").message).toMatchObject({ status: "held", heldFor: "first_contact" });
    // And the other way round, with a second person.
    const w2 = await withDana();
    const two = w2.p.shares.create(w2.chris.id, w2.launch.id, { email: "dana@example.com", allow: true });
    expect((await enter(w2.p, w2.danaCookie, two.secret, { agents: [w2.helper.agent.id] })).status).toBe(200);
    expect(send(w2.p, w2.helper.agent, "chris/muse", "Hello").message.status).toBe("pending");
    expect(send(w2.p, w2.muse.agent, "dana/helper", "Hello").message).toMatchObject({ status: "held", heldFor: "first_contact" });
  });

  test("no agent sets either tick: only the person's own answer on Portico's page counts", async () => {
    const { p, chris, dana, muse, helper, launch, cookies, danaCookie } = await withDana();
    const tool = (token: string, name: string, args: Record<string, unknown>) => json(callAs(p, { token }, "POST", `/api/agent/portico-tools/${name}`, args));
    // Chris's agent asks to share and says "allow": the word is ignored. Chris allows the share with his line unticked.
    const asked = await tool(muse.token, "share_portico", { portico: launch.id, email: "dana@example.com", allow: true });
    expect(asked.status).toBe("waiting_for_person");
    const page1 = await page(p, `/c/${asked.request.id}`, cookies.chris);
    expect(page1.html).toContain('name="allow" checked');
    expect((await callPerson(p, cookies.chris, "POST", `/api/consents/${asked.request.id}`, { decision: "approve", allow: false })).status).toBe(200);
    const share = p.shares.openFor(chris.id, launch.id)[0]!;
    expect(share.allowsBack).toBe(false);
    // Dana's agent uses the link and says "allow": ignored too. Dana allows with her line unticked.
    const joining = await tool(helper.token, "join_portico", { link: link(p.shares.secretFor(chris.id, share.id)!), allow: true });
    expect((await callPerson(p, danaCookie, "POST", `/api/consents/${joining.request.id}`, { decision: "approve", agents: [helper.agent.id] })).status).toBe(200);
    expect(p.workspaces.hasPerson(launch.id, dana.id)).toBe(true);
    expect(send(p, muse.agent, "dana/helper", "Plan").message).toMatchObject({ status: "held", heldFor: "first_contact" });
    expect(send(p, helper.agent, "chris/muse", "Plan").message).toMatchObject({ status: "held", heldFor: "first_contact" });
    // The same pages, ticked by the people, do allow: a second link, a second person.
    const w2 = await withDana();
    const asked2 = await json(callAs(w2.p, { token: w2.muse.token }, "POST", "/api/agent/portico-tools/share_portico", { portico: w2.launch.id, email: "dana@example.com" }));
    await callPerson(w2.p, w2.cookies.chris, "POST", `/api/consents/${asked2.request.id}`, { decision: "approve", allow: true });
    const share2 = w2.p.shares.openFor(w2.chris.id, w2.launch.id)[0]!;
    const joining2 = await json(callAs(w2.p, { token: w2.helper.token }, "POST", "/api/agent/portico-tools/join_portico", { link: link(w2.p.shares.secretFor(w2.chris.id, share2.id)!) }));
    await callPerson(w2.p, w2.danaCookie, "POST", `/api/consents/${joining2.request.id}`, { decision: "approve", agents: [w2.helper.agent.id], allow: true });
    expect(send(w2.p, w2.muse.agent, "dana/helper", "Plan").message.status).toBe("pending");
    expect(send(w2.p, w2.helper.agent, "chris/muse", "Plan").message.status).toBe("pending");
  });
});

describe("vouching for a new agent on the page that says the agent joined", () => {
  test("the person's Yes lets through what waited and stops the hold; nobody else, and no agent, can say it", async () => {
    const { p, chris, robert, muse, grok, dots, launch, cookies } = await world();
    acquaint(p, chris.id, robert.id);
    const rookie = addAppAgent(p, chris, "rookie");
    p.agents.markUnproven({ agentId: rookie.agent.id });
    p.workspaces.addAgent(chris.id, launch.id, rookie.agent.id);
    // New, so its first message to one of Chris's own agents, and what it sends to other people's, waits for Chris.
    const own = send(p, p.agents.get(rookie.agent.id)!, "muse", "Hi").message;
    const out = send(p, p.agents.get(rookie.agent.id)!, "robert/dots", "Hi").message;
    expect([own.heldFor, out.heldFor]).toEqual(["new_agent", "outbound"]);
    const path = `/api/agents/${rookie.agent.id}/always-allow`;
    // Another person gets what an unknown agent gets. The agent itself has no way in: this is not on the agents' API.
    expect((await callPerson(p, cookies.robert, "POST", path)).status).toBe(404);
    expect((await callPerson(p, null, "POST", path)).status).toBe(401);
    for (const token of [rookie.token, grok.token]) {
      const res = await p.app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: PUBLIC_URL, host: new URL(PUBLIC_URL).host } });
      expect(res.status).toBe(401);
      expect((await callAs(p, { token }, "POST", `/api/agent/agents/${rookie.agent.id}/always-allow`)).status).toBe(404);
    }
    expect(p.agents.get(rookie.agent.id)!.unproven).toBe(true);
    // Chris says yes.
    expect((await callPerson(p, cookies.chris, "POST", path)).status).toBe(200);
    expect(p.agents.get(rookie.agent.id)!.unproven).toBe(false);
    expect(p.messages.get({ agent: muse.agent.id }, own.id)!.status).toBe("pending");
    expect(p.messages.get({ agent: dots.agent.id }, out.id)!.status).toBe("pending");
    expect(send(p, p.agents.get(rookie.agent.id)!, "grok", "Later").message.status).toBe("pending");
  });

  test("a stranger's first message is still held after a vouch", async () => {
    const { p, chris, pilot, launch, cookies } = await world();
    const rookie = addAppAgent(p, chris, "rookie");
    p.agents.markUnproven({ agentId: rookie.agent.id });
    p.workspaces.addAgent(chris.id, launch.id, rookie.agent.id);
    expect((await callPerson(p, cookies.chris, "POST", `/api/agents/${rookie.agent.id}/always-allow`)).status).toBe(200);
    expect(send(p, pilot.agent, "chris/rookie", "Hi").message).toMatchObject({ status: "held", heldFor: "first_contact" });
    expect(send(p, p.agents.get(rookie.agent.id)!, "maya/pilot", "Hi").message).toMatchObject({ status: "held", heldFor: "first_contact" });
  });
});

describe("outbound hold, per agent", () => {
  test("a message to another person's agent waits for the sender's own person first, then goes on to what the receiving side requires", async () => {
    const hooks = fakeWebhooks();
    const { p, chris, robert, muse, grok, dots, cookies } = await world(makePortico({ config: { mail: MAIL }, mailPost: hooks.post }));
    expect((await callPerson(p, cookies.robert, "PATCH", `/api/agents/${muse.agent.id}`, { outboundHold: true })).status).toBe(403);
    const patched = await json(callPerson(p, cookies.chris, "PATCH", `/api/agents/${muse.agent.id}`, { outboundHold: true }));
    expect(patched.agent.outboundHold).toBe(true);
    const sender = p.agents.require(muse.agent.id);
    // Chris's own agents are never held by the switch.
    expect(send(p, sender, "grok").message.status).toBe("pending");
    const sent = send(p, sender, "robert/dots", "Out");
    expect(sent.message).toMatchObject({ status: "held", heldFor: "outbound" });
    expect(sent.note).toStartWith(`Held for “Chris”: “Chris” asked to see each message this agent sends to other people's agents first, and decides on Portico's page, ${PUBLIC_URL}/held/${sent.message.id}.`);
    expect(sent.note).toContain("The message is not delivered.");
    // Chris decides, not Robert: Robert neither sees nor decides a message that hasn't left yet.
    expect(p.approvals.heldFor(chris.id).map((m) => m.id)).toEqual([sent.message.id]);
    expect(p.approvals.heldFor(robert.id)).toEqual([]);
    expect((await page(p, `/held/${sent.message.id}`, cookies.robert)).status).toBe(404);
    expect((await callPerson(p, cookies.robert, "POST", `/api/approvals/held/${sent.message.id}`, { decision: "allow_once" })).status).toBe(404);
    const thread = await json(callPerson(p, cookies.robert, "GET", `/api/threads/${sent.message.threadId}`));
    expect(thread.messages).toEqual([]);
    expect(thread.thread.last).toBeNull();
    expect((await callPerson(p, cookies.robert, "GET", `/api/tasks/${sent.message.id}`)).status).toBe(404);
    for (const path of ["/api/tasks?outcome=needs_approval", "/api/today", "/api/threads", "/", "/activity"]) {
      expect(await (await callPerson(p, cookies.robert, "GET", path)).text()).not.toContain("Out: the text");
      expect(await (await callPerson(p, cookies.robert, "GET", path)).text()).not.toContain('"subject":"Out"');
    }
    // Neither does Robert's agent: nothing is listed, and the task isn't there to read.
    expect((await json(callAs(p, dots, "GET", "/api/agent/tasks?outcome=all"))).tasks).toEqual([]);
    expect((await callAs(p, dots, "GET", `/api/agent/tasks/${sent.message.id}`)).status).toBe(404);
    // Chris, whose agent wrote it, sees the task waiting.
    expect((await json(callPerson(p, cookies.chris, "GET", "/api/tasks?outcome=needs_approval"))).tasks.map((t: Body) => t.subject)).toContain("Out");
    await flush();
    expect(mails(hooks).map((mail) => mail.to[0])).toEqual(["chris@example.com"]);
    expect(mails(hooks)[0]!.text).toContain("Chris asked to see what that agent sends to other people's agents first.");
    expect(mails(hooks)[0]!.text).toContain(`${PUBLIC_URL}/a/${muse.agent.id}`);
    // The page for the sender's person: no "always", since the switch is the always.
    const held = await page(p, `/held/${sent.message.id}`, cookies.chris);
    expect(visibleCopy(held.html)).toContain("You asked to see what muse sends to other people");
    expect(held.html).not.toContain('value="always_allow"');
    expect(copyProblems(visibleCopy(held.html).replace("Out: the text", ""))).toEqual([]);
    expect((await callPerson(p, cookies.chris, "POST", `/api/approvals/held/${sent.message.id}`, { decision: "always_allow" })).status).toBe(400);
    // Allowed on its way out, it meets the receiving side's own rule: first contact, for Robert.
    hooks.sent.length = 0;
    expect((await callPerson(p, cookies.chris, "POST", `/api/approvals/held/${sent.message.id}`, { decision: "allow_once" })).status).toBe(200);
    expect(p.messages.get({ person: chris.id }, sent.message.id)).toMatchObject({ status: "held", heldFor: "first_contact", decision: null });
    expect(p.approvals.heldFor(chris.id)).toEqual([]);
    expect(p.approvals.heldFor(robert.id).map((m) => m.id)).toEqual([sent.message.id]);
    expect(p.messages.inbox(dots.agent).messages).toEqual([]);
    await flush();
    expect(mails(hooks).map((mail) => mail.to[0])).toEqual(["robert@example.com"]);
    // Chris's page now says who the message waits for; Robert's offers the decision.
    const waiting = await page(p, `/held/${sent.message.id}`, cookies.chris);
    expect(visibleCopy(waiting.html)).toContain("This message now waits for the other agent");
    expect(waiting.html).not.toContain('name="decision"');
    expect((await callPerson(p, cookies.robert, "POST", `/api/approvals/held/${sent.message.id}`, { decision: "always_allow" })).status).toBe(200);
    expect(p.messages.inbox(dots.agent).messages.map((m) => m.id)).toEqual([sent.message.id]);
    // With Robert's Always in place, the next one stops only at Chris.
    const next = send(p, sender, "robert/dots", "Next").message;
    expect(p.approvals.decide(chris.id, next.id, "allow_once")).toMatchObject({ status: "pending", decision: "allow_once" });
    expect(grok.agent.outboundHold).toBe(false);
  });

  test("turned down by the sender's own person: never sent on, and the sender hears who said no", async () => {
    const { p, chris, robert, muse, dots } = await world();
    const sender = p.agents.update(chris.id, muse.agent.id, { outboundHold: true });
    const sent = send(p, sender, "robert/dots").message;
    expect(p.approvals.decide(chris.id, sent.id, "deny").status).toBe("declined");
    expect(p.approvals.heldFor(robert.id)).toEqual([]);
    expect(p.messages.inbox(dots.agent).messages).toEqual([]);
    const update = (await json(callAs(p, muse, "GET", "/api/agent/inbox"))).updates[0];
    expect(update.framed_message).toContain("was declined by the person who manages this agent, and was never sent on");
    // The switch is recorded as a settings change.
    expect(p.activity.list().some((entry) => entry.kind === "outbound_switched" && entry.detail.on === true)).toBe(true);
  });
});

describe("one-step stops", () => {
  test("pause: only the maker; nothing moves, sends answer with a plain refusal, what was on its way is withdrawn, and resume restores", async () => {
    const { p, chris, robert, muse, dots, pilot, launch, cookies } = await world();
    acquaint(p, chris.id, robert.id);
    const pending = send(p, muse.agent, "robert/dots", "Outbound note").message;
    const held = send(p, pilot.agent, "chris/muse", "Waiting for Chris").message;
    expect((await callPerson(p, cookies.robert, "PUT", `/api/porticos/${launch.id}/pause`)).status).toBe(403);
    expect((await callPerson(p, cookies.chris, "PUT", `/api/porticos/no-such-portico/pause`)).status).toBe(404);
    const paused = await json(callPerson(p, cookies.chris, "PUT", `/api/porticos/${launch.id}/pause`));
    expect(paused.workspace.pausedAt).not.toBeNull();
    // Everyone stays in, and the history is kept.
    expect(p.workspaces.peopleIn(launch.id)).toHaveLength(3);
    expect(p.messages.get({ person: chris.id }, pending.id)).toMatchObject({ status: "withdrawn" });
    expect(p.messages.get({ person: chris.id }, held.id)).toMatchObject({ status: "withdrawn" });
    // Never delivered afterwards, and each sender's side learns it, once.
    expect(p.messages.inbox(dots.agent).messages).toEqual([]);
    const told = (await json(callAs(p, muse, "GET", "/api/agent/inbox"))).updates as Body[];
    expect(told.map((u) => [u.message_id, u.status])).toEqual([[pending.id, "withdrawn"]]);
    expect(told[0]!.framed_message).toContain("was withdrawn and will not be delivered");
    expect((await json(callAs(p, muse, "GET", "/api/agent/inbox"))).updates).toEqual([]);
    expect(p.messages.inbox(pilot.agent).updates.map((m) => m.status)).toEqual(["withdrawn"]);
    expect(p.approvals.heldFor(chris.id)).toEqual([]);
    expect(errorCode(() => p.approvals.decide(chris.id, held.id, "allow_once"))).toBe("wrong_status");
    // A send is refused in plain words, and nothing is stored.
    const refused = await callAs(p, muse, "POST", "/api/agent/messages", { to: "robert/dots", subject: "Now?", text: "x" });
    expect(refused.status).toBe(403);
    expect((await refused.json()).message).toBe(
      "The Portico “Launch” is paused, so nothing moves through that Portico: this message was not sent. “Chris”, who paused the Portico, can resume the Portico on Portico's pages.",
    );
    expect((await json(callAs(p, muse, "GET", "/api/agent/agents"))).agents.find((a: Body) => a.name === "robert/dots").porticos).toEqual([{ id: launch.id, name: "Launch", paused: true }]);
    // The agents there were told, and the page says so.
    expect(p.agentNotices.waiting(dots.agent.id).map((n) => n.text)).toEqual([
      "“Chris” (chris) paused the Portico “Launch”: nothing moves through that Portico until the owner resumes the Portico, and a send through that Portico is refused.",
    ]);
    const html = (await page(p, `/p/${launch.id}`, cookies.robert)).html;
    expect(visibleCopy(html)).toContain("Paused by Chris: no messages move through the Portico “Launch”.");
    expect(copyProblems(visibleCopy(html))).toEqual([]);
    // Resume: only the maker; messages move again, and nothing withdrawn comes back.
    expect((await callPerson(p, cookies.robert, "DELETE", `/api/porticos/${launch.id}/pause`)).status).toBe(403);
    expect((await json(callPerson(p, cookies.chris, "DELETE", `/api/porticos/${launch.id}/pause`))).workspace.pausedAt).toBeNull();
    const after = send(p, muse.agent, "robert/dots", "After").message;
    expect(p.messages.inbox(dots.agent).messages.map((m) => m.id)).toEqual([after.id]);
    expect(robert.id).toBeTruthy();
  });

  test("paused with another Portico still joining the two: the message goes through the other one", async () => {
    const { p, chris, robert, muse, dots, launch } = await world();
    acquaint(p, chris.id, robert.id);
    const side = p.workspaces.create(robert.id, "Side");
    p.workspaces.admit(side.id, chris.id);
    p.workspaces.addAgent(chris.id, side.id, muse.agent.id);
    p.workspaces.addAgent(robert.id, side.id, dots.agent.id);
    // The Portico with only the two people is the more private one, so a message goes there first.
    const first = send(p, muse.agent, "robert/dots").message;
    expect(first.workspaceId).toBe(side.id);
    p.workspaces.pause(robert.id, side.id);
    expect(p.messages.get({ person: chris.id }, first.id)!.status).toBe("withdrawn");
    expect(send(p, muse.agent, "robert/dots").message.workspaceId).toBe(launch.id);
    // A reply to a message in the paused Portico starts a new conversation in the other.
    const moved = p.messages.send(muse.agent, { replyTo: first.id, subject: "Re", text: "x" });
    expect(moved.message).toMatchObject({ workspaceId: launch.id, replyTo: null });
    // A person's own Portico can be paused too, and stops that person's own agents.
    const own = p.workspaces.personal(chris.id);
    p.workspaces.pause(chris.id, own.id);
    expect(errorCode(() => send(p, muse.agent, "grok"))).toBe("not_allowed");
  });

  test("remove a person: that person's agents are out, and their undelivered messages in the Portico are withdrawn, both ways", async () => {
    const { p, chris, robert, maya, muse, dots, pilot, launch, cookies } = await world();
    acquaint(p, chris.id, robert.id, maya.id);
    const fromRobert = send(p, dots.agent, "chris/muse", "From Robert").message;
    const toRobert = send(p, muse.agent, "robert/dots", "To Robert").message;
    const untouched = send(p, pilot.agent, "chris/muse", "From Maya").message;
    expect((await callPerson(p, cookies.maya, "DELETE", `/api/porticos/${launch.id}/people/${robert.id}`)).status).toBe(403);
    expect((await callPerson(p, cookies.chris, "DELETE", `/api/porticos/${launch.id}/people/${robert.id}`)).status).toBe(204);
    expect(p.messages.get({ person: chris.id }, fromRobert.id)!.status).toBe("withdrawn");
    expect(p.messages.get({ person: chris.id }, toRobert.id)!.status).toBe("withdrawn");
    const inbox = p.messages.inbox(muse.agent);
    expect(inbox.messages.map((m) => m.id)).toEqual([untouched.id]);
    expect(inbox.updates.map((m) => [m.id, m.status])).toEqual([[toRobert.id, "withdrawn"]]);
    // Robert's agent, out of the Portico, still hears what became of its own message, and gets nothing else.
    const out = p.messages.inbox(dots.agent);
    expect(out.messages).toEqual([]);
    expect(out.updates.map((m) => [m.id, m.status])).toEqual([[fromRobert.id, "withdrawn"]]);
    expect(errorCode(() => send(p, dots.agent, "chris/muse"))).toBe("not_allowed");
    // Tasks show it as not gone through, with the reason.
    const tasks = (await json(callAs(p, muse, "GET", "/api/agent/tasks?outcome=failed"))).tasks as Body[];
    expect(tasks.map((t) => t.reason)).toEqual(["withdrawn", "withdrawn"]);
  });

  test("revoke an agent: its tokens die at once, it is out of every Portico, and its undelivered messages are withdrawn", async () => {
    const { p, chris, robert, muse, grok, dots, launch, cookies } = await world();
    acquaint(p, chris.id, robert.id);
    const out = send(p, dots.agent, "chris/muse", "Before the stop").message;
    const incoming = send(p, muse.agent, "robert/dots", "To the revoked").message;
    const own = send(p, dots.agent, "scout", "Robert's own").message;
    // Only the agent's own person revokes: the maker of a Portico takes an agent out of that Portico instead.
    expect((await callPerson(p, cookies.chris, "POST", `/api/agents/${dots.agent.id}/revoke`)).status).toBe(403);
    expect((await callPerson(p, cookies.maya, "POST", `/api/agents/${dots.agent.id}/revoke`)).status).toBe(403);
    expect((await callPerson(p, cookies.maya, "POST", `/api/agents/${grok.agent.id}/revoke`)).status).toBe(404);
    const revoked = await json(callPerson(p, cookies.robert, "POST", `/api/agents/${dots.agent.id}/revoke`));
    expect(revoked.agent.revokedAt).not.toBeNull();
    // Every surface refuses the token, exactly as a token nobody has.
    for (const [method, path, body] of [
      ["GET", "/api/agent/inbox", undefined],
      ["GET", "/api/agent/agents", undefined],
      ["POST", "/api/agent/messages", { to: "chris/muse", subject: "s", text: "t" }],
      ["POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
    ] as const) {
      const res = await callAs(p, dots, method, path, body);
      const never = await callAs(p, { token: "pa_never-issued" }, method, path, body);
      expect([res.status, await res.text()]).toEqual([401, await never.text()]);
    }
    expect(p.workspaces.ofAgent(dots.agent.id)).toEqual([]);
    expect((await json(callAs(p, muse, "GET", "/api/agent/agents"))).agents.map((a: Body) => a.name)).not.toContain("robert/dots");
    for (const m of [out, incoming, own]) expect(p.messages.get({ person: robert.id }, m.id)!.status).toBe("withdrawn");
    const inbox = p.messages.inbox(muse.agent);
    expect(inbox.messages).toEqual([]);
    expect(inbox.updates.map((m) => [m.id, m.status])).toEqual([[incoming.id, "withdrawn"]]);
    // It can't be put back, the record says what happened, and the history stays readable to Robert.
    expect(errorCode(() => p.workspaces.addAgent(robert.id, launch.id, dots.agent.id))).toBe("not_allowed");
    expect((await json(callPerson(p, cookies.chris, "GET", `/api/porticos/${launch.id}`))).record[0].text).toBe("robert/dots was revoked by Robert (robert), and left.");
    expect((await callPerson(p, cookies.robert, "GET", `/api/threads/${out.threadId}`)).status).toBe(200);
    expect(p.agentNotices.waiting(muse.agent.id).map((n) => n.text)).toEqual(["`robert/dots` left the Portico “Launch”."]);
    expect(grok.agent.id && chris.id).toBeTruthy();
  });

  test("a revoked session: its session key stops resolving, and the folder can't register again until the agent is removed", async () => {
    const { p, chris } = await world();
    const { computer, token } = addComputer(p, chris);
    const session = addSession(p, computer, { repo: "api", folderId: "f".repeat(64) });
    expect((await callAs(p, { token, key: session.key }, "GET", "/api/agent/agents")).status).toBe(200);
    p.agents.revoke(chris.id, session.agent.id);
    expect((await callAs(p, { token, key: session.key }, "GET", "/api/agent/agents")).status).toBe(401);
    expect(errorCode(() => p.agents.registerSession(computer, { key: "another-key-01", repo: "api", folderId: "f".repeat(64), client: "claude-code" }))).toBe("folder_off");
    p.agents.remove(chris.id, session.agent.id);
    expect(p.agents.registerSession(computer, { key: "another-key-02", repo: "api", folderId: "f".repeat(64), client: "claude-code" }).created).toBe(true);
  });

  test("the inbox never delivers a pending message from a Portico that was deleted under it", async () => {
    const { p, chris, robert, maya, dots, pilot, launch } = await world();
    acquaint(p, chris.id, robert.id, maya.id);
    const between = send(p, dots.agent, "maya/pilot", "Between the others").message;
    // The maker's account is removed: the Portico goes with the account, and what other people's agents had on its
    // way there is withdrawn, as when the maker deletes the Portico. The sender is told, and so are the agents left.
    p.agentNotices.take(dots.agent.id);
    p.people.remove(chris.id);
    expect(p.workspaces.get(launch.id)).toBeNull();
    expect(p.messages.get({ person: robert.id }, between.id)!.status).toBe("withdrawn");
    expect(p.messages.inbox(dots.agent).updates.map((u) => [u.id, u.status])).toEqual([[between.id, "withdrawn"]]);
    expect(p.agentNotices.take(dots.agent.id).map((n) => n.text)).toEqual(["The Portico “Launch” was deleted: the owner's account was removed. This agent reaches nobody through that Portico any more."]);
    expect(p.messages.inbox(pilot.agent).messages).toEqual([]);
    // What waits for pilot is Portico's own notice that the Portico is gone, never the message.
    expect(p.agentNotices.take(pilot.agent.id)).toHaveLength(1);
    expect(p.messages.unreadCount(pilot.agent.id)).toBe(0);
    expect(p.messages.pending(pilot.agent).messages).toEqual([]);
    expect(p.messages.ack(pilot.agent, { messages: [between.id], updates: [] }).messages).toBe(0);
    // A Portico deleted by its maker withdraws what was on its way.
    const again = await world();
    acquaint(again.p, again.chris.id, again.robert.id);
    const sent = send(again.p, again.dots.agent, "chris/muse").message;
    again.p.workspaces.remove(again.chris.id, again.launch.id);
    expect(again.p.messages.get({ person: again.robert.id }, sent.id)!.status).toBe("withdrawn");
    expect(again.p.messages.inbox(again.muse.agent).messages).toEqual([]);
  });

  test("every notice email carries the link to the stop that fits", async () => {
    const hooks = fakeWebhooks();
    const { p, dots, muse, launch } = await world(makePortico({ config: { mail: MAIL }, mailPost: hooks.post }));
    send(p, dots.agent, "chris/muse");
    p.consents.ask(muse.agent, "delete", launch.id);
    await flush();
    const held = mails(hooks).find((mail) => mail.subject === "A message waits for a decision on Portico");
    const consent = mails(hooks).find((mail) => mail.subject.startsWith("Delete a Portico"));
    expect(held!.text).toContain("To stop the sender, take the sender's person out, or pause the Portico, in one step on the Portico's page:");
    expect(held!.text).toContain(`${PUBLIC_URL}/p/${launch.id}`);
    expect(held!.html).toContain(`href="${PUBLIC_URL}/p/${launch.id}"`);
    expect(consent!.text).toContain("To stop the agent that asked, revoke the agent in one step on the agent's page:");
    expect(consent!.text).toContain(`${PUBLIC_URL}/a/${muse.agent.id}`);
    for (const mail of [held!, consent!]) expect(mail.text).toContain("Stop emails from Portico to this address:");
  });
});

describe("names that cannot be faked", () => {
  test("one folding for handles, agent names and computer names", () => {
    expect(nameKey("c1aude-c0de")).toBe(nameKey("claude-code"));
    expect(nameKey("rnuse")).toBe(nameKey("muse"));
    expect(nameKey("vvorker")).toBe(nameKey("worker"));
    expect(nameKey("muse")).not.toBe(nameKey("mouse"));
    expect(titleKey("  LAUNCH\u200b  team ")).toBe(titleKey("launch team"));
    expect(titleKey("Caf\u00e9")).toBe(titleKey("Cafe"));
    expect(porticoKey("The Launch Portico")).toBe(porticoKey("launch"));
    for (const name of ["Your Portico", "Personal Portico", "Shared Portico", "shared", "your  portico", "Chris's Portico", "Chris\u2019s Portico", "Dana's new Portico", "A Portico", "Portico"]) expect(posesAsOwnPortico(name)).toBe(true);
    for (const name of ["Launch", "Portico plans", "Your plans"]) expect(posesAsOwnPortico(name)).toBe(false);
  });

  test("an agent can't take a name that reads like another agent of the same person, or a reserved word", async () => {
    const { p, chris, robert, muse, cookies } = await world();
    addAppAgent(p, chris, "claude-code");
    for (const name of ["c1aude-code", "claude-c0de", "claudecode", "claude--code".replace("--", "-c").slice(0, 0) + "clau-de-code", "rnuse", "muse"]) {
      expect(errorCode(() => p.agents.create({ ownerId: chris.id, name, kind: "other", type: "app" }))).toBe("conflict");
    }
    for (const name of ["system", "portico", "a11", "everyone", "0wner"]) {
      expect(errorCode(() => p.agents.create({ ownerId: chris.id, name, kind: "other", type: "app" }))).toBe("conflict");
    }
    // Renaming is held to the same rule, and says which name it reads like.
    const renamed = await callPerson(p, cookies.chris, "PATCH", `/api/agents/${muse.agent.id}`, { name: "c1aude-code" });
    expect(renamed.status).toBe(409);
    expect((await renamed.json()).message).toBe("The name c1aude-code reads too much like claude-code, another agent of the same person. Pick a name that can't be mistaken for the other.");
    expect((await callPerson(p, cookies.chris, "PATCH", `/api/agents/${muse.agent.id}`, { name: "system" })).status).toBe(409);
    // Another person's agents carry that person's handle, so the same name is free there.
    expect(p.agents.create({ ownerId: robert.id, name: "claude-code", kind: "other", type: "app" }).name).toBe("claude-code");
    // A join that asks for a look-alike name is refused when the person allows it, not silently renamed.
    expect(p.agents.nameFree("c1aude-code", chris.id)).toBe(false);
    expect(p.agents.nameFree("helper", chris.id)).toBe(true);
  });

  test("a session never gets a name that reads like another session's on its computer or like one of its person's apps", async () => {
    const { p, chris } = await world();
    addAppAgent(p, chris, "ap1-claude");
    const { computer } = addComputer(p, chris, "studio");
    expect(addSession(p, computer, { repo: "api" }).agent.name).toBe("api-claude-2");
    expect(addSession(p, computer, { repo: "apl", folderId: "e".repeat(64) }).agent.name).toBe("apl-claude-3");
  });

  test("a computer's name never reads like another of the same person's, or like a reserved word", async () => {
    const { p, chris, robert } = await world();
    expect(addComputer(p, chris, "macbook").computer.name).toBe("macbook");
    expect(addComputer(p, chris, "macb00k").computer.name).toBe("macb00k-2");
    expect(addComputer(p, chris, "system").computer.name).toBe("system-computer");
    expect(addComputer(p, robert, "macbook").computer.name).toBe("macbook");
  });

  test("a Portico can't be named like another Portico one of its people is in, or like the forms Portico itself uses", async () => {
    const { p, chris, robert, launch, cookies } = await world();
    for (const name of ["Launch", "launch", "the Launch Portico", "L\u0430unch", "L\u03b1un\u0441h", "Laun-ch", "Lau nch"]) {
      expect(errorCode(() => p.workspaces.create(chris.id, name))).toBe("conflict");
    }
    for (const name of ["Your Portico", "Chris's Portico", "Robert\u2019s Portico", "A Portico", "Chris and Robert", "Robert, Maya and Chris", "Chris & Maya"]) {
      expect(errorCode(() => p.workspaces.create(chris.id, name))).toBe("conflict");
    }
    // Robert is in Launch, so Robert can't make another that reads the same; Dana, who isn't, could.
    expect(errorCode(() => p.workspaces.create(robert.id, "LAUNCH"))).toBe("conflict");
    const side = p.workspaces.create(robert.id, "Side");
    const refused = await callPerson(p, cookies.robert, "PATCH", `/api/porticos/${side.id}`, { name: "1aunch" });
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toBe(`A Portico can't be named "1aunch": the name reads the same as another Portico one of the people here is in. Pick another name.`);
    // A name is checked against the Porticos of everyone already in, and of whoever comes in.
    const other = p.workspaces.create(robert.id, "Plans");
    const mine = p.workspaces.create(chris.id, "Budget");
    p.workspaces.admit(other.id, chris.id);
    expect(errorCode(() => p.workspaces.rename(robert.id, other.id, "Budget"))).toBe("conflict");
    const clash = p.workspaces.create(robert.id, "Budget");
    expect(errorCode(() => p.workspaces.admit(clash.id, chris.id))).toBe("conflict");
    expect(p.workspaces.rename(chris.id, mine.id, "Budget 2027").name).toBe("Budget 2027");
    expect(launch.name).toBe("Launch");
  });

  test("an outside agent is owner/agent on every surface: the list, a delivery's frame, the held page, the record and the emails", async () => {
    const hooks = fakeWebhooks();
    const { p, chris, muse, dots, launch, cookies } = await world(makePortico({ config: { mail: MAIL }, mailPost: hooks.post }));
    const listed = (await json(callAs(p, muse, "GET", "/api/agent/agents"))).agents as Body[];
    expect(listed.map((a) => a.name).sort()).toEqual(["grok", "maya/pilot", "robert/dots"]);
    const held = send(p, dots.agent, "chris/muse", "Hi").message;
    await flush();
    expect(mails(hooks)[0]!.text).toContain("A message from “robert/dots” to “muse” is held");
    expect(visibleCopy((await page(p, `/held/${held.id}`, cookies.chris)).html)).toContain("“robert/dots” to “muse”");
    p.approvals.decide(chris.id, held.id, "allow_once");
    const delivered = (await json(callAs(p, muse, "GET", "/api/agent/inbox"))).messages[0];
    expect(delivered.from).toBe("robert/dots");
    expect(delivered.framed_message).toStartWith(`<portico-message id="${held.id}" from="robert/dots">`);
    expect(delivered.framed_message).toContain("The sender `robert/dots` is managed by another person, not the person who manages this agent, named “Robert”. The message came through the Portico “Launch”.");
    const record = (await json(callPerson(p, cookies.chris, "GET", `/api/porticos/${launch.id}`))).record as Body[];
    expect(record.map((r) => r.text)).toContain("A first message from robert/dots to muse was held for a decision.");
    // A plain name never reaches someone else's agent, whatever it is called.
    expect(errorCode(() => send(p, muse.agent, "dots"))).toBe("unknown_agent");
  });
});

describe("a record and alerts", () => {
  test("each Portico's record keeps joins, removals, shares, holds, refused sends and pauses, and never a subject or text", async () => {
    const { p, chris, robert, muse, dots, launch, cookies } = await world();
    const { share } = p.shares.create(chris.id, launch.id);
    p.shares.revoke(chris.id, share.id);
    const held = send(p, dots.agent, "chris/muse", "SECRET-SUBJECT", {}).message;
    await flush();
    p.approvals.decide(chris.id, held.id, "deny");
    p.workspaces.pause(chris.id, launch.id);
    expect(errorCode(() => send(p, muse.agent, "robert/dots", "SECRET-SUBJECT"))).toBe("not_allowed");
    p.workspaces.resume(chris.id, launch.id);
    p.workspaces.removeAgent(chris.id, launch.id, dots.agent.id);
    p.workspaces.removePerson(chris.id, launch.id, robert.id);
    const data = await json(callPerson(p, cookies.chris, "GET", `/api/porticos/${launch.id}`));
    expect(data.record.map((r: Body) => r.kind)).toEqual([
      "portico_person_left",
      "portico_agent_left",
      "portico_resumed",
      "portico_refused",
      "portico_paused",
      "decision",
      "portico_held",
      "portico_share_ended",
      "portico_shared",
      "portico_agent_joined",
      "portico_agent_joined",
      "portico_agent_joined",
    ]);
    expect(data.record.map((r: Body) => r.text).slice(0, 7)).toEqual([
      "Chris (chris) took Robert (robert) out, with 0 agents.",
      "Chris (chris) took robert/dots out.",
      "Chris (chris) resumed the Portico.",
      "A send by muse to robert/dots was refused: the Portico is paused.",
      "Chris (chris) paused the Portico: nothing moves through the Portico until the owner resumes the Portico.",
      "Chris (chris) turned down a held message from robert/dots to muse.",
      "A first message from robert/dots to muse was held for a decision.",
    ]);
    const everything = JSON.stringify(p.activity.list({ limit: 500 })) + JSON.stringify(data);
    expect(everything).not.toContain("SECRET-SUBJECT");
    expect(everything).not.toContain("the text");
    // The page shows the record to the people in the Portico, in words that pass the copy rules.
    const html = (await page(p, `/p/${launch.id}`, cookies.chris)).html;
    expect(visibleCopy(html)).toContain("Joins, shares and held messages. Never what a message says.");
    expect(copyProblems(visibleCopy(html))).toEqual([]);
  });

  test("a burst of messages from one of another person's agents: the person is told once a day, on the page and by email", async () => {
    const hooks = fakeWebhooks();
    const { p, chris, robert, dots, pilot, launch, cookies } = await world(makePortico({ config: { mail: MAIL }, mailPost: hooks.post }));
    acquaint(p, chris.id, robert.id);
    // Under the loop guard, so the burst is spread over Chris's two agents.
    p.workspaces.addAgent(chris.id, launch.id, p.agents.byAddress("grok")!.id);
    const burst = async (count: number) => {
      for (let i = 0; i < count; i++) {
        send(p, dots.agent, i % 2 === 0 ? "chris/muse" : "chris/grok", `Burst ${i}`);
        p.clock.advance(1000);
      }
      await flush();
    };
    expect(LIMITS.burstMessages).toBe(10);
    // Nine is no burst; the tenth within the window is, and more of the same say nothing again that day.
    await burst(9);
    expect(p.activity.list({ limit: 500 }).some((entry) => entry.kind === "portico_burst")).toBe(false);
    await burst(9);
    const alerts = p.activity.list({ limit: 500 }).filter((entry) => entry.kind === "portico_burst");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ otherId: dots.agent.id, subjectId: chris.id, workspaceId: launch.id });
    const alert = mails(hooks).filter((mail) => mail.subject === "Many messages from one agent on Portico");
    expect(alert.map((mail) => mail.to[0])).toEqual(["chris@example.com"]);
    expect(alert[0]!.text).toMatch(/“robert\/dots” sent \d+ messages to Chris's agents within 10 minutes\./);
    expect(alert[0]!.text).toContain(`${PUBLIC_URL}/p/${launch.id}`);
    expect(alert[0]!.text).not.toContain("Burst");
    // Shown to Chris on the Portico's page, and to nobody else there.
    const mine = (await json(callPerson(p, cookies.chris, "GET", `/api/porticos/${launch.id}`))).record as Body[];
    expect(mine.filter((r) => r.kind === "portico_burst").map((r) => r.text)).toEqual([expect.stringMatching(/^robert\/dots sent \d+ messages to Chris \(chris\)'s agents within 10 minutes\.$/)]);
    const theirs = (await json(callPerson(p, cookies.maya, "GET", `/api/porticos/${launch.id}`))).record as Body[];
    expect(theirs.some((r) => r.kind === "portico_burst")).toBe(false);
    expect(pilot.agent.id).toBeTruthy();
  });

  test("repeated refused sends: the agent's own person is told once a day, and a looping agent can't flood the record", async () => {
    const hooks = fakeWebhooks();
    const { p, chris, muse, cookies } = await world(makePortico({ config: { mail: MAIL }, mailPost: hooks.post }));
    for (let i = 0; i < 200; i++) expect(errorCode(() => send(p, muse.agent, `robert/nobody-${i}`))).toBe("unknown_agent");
    await flush();
    const entries = p.activity.list({ limit: 500 });
    expect(entries.filter((entry) => entry.kind === "portico_refused")).toHaveLength(LIMITS.refusedSends * 3);
    expect(entries.filter((entry) => entry.kind === "portico_refusals")).toMatchObject([{ agentId: muse.agent.id, subjectId: chris.id }]);
    const alert = mails(hooks).filter((mail) => mail.subject === "An agent keeps being refused on Portico");
    expect(alert).toHaveLength(1);
    expect(alert[0]!.text).toContain("“muse” had 10 sends refused within 10 minutes.");
    expect(alert[0]!.text).toContain(`${PUBLIC_URL}/a/${muse.agent.id}`);
    // Chris sees both in the dashboard's activity.
    const activity = await json(callPerson(p, cookies.chris, "GET", "/api/activity?events=1"));
    expect(JSON.stringify(activity)).toContain("portico_refusals");
    // The next day counts afresh.
    p.clock.advance(DAY + MINUTE);
    for (let i = 0; i < LIMITS.refusedSends; i++) errorCode(() => send(p, muse.agent, `robert/nobody-${i}`));
    expect(p.activity.list({ limit: 500 }).filter((entry) => entry.kind === "portico_refusals")).toHaveLength(2);
  });
});
