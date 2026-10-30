import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { LIMITS } from "../src/core/limits";
import { s256 } from "../src/oauth/store";
import {
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
  MINUTE,
  makePortico,
  PUBLIC_URL,
  signIn,
} from "./helpers";

type P = ReturnType<typeof makePortico>;
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const WINDOW = LIMITS.historyDays * DAY;

/** Owner Chris with an approval-protected app that sends by name, and member Maya with an app of her own. */
async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const maya = await addMember(p);
  const desk = addAppAgent(p, chris, "chris-desk", { approvalRequired: true });
  const mayaBot = addAppAgent(p, maya, "maya-bot");
  return { p, chris, maya, desk, mayaBot, owner: signIn(p, chris), member: signIn(p, maya) };
}

function send(p: P, from: { token: string }, to: string) {
  return callAs(p, from, "POST", "/api/agent/messages", { to, subject: "Q3 numbers", text: "Draft Q3 figures." });
}

async function joinComputer(p: P, cookie: string, proposed: string): Promise<string> {
  const { joinLine } = await json<{ joinLine: { line: string } }>(callPerson(p, cookie, "POST", "/api/join-lines", { kind: "claude-code" }));
  const res = await p.app.request("/api/computer/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: joinLine.line.split("#")[1], computer: proposed }),
  });
  expect(res.status).toBe(201);
  return (await json<{ computer: { name: string } }>(res)).computer.name;
}

