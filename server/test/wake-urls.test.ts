import { describe, expect, test } from "bun:test";
import { MAX_WAKES_PER_HOUR, REWAKE_MS } from "../src/core/wake-urls";
import {
  addAppAgent,
  addComputer,
  addMember,
  addOwner,
  addSession,
  callAs,
  callPerson,
  fakeWebhooks,
  flush,
  makePortico,
  MINUTE,
  signIn,
} from "./helpers";

const HOOK = "https://api.x.ai/routines/r_123/fire";

async function setup() {
  const hooks = fakeWebhooks();
  const p = makePortico({ webhooks: hooks });
  const chris = await addOwner(p);
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  const muse = addAppAgent(p, chris, "muse");
  return { p, hooks, chris, grok, muse, cookie: signIn(p, chris) };
}

const send = (p: ReturnType<typeof makePortico>, from: { agent: { id: string } }, to: string, subject = "Ping") =>
  p.messages.send(p.agents.require(from.agent.id), { to, subject, text: "Secret details" });

describe("wake URLs", () => {
  test("only the agent's manager sets one; the key never comes back", async () => {
    const { p, grok, cookie } = await setup();
    const maya = await addMember(p);
    const other = await callPerson(p, signIn(p, maya), "PUT", `/api/agents/${grok.agent.id}/wake`, { url: HOOK, key: "k_1" });
    expect(other.status).toBe(403);

    const res = await callPerson(p, cookie, "PUT", `/api/agents/${grok.agent.id}/wake`, { url: HOOK, key: "k_1" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("k_1");
    expect(JSON.parse(body)).toMatchObject({ wake: { host: "api.x.ai", lastAt: null, lastStatus: null } });

    const page = (await (await callPerson(p, cookie, "GET", `/api/agents/${grok.agent.id}`)).json()) as Record<string, unknown>;
    expect(page).toMatchObject({ woken: true, wake: { host: "api.x.ai" }, events: null });
    expect(JSON.stringify(page)).not.toContain("k_1");
    const asMaya = (await (await callPerson(p, signIn(p, maya), "GET", `/api/agents/${grok.agent.id}`)).json()) as Record<string, unknown>;
    expect(asMaya).toMatchObject({ woken: true, wake: null });
  });

  test("refuses http, credentials in the URL, a key with spaces, and sessions", async () => {
    const { p, chris, grok, cookie } = await setup();
    for (const body of [
      { url: "http://api.x.ai/fire", key: "k" },
      { url: "https://u:p@api.x.ai/fire", key: "k" },
      { url: HOOK, key: "two words" },
      { url: HOOK, key: "" },
    ]) {
      expect((await callPerson(p, cookie, "PUT", `/api/agents/${grok.agent.id}/wake`, body)).status).toBe(400);
    }
    const session = addSession(p, addComputer(p, chris).computer);
    expect((await callPerson(p, cookie, "PUT", `/api/agents/${session.agent.id}/wake`, { url: HOOK, key: "k" })).status).toBe(403);
  });

  test("a new message posts the key as a bearer token, with the sender and message ID but never the text", async () => {
    const { p, hooks, chris, grok, muse } = await setup();
    p.wakeUrls.set(grok.agent, chris.id, { url: HOOK, key: "k_1" });
    const { message } = send(p, muse, "grok", "Book the review");
    await flush();
    expect(hooks.sent).toHaveLength(1);
    const req = hooks.sent[0]!;
    expect(req.url).toBe(HOOK);
    expect(req.headers.authorization).toBe("Bearer k_1");
    expect(JSON.parse(req.body)).toEqual({
      portico: { event: "message.received", agent: "grok", waiting: 1, latest: { message_id: message.id, from: "muse" } },
    });
    expect(req.body).not.toContain("Secret details");
    expect(req.body).not.toContain("Book the review");
    expect(p.wakeUrls.view(grok.agent.id)).toMatchObject({ lastStatus: "ok" });
  });

  test("one wake covers every message until the agent checks in, or until 10 minutes pass", async () => {
    const { p, hooks, chris, grok, muse } = await setup();
    p.wakeUrls.set(grok.agent, chris.id, { url: HOOK, key: "k" });
    send(p, muse, "grok", "One");
    await flush();
    send(p, muse, "grok", "Two");
    await flush();
    expect(hooks.sent).toHaveLength(1);

    p.clock.advance(MINUTE);
    await callAs(p, { token: grok.token }, "GET", "/api/agent/inbox");
    p.clock.advance(MINUTE);
    send(p, muse, "grok", "Three");
    await flush();
    expect(hooks.sent).toHaveLength(2);

    p.clock.advance(REWAKE_MS);
    send(p, muse, "grok", "Four");
    await flush();
    expect(hooks.sent).toHaveLength(3);
  });

  test("a check-in while the wake is still on its way counts: the time sent is what's compared", async () => {
    const { p, hooks, chris, grok, muse } = await setup();
    p.wakeUrls.set(grok.agent, chris.id, { url: HOOK, key: "k" });
    // The routine's run checks the inbox before the trigger's answer comes back.
    hooks.answer = () => {
      p.clock.advance(2000);
      p.agents.checkedIn(p.agents.require(grok.agent.id));
      p.clock.advance(3000);
      return { status: 200, body: "" };
    };
    send(p, muse, "grok", "One");
    await flush();
    hooks.answer = () => ({ status: 200, body: "" });
    p.clock.advance(3 * MINUTE);
    send(p, muse, "grok", "Two");
    await flush();
    expect(hooks.sent).toHaveLength(2);
  });

  test("a new wake URL starts over, even while the old one's retries wait", async () => {
    const { p, hooks, chris, grok, muse } = await setup();
    p.wakeUrls.set(grok.agent, chris.id, { url: HOOK, key: "old" });
    hooks.answer = () => ({ status: 503, body: "" });
    send(p, muse, "grok", "One");
    await flush();
    expect(hooks.timers).toHaveLength(1);

    hooks.answer = () => ({ status: 200, body: "" });
    p.wakeUrls.set(grok.agent, chris.id, { url: "https://hooks.example.com/new", key: "new" });
    send(p, muse, "grok", "Two");
    await flush();
    expect(hooks.sent.map((r) => r.headers.authorization)).toEqual(["Bearer old", "Bearer new"]);
    // The old chain's retry finds a new wake URL and stops.
    hooks.runTimers();
    await flush();
    expect(hooks.sent).toHaveLength(2);
  });

  test("a failed wake is recorded, retried when worth it, and the next message tries again", async () => {
    const { p, hooks, chris, grok, muse } = await setup();
    p.wakeUrls.set(grok.agent, chris.id, { url: HOOK, key: "k" });
    hooks.answer = () => ({ status: 503, body: "" });
    send(p, muse, "grok");
    await flush();
    expect(p.wakeUrls.view(grok.agent.id)).toMatchObject({ lastStatus: "http_503" });
    expect(hooks.timers).toHaveLength(1);
    hooks.answer = () => ({ status: 200, body: "" });
    hooks.runTimers();
    await flush();
    expect(hooks.sent).toHaveLength(2);
    expect(p.wakeUrls.view(grok.agent.id)).toMatchObject({ lastStatus: "ok" });

    // A wrong key isn't retried, and doesn't stop a later message from trying.
    hooks.answer = () => ({ status: 401, body: "" });
    p.clock.advance(REWAKE_MS);
    send(p, muse, "grok");
    await flush();
    expect(hooks.timers).toHaveLength(0);
    expect(p.wakeUrls.view(grok.agent.id)).toMatchObject({ lastStatus: "http_401" });
    send(p, muse, "grok");
    await flush();
    expect(hooks.sent).toHaveLength(4);
    // A wake URL that fails doesn't count as waking the agent.
    const page = (await (await callPerson(p, signIn(p, chris), "GET", `/api/agents/${grok.agent.id}`)).json()) as Record<string, unknown>;
    expect(page).toMatchObject({ woken: false, wake: { lastStatus: "http_401" } });
  });

  test("held messages wake the agent only once allowed; no wake URL, no post", async () => {
    const { p, hooks, chris, muse } = await setup();
    const guarded = addAppAgent(p, chris, "guarded", { kind: "grok-bot", approvalRequired: true });
    send(p, guarded, "muse");
    await flush();
    expect(hooks.sent).toHaveLength(0);

    p.wakeUrls.set(guarded.agent, chris.id, { url: HOOK, key: "k" });
    const { message } = send(p, muse, "guarded");
    await flush();
    expect(hooks.sent).toHaveLength(0);
    p.approvals.decide(chris.id, message.id, "allow_once");
    await flush();
    expect(hooks.sent).toHaveLength(1);
  });

  test("at most 30 wakes an hour", async () => {
    const { p, hooks, chris, grok, muse } = await setup();
    p.wakeUrls.set(grok.agent, chris.id, { url: HOOK, key: "k" });
    // About a minute apart, under the loop guard's 12 messages in 10 minutes, and all within the hour.
    for (let i = 0; i < MAX_WAKES_PER_HOUR + 5; i++) {
      p.clock.advance(30_000);
      p.agents.checkedIn(p.agents.require(grok.agent.id));
      p.clock.advance(31_000);
      send(p, muse, "grok", `N${i}`);
      await flush();
    }
    expect(hooks.sent).toHaveLength(MAX_WAKES_PER_HOUR);
  });

  test("removing the wake URL or the agent stops the wakes, and Activity says so without the key", async () => {
    const { p, hooks, chris, grok, muse, cookie } = await setup();
    await callPerson(p, cookie, "PUT", `/api/agents/${grok.agent.id}/wake`, { url: HOOK, key: "k_secret" });
    expect((await callPerson(p, cookie, "DELETE", `/api/agents/${grok.agent.id}/wake`)).status).toBe(204);
    send(p, muse, "grok");
    await flush();
    expect(hooks.sent).toHaveLength(0);
    const kinds = p.activity
      .list({ agentIds: [grok.agent.id] })
      .filter((e) => e.kind.startsWith("wake_"))
      .map((e) => [e.kind, e.detail.host]);
    expect(kinds).toEqual([
      ["wake_removed", "api.x.ai"],
      ["wake_set", "api.x.ai"],
    ]);
    expect(JSON.stringify(p.activity.list())).not.toContain("k_secret");

    p.wakeUrls.set(grok.agent, chris.id, { url: HOOK, key: "k" });
    p.agents.remove(chris.id, grok.agent.id);
    expect(p.db.query("SELECT COUNT(*) AS n FROM wake_urls").get()).toEqual({ n: 0 });
  });
});
