import { describe, expect, test } from "bun:test";
import {
  addAppAgent,
  addComputer,
  addMember,
  addOwner,
  addSession,
  callPerson,
  flush,
  makePortico,
  PUBLIC_URL,
  signIn,
  sseReader,
} from "./helpers";

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const maya = await addMember(p);
  const owner = signIn(p, chris);
  const member = signIn(p, maya);
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" }).agent;
  const muse = addAppAgent(p, chris, "muse", { approvalRequired: true }).agent;
  const mayaDot = addAppAgent(p, maya, "maya-dot", { kind: "dots" }).agent;
  return { p, chris, maya, owner, member, grok, muse, mayaDot };
}

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

describe("conventions", () => {
  test("before setup, every route but /api/setup answers setup_required", async () => {
    const p = makePortico({ setup: false });
    const res = await callPerson(p, null, "GET", "/api/me");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "setup_required" });
    expect((await callPerson(p, null, "POST", "/api/setup", {})).status).not.toBe(503);
  });

  test("signed out is 401; a changed request from another site is 403", async () => {
    const { p, owner } = await setup();
    expect((await callPerson(p, null, "GET", "/api/agents")).status).toBe(401);
    const res = await p.app.request(`${PUBLIC_URL}/api/agents/x`, {
      method: "DELETE",
      headers: { cookie: owner, origin: "https://evil.example", host: "portico.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("a claim waiting for approval reads only /api/me", async () => {
    const p = makePortico();
    await addOwner(p);
    const priya = await addMember(p, "Priya", "pending");
    const cookie = signIn(p, priya);
    expect(await json(callPerson(p, cookie, "GET", "/api/me"))).toMatchObject({ person: { name: "Priya", status: "pending" } });
    expect((await callPerson(p, cookie, "GET", "/api/agents")).status).toBe(403);
  });

  test("unknown routes are JSON 404s", async () => {
    const { p, owner } = await setup();
    const res = await callPerson(p, owner, "GET", "/api/nothing");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});

describe("agents", () => {
  test("everyone sees every agent, the signed-in person's first, with what each may change", async () => {
    const { p, member } = await setup();
    const { agents } = await json<{ agents: { name: string; mine: boolean; owner: { name: string } }[] }>(
      callPerson(p, member, "GET", "/api/agents"),
    );
    expect(agents.map((a) => [a.name, a.mine, a.owner.name])).toEqual([
      ["maya-dot", true, "Maya"],
      ["grok", false, "Chris"],
      ["muse", false, "Chris"],
    ]);
  });

  test("edits go live; a name in use is 409; another person's agent is 403 and has no allow list", async () => {
    const { p, owner, member, muse, mayaDot } = await setup();
    const res = await callPerson(p, owner, "PATCH", `/api/agents/${muse.id}`, { name: "muse-work", description: "Calendar" });
    expect(await res.json()).toMatchObject({ agent: { name: "muse-work", description: "Calendar" } });
    expect((await callPerson(p, owner, "PATCH", `/api/agents/${muse.id}`, { name: "grok" })).status).toBe(409);
    expect((await callPerson(p, owner, "PATCH", `/api/agents/${mayaDot.id}`, { approvalRequired: true })).status).toBe(403);
    expect(await json(callPerson(p, member, "GET", `/api/agents/${muse.id}`))).toMatchObject({ allowList: null });
  });

  test("a session's folder switch is part of the agent", async () => {
    const { p, chris, owner } = await setup();
    const { agent } = addSession(p, addComputer(p, chris).computer);
    const res = await callPerson(p, owner, "PATCH", `/api/agents/${agent.id}`, { joinFromFolder: false });
    expect(await res.json()).toMatchObject({ agent: { joinFromFolder: false, computer: { name: "macbook" } } });
  });

  test("remove, and remove a sender from the Always allow list", async () => {
    const { p, chris, owner, grok, muse } = await setup();
    const held = p.messages.send(grok, { to: "muse", subject: "s", text: "t" }).message;
    p.approvals.decide(chris.id, held.id, "always_allow");
    const detail = await json<{ allowList: { sender: { display: string } }[] }>(callPerson(p, owner, "GET", `/api/agents/${muse.id}`));
    expect(detail.allowList.map((e) => e.sender.display)).toEqual(["grok"]);
    expect((await callPerson(p, owner, "DELETE", `/api/agents/${muse.id}/allow/${grok.id}`)).status).toBe(204);
    expect((await callPerson(p, owner, "DELETE", `/api/agents/${grok.id}`)).status).toBe(204);
    expect(p.agents.get(grok.id)).toBeNull();
  });
});

describe("approvals", () => {
  test("held cards carry the facts, and a decision delivers", async () => {
    const { p, owner, member, grok } = await setup();
    const held = p.messages.send(grok, { to: "muse", subject: "Add the doc link", text: "docs/billing-v2.md" }).message;
    const list = await json<{ held: { id: string; subject: string; from: { display: string }; facts: { managedBy: { name: string } } }[]; signIns: unknown[] }>(
      callPerson(p, owner, "GET", "/api/approvals"),
    );
    expect(list.held).toHaveLength(1);
    expect(list.held[0]).toMatchObject({ subject: "Add the doc link", from: { display: "grok" }, facts: { managedBy: { name: "Chris" } } });
    expect(list.signIns).toEqual([]);
    expect(await json(callPerson(p, member, "GET", "/api/approvals"))).toMatchObject({ held: [] });
    expect((await callPerson(p, member, "POST", `/api/approvals/held/${held.id}`, { decision: "allow_once" })).status).toBe(403);
    const decided = await callPerson(p, owner, "POST", `/api/approvals/held/${held.id}`, { decision: "allow_once" });
    expect(await decided.json()).toMatchObject({ message: { status: "pending", decision: "allow_once", decidedBy: { name: "Chris" } } });
  });
});

describe("held card quote", () => {
  test("quotes reply_to, or else the recipient's message just before", async () => {
    const { p, chris, owner, grok, muse } = await setup();
    const first = p.messages.send(grok, { to: "muse", subject: "Find a time", text: "With Sam" }).message;
    p.approvals.decide(chris.id, first.id, "allow_once");
    p.messages.send(muse, { to: "grok", subject: "Thursday", text: "Thursday 2pm works" });
    p.messages.send(grok, { to: "muse", subject: "Add the link", text: "docs/billing-v2.md" });
    const { held } = await json<{ held: { replyTo: { text: string } | null }[] }>(callPerson(p, owner, "GET", "/api/approvals"));
    expect(held[0]!.replyTo?.text).toBe("Thursday 2pm works");
  });
});

describe("threads", () => {
  test("the owner sees every thread; a member sees threads with the member's agents; others are 404", async () => {
    const { p, owner, member, grok, mayaDot } = await setup();
    const ours = p.messages.send(grok, { to: "maya-dot", subject: "Churn", text: "Last quarter?" }).message;
    const private_ = p.messages.send(grok, { to: "muse", subject: "Flights", text: "Denver" }).message;
    const all = await json<{ threads: { id: string }[] }>(callPerson(p, owner, "GET", "/api/threads"));
    expect(all.threads).toHaveLength(2);
    const mine = await json<{ threads: { id: string; last: { subject: string } }[] }>(callPerson(p, member, "GET", "/api/threads"));
    expect(mine.threads.map((t) => t.last.subject)).toEqual(["Churn"]);
    expect((await callPerson(p, member, "GET", `/api/threads/${private_.threadId}`)).status).toBe(404);
    const thread = await json<{ messages: { subject: string; text: string }[] }>(callPerson(p, member, "GET", `/api/threads/${ours.threadId}`));
    expect(thread.messages.map((m) => m.text)).toEqual(["Last quarter?"]);
    expect(mayaDot.id).toBeDefined();
  });

  test("filter by agent", async () => {
    const { p, owner, grok, muse } = await setup();
    p.messages.send(grok, { to: "maya-dot", subject: "s", text: "t" });
    const { threads } = await json<{ threads: unknown[] }>(callPerson(p, owner, "GET", `/api/threads?agent=${muse.id}`));
    expect(threads).toEqual([]);
  });
});

describe("live updates", () => {
  test("a signed-in page hears topics, never data", async () => {
    const { p, owner, grok } = await setup();
    const res = await callPerson(p, owner, "GET", "/api/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = sseReader(res);
    expect((await events.next()).event).toBe("hello");
    p.messages.send(grok, { to: "muse", subject: "s", text: "t" });
    await flush();
    expect(await events.next()).toEqual({ event: "changed", data: { topics: ["approvals", "threads"] } });
    await events.cancel();
  });
});