describe("a released agent name stays with its person for the history window", () => {
  test("after an app is removed, another person's create, rename and sign-in get 409, and sends by the name fail", async () => {
    const { p, chris, maya, desk, mayaBot, owner, member } = await setup();
    const reports = addAppAgent(p, chris, "reports").agent;
    expect((await callPerson(p, owner, "DELETE", `/api/agents/${reports.id}`)).status).toBe(204);

    const renamed = await callPerson(p, member, "PATCH", `/api/agents/${mayaBot.agent.id}`, { name: "reports" });
    expect(renamed.status).toBe(409);
    const body = await json<{ error: string; message: string }>(renamed);
    expect(copyProblems(body.message)).toEqual([]);
    expect(body).toMatchObject({ error: "conflict", message: expect.stringContaining("reserved for 30 days") });
    expect(errorCode(() => p.agents.create({ ownerId: maya.id, name: "reports", kind: "muse", type: "app" }))).toBe("conflict");

    const { joinLine } = await json<{ joinLine: { id: string; line: string } }>(
      callPerson(p, member, "POST", "/api/join-lines", { kind: "muse" }),
    );
    const asked = await json<{ id: string }>(
      p.app.request("/api/sign-in-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: joinLine.line.split("#")[1], name: "reports" }),
      }),
    );
    expect((await callPerson(p, member, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "approve" })).status).toBe(409);
    expect(p.computers.signInRequest(asked.id)?.status).toBe("pending");

    // With no one holding the name, a stale sender is told, instead of reaching another person's agent.
    const sent = await send(p, desk, "reports");
    expect(sent.status).toBe(400);
    expect(await sent.json()).toMatchObject({ error: "unknown_agent" });

    // The person who had the name takes it back.
    expect(p.agents.create({ ownerId: chris.id, name: "reports", kind: "muse", type: "app" }).ownerId).toBe(chris.id);
  });

  test("a rename releases the old name: another person can't take it, the person who had it can", async () => {
    const { p, chris, mayaBot, owner, member } = await setup();
    const reports = addAppAgent(p, chris, "reports").agent;
    expect((await callPerson(p, owner, "PATCH", `/api/agents/${reports.id}`, { name: "reports-v2" })).status).toBe(200);
    expect((await callPerson(p, member, "PATCH", `/api/agents/${mayaBot.agent.id}`, { name: "reports" })).status).toBe(409);
    expect((await callPerson(p, owner, "PATCH", `/api/agents/${reports.id}`, { name: "reports" })).status).toBe(200);
  });

  test("the name is free to anyone once the history window has passed", async () => {
    const { p, chris, maya, mayaBot } = await setup();
    const reports = addAppAgent(p, chris, "reports").agent;
    p.agents.remove(chris.id, reports.id);
    p.clock.advance(WINDOW - MINUTE);
    expect(errorCode(() => p.agents.update(maya.id, mayaBot.agent.id, { name: "reports" }))).toBe("conflict");
    p.clock.advance(2 * MINUTE);
    expect(p.agents.update(maya.id, mayaBot.agent.id, { name: "reports" }).name).toBe("reports");
  });

  test("one person letting a name go doesn't clear another person's hold on it", async () => {
    const { p, chris, maya, mayaBot } = await setup();
    const chrisSession = addSession(p, addComputer(p, chris, "chris-mbp").computer, { repo: "portico" }).agent;
    const mayaSession = addSession(p, addComputer(p, maya, "maya-mbp").computer, { repo: "portico" }).agent;
    p.agents.remove(chris.id, chrisSession.id);
    p.agents.update(maya.id, mayaSession.id, { name: "web-claude" });
    expect(errorCode(() => p.agents.update(maya.id, mayaSession.id, { name: "portico-claude" }))).toBe("conflict");
    expect(errorCode(() => p.agents.update(maya.id, mayaBot.agent.id, { name: "portico-claude" }))).toBe("conflict");
  });

  test("removing a member releases every agent and computer name the member had", async () => {
    const { p, chris, maya, owner } = await setup();
    addComputer(p, maya, "maya-mbp");
    expect((await callPerson(p, owner, "DELETE", `/api/people/${maya.id}`)).status).toBe(204);
    expect(errorCode(() => p.agents.create({ ownerId: chris.id, name: "maya-bot", kind: "muse", type: "app" }))).toBe("conflict");
    expect(await joinComputer(p, owner, "maya-mbp")).toBe("maya-mbp-2");
  });

  test("a connector's name stays with its person: OAuth consent suggests and accepts it only for that person", async () => {
    const { p, chris, owner, member } = await setup();
    const duet = p.agents.create({ ownerId: chris.id, name: "claude-duet", kind: "claude-duet", type: "connector" });
    p.agents.remove(chris.id, duet.id);

    const registered = await p.app.request(`${PUBLIC_URL}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Duet", redirect_uris: ["http://localhost:4567/callback"], token_endpoint_auth_method: "none" }),
    });
    const clientId = (await json<{ client_id: string }>(registered)).client_id;
    const challenge = s256(randomBytes(32).toString("base64url"));
    const request = {
      client_id: clientId,
      redirect_uri: "http://localhost:4567/callback",
      state: "s",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${PUBLIC_URL}/mcp`,
    };
    const consentPage = async (cookie: string) =>
      (await p.app.request(`${PUBLIC_URL}/oauth/authorize?${new URLSearchParams({ ...request, response_type: "code" })}`, { headers: { cookie } })).text();
    const consent = (cookie: string, name: string) =>
      p.app.request(`${PUBLIC_URL}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: PUBLIC_URL, host: "portico.example.com", cookie },
        body: JSON.stringify({ ...request, name, kind: "claude-duet" }),
      });

    expect(await consentPage(member)).toContain('value="claude-duet-2" aria-describedby');
    expect((await consent(member, "claude-duet")).status).toBe(409);
    expect(await consentPage(owner)).toContain('value="claude-duet" aria-describedby');
    expect((await consent(owner, "claude-duet")).status).toBe(200);
  });
});

describe("a session can't hold a bare name another person's agent goes by", () => {
  test("renaming a session to another person's live app or session name is 409, so nothing waits to capture it", async () => {
    const { p, chris, maya, desk, member } = await setup();
    const reports = addAppAgent(p, chris, "reports").agent;
    addSession(p, addComputer(p, chris, "chris-mbp").computer, { repo: "portico" });
    const mayaSession = addSession(p, addComputer(p, maya, "maya-mbp").computer, { repo: "web" }).agent;
    expect((await callPerson(p, member, "PATCH", `/api/agents/${mayaSession.id}`, { name: "reports" })).status).toBe(409);
    expect((await callPerson(p, member, "PATCH", `/api/agents/${mayaSession.id}`, { name: "portico-claude" })).status).toBe(409);

    // The app moving to a new name doesn't hand the old one to the session either.
    p.agents.update(chris.id, reports.id, { name: "reports-v2" });
    expect((await callPerson(p, member, "PATCH", `/api/agents/${mayaSession.id}`, { name: "reports" })).status).toBe(409);
    expect((await send(p, desk, "reports")).status).toBe(400);
    expect(p.agents.update(chris.id, reports.id, { name: "reports" }).name).toBe("reports");
  });

  test("a released short name another person's session goes by needs the full address for the window", async () => {
    const { p, chris, maya, desk, owner } = await setup();
    const chrisMbp = addComputer(p, chris, "chris-mbp").computer;
    addSession(p, chrisMbp, { repo: "portico" });
    expect((await callPerson(p, owner, "DELETE", `/api/computers/${chrisMbp.id}`)).status).toBe(204);
    const mayaSession = addSession(p, addComputer(p, maya, "maya-mbp").computer, { repo: "portico" }).agent;
    expect(mayaSession.name).toBe("portico-claude");

    const sent = await send(p, desk, "portico-claude");
    expect(sent.status).toBe(400);
    const body = await json<{ error: string; message: string }>(sent);
    expect(copyProblems(body.message)).toEqual([]);
    expect(body).toMatchObject({ error: "unknown_agent", message: expect.stringContaining("portico-claude@maya-mbp") });
    expect(p.agents.display(mayaSession)).toBe("portico-claude@maya-mbp");
    expect((await send(p, desk, "portico-claude@maya-mbp")).status).toBe(201);

    p.clock.advance(WINDOW + MINUTE);
    expect(p.agents.resolve("portico-claude", desk.agent.id).id).toBe(mayaSession.id);
    expect(p.agents.display(mayaSession)).toBe("portico-claude");
  });

  test("a session's rename releases its old short name the same way", async () => {
    const { p, chris, maya, desk } = await setup();
    const chrisMbp = addComputer(p, chris, "chris-mbp").computer;
    const chrisWeb = addSession(p, chrisMbp, { repo: "web" }).agent;
    p.agents.update(chris.id, chrisWeb.id, { name: "site-claude" });
    const mayaMbp = addComputer(p, maya, "maya-mbp").computer;
    const mayaApi = addSession(p, mayaMbp, { repo: "api" }).agent;
    expect(errorCode(() => p.agents.update(maya.id, mayaApi.id, { name: "web-claude" }))).toBe("conflict");
    const mayaWeb = addSession(p, mayaMbp, { repo: "web" }).agent;
    expect(mayaWeb.name).toBe("web-claude");
    expect(errorCode(() => p.agents.resolve("web-claude", desk.agent.id))).toBe("unknown_agent");
    expect(p.agents.resolve("web-claude@maya-mbp", desk.agent.id).id).toBe(mayaWeb.id);

    // The person who had a name takes it back, and the bare name reaches that person's session as before.
    const chrisDocs = addSession(p, chrisMbp, { repo: "docs" }).agent;
    p.agents.update(chris.id, chrisDocs.id, { name: "manual-claude" });
    p.agents.update(chris.id, chrisDocs.id, { name: "docs-claude" });
    expect(p.agents.resolve("docs-claude", desk.agent.id).id).toBe(chrisDocs.id);
  });
});

describe("a released computer name stays with its person for the history window", () => {
  test("another person's join proposing the name gets -2; the person who had it gets it back", async () => {
    const { p, chris, owner, member } = await setup();
    const chrisMbp = addComputer(p, chris, "chris-mbp").computer;
    expect((await callPerson(p, owner, "DELETE", `/api/computers/${chrisMbp.id}`)).status).toBe(204);
    expect(await joinComputer(p, member, "chris-mbp")).toBe("chris-mbp-2");
    expect(await joinComputer(p, owner, "chris-mbp")).toBe("chris-mbp");
  });

  test("portico leave releases the name too, and the window ends the hold", async () => {
    const { p, chris, maya, member } = await setup();
    const { token } = addComputer(p, chris, "studio");
    expect((await callAs(p, { token }, "DELETE", "/api/computer")).status).toBe(204);
    expect(await joinComputer(p, member, "studio")).toBe("studio-2");
    p.clock.advance(WINDOW + MINUTE);
    expect(await joinComputer(p, signIn(p, maya), "studio")).toBe("studio");
  });
});
