import { describe, expect, test } from "bun:test";
import type { Topic } from "../src/core/changes";
import {
  addAppAgent,
  addMember,
  addOwner,
  callAs,
  callPerson,
  copyProblems,
  flush,
  makePortico,
  MINUTE,
  PUBLIC_URL,
  signIn,
} from "./helpers";

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

interface Asked {
  id: string;
  code: string;
  poll_secret: string;
  expires_at: string;
}

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const maya = await addMember(p);
  return { p, chris, maya, owner: signIn(p, chris), member: signIn(p, maya) };
}

async function makeLine(p: ReturnType<typeof makePortico>, cookie: string, kind = "muse") {
  const { joinLine } = await json<{ joinLine: { id: string; line: string } }>(callPerson(p, cookie, "POST", "/api/join-lines", { kind }));
  return { id: joinLine.id, secret: joinLine.line.split("#")[1]!, line: joinLine.line };
}

function ask(p: ReturnType<typeof makePortico>, body: unknown) {
  return p.app.request("/api/sign-in-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function poll(p: ReturnType<typeof makePortico>, id: string, secret: string) {
  return p.app.request(`/api/sign-in-requests/${id}`, { headers: { authorization: `Bearer ${secret}` } });
}

describe("asking to join", () => {
  test("a 4-digit code, a poll secret and 10 minutes; asking uses up the line", async () => {
    const { p, owner } = await setup();
    const line = await makeLine(p, owner);
    const res = await ask(p, { token: line.secret, name: "muse-work" });
    expect(res.status).toBe(201);
    const asked = (await res.json()) as Asked;
    expect(asked.code).toMatch(/^\d{4}$/);
    expect(asked.poll_secret).toStartWith("ps_");
    expect(Date.parse(asked.expires_at) - p.now().getTime()).toBe(10 * MINUTE);
    expect(p.computers.joinLine(line.id)?.usedAt).not.toBeNull();
    expect(await json(ask(p, { token: line.secret, name: "muse-other" }))).toMatchObject({ error: "wrong_status" });
  });

  test("the name is checked, computer lines are refused, and the whole line works as the token", async () => {
    const { p, owner } = await setup();
    const line = await makeLine(p, owner);
    expect((await ask(p, { token: line.secret, name: "Muse Work!" })).status).toBe(400);
    const computerLine = await makeLine(p, owner, "claude-code");
    const refused = await ask(p, { token: computerLine.secret, name: "muse" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toContain("Claude Code");
    expect(p.computers.joinLine(computerLine.id)?.usedAt).toBeNull();
    expect((await ask(p, { token: line.line, name: "muse-work" })).status).toBe(201);
  });

  test("a line for any other app takes the agent's kind; a named kind's line keeps its own", async () => {
    const { p, owner } = await setup();
    const other = await makeLine(p, owner, "other");
    const fromOther = await json<Asked>(ask(p, { token: other.secret, name: "grok-home", kind: "grok-bot" }));
    expect(p.computers.signInRequest(fromOther.id)?.kind).toBe("grok-bot");
    const muse = await makeLine(p, owner, "muse");
    const fromMuse = await json<Asked>(ask(p, { token: muse.secret, name: "muse-work", kind: "grok-bot" }));
    expect(p.computers.signInRequest(fromMuse.id)?.kind).toBe("muse");
  });

  test("dots and Claude Duet ask to join from a chat like Muse, and join as apps of their own kind", async () => {
    const { p, owner } = await setup();
    for (const [kind, name] of [["dots", "alfred-dot"], ["claude-duet", "duet-home"]] as const) {
      const line = await makeLine(p, owner, kind);
      const asked = await json<Asked>(ask(p, { token: line.secret, name, kind: "muse" }));
      expect(p.computers.signInRequest(asked.id)?.kind).toBe(kind);
      const decided = await json<{ agent: { name: string; kind: string; type: string } }>(
        callPerson(p, owner, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "approve" }),
      );
      expect(decided.agent).toMatchObject({ name, kind, type: "app" });
    }
  });

  test("a Codex line is for a computer: asking to sign in with it is refused, and the line stays usable", async () => {
    const { p, owner } = await setup();
    const line = await makeLine(p, owner, "codex");
    const res = await ask(p, { token: line.secret, name: "codex-laptop" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe(
      "This join line is for Codex on a computer. Follow the Codex steps at /join.",
    );
    expect(p.computers.joinLine(line.id)?.usedAt).toBeNull();
  });
});

describe("approving and polling", () => {
  test("the line's maker sees the request, approves with a name, and the first poll alone gets the token", async () => {
    const { p, chris, owner, member } = await setup();
    const topics: Topic[][] = [];
    p.changes.on((batch) => topics.push(batch));
    const line = await makeLine(p, owner);
    const asked = await json<Asked>(ask(p, { token: line.secret, name: "muse-work" }));
    await flush();
    expect(topics.flat()).toContain("approvals");

    const approvals = await json<{ signIns: { id: string; kind: string; name: string; code: string; status: string }[] }>(
      callPerson(p, owner, "GET", "/api/approvals"),
    );
    expect(approvals.signIns).toEqual([
      expect.objectContaining({ id: asked.id, kind: "muse", name: "muse-work", code: asked.code, status: "pending" }),
    ]);
    expect(await json(callPerson(p, member, "GET", "/api/approvals"))).toMatchObject({ signIns: [] });
    expect(await json(poll(p, asked.id, asked.poll_secret))).toEqual({ status: "pending" });

    expect((await callPerson(p, member, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "approve" })).status).toBe(403);
    const decided = await json<{ signIn: { status: string }; agent: { name: string; kind: string; type: string; mine: boolean } }>(
      callPerson(p, owner, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "approve", name: "muse-chris" }),
    );
    expect(decided.signIn.status).toBe("approved");
    expect(decided.agent).toMatchObject({ name: "muse-chris", kind: "muse", type: "app", mine: true });
    expect(p.agents.byAddress("muse-chris")?.ownerId).toBe(chris.id);

    const first = await json<{ status: string; agent: { name: string }; token: string; mcp_url: string; openapi_url: string }>(
      poll(p, asked.id, asked.poll_secret),
    );
    expect(first).toEqual({
      status: "approved",
      agent: { name: "muse-chris" },
      token: expect.stringMatching(/^pa_/),
      mcp_url: `${PUBLIC_URL}/mcp`,
      openapi_url: `${PUBLIC_URL}/api/agent/openapi.json`,
    });
    expect((await callAs(p, { token: first.token }, "GET", "/api/agent/agents")).status).toBe(200);
    expect(await json(poll(p, asked.id, asked.poll_secret))).toEqual({ status: "approved", agent: { name: "muse-chris" } });

    const state = await json<{ joinLine: { agent: { name: string }; signIn: { status: string } } }>(
      callPerson(p, owner, "GET", `/api/join-lines/${line.id}`),
    );
    expect(state.joinLine).toMatchObject({ agent: { name: "muse-chris" }, signIn: { status: "approved" } });
    expect(await json(callPerson(p, owner, "GET", "/api/approvals"))).toMatchObject({ signIns: [] });
  });

  test("approving without a name uses the requested one; a name in use is 409 and the request keeps waiting", async () => {
    const { p, chris, owner } = await setup();
    addAppAgent(p, chris, "muse-work");
    const asked = await json<Asked>(ask(p, { token: (await makeLine(p, owner)).secret, name: "muse-work" }));
    const taken = await callPerson(p, owner, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "approve" });
    expect(taken.status).toBe(409);
    expect(p.computers.signInRequest(asked.id)?.status).toBe("pending");
    const ok = await callPerson(p, owner, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "approve", name: "muse-two" });
    expect(await ok.json()).toMatchObject({ agent: { name: "muse-two" } });
    const again = await callPerson(p, owner, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "deny" });
    expect(await again.json()).toMatchObject({ error: "wrong_status" });
  });

  test("deny ends the request; the poll says denied and never carries a token", async () => {
    const { p, owner } = await setup();
    const asked = await json<Asked>(ask(p, { token: (await makeLine(p, owner, "grok-bot")).secret, name: "grok-home" }));
    const res = await callPerson(p, owner, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "deny" });
    expect(await res.json()).toEqual({ signIn: expect.objectContaining({ status: "denied" }), agent: null });
    expect(await json(poll(p, asked.id, asked.poll_secret))).toEqual({ status: "denied" });
    expect(p.agents.byAddress("grok-home")).toBeNull();
    expect((await callPerson(p, owner, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "maybe" })).status).toBe(400);
  });

  test("after 10 minutes the request expires: the poll says so, the sweep marks it, and approving is refused", async () => {
    const { p, owner } = await setup();
    const asked = await json<Asked>(ask(p, { token: (await makeLine(p, owner)).secret, name: "muse-work" }));
    p.clock.advance(10 * MINUTE);
    expect(await json(poll(p, asked.id, asked.poll_secret))).toEqual({ status: "expired" });
    expect(await json(callPerson(p, owner, "GET", "/api/approvals"))).toMatchObject({ signIns: [] });
    expect(p.computers.sweepMinute()).toBe(1);
    const res = await callPerson(p, owner, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "approve" });
    expect(await res.json()).toMatchObject({ error: "wrong_status", message: "This sign in request expired." });
  });

  test("a wrong or missing poll secret is 401, and unknown requests look the same", async () => {
    const { p, owner } = await setup();
    const asked = await json<Asked>(ask(p, { token: (await makeLine(p, owner)).secret, name: "muse-work" }));
    expect((await poll(p, asked.id, "ps_wrong")).status).toBe(401);
    expect((await p.app.request(`/api/sign-in-requests/${asked.id}`)).status).toBe(401);
    expect((await poll(p, "nope", asked.poll_secret)).status).toBe(401);
  });

  test("unknown lines count toward the join limit", async () => {
    const { p, owner } = await setup();
    const line = await makeLine(p, owner);
    for (let i = 0; i < 10; i++) expect((await ask(p, { token: `unknown-${i}`.padEnd(22, "y"), name: "muse" })).status).toBe(404);
    expect((await ask(p, { token: line.secret, name: "muse" })).status).toBe(429);
  });

  test("error copy uses no pronouns", async () => {
    const { p, owner, member } = await setup();
    const messages: string[] = [];
    const collect = async (res: Response | Promise<Response>) => messages.push(((await (await res).json()) as { message: string }).message);
    const asked = await json<Asked>(ask(p, { token: (await makeLine(p, owner)).secret, name: "muse-work" }));
    await collect(ask(p, { token: (await makeLine(p, owner, "claude-code")).secret, name: "muse" }));
    await collect(ask(p, { token: "x".repeat(22), name: "muse" }));
    await collect(ask(p, { token: "x".repeat(22), name: "Not A Name" }));
    await collect(poll(p, asked.id, "ps_wrong"));
    await collect(callPerson(p, member, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "approve" }));
    await collect(callPerson(p, owner, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "deny" }));
    await collect(callPerson(p, owner, "POST", `/api/approvals/sign-ins/${asked.id}`, { decision: "approve" }));
    expect(copyProblems(messages.join(" | "))).toEqual([]);
  });
});
