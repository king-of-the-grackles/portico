import { describe, expect, test } from "bun:test";
import { porticoTools } from "../src/agent-api/portico-tools";
import type { Agent } from "../src/core/types";
import { addAppAgent, addMember, addOwner, callAs, callPerson, copyProblems, DAY, errorCode, fakeAccounts, makePortico, MINUTE, signIn, type TestPortico, visibleCopy } from "./helpers";

const on = () => makePortico();

/**
 * Chris (handle chris) with muse and grok-bot in his shared workspace "Launch". Robert (handle robert) with muse and
 * dots, and Maya (handle maya) with scout: neither is in Launch.
 */
async function world(p: TestPortico = on()) {
  const chris = p.people.setHandle((await addOwner(p, "Chris")).id, "chris");
  const robert = p.people.setEmail(p.people.setHandle((await addMember(p, "Robert")).id, "robert").id, "robert@example.com");
  const maya = p.people.setEmail(p.people.setHandle((await addMember(p, "Maya")).id, "maya").id, "maya@example.com");
  const muse = addAppAgent(p, chris, "muse");
  const grok = addAppAgent(p, chris, "grok-bot", { kind: "grok-bot" });
  const rmuse = addAppAgent(p, robert, "muse");
  const dots = addAppAgent(p, robert, "dots", { kind: "dots" });
  const scout = addAppAgent(p, maya, "scout");
  const launch = p.workspaces.create(chris.id, "Launch");
  p.workspaces.addAgent(chris.id, launch.id, muse.agent.id);
  const cookies = { chris: signIn(p, chris), robert: signIn(p, robert), maya: signIn(p, maya) };
  return { p, chris, robert, maya, muse, grok, rmuse, dots, scout, launch, cookies };
}

const names = (p: TestPortico, viewer: Agent) => p.agents.entriesFor(viewer).map((e) => e.address);
const link = (secret: string) => `https://portico.example.com/share#${secret}`;

describe("share links", () => {
  test("anyone in a shared workspace makes a link; a personal workspace and a stranger's workspace can't be shared", async () => {
    const { p, chris, robert, maya, launch } = await world();
    const { share, secret } = p.shares.create(chris.id, launch.id);
    expect(share).toMatchObject({ workspaceId: launch.id, createdBy: chris.id, email: null, claimedBy: null });
    expect(Date.parse(share.expiresAt) - Date.parse(share.createdAt)).toBe(7 * DAY);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(errorCode(() => p.shares.create(chris.id, p.workspaces.personal(chris.id).id))).toBe("not_allowed");
    // Not in the workspace: the same answer as a workspace that isn't there.
    expect(errorCode(() => p.shares.create(robert.id, launch.id))).toBe("not_found");
    expect(errorCode(() => p.shares.create(chris.id, "nope"))).toBe("not_found");
    // A member who isn't the owner shares too.
    p.workspaces.admit(launch.id, maya.id);
    expect(p.shares.create(maya.id, launch.id).share.createdBy).toBe(maya.id);
  });

  test("the link shows again only to the person who made the link and to the workspace's owner", async () => {
    const { p, chris, robert, maya, launch } = await world();
    p.workspaces.admit(launch.id, maya.id);
    p.workspaces.admit(launch.id, robert.id);
    const mine = p.shares.create(maya.id, launch.id);
    expect(p.shares.secretFor(maya.id, mine.share.id)).toBe(mine.secret);
    expect(p.shares.secretFor(chris.id, mine.share.id)).toBe(mine.secret);
    expect(p.shares.secretFor(robert.id, mine.share.id)).toBeNull();
    expect(p.shares.openFor(robert.id, launch.id)).toEqual([]);
    expect(p.shares.openFor(chris.id, launch.id).map((s) => s.id)).toEqual([mine.share.id]);
    // The secret is stored sealed and hashed, never as written.
    const row = p.db.query("SELECT secret_hash, secret_box FROM shares").get() as { secret_hash: string; secret_box: string };
    expect(row.secret_hash).not.toContain(mine.secret);
    expect(row.secret_box).not.toContain(mine.secret);
  });

  test("a link that is ended, expired or unknown lets nobody ask, with one answer for all three", async () => {
    const { p, chris, robert, rmuse, launch } = await world();
    const ended = p.shares.create(chris.id, launch.id);
    expect(errorCode(() => p.shares.revoke(robert.id, ended.share.id))).toBe("not_found");
    p.shares.revoke(chris.id, ended.share.id);
    const old = p.shares.create(chris.id, launch.id);
    p.clock.advance(7 * DAY);
    const messages = new Set<string>();
    for (const secret of [ended.secret, old.secret, "A".repeat(32), "", null]) {
      try {
        p.shares.requestForAgent(rmuse.agent, secret);
      } catch (err) {
        messages.add((err as Error).message);
      }
    }
    expect([...messages]).toEqual(["This share link doesn't work. Ask the person who sent it for a new one."]);
  });
});

