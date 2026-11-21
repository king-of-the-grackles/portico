import { describe, expect, test } from "bun:test";
import type { AgentPageData } from "../src/api/agents";
import { LIMITS } from "../src/core/limits";
import { MAX_WAKE_TESTS_PER_HOUR } from "../src/core/wake-urls";
import { wakeLine } from "../src/web/client/render/agent";
import { addAppAgent, addOwner, askToJoin, callAs, callPerson, copyProblems, fakeWebhooks, finishJoin, flush, makePortico, PUBLIC_URL, signIn } from "./helpers";

const HOOK = "https://api.x.ai/routines/r_123/fire";

async function setup(answer?: Parameters<typeof fakeWebhooks>[0]) {
  const hooks = fakeWebhooks(answer);
  const p = makePortico({ webhooks: hooks });
  const chris = await addOwner(p);
  return { p, hooks, chris, cookie: signIn(p, chris) };
}

const tool = async (p: ReturnType<typeof makePortico>, token: string, name: string, args: Record<string, unknown> = {}) => {
  const res = await callAs(p, { token }, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return body.result;
};

describe("wake-ups are the last step of joining", () => {
  test("the answer that hands over the token says wake-ups are off, and carries the step in full, in the app's words", async () => {
    const { p, cookie } = await setup();
    const asked = await askToJoin(p, { kind: "agent", name: "grok", client: "grok-bot" });
    const joined = await finishJoin(p, cookie, asked);
    expect(typeof joined.token).toBe("string");
    expect(joined.wake).toEqual({ on: false, how: "none", tested: false, schedule_minutes: null });
    expect(joined.next).toStartWith("Joining isn't finished: wake-ups aren't on for this agent yet");
    expect(joined.next).toContain("without waiting to be asked and without help from the person");
    expect(joined.next).toContain(`call PUT ${PUBLIC_URL}/api/agent/wake with the agent's token and {"url": "<trigger URL>", "key": "<trigger key>"}`);
    expect(joined.next).toContain("In Grok Bot, a routine with a webhook trigger does this");
    expect(joined.next).toContain(`{"schedule_minutes": ${LIMITS.appCheckMinutes}}`);
    expect(joined.next).toContain(`${PUBLIC_URL}/join#wake`);
    expect(copyProblems(joined.next)).toEqual([]);
  });

  test("every inbox check and agent list repeats the step until a wake went through, then stops", async () => {
    const { p, hooks, chris } = await setup();
    const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
    const inbox = async () => (await (await callAs(p, grok, "GET", "/api/agent/inbox")).json()) as Record<string, any>;
    const before = await inbox();
    expect(before.wake).toEqual({ on: false, how: "none", tested: false, schedule_minutes: null });
    expect(before.wake_note).toStartWith("Joining isn't finished");
    expect(((await (await callAs(p, grok, "GET", "/api/agent/agents")).json()) as Record<string, any>).wake_note).toBe(before.wake_note);
    expect(((await (await callAs(p, grok, "GET", "/api/agent/wake")).json()) as Record<string, any>).wake_note).toBe(before.wake_note);
    // Over MCP the same step, in the words for the tools, as text an app reads without parsing.
    const checked = await tool(p, grok.token, "check_inbox");
    expect(checked.content[0]!.text).toContain("No new messages.\n\nJoining isn't finished: wake-ups aren't on for this agent yet");

    const set = (await (await callAs(p, grok, "PUT", "/api/agent/wake", { url: HOOK, key: "k_1" })).json()) as Record<string, any>;
    expect(set.wake).toMatchObject({ host: "api.x.ai", test: "ok", on: true, tested: true });
    expect(set.wake_note).toBeUndefined();
    expect(hooks.sent).toHaveLength(1);
    const after = await inbox();
    expect(after.wake).toEqual({ on: true, how: "wake_url", tested: true, schedule_minutes: null });
    expect(after.wake_note).toBeUndefined();
    expect((await tool(p, grok.token, "check_inbox")).content[0]!.text).toBe("No new messages.");
  });

  test("a test wake that fails says why, wake-ups stay off, and the agent's page says so", async () => {
    const { p, chris, cookie } = await setup(() => ({ status: 401, body: "" }));
    const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
    const set = (await (await callAs(p, grok, "PUT", "/api/agent/wake", { url: HOOK, key: "wrong" })).json()) as Record<string, any>;
    expect(set.wake).toMatchObject({ host: "api.x.ai", test: "http_401", on: false, problem: "http_401" });
    expect(set.wake_note).toContain("The last wake was refused (http_401): the key is wrong or was replaced.");
    expect(JSON.stringify(set)).not.toContain("wrong\"");
    const page = (await (await callPerson(p, cookie, "GET", `/api/agents/${grok.agent.id}`)).json()) as Record<string, unknown>;
    expect(page).toMatchObject({ woken: false, wake: { lastStatus: "http_401" } });
  });

  test("an app that can't be woken states its schedule: the reminder stops, and the schedule shows", async () => {
    const { p, chris, cookie } = await setup();
    const muse = addAppAgent(p, chris, "muse");
    const said = (await (await callAs(p, muse, "PUT", "/api/agent/wake", { schedule_minutes: 30 })).json()) as Record<string, any>;
    expect(said).toEqual({ wake: { on: false, how: "schedule", tested: false, schedule_minutes: 30 } });
    const page = (await (await callPerson(p, cookie, "GET", `/api/agents/${muse.agent.id}`)).json()) as Record<string, unknown>;
    expect(page).toMatchObject({ woken: false, checkMinutes: 30 });
    // The tool does the same, and 0 takes the statement back.
    const dot = addAppAgent(p, chris, "dot", { kind: "dots" });
    expect(JSON.parse((await tool(p, dot.token, "set_inbox_schedule", { minutes: 30 })).content[0]!.text)).toEqual(said);
    expect(JSON.parse((await tool(p, dot.token, "set_inbox_schedule", { minutes: 0 })).content[0]!.text).wake.how).toBe("none");
    for (const minutes of [1, 2.5, 100_000, "30"]) {
      expect((await callAs(p, muse, "PUT", "/api/agent/wake", { schedule_minutes: minutes })).status).toBe(400);
    }
  });

  test("test wakes are capped for one agent, so setting address after address tells nothing more", async () => {
    const { p, hooks, chris } = await setup();
    const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
    const set = async (n: number) => (await (await callAs(p, grok, "PUT", "/api/agent/wake", { url: `https://host-${n}.example.com/fire`, key: "k_1" })).json()) as Record<string, any>;
    for (let n = 0; n < MAX_WAKE_TESTS_PER_HOUR; n++) expect((await set(n)).wake.test).toBe("ok");
    const capped = await set(99);
    // The address is saved, nothing was posted to it, and the answer says the test didn't run.
    expect(capped.wake).toMatchObject({ host: "host-99.example.com", test: "not_tested", on: true, tested: false });
    expect(hooks.sent).toHaveLength(MAX_WAKE_TESTS_PER_HOUR);
    expect(hooks.sent.map((req) => req.url)).not.toContain("https://host-99.example.com/fire");
  });

  test("a message after the test wake still wakes the agent", async () => {
    const { p, hooks, chris } = await setup();
    const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
    const muse = addAppAgent(p, chris, "muse");
    await callAs(p, grok, "PUT", "/api/agent/wake", { url: HOOK, key: "k_1" });
    p.messages.send(p.agents.require(muse.agent.id), { to: "grok", subject: "Ping", text: "Hello" });
    await flush();
    expect(hooks.sent.map((req) => JSON.parse(req.body).portico.event)).toEqual(["wake.test", "message.received"]);
  });
});

describe("the agent's page says when an agent isn't woken", () => {
  const data = (o: { agent: Record<string, unknown>; woken?: boolean; checkMinutes?: number | null }) => {
    const agent: Record<string, unknown> = { label: "dotsie", mine: true, type: "app", revokedAt: null };
    return { woken: false, checkMinutes: null, ...o, agent: Object.assign(agent, o.agent) } as unknown as AgentPageData;
  };
  const text = (html: string) => html.replace(/<[^>]+>/g, "");

  test("with the one line that fixes it, until wake-ups are on", () => {
    const line = wakeLine(data({ agent: {} }), "https://app.portico.chat");
    expect(text(line)).toBe("Not getting new messages automatically. To fix: tell dotsie Finish joining Portico: set up wake-ups, as https://app.portico.chat/join#wake says.");
    expect(copyProblems(text(line))).toEqual([]);
    expect(wakeLine(data({ agent: {}, woken: true }), "")).toBe("");
  });

  test("with the schedule, for an app that can't be woken", () => {
    const line = text(wakeLine(data({ agent: {}, checkMinutes: 30 }), ""));
    expect(line).toBe("Not getting new messages automatically. dotsie checks for messages every 30 minutes, because the app can't be woken. A message can wait that long.");
    expect(copyProblems(line)).toEqual([]);
  });

  test("never for a session, another person's agent or a revoked one", () => {
    expect(wakeLine(data({ agent: { type: "session" } }), "")).toBe("");
    expect(wakeLine(data({ agent: { mine: false } }), "")).toBe("");
    expect(wakeLine(data({ agent: { revokedAt: "2026-11-20T00:00:00.000Z" } }), "")).toBe("");
  });
});
