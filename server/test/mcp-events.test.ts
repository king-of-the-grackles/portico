import { describe, expect, test } from "bun:test";
import { EVENTS_EXTENSION, MODERN_PROTOCOL_VERSION } from "../src/agent-api/mcp";
import { verifyWebhook, type WebhookRequest } from "../src/core/webhooks";
import { addAppAgent, addOwner, callPerson, DAY, fakeWebhooks, flush, HOUR, makePortico, MINUTE, signIn } from "./helpers";

const SECRET = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const SECRET_2 = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
const CALLBACK = "https://chatgpt.com/mcp-events/callback_123";

type Rpc = { jsonrpc: string; id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };

const modernMeta = (caps: Record<string, unknown> = {}) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": caps,
  "io.modelcontextprotocol/clientInfo": { name: "ChatGPT", version: "1" },
});

/** Answers the verification challenge the way ChatGPT does: echoes it back. */
const echoChallenge = (req: WebhookRequest) => {
  const body = JSON.parse(req.body) as { type?: string; challenge?: string };
  return body.type === "verification" ? { status: 200, body: JSON.stringify({ challenge: body.challenge }) } : { status: 200, body: "" };
};

async function setup() {
  const hooks = fakeWebhooks(echoChallenge);
  const p = makePortico({ webhooks: hooks });
  const chris = await addOwner(p);
  const dot = addAppAgent(p, chris, "dot", { kind: "dots" });
  const muse = addAppAgent(p, chris, "muse");
  return { p, hooks, chris, dot, muse };
}

/** A POST to /mcp with the given body and headers; modern requests get their MCP headers unless `headers` says otherwise. */
async function post(p: ReturnType<typeof makePortico>, token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await p.app.request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Rpc };
}

function modern(method: string, params: Record<string, unknown> = {}, caps: Record<string, unknown> = {}) {
  const body = { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: modernMeta(caps) } };
  const headers: Record<string, string> = { "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "mcp-method": method };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  return { body, headers };
}

const call = (p: ReturnType<typeof makePortico>, token: string, method: string, params: Record<string, unknown> = {}, caps = {}) => {
  const { body, headers } = modern(method, params, caps);
  return post(p, token, body, headers);
};

const subscribeParams = (over: Record<string, unknown> = {}) => ({
  name: "message.received",
  arguments: {},
  delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
  cursor: null,
  ...over,
});

const send = (p: ReturnType<typeof makePortico>, from: { agent: { id: string } }, to: string) =>
  p.messages.send(p.agents.require(from.agent.id), { to, subject: "Book the review", text: "Secret details" });