describe("an agent on Portico comes in with a link", () => {
  test("the link alone lets no agent in: nothing changes until the person who manages the agent confirms", async () => {
    const { p, chris, robert, muse, rmuse, launch } = await world();
    const { secret } = p.shares.create(chris.id, launch.id);
    const request = p.shares.requestForAgent(rmuse.agent, link(secret));
    expect(request.code).toMatch(/^\d{4}$/);
    expect(p.workspaces.hasPerson(launch.id, robert.id)).toBe(false);
    expect(p.workspaces.hasAgent(launch.id, rmuse.agent.id)).toBe(false);
    expect(names(p, muse.agent)).not.toContain("robert/muse");
    expect(errorCode(() => p.messages.send(rmuse.agent, { to: "chris/muse", subject: "Hi", text: "x" }))).toBe("unknown_agent");
    // Asking twice answers the same request.
    expect(p.shares.requestForAgent(rmuse.agent, secret).id).toBe(request.id);
  });

  test("only the person who manages the agent confirms; then the person and the agent are in, and reach the others", async () => {
    const { p, chris, robert, maya, muse, rmuse, dots, launch } = await world();
    const { share, secret } = p.shares.create(chris.id, launch.id);
    const request = p.shares.requestForAgent(rmuse.agent, secret);
    // Chris, who made the link, can't confirm Robert's agent; nor can Maya.
    expect(errorCode(() => p.shares.decide(chris.id, request.id, { decision: "approve" }))).toBe("not_found");
    expect(errorCode(() => p.shares.decide(maya.id, request.id, { decision: "approve" }))).toBe("not_found");
    expect(p.shares.pendingFor(robert.id).map((r) => r.id)).toEqual([request.id]);
    expect(p.shares.pendingFor(chris.id)).toEqual([]);

    const { agent } = p.shares.decide(robert.id, request.id, { decision: "approve" });
    expect(agent!.id).toBe(rmuse.agent.id);
    expect(p.workspaces.hasPerson(launch.id, robert.id)).toBe(true);
    expect(p.workspaces.agentsIn(launch.id).sort()).toEqual([muse.agent.id, rmuse.agent.id].sort());
    expect(p.shares.get(share.id)!.claimedBy).toBe(robert.id);
    expect(names(p, muse.agent)).toContain("robert/muse");
    expect(p.messages.send(rmuse.agent, { to: "chris/muse", subject: "Hi", text: "x" }).message.status).toBe("pending");
    // Robert's other agent stays out until Robert puts that one in too.
    expect(names(p, muse.agent)).not.toContain("robert/dots");
    expect(errorCode(() => p.shares.decide(robert.id, request.id, { decision: "approve" }))).toBe("wrong_status");

    // The same link brings in another of Robert's agents.
    const second = p.shares.requestForAgent(dots.agent, secret);
    p.shares.decide(robert.id, second.id, { decision: "approve" });
    expect(names(p, muse.agent)).toContain("robert/dots");
    expect(errorCode(() => p.shares.requestForAgent(dots.agent, secret))).toBe("wrong_status");
  });

  test("once one person used a link, nobody else can", async () => {
    const { p, chris, robert, maya, rmuse, scout, launch } = await world();
    const { secret } = p.shares.create(chris.id, launch.id);
    const early = p.shares.requestForAgent(scout.agent, secret);
    const request = p.shares.requestForAgent(rmuse.agent, secret);
    p.shares.decide(robert.id, request.id, { decision: "approve" });
    // Maya's agent asked before the link was claimed: her request is dead now, and a new one is refused.
    expect(errorCode(() => p.shares.decide(maya.id, early.id, { decision: "approve" }))).toBe("not_found");
    expect(errorCode(() => p.shares.requestForAgent(scout.agent, secret))).toBe("not_found");
    expect(p.workspaces.hasPerson(launch.id, maya.id)).toBe(false);
  });

  test("a link sent by email works only for the person with that address", async () => {
    const { p, chris, robert, maya, rmuse, scout, launch } = await world();
    const { secret } = p.shares.create(chris.id, launch.id, { email: " Robert@Example.com " });
    expect(errorCode(() => p.shares.requestForAgent(scout.agent, secret))).toBe("not_found");
    const request = p.shares.requestForAgent(rmuse.agent, secret);
    // The address changing between asking and confirming closes the door again.
    p.people.setEmail(robert.id, "other@example.com");
    expect(errorCode(() => p.shares.decide(robert.id, request.id, { decision: "approve" }))).toBe("not_found");
    p.people.setEmail(robert.id, "robert@example.com");
    p.shares.decide(robert.id, request.id, { decision: "approve" });
    expect(p.workspaces.hasPerson(launch.id, robert.id)).toBe(true);
    expect(p.workspaces.hasPerson(launch.id, maya.id)).toBe(false);
  });

  test("declining, a request past its time, and an ended link all leave everything as it was", async () => {
    const { p, chris, robert, rmuse, dots, launch } = await world();
    const { share, secret } = p.shares.create(chris.id, launch.id);
    const declined = p.shares.requestForAgent(rmuse.agent, secret);
    expect(p.shares.decide(robert.id, declined.id, { decision: "deny" }).request.status).toBe("denied");
    const late = p.shares.requestForAgent(rmuse.agent, secret);
    p.clock.advance(15 * MINUTE);
    expect(errorCode(() => p.shares.decide(robert.id, late.id, { decision: "approve" }))).toBe("wrong_status");
    const waiting = p.shares.requestForAgent(dots.agent, secret);
    p.shares.revoke(chris.id, share.id);
    expect(errorCode(() => p.shares.decide(robert.id, waiting.id, { decision: "approve" }))).toBe("wrong_status");
    expect(p.workspaces.hasPerson(launch.id, robert.id)).toBe(false);
    expect(p.workspaces.agentsIn(launch.id)).toHaveLength(1);
    expect(p.shares.get(share.id)!.claimedBy).toBeNull();
  });

  test("a person without a handle can't come in", async () => {
    // Signing in with an outside account makes a person with no handle yet.
    const { p, chris, launch } = await world(makePortico({ accountCheck: fakeAccounts }));
    const ada = await addMember(p, "Ada");
    expect(ada.handle).toBeNull();
    const helper = addAppAgent(p, ada, "helper");
    const request = p.shares.requestForAgent(helper.agent, p.shares.create(chris.id, launch.id).secret);
    expect(errorCode(() => p.shares.decide(ada.id, request.id, { decision: "approve" }))).toBe("wrong_status");
    expect(p.workspaces.hasPerson(launch.id, ada.id)).toBe(false);
  });
});

