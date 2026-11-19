import { describe, expect, test } from "bun:test";
import { workspaceTools } from "../src/agent-api/workspace-tools";
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
    expect(page).toContain("Let helper into Launch");
    expect(page).not.toContain(made.code);
    expect((await p.app.request(`/share/confirm/${made.id}`)).headers.get("location")).toContain("/sign-in");

    const wrong = await callPerson(p, cookies.robert, "POST", `/api/approvals/joins/${made.id}`, { decision: "approve", code: made.code === "0000" ? "0001" : "0000" });
    expect(wrong.status).toBe(400);
    expect(p.agents.ownedBy(robert.id)).toHaveLength(2);
    const right = await callPerson(p, cookies.robert, "POST", `/api/approvals/joins/${made.id}`, { decision: "approve", code: made.code, name: "helper" });
    expect(right.status).toBe(200);
    expect(((await right.json()) as { next: string }).next).toBe(`/w/${launch.id}`);

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
      expect((await callPerson(p, cookies.robert, "PUT", `/api/workspaces/${id}/agents/${rmuse.agent.id}`)).status).toBe(404);
      expect((await callPerson(p, cookies.robert, "DELETE", `/api/workspaces/${id}/people/${chris.id}`)).status).toBe(404);
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

describe("the workspace tools", () => {
  const tool = async (p: TestPortico, token: string, name: string, args: unknown = {}) => {
    const res = await callAs(p, { token }, "POST", `/api/agent/workspace-tools/${name}`, args);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const mcp = async (p: TestPortico, token: string, method: string, params: unknown = {}) => {
    const res = await callAs(p, { token }, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params });
    return ((await res.json()) as { result: any }).result;
  };

  test("an agent lists, makes and fills workspaces for the person who manages the agent, and nobody else's", async () => {
    const { p, muse, rmuse, launch } = await world();
    const listed = await tool(p, muse.token, "list_workspaces");
    expect(listed.body.handle).toBe("chris");
    expect(listed.body.workspaces.map((w: any) => [w.name, w.kind, w.this_agent_is_in])).toEqual([
      ["Personal", "personal", true],
      ["Launch", "shared", true],
    ]);
    expect((await tool(p, rmuse.token, "list_workspaces")).body.workspaces.map((w: any) => w.name)).toEqual(["Personal"]);

    const made = await tool(p, muse.token, "create_workspace", { name: "Design" });
    expect(made.body.workspace).toMatchObject({ name: "Design", agents: ["muse"], owned_by_this_person: true });
    const filled = await tool(p, muse.token, "set_workspace_agents", { workspace: made.body.workspace.id, add: ["grok-bot"], remove: ["muse"] });
    expect(filled.body.workspace.agents).toEqual(["grok-bot"]);
    // Another person's agent, and another person's workspace, are out of reach.
    expect((await tool(p, muse.token, "set_workspace_agents", { workspace: launch.id, add: ["robert/muse"] })).status).toBe(400);
    expect((await tool(p, rmuse.token, "set_workspace_agents", { workspace: launch.id, add: ["muse"] })).status).toBe(404);
    expect((await tool(p, muse.token, "nope")).status).toBe(404);
  });

  test("sharing through an agent ends with the link in list_workspaces, after the person's yes", async () => {
    const { p, muse, rmuse, robert, launch, cookies } = await world();
    const asked = await tool(p, muse.token, "share_workspace", { workspace: launch.id });
    expect(asked.body.request).toMatchObject({ kind: "share", status: "pending" });
    expect(asked.body.request.link).toBeUndefined();
    const approvals = (await (await callPerson(p, cookies.chris, "GET", "/api/approvals")).json()) as { asks: { id: string; agent: { label: string } }[] };
    expect(approvals.asks.map((a) => a.id)).toEqual([asked.body.request.id]);
    // Someone else's cookie can't answer.
    expect((await callPerson(p, cookies.robert, "POST", `/api/approvals/asks/${asked.body.request.id}`, { decision: "approve" })).status).toBe(404);
    expect((await callPerson(p, cookies.chris, "POST", `/api/approvals/asks/${asked.body.request.id}`, { decision: "approve" })).status).toBe(200);
    const after = await tool(p, muse.token, "list_workspaces");
    const shared = after.body.requests.find((r: any) => r.id === asked.body.request.id);
    expect(shared.status).toBe("approved");
    expect(shared.link).toMatch(/^https:\/\/portico\.example\.com\/share#[A-Za-z0-9_-]+$/);

    const joining = await tool(p, rmuse.token, "join_workspace", { link: shared.link });
    expect(joining.body.request.code).toMatch(/^\d{4}$/);
    expect(joining.body.note).toContain(joining.body.request.code);
    const joins = (await (await callPerson(p, cookies.robert, "GET", "/api/approvals")).json()) as { joins: { id: string; code: string; workspace: { name: string } }[] };
    expect(joins.joins).toMatchObject([{ id: joining.body.request.id, code: joining.body.request.code, workspace: { name: "Launch" } }]);
    expect((await callPerson(p, cookies.chris, "POST", `/api/approvals/joins/${joining.body.request.id}`, { decision: "approve" })).status).toBe(404);
    expect((await callPerson(p, cookies.robert, "POST", `/api/approvals/joins/${joining.body.request.id}`, { decision: "approve" })).status).toBe(200);
    expect(p.workspaces.hasPerson(launch.id, robert.id)).toBe(true);
  });

  test("the tools are offered over MCP, with copy that follows the rules", async () => {
    const { p, muse } = await world();
    const listed = (await mcp(p, muse.token, "tools/list")).tools.map((t: { name: string }) => t.name);
    for (const name of ["list_workspaces", "create_workspace", "set_workspace_agents", "share_workspace", "remove_from_workspace", "join_workspace"]) {
      expect(listed).toContain(name);
    }
    const called = await mcp(p, muse.token, "tools/call", { name: "list_workspaces", arguments: {} });
    expect(JSON.parse(called.content[0].text).workspaces).toHaveLength(2);
    expect(copyProblems(JSON.stringify(workspaceTools()))).toEqual([]);
  });
});

describe("workspaces for a signed-in person", () => {
  test("a person lists, makes, renames and deletes workspaces, and puts only their own agents in", async () => {
    const { p, muse, grok, rmuse, launch, cookies } = await world();
    const list = (await (await callPerson(p, cookies.chris, "GET", "/api/workspaces")).json()) as { workspaces: { name: string; kind: string; agentIds: string[] }[] };
    expect(list.workspaces.map((w) => [w.name, w.kind])).toEqual([["Personal", "personal"], ["Launch", "shared"]]);
    const made = await callPerson(p, cookies.chris, "POST", "/api/workspaces", { name: "Design", agentIds: [grok.agent.id] });
    expect(made.status).toBe(201);
    const design = ((await made.json()) as { workspace: { id: string; agentIds: string[] } }).workspace;
    expect(design.agentIds).toEqual([grok.agent.id]);
    // Someone else's agent can't be put in, and the whole request leaves nothing behind.
    expect((await callPerson(p, cookies.chris, "POST", "/api/workspaces", { name: "Sneaky", agentIds: [rmuse.agent.id] })).status).toBe(403);
    expect(p.workspaces.forPerson(p.people.byHandle("chris")!.id).map((w) => w.name)).not.toContain("Sneaky");
    expect((await callPerson(p, cookies.chris, "PUT", `/api/workspaces/${design.id}/agents/${muse.agent.id}`)).status).toBe(204);
    expect((await callPerson(p, cookies.chris, "DELETE", `/api/workspaces/${design.id}/agents/${muse.agent.id}`)).status).toBe(204);
    expect((await callPerson(p, cookies.chris, "PATCH", `/api/workspaces/${design.id}`, { name: "Studio" })).status).toBe(200);
    expect((await callPerson(p, cookies.chris, "DELETE", `/api/workspaces/${design.id}`)).status).toBe(204);
    void launch;
  });

  test("a workspace the person isn't in answers like one that isn't there, on every route", async () => {
    const { p, rmuse, launch, cookies } = await world();
    const share = p.shares.create(p.people.byHandle("chris")!.id, launch.id).share;
    const tries: [string, string, unknown?][] = [
      ["GET", `/api/workspaces/${launch.id}`],
      ["PATCH", `/api/workspaces/${launch.id}`, { name: "Mine now" }],
      ["DELETE", `/api/workspaces/${launch.id}`],
      ["PUT", `/api/workspaces/${launch.id}/agents/${rmuse.agent.id}`],
      ["DELETE", `/api/workspaces/${launch.id}/agents/${rmuse.agent.id}`],
      ["DELETE", `/api/workspaces/${launch.id}/people/${p.people.byHandle("chris")!.id}`],
      ["POST", `/api/workspaces/${launch.id}/shares`, {}],
      ["DELETE", `/api/shares/${share.id}`],
    ];
    for (const [method, path, body] of tries) {
      expect(`${method} ${path}: ${(await callPerson(p, cookies.robert, method, path, body)).status}`).toBe(`${method} ${path}: 404`);
      expect((await callPerson(p, null, method, path, body)).status).toBe(401);
    }
    expect(p.workspaces.get(launch.id)!.name).toBe("Launch");
    expect(p.shares.isOpen(p.shares.get(share.id)!)).toBe(true);
    expect((await p.app.request(`/w/${launch.id}`, { headers: { cookie: cookies.robert } })).headers.get("location")).toBe("/");
  });

  test("sharing from a page makes a link the maker can copy again; an emailed one says email is off until mail is set up", async () => {
    const { p, launch, cookies } = await world();
    const made = (await (await callPerson(p, cookies.chris, "POST", `/api/workspaces/${launch.id}/shares`, {})).json()) as { share: { id: string; link: string; email: null } };
    expect(made.share.link).toMatch(/^https:\/\/portico\.example\.com\/share#/);
    const mailed = (await (await callPerson(p, cookies.chris, "POST", `/api/workspaces/${launch.id}/shares`, { email: "robert@example.com" })).json()) as { share: { mail: string; email: string } };
    expect(mailed.share).toMatchObject({ email: "robert@example.com", mail: "off" });
    expect((await callPerson(p, cookies.chris, "POST", `/api/workspaces/${launch.id}/shares`, { email: "not an address" })).status).toBe(400);
    const page = (await (await callPerson(p, cookies.chris, "GET", `/api/workspaces/${launch.id}`)).json()) as { shares: { link: string }[] };
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
    for (const path of ["/", `/w/${launch.id}`, `/w/${personal.id}`, "/agents", "/share", "/settings"]) {
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