describe("MCP 2026-07-28", () => {
  test("server/discover names the versions, the events capability both ways, and who answered", async () => {
    const { p, dot } = await setup();
    const { status, body } = await call(p, dot.token, "server/discover");
    expect(status).toBe(200);
    expect(body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [MODERN_PROTOCOL_VERSION, "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"],
      capabilities: { tools: {}, events: {}, extensions: { [EVENTS_EXTENSION]: {} } },
      ttlMs: HOUR,
      cacheScope: "public",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "portico" } },
    });
    expect(body.result!.instructions).toContain("message.received");
  });

  test("tools work statelessly, with resultType on every result and freshness on the list", async () => {
    const { p, dot } = await setup();
    const list = await call(p, dot.token, "tools/list");
    expect(list.body.result).toMatchObject({ resultType: "complete", ttlMs: HOUR, cacheScope: "public" });
    const sent = await call(p, dot.token, "tools/call", { name: "send_message", arguments: { to: "muse", subject: "Hi", text: "t" } });
    expect(sent.body.result).toMatchObject({ resultType: "complete", isError: false });
  });

  test("initialize-based clients are served exactly as before", async () => {
    const { p, dot } = await setup();
    const init = await post(p, dot.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } } });
    expect(init.body.result).not.toHaveProperty("resultType");
    const list = await post(p, dot.token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" });
    expect(list.body.result).not.toHaveProperty("resultType");
    const ping = await post(p, dot.token, { jsonrpc: "2.0", id: 3, method: "ping" });
    expect(ping.body.result).toEqual({});
    // The events methods belong to 2026-07-28.
    const events = await post(p, dot.token, { jsonrpc: "2.0", id: 4, method: "events/list" });
    expect(events.body.error?.code).toBe(-32601);
  });

  test("refuses an unknown version, mismatched headers, and a modern header without _meta, with 400s; unknown methods 404", async () => {
    const { p, dot } = await setup();
    const future = await post(p, dot.token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01", "io.modelcontextprotocol/clientCapabilities": {} } },
    });
    expect(future.status).toBe(400);
    expect(future.body.error).toMatchObject({ code: -32022, data: { requested: "2099-01-01" } });
    expect((future.body.error!.data as { supported: string[] }).supported[0]).toBe(MODERN_PROTOCOL_VERSION);

    const { body } = modern("tools/list");
    const mismatch = await post(p, dot.token, body, { "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "mcp-method": "tools/call" });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error?.code).toBe(-32020);

    const named = modern("tools/call", { name: "list_agents" });
    const wrongName = await post(p, dot.token, named.body, { ...named.headers, "mcp-name": "send_message" });
    expect(wrongName.body.error?.code).toBe(-32020);
    const encoded = `=?base64?${Buffer.from("list_agents").toString("base64")}?=`;
    expect((await post(p, dot.token, named.body, { ...named.headers, "mcp-name": encoded })).status).toBe(200);

    const bare = await post(p, dot.token, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": MODERN_PROTOCOL_VERSION });
    expect(bare.status).toBe(400);
    expect(bare.body.error?.code).toBe(-32602);

    const unknown = await call(p, dot.token, "resources/list");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error?.code).toBe(-32601);
    // Gone from 2026-07-28, but still answered for clients that check the server is there.
    expect((await call(p, dot.token, "ping")).body.result).toMatchObject({ resultType: "complete" });
  });

  test("still needs a token, and points to the sign-in when there isn't one", async () => {
    const { p } = await setup();
    const res = await p.app.request("/mcp", { method: "POST", body: JSON.stringify(modern("server/discover").body) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });
});

describe("MCP Events", () => {
  test("events/list offers message.received, by webhook, with no arguments", async () => {
    const { p, dot } = await setup();
    const { body } = await call(p, dot.token, "events/list");
    const events = body.result!.events as Record<string, unknown>[];
    expect(events.map((e) => [e.name, e.delivery])).toEqual([["message.received", ["webhook"]]]);
    expect(events[0]!.payloadSchema).toMatchObject({ required: ["agent", "message_id", "from", "waiting"] });
  });

  test("subscribing checks the callback with a signed challenge, then answers with the subscription", async () => {
    const { p, hooks, dot } = await setup();
    const { body } = await call(p, dot.token, "events/subscribe", subscribeParams());
    expect(body.result).toMatchObject({ resultType: "complete", cursor: null, truncated: false });
    const result = body.result as { id: string; refreshBefore: string };
    expect(result.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(result.refreshBefore).toBe(new Date(p.clock.now().getTime() + 7 * DAY).toISOString());

    expect(hooks.sent).toHaveLength(1);
    const challenge = hooks.sent[0]!;
    expect(challenge.url).toBe(CALLBACK);
    expect(JSON.parse(challenge.body)).toMatchObject({ type: "verification" });
    expect(challenge.headers["x-mcp-subscription-id"]).toBe(result.id);
    expect(challenge.headers["webhook-id"]).toMatch(/^msg_verification_/);
    const ts = Number(challenge.headers["webhook-timestamp"]);
    expect(verifyWebhook(SECRET, challenge.headers["webhook-id"]!, ts, challenge.body, challenge.headers["webhook-signature"]!)).toBe(true);
  });

  test("a callback that doesn't echo the challenge is refused with CallbackEndpointError", async () => {
    const { p, hooks, dot } = await setup();
    hooks.answer = () => ({ status: 200, body: JSON.stringify({ challenge: "wrong" }) });
    const sketch = await call(p, dot.token, "events/subscribe", subscribeParams());
    expect(sketch.body.error).toMatchObject({ code: -32015, data: { reason: "challenge_failed" } });

    hooks.answer = () => ({ status: null, error: "unreachable" });
    const sep = await call(p, dot.token, "events/subscribe", subscribeParams(), { extensions: { [EVENTS_EXTENSION]: {} } });
    expect(sep.body.error).toMatchObject({ code: -32027, data: { reason: "connection_refused" } });

    hooks.answer = () => ({ status: 404, body: "" });
    expect((await call(p, dot.token, "events/subscribe", subscribeParams())).body.error?.data).toEqual({ reason: "http_4xx" });
    expect(p.events.has(dot.agent.id)).toBe(false);
  });

  test("bad requests are invalid params", async () => {
    const { p, dot } = await setup();
    for (const params of [
      subscribeParams({ name: "comment.created" }),
      subscribeParams({ arguments: { channel: "x" } }),
      subscribeParams({ delivery: { mode: "webhook", url: "http://chatgpt.com/cb", secret: SECRET } }),
      subscribeParams({ delivery: { mode: "webhook", url: CALLBACK, secret: "plain-secret" } }),
      subscribeParams({ delivery: { mode: "webhook", url: CALLBACK, secret: `whsec_${Buffer.alloc(8).toString("base64")}` } }),
      subscribeParams({ delivery: { mode: "poll", url: CALLBACK, secret: SECRET } }),
    ]) {
      expect((await call(p, dot.token, "events/subscribe", params)).body.error?.code).toBe(-32602);
    }
  });

  test("each new message sends one signed event with the sender and message ID, never the text", async () => {
    const { p, hooks, dot, muse } = await setup();
    const sub = (await call(p, dot.token, "events/subscribe", subscribeParams())).body.result as { id: string };
    const { message } = send(p, muse, "dot");
    await flush();
    expect(hooks.sent).toHaveLength(2);
    const event = hooks.sent[1]!;
    const body = JSON.parse(event.body) as Record<string, unknown>;
    expect(body).toEqual({
      eventId: `evt_${message.id}`,
      name: "message.received",
      timestamp: p.clock.now().toISOString(),
      data: { agent: "dot", message_id: message.id, from: "muse", waiting: 1 },
      cursor: null,
    });
    expect(event.body).not.toContain("Secret details");
    expect(event.body).not.toContain("Book the review");
    expect(event.headers["webhook-id"]).toBe(`evt_${message.id}`);
    expect(event.headers["x-mcp-subscription-id"]).toBe(sub.id);
    expect(verifyWebhook(SECRET, event.headers["webhook-id"]!, Number(event.headers["webhook-timestamp"]), event.body, event.headers["webhook-signature"]!)).toBe(true);
    expect(p.events.view(dot.agent.id)).toMatchObject({ count: 1, lastStatus: "ok" });
  });

  test("subscribing again refreshes the same subscription without a new challenge; a new secret signs alongside the old for 10 minutes", async () => {
    const { p, hooks, dot, muse } = await setup();
    const first = (await call(p, dot.token, "events/subscribe", subscribeParams())).body.result as { id: string };
    p.clock.advance(HOUR);
    // Key order in arguments doesn't make a second subscription.
    const again = await call(p, dot.token, "events/subscribe", subscribeParams({ delivery: { secret: SECRET_2, url: CALLBACK, mode: "webhook" } }));
    const refreshed = again.body.result as { id: string; refreshBefore: string; deliveryStatus: { active: boolean } };
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.refreshBefore).toBe(new Date(p.clock.now().getTime() + 7 * DAY).toISOString());
    expect(refreshed.deliveryStatus.active).toBe(true);
    expect(hooks.sent).toHaveLength(1);

    send(p, muse, "dot");
    await flush();
    const during = hooks.sent.at(-1)!;
    expect(during.headers["webhook-signature"]!.split(" ")).toHaveLength(2);
    const args = [during.headers["webhook-id"]!, Number(during.headers["webhook-timestamp"]), during.body, during.headers["webhook-signature"]!] as const;
    expect(verifyWebhook(SECRET_2, ...args)).toBe(true);
    expect(verifyWebhook(SECRET, ...args)).toBe(true);

    p.clock.advance(11 * MINUTE);
    send(p, muse, "dot");
    await flush();
    expect(hooks.sent.at(-1)!.headers["webhook-signature"]!.split(" ")).toHaveLength(1);
  });

  test("the granted lifetime is the default, or what was asked within an hour and 30 days", async () => {
    const { p, dot } = await setup();
    const at = (ms: number) => new Date(p.clock.now().getTime() + ms).toISOString();
    const grant = async (ttlMs: unknown, url: string) =>
      ((await call(p, dot.token, "events/subscribe", subscribeParams({ ttlMs, delivery: { mode: "webhook", url, secret: SECRET } }))).body.result as {
        refreshBefore: string;
      }).refreshBefore;
    expect(await grant(1000, `${CALLBACK}/a`)).toBe(at(HOUR));
    expect(await grant(2 * DAY, `${CALLBACK}/b`)).toBe(at(2 * DAY));
    expect(await grant(90 * DAY, `${CALLBACK}/c`)).toBe(at(30 * DAY));
    expect(await grant(null, `${CALLBACK}/d`)).toBe(at(30 * DAY));
  });

  test("unsubscribing stops the events, and asking again still succeeds", async () => {
    const { p, hooks, dot, muse } = await setup();
    await call(p, dot.token, "events/subscribe", subscribeParams());
    const params = { name: "message.received", arguments: {}, delivery: { mode: "webhook", url: CALLBACK } };
    expect((await call(p, dot.token, "events/unsubscribe", params)).body.result).toMatchObject({ resultType: "complete" });
    expect((await call(p, dot.token, "events/unsubscribe", params)).body.result).toMatchObject({ resultType: "complete" });
    send(p, muse, "dot");
    await flush();
    expect(hooks.sent).toHaveLength(1);
  });

  test("an expired subscription gets nothing, and the minute sweep removes it", async () => {
    const { p, hooks, dot, muse } = await setup();
    await call(p, dot.token, "events/subscribe", subscribeParams({ ttlMs: HOUR }));
    p.clock.advance(HOUR);
    send(p, muse, "dot");
    await flush();
    expect(hooks.sent).toHaveLength(1);
    p.sweepMinute();
    expect(p.db.query("SELECT COUNT(*) AS n FROM event_subscriptions").get()).toEqual({ n: 0 });
  });

  test("server errors are retried with the same event ID; 410 isn't, and the subscription stays", async () => {
    const { p, hooks, dot, muse } = await setup();
    await call(p, dot.token, "events/subscribe", subscribeParams());
    hooks.answer = () => ({ status: 503, body: "" });
    send(p, muse, "dot");
    await flush();
    expect(hooks.timers).toHaveLength(1);
    hooks.answer = () => ({ status: 200, body: "" });
    hooks.runTimers();
    await flush();
    expect(hooks.sent).toHaveLength(3);
    expect(hooks.sent[2]!.headers["webhook-id"]).toBe(hooks.sent[1]!.headers["webhook-id"]!);

    hooks.answer = () => ({ status: 410, body: "" });
    send(p, muse, "dot");
    await flush();
    expect(hooks.timers).toHaveLength(0);
    expect(p.events.view(dot.agent.id)).toMatchObject({ count: 1, lastStatus: "http_410" });
    const page = (await (await callPerson(p, signIn(p, p.people.owner()!), "GET", `/api/agents/${dot.agent.id}`)).json()) as Record<string, unknown>;
    expect(page).toMatchObject({ woken: false, events: { count: 1, lastStatus: "http_410" } });
  });

  test("a held message sends its event only once allowed", async () => {
    const { p, hooks, chris, muse } = await setup();
    const guarded = addAppAgent(p, chris, "guarded", { kind: "dots", approvalRequired: true });
    await call(p, guarded.token, "events/subscribe", subscribeParams());
    const { message } = send(p, muse, "guarded");
    await flush();
    expect(hooks.sent).toHaveLength(1);
    p.approvals.decide(chris.id, message.id, "allow_once");
    await flush();
    expect(hooks.sent).toHaveLength(2);
  });

  test("the agent page shows the subscriptions to the agent's manager", async () => {
    const { p, chris, dot } = await setup();
    await call(p, dot.token, "events/subscribe", subscribeParams());
    const page = (await (await callPerson(p, signIn(p, chris), "GET", `/api/agents/${dot.agent.id}`)).json()) as Record<string, unknown>;
    expect(page).toMatchObject({ woken: true, wake: null, events: { count: 1 } });
  });
});