describe("an agent that isn't on Portico joins with a link", () => {
  test("the agent asks with the link, the person types the code, and the token comes once", async () => {
    const { p, chris, robert, muse, launch, cookies } = await world();
    const { secret } = p.shares.create(chris.id, launch.id);
    const asked = await p.app.request("/api/share-requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: link(secret), name: "helper", kind: "grok-bot" }) });
    expect(asked.status).toBe(201);
    const made = (await asked.json()) as { id: string; code: string; poll_secret: string; confirm_url: string };
    expect(made.confirm_url).toBe(`https://portico.example.com/share/confirm/${made.id}`);
    const poll = () => p.app.request(`/api/share-requests/${made.id}`, { headers: { authorization: `Bearer ${made.poll_secret}` } });
    expect(await (await poll()).json()).toEqual({ status: "pending" });
    expect((await p.app.request(`/api/share-requests/${made.id}`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect(p.agents.ownedBy(robert.id)).toHaveLength(2);

    // The confirm page never shows the code: the person reads the code in the agent's chat.
    const page = await (await p.app.request(`/share/confirm/${made.id}`, { headers: { cookie: cookies.robert } })).text();
    expect(page).toContain("Let helper into the Launch Portico");
    expect(page).not.toContain(made.code);
    expect((await p.app.request(`/share/confirm/${made.id}`)).headers.get("location")).toContain("/sign-in");

    const wrong = await callPerson(p, cookies.robert, "POST", `/api/approvals/joins/${made.id}`, { decision: "approve", code: made.code === "0000" ? "0001" : "0000" });
    expect(wrong.status).toBe(400);
    expect(p.agents.ownedBy(robert.id)).toHaveLength(2);
    const right = await callPerson(p, cookies.robert, "POST", `/api/approvals/joins/${made.id}`, { decision: "approve", code: made.code, name: "helper" });
    expect(right.status).toBe(200);
    expect(((await right.json()) as { next: string }).next).toBe(`/p/${launch.id}`);

    const first = (await (await poll()).json()) as { status: string; token: string; mcp_url: string; agent: { name: string } };
    expect(first).toMatchObject({ status: "approved", agent: { name: "helper" }, mcp_url: "https://portico.example.com/mcp" });
    expect(((await (await poll()).json()) as { token?: string }).token).toBeUndefined();
    const helper = p.agents.ownedBy(robert.id).find((a) => a.name === "helper")!;
    expect(helper).toMatchObject({ kind: "grok-bot", type: "app" });
    expect(p.workspaces.hasAgent(launch.id, helper.id)).toBe(true);
    const list = (await (await callAs(p, { token: first.token }, "GET", "/api/agent/agents")).json()) as { agents: { name: string }[] };
    // The new agent reaches the workspace, and the other agents of the person who let the agent in.
    expect(list.agents.map((a) => a.name).sort()).toEqual(["chris/muse", "dots", "muse"]);
    expect(names(p, muse.agent)).toContain("robert/helper");
  });

  test("a few wrong codes close the request, and a stranger with the request's address gets nowhere without the code", async () => {
    const { p, chris, maya, launch } = await world();
    const { secret } = p.shares.create(chris.id, launch.id);
    const { request } = p.shares.requestForNewAgent(secret, { name: "helper" });
    const wrong = request.code === "1111" ? "2222" : "1111";
    for (let i = 0; i < 4; i++) expect(errorCode(() => p.shares.decide(maya.id, request.id, { decision: "approve", code: wrong }))).toBe("bad_request");
    expect(errorCode(() => p.shares.decide(maya.id, request.id, { decision: "approve", code: wrong }))).toBe("wrong_status");
    // Even the right code is too late now.
    expect(errorCode(() => p.shares.decide(maya.id, request.id, { decision: "approve", code: request.code }))).toBe("wrong_status");
    expect(p.workspaces.hasPerson(launch.id, maya.id)).toBe(false);
    expect(p.agents.ownedBy(maya.id)).toHaveLength(1);
  });

  test("a bad name, a coding agent's kind and a dead link are refused or made safe", async () => {
    const { p, chris, launch } = await world();
    const { secret } = p.shares.create(chris.id, launch.id);
    expect(errorCode(() => p.shares.requestForNewAgent(secret, { name: "Not A Name" }))).toBe("bad_request");
    expect(errorCode(() => p.shares.requestForNewAgent(secret, { name: "helper", kind: "nope" }))).toBe("bad_request");
    expect(p.shares.requestForNewAgent(secret, { name: "helper", kind: "claude-code" }).request.kind).toBe("other");
    expect(errorCode(() => p.shares.requestForNewAgent("A".repeat(32), { name: "helper" }))).toBe("not_found");
    // Guessing links from one address stops after ten.
    const guess = () => p.app.request("/api/share-requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: "B".repeat(32), name: "helper" }) });
    for (let i = 0; i < 10; i++) expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(429);
  });
});

describe("what an agent asks the person to confirm", () => {
  test("sharing waits for the person; the agent gets the link only after the yes", async () => {
    const { p, chris, robert, muse, launch } = await world();
    const ask = p.shares.ask(muse.agent, "share", launch.id, { email: "robert@example.com" });
    expect(ask).toMatchObject({ status: "pending", personId: chris.id, detail: { email: "robert@example.com" } });
    expect(p.shares.openFor(chris.id, launch.id)).toEqual([]);
    expect(errorCode(() => p.shares.decideAsk(robert.id, ask.id, "approve"))).toBe("not_found");
    const done = p.shares.decideAsk(chris.id, ask.id, "approve");
    expect(done.status).toBe("approved");
    expect(p.shares.get(done.result!.shareId!)).toMatchObject({ workspaceId: launch.id, email: "robert@example.com", createdBy: chris.id });
    expect(errorCode(() => p.shares.decideAsk(chris.id, ask.id, "approve"))).toBe("wrong_status");
    const declined = p.shares.ask(muse.agent, "share", launch.id);
    expect(p.shares.decideAsk(chris.id, declined.id, "deny").result).toBeNull();
    expect(p.shares.openFor(chris.id, launch.id)).toHaveLength(1);
  });

  test("an agent asks only about workspaces the person who manages the agent is in", async () => {
    const { p, chris, rmuse, muse, launch } = await world();
    expect(errorCode(() => p.shares.ask(rmuse.agent, "share", launch.id))).toBe("not_found");
    expect(errorCode(() => p.shares.ask(muse.agent, "share", p.workspaces.personal(chris.id).id))).toBe("not_allowed");
  });

  test("removing a person waits too, and follows the owner's rules", async () => {
    const { p, chris, robert, maya, muse, rmuse, scout, launch } = await world();
    p.workspaces.admit(launch.id, robert.id);
    p.workspaces.admit(launch.id, maya.id);
    p.workspaces.addAgent(robert.id, launch.id, rmuse.agent.id);
    // Robert isn't the owner: his agent can ask for him to leave, not to remove Maya or the owner.
    expect(errorCode(() => p.shares.ask(rmuse.agent, "remove_person", launch.id, { person: "maya" }))).toBe("not_allowed");
    expect(errorCode(() => p.shares.ask(rmuse.agent, "remove_person", launch.id, { person: "chris" }))).toBe("not_allowed");
    expect(errorCode(() => p.shares.ask(muse.agent, "remove_person", launch.id, { person: "nobody" }))).toBe("not_found");
    const ask = p.shares.ask(muse.agent, "remove_person", launch.id, { person: "robert" });
    expect(p.workspaces.hasPerson(launch.id, robert.id)).toBe(true);
    p.shares.decideAsk(chris.id, ask.id, "approve");
    expect(p.workspaces.hasPerson(launch.id, robert.id)).toBe(false);
    expect(p.workspaces.hasAgent(launch.id, rmuse.agent.id)).toBe(false);
    void scout;
  });

  test("asks and requests expire by themselves", async () => {
    const { p, chris, muse, rmuse, launch } = await world();
    const ask = p.shares.ask(muse.agent, "share", launch.id);
    p.shares.requestForAgent(rmuse.agent, p.shares.create(chris.id, launch.id).secret);
    p.clock.advance(24 * 60 * MINUTE);
    expect(p.shares.sweepMinute()).toBe(2);
    expect(errorCode(() => p.shares.decideAsk(chris.id, ask.id, "approve"))).toBe("wrong_status");
  });
});

describe("what the security review found", () => {
  test("a person taken out can't come back with an old link, and the links that person made stop working", async () => {
    const { p, chris, robert, maya, rmuse, scout, launch } = await world();
    const { secret } = p.shares.create(chris.id, launch.id);
    p.shares.decide(robert.id, p.shares.requestForAgent(rmuse.agent, secret).id, { decision: "approve" });
    const made = p.shares.create(robert.id, launch.id);
    const waiting = p.shares.requestForAgent(scout.agent, made.secret);
    p.workspaces.removePerson(chris.id, launch.id, robert.id);
    // The link Robert came in with, and the one Robert made, are both dead.
    expect(errorCode(() => p.shares.requestForAgent(rmuse.agent, secret))).toBe("not_found");
    expect(errorCode(() => p.shares.requestForAgent(scout.agent, made.secret))).toBe("not_found");
    expect(errorCode(() => p.shares.decide(maya.id, waiting.id, { decision: "approve" }))).toBe("wrong_status");
    expect(p.workspaces.hasPerson(launch.id, robert.id)).toBe(false);
    expect(p.workspaces.hasPerson(launch.id, maya.id)).toBe(false);
    // A fresh link from the owner still works for Robert.
    const again = p.shares.create(chris.id, launch.id);
    p.shares.decide(robert.id, p.shares.requestForAgent(rmuse.agent, again.secret).id, { decision: "approve" });
    expect(p.workspaces.hasPerson(launch.id, robert.id)).toBe(true);
    // Leaving ends them just the same.
    p.workspaces.removePerson(robert.id, launch.id, robert.id);
    expect(errorCode(() => p.shares.requestForAgent(rmuse.agent, again.secret))).toBe("not_found");
  });

  test("no agent can answer for the person: an ask or a request to come in is never decided through the pop-up route", async () => {
    const { p, chris, muse, rmuse, launch } = await world();
    const ask = p.shares.ask(muse.agent, "share", launch.id, { email: "attacker@example.com" });
    const join = p.shares.requestForAgent(rmuse.agent, p.shares.create(chris.id, launch.id).secret);
    for (const [token, id] of [[muse.token, `ask-${ask.id}`], [rmuse.token, `join-${join.id}`]] as const) {
      const res = await callAs(p, { token }, "POST", `/api/agent/approvals/${id}`, { nonce: "anything", decision: "allow_once" });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(p.shares.getAsk(ask.id)!.status).toBe("pending");
    expect(p.shares.request(join.id)!.status).toBe("pending");
    expect(p.shares.openFor(chris.id, launch.id)).toHaveLength(1);
  });

  test("a message held while two agents shared a workspace can't be let through after they stop", async () => {
    const { p, chris, robert, muse, rmuse, launch, cookies } = await world();
    p.shares.decide(robert.id, p.shares.requestForAgent(rmuse.agent, p.shares.create(chris.id, launch.id).secret).id, { decision: "approve" });
    p.agents.update(chris.id, muse.agent.id, { approvalRequired: true });
    const held = p.messages.send(rmuse.agent, { to: "chris/muse", subject: "Hi", text: "x" }).message;
    expect(held.status).toBe("held");
    p.workspaces.removePerson(chris.id, launch.id, robert.id);
    expect((await callPerson(p, cookies.chris, "POST", `/api/approvals/held/${held.id}`, { decision: "allow_once" })).status).toBe(409);
    expect((await callPerson(p, cookies.chris, "POST", `/api/approvals/held/${held.id}`, { decision: "deny" })).status).toBe(200);
  });

  test("a stranger can't tell someone else's workspace or agent from one that isn't there", async () => {
    const { p, chris, muse, rmuse, cookies } = await world();
    const personal = p.workspaces.personal(chris.id);
    for (const id of [personal.id, "no-such-workspace"]) {
      expect((await callPerson(p, cookies.robert, "PUT", `/api/porticos/${id}/agents/${rmuse.agent.id}`)).status).toBe(404);
      expect((await callPerson(p, cookies.robert, "DELETE", `/api/porticos/${id}/people/${chris.id}`)).status).toBe(404);
    }
    for (const id of [muse.agent.id, "no-such-agent"]) {
      expect((await callPerson(p, cookies.robert, "GET", `/api/agents/${id}`)).status).toBe(404);
      expect((await callPerson(p, cookies.robert, "PATCH", `/api/agents/${id}`, { description: "x" })).status).toBe(404);
      expect((await callPerson(p, cookies.robert, "DELETE", `/api/agents/${id}`)).status).toBe(404);
      expect((await callPerson(p, cookies.robert, "DELETE", `/api/agents/${id}/wake`)).status).toBe(404);
      const page = await p.app.request(`/a/${id}`, { headers: { cookie: cookies.robert } });
      expect([page.status, page.headers.get("location")]).toEqual([303, "/"]);
    }
    expect(p.agents.get(muse.agent.id)!.description).not.toBe("x");
  });
});

describe("the Portico tools", () => {
  const tool = async (p: TestPortico, token: string, name: string, args: unknown = {}) => {
    const res = await callAs(p, { token }, "POST", `/api/agent/portico-tools/${name}`, args);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const mcp = async (p: TestPortico, token: string, method: string, params: unknown = {}) => {
    const res = await callAs(p, { token }, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params });
    return ((await res.json()) as { result: any }).result;
  };

  test("an agent lists, makes and fills Porticos for the person who manages the agent, one agent at a time, and nobody else's", async () => {
    const { p, muse, rmuse, launch } = await world();
    const listed = await tool(p, muse.token, "list_porticos");
    expect(listed.body.handle).toBe("chris");
    expect(listed.body.porticos.map((w: any) => [w.name, w.kind, w.this_agent_is_in])).toEqual([
      ["Chris's Portico", "own", true],
      ["Launch", "shared", true],
    ]);
    expect(listed.body.porticos[1]).toMatchObject({ people: [{ name: "Chris", handle: "chris" }], agents: ["muse"], owned_by_this_person: true });
    expect((await tool(p, rmuse.token, "list_porticos")).body.porticos.map((w: any) => w.name)).toEqual(["Robert's Portico"]);

    const made = await tool(p, muse.token, "create_portico", { name: "Design" });
    expect(made.body.portico).toMatchObject({ name: "Design", agents: ["muse"], owned_by_this_person: true });
    expect(made.body.note).toBe("Made the Design Portico with `muse` in it. Nobody else is in the Design Portico until share_portico brings someone in.");
    // By name or by ID, and one agent to a call.
    const added = await tool(p, muse.token, "add_to_portico", { portico: "Design", agent: "grok-bot" });
    expect(added.body.portico.agents).toEqual(["muse", "grok-bot"]);
    expect(added.body.note).toBe("`grok-bot` is in the Design Portico: everyone there can message `grok-bot`.");
    const removed = await tool(p, muse.token, "remove_from_portico", { portico: made.body.portico.id, agent: "muse" });
    expect(removed.body.portico.agents).toEqual(["grok-bot"]);
    expect(removed.body.note).toContain("out of the Design Portico");
    expect((await tool(p, muse.token, "add_to_portico", { portico: "Design", agents: ["muse", "grok-bot"] })).status).toBe(400);
    expect((await tool(p, muse.token, "remove_from_portico", { portico: "Design" })).status).toBe(400);
    expect((await tool(p, muse.token, "remove_from_portico", { portico: "Design", agent: "muse", person: "robert" })).status).toBe(400);
    const renamed = await tool(p, muse.token, "rename_portico", { portico: "the Design Portico", name: "Studio" });
    expect(renamed.body).toMatchObject({ portico: { name: "Studio" }, note: "The Design Portico is now the Studio Portico." });
    // Another person's agent, and another person's Portico, are out of reach.
    expect((await tool(p, muse.token, "add_to_portico", { portico: launch.id, agent: "robert/muse" })).status).toBe(400);
    expect((await tool(p, muse.token, "remove_from_portico", { portico: launch.id, agent: "robert/muse" })).status).toBe(403);
    expect(await tool(p, rmuse.token, "add_to_portico", { portico: launch.id, agent: "muse" })).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect((await tool(p, rmuse.token, "rename_portico", { portico: "Launch", name: "Mine" })).status).toBe(404);
    expect((await tool(p, muse.token, "nope")).status).toBe(404);
    expect((await tool(p, muse.token, "set_workspace_agents")).status).toBe(404);
  });

  test("an agent taken out of its person's own Portico stays out: no tool puts it anywhere", async () => {
    const { p, chris, muse, grok, launch } = await world();
    const own = p.workspaces.personal(chris.id);
    // A tool can take an agent out, which only narrows who reaches it.
    expect((await tool(p, grok.token, "remove_from_portico", { portico: "Chris's Portico", agent: "muse" })).status).toBe(200);
    expect(p.workspaces.hasAgent(own.id, muse.agent.id)).toBe(false);
    for (const portico of [own.id, launch.id]) {
      const back = await tool(p, grok.token, "add_to_portico", { portico, agent: "muse" });
      expect(back.status).toBe(403);
      expect(back.body.message).toContain("Chris took `muse` out of Chris's Portico, so only Chris can put `muse` into");
    }
    expect((await tool(p, grok.token, "create_portico", { name: "Side door", agents: ["grok-bot", "muse"] })).status).toBe(403);
    expect(p.workspaces.forPerson(chris.id).map((w) => w.name)).toEqual(["Chris's Portico", "Launch"]);
    expect((await tool(p, muse.token, "add_to_portico", { portico: own.id, agent: "muse" })).status).toBe(403);
    // Chris can, on the pages.
    p.workspaces.addAgent(chris.id, own.id, muse.agent.id);
    expect((await tool(p, grok.token, "add_to_portico", { portico: "Launch", agent: "muse" })).status).toBe(200);
  });

  test("sharing through an agent waits for the person, says so in a sentence to show, and ends with the link in list_porticos", async () => {
    const { p, muse, rmuse, robert, launch, cookies } = await world();
    const asked = await tool(p, muse.token, "share_portico", { portico: "launch" });
    expect(asked.body).toMatchObject({ status: "waiting_for_person", portico: { id: launch.id, name: "Launch" }, request: { kind: "share", status: "pending", portico: { name: "Launch" } } });
    expect(asked.body.show).toBe(
      `Waiting for Chris: sharing the Launch Portico with one more person happens only once Chris confirms at https://portico.example.com/, under what needs a decision. The request runs out at ${asked.body.request.expires_at}; the same call asks again after that.`,
    );
    expect(asked.body.request.link).toBeUndefined();
    const approvals = (await (await callPerson(p, cookies.chris, "GET", "/api/approvals")).json()) as { asks: { id: string; agent: { label: string } }[] };
    expect(approvals.asks.map((a) => a.id)).toEqual([asked.body.request.id]);
    // Someone else's cookie can't answer.
    expect((await callPerson(p, cookies.robert, "POST", `/api/approvals/asks/${asked.body.request.id}`, { decision: "approve" })).status).toBe(404);
    expect((await callPerson(p, cookies.chris, "POST", `/api/approvals/asks/${asked.body.request.id}`, { decision: "approve" })).status).toBe(200);
    const after = await tool(p, muse.token, "list_porticos");
    const shared = after.body.waiting.find((r: any) => r.id === asked.body.request.id);
    expect(shared.status).toBe("approved");
    expect(shared.link).toMatch(/^https:\/\/portico\.example\.com\/share#[A-Za-z0-9_-]+$/);

    const joining = await tool(p, rmuse.token, "join_portico", { link: shared.link });
    expect(joining.body.request.code).toMatch(/^\d{4}$/);
    expect(joining.body).toMatchObject({ status: "waiting_for_person", portico: { id: launch.id, name: "Launch" } });
    expect(joining.body.show).toContain(`this agent comes into the Launch Portico only once Robert confirms`);
    expect(joining.body.show).toContain(`with the code ${joining.body.request.code}`);
    expect((await tool(p, rmuse.token, "list_porticos")).body.waiting).toMatchObject([{ kind: "join", status: "pending", portico: { name: "Launch" } }]);
    const joins = (await (await callPerson(p, cookies.robert, "GET", "/api/approvals")).json()) as { joins: { id: string; code: string; workspace: { name: string } }[] };
    expect(joins.joins).toMatchObject([{ id: joining.body.request.id, code: joining.body.request.code, workspace: { name: "Launch", phrase: "the Launch Portico" } }]);
    expect((await callPerson(p, cookies.chris, "POST", `/api/approvals/joins/${joining.body.request.id}`, { decision: "approve" })).status).toBe(404);
    expect((await callPerson(p, cookies.robert, "POST", `/api/approvals/joins/${joining.body.request.id}`, { decision: "approve" })).status).toBe(200);
    expect(p.workspaces.hasPerson(launch.id, robert.id)).toBe(true);
  });

  test("taking a person out and deleting a Portico wait for the person too", async () => {
    const { p, chris, robert, muse, rmuse, launch, cookies } = await world();
    p.workspaces.admit(launch.id, robert.id);
    p.workspaces.addAgent(robert.id, launch.id, rmuse.agent.id);
    const out = await tool(p, muse.token, "remove_from_portico", { portico: "Launch", person: "robert" });
    expect(out.body).toMatchObject({ status: "waiting_for_person", request: { kind: "remove_person", person: "robert" } });
    expect(out.body.show).toStartWith("Waiting for Chris: taking Robert out of the Launch Portico happens only once Chris confirms at ");
    expect(p.workspaces.hasPerson(launch.id, robert.id)).toBe(true);
    // Only the owner deletes, and a person's own Portico is never deleted.
    expect(await tool(p, rmuse.token, "delete_portico", { portico: "Launch" })).toMatchObject({ status: 403, body: { message: "Only the owner of the Launch Portico can delete it." } });
    expect((await tool(p, muse.token, "delete_portico", { portico: "Chris's Portico" })).status).toBe(403);
    const gone = await tool(p, muse.token, "delete_portico", { portico: "Launch" });
    expect(gone.body).toMatchObject({ status: "waiting_for_person", portico: { name: "Launch" }, request: { kind: "delete" } });
    expect(gone.body.show).toStartWith("Waiting for Chris: deleting the Launch Portico happens only once Chris confirms at ");
    expect(p.workspaces.get(launch.id)).not.toBeNull();
    expect((await callPerson(p, cookies.chris, "POST", `/api/approvals/asks/${gone.body.request.id}`, { decision: "approve" })).status).toBe(200);
    expect(p.workspaces.get(launch.id)).toBeNull();
    expect(p.workspaces.forPerson(chris.id).map((w) => w.name)).toEqual(["Chris's Portico"]);
  });

  test("the tools are offered over MCP, with copy that follows the rules", async () => {
    const { p, muse } = await world();
    const listed = (await mcp(p, muse.token, "tools/list")).tools.map((t: { name: string }) => t.name);
    expect(listed.slice(-8)).toEqual(["list_porticos", "create_portico", "add_to_portico", "remove_from_portico", "rename_portico", "delete_portico", "share_portico", "join_portico"]);
    const called = await mcp(p, muse.token, "tools/call", { name: "list_porticos", arguments: {} });
    expect(JSON.parse(called.content[0].text).porticos).toHaveLength(2);
    expect(copyProblems(JSON.stringify(porticoTools()))).toEqual([]);
  });
});

describe("workspaces for a signed-in person", () => {
  test("a person lists, makes, renames and deletes workspaces, and puts only their own agents in", async () => {
    const { p, muse, grok, rmuse, launch, cookies } = await world();
    const list = (await (await callPerson(p, cookies.chris, "GET", "/api/porticos")).json()) as { workspaces: { name: string; kind: string; agentIds: string[] }[] };
    expect(list.workspaces.map((w) => [w.name, w.kind])).toEqual([["Your Portico", "personal"], ["Launch", "shared"]]);
    const made = await callPerson(p, cookies.chris, "POST", "/api/porticos", { name: "Design", agentIds: [grok.agent.id] });
    expect(made.status).toBe(201);
    const design = ((await made.json()) as { workspace: { id: string; agentIds: string[] } }).workspace;
    expect(design.agentIds).toEqual([grok.agent.id]);
    // Someone else's agent can't be put in, and the whole request leaves nothing behind.
    expect((await callPerson(p, cookies.chris, "POST", "/api/porticos", { name: "Sneaky", agentIds: [rmuse.agent.id] })).status).toBe(403);
    expect(p.workspaces.forPerson(p.people.byHandle("chris")!.id).map((w) => w.name)).not.toContain("Sneaky");
    expect((await callPerson(p, cookies.chris, "PUT", `/api/porticos/${design.id}/agents/${muse.agent.id}`)).status).toBe(204);
    expect((await callPerson(p, cookies.chris, "DELETE", `/api/porticos/${design.id}/agents/${muse.agent.id}`)).status).toBe(204);
    expect((await callPerson(p, cookies.chris, "PATCH", `/api/porticos/${design.id}`, { name: "Studio" })).status).toBe(200);
    expect((await callPerson(p, cookies.chris, "DELETE", `/api/porticos/${design.id}`)).status).toBe(204);
    void launch;
  });

  test("a workspace the person isn't in answers like one that isn't there, on every route", async () => {
    const { p, rmuse, launch, cookies } = await world();
    const share = p.shares.create(p.people.byHandle("chris")!.id, launch.id).share;
    const tries: [string, string, unknown?][] = [
      ["GET", `/api/porticos/${launch.id}`],
      ["PATCH", `/api/porticos/${launch.id}`, { name: "Mine now" }],
      ["DELETE", `/api/porticos/${launch.id}`],
      ["PUT", `/api/porticos/${launch.id}/agents/${rmuse.agent.id}`],
      ["DELETE", `/api/porticos/${launch.id}/agents/${rmuse.agent.id}`],
      ["DELETE", `/api/porticos/${launch.id}/people/${p.people.byHandle("chris")!.id}`],
      ["POST", `/api/porticos/${launch.id}/shares`, {}],
      ["DELETE", `/api/shares/${share.id}`],
    ];
    for (const [method, path, body] of tries) {
      expect(`${method} ${path}: ${(await callPerson(p, cookies.robert, method, path, body)).status}`).toBe(`${method} ${path}: 404`);
      expect((await callPerson(p, null, method, path, body)).status).toBe(401);
    }
    expect(p.workspaces.get(launch.id)!.name).toBe("Launch");
    expect(p.shares.isOpen(p.shares.get(share.id)!)).toBe(true);
    expect((await p.app.request(`/p/${launch.id}`, { headers: { cookie: cookies.robert } })).headers.get("location")).toBe("/");
  });

  test("sharing from a page makes a link the maker can copy again; an emailed one says email is off until mail is set up", async () => {
    const { p, launch, cookies } = await world();
    const made = (await (await callPerson(p, cookies.chris, "POST", `/api/porticos/${launch.id}/shares`, {})).json()) as { share: { id: string; link: string; email: null } };
    expect(made.share.link).toMatch(/^https:\/\/portico\.example\.com\/share#/);
    const mailed = (await (await callPerson(p, cookies.chris, "POST", `/api/porticos/${launch.id}/shares`, { email: "robert@example.com" })).json()) as { share: { mail: string; email: string } };
    expect(mailed.share).toMatchObject({ email: "robert@example.com", mail: "off" });
    expect((await callPerson(p, cookies.chris, "POST", `/api/porticos/${launch.id}/shares`, { email: "not an address" })).status).toBe(400);
    const page = (await (await callPerson(p, cookies.chris, "GET", `/api/porticos/${launch.id}`)).json()) as { shares: { link: string }[] };
    expect(page.shares).toHaveLength(2);
    expect(page.shares[0]!.link).toBe(made.share.link);
  });

  test("the handle changes in the account, and the old one stays held back", async () => {
    const { p, chris, cookies } = await world();
    expect((await callPerson(p, cookies.chris, "PATCH", "/api/me", { handle: "robert" })).status).toBe(409);
    const changed = (await (await callPerson(p, cookies.chris, "PATCH", "/api/me", { handle: "Chris-I" })).json()) as { person: { handle: string } };
    expect(changed.person.handle).toBe("chris-i");
    expect((await callPerson(p, cookies.robert, "PATCH", "/api/me", { handle: "chris" })).status).toBe(409);
    expect(p.people.get(chris.id)!.handle).toBe("chris-i");
  });

  test("the pages follow the copy rules", async () => {
    const { p, chris, muse, rmuse, launch, cookies } = await world();
    p.shares.ask(muse.agent, "share", launch.id, { email: "robert@example.com" });
    p.shares.create(chris.id, launch.id);
    const personal = p.workspaces.personal(chris.id);
    for (const path of ["/", `/p/${launch.id}`, `/p/${personal.id}`, "/agents", "/share", "/settings"]) {
      const res = await p.app.request(path, { headers: { cookie: cookies.chris } });
      expect(`${path}: ${res.status}`).toBe(`${path}: 200`);
      expect(`${path}: ${copyProblems(visibleCopy(await res.text())).join("; ")}`).toBe(`${path}: `);
    }
    const { request } = p.shares.requestForNewAgent(p.shares.create(chris.id, launch.id).secret, { name: "helper" });
    const confirm = await (await p.app.request(`/share/confirm/${request.id}`, { headers: { cookie: cookies.robert } })).text();
    expect(copyProblems(visibleCopy(confirm))).toEqual([]);
    p.shares.requestForAgent(rmuse.agent, p.shares.create(chris.id, launch.id).secret);
    expect(copyProblems(visibleCopy(await (await p.app.request("/", { headers: { cookie: cookies.robert } })).text()))).toEqual([]);
  });
});
