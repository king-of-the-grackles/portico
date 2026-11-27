import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analytics } from "../src/core/analytics";
import { readKept, resolveVisit } from "../src/web/client/visit-id";
import { LIMITS } from "../src/core/limits";
import type { WebhookRequest, WebhookResult } from "../src/core/webhooks";
import { captureLogs } from "../src/log";
import {
  addAppAgent,
  addMember,
  addOwner,
  answerConsent,
  askToJoin,
  callAs,
  callPerson,
  fakeAccounts,
  fakeWebhooks,
  finishJoin,
  flush,
  joinCodeOn,
  makePortico,
  PASSWORD,
  PUBLIC_URL,
  signIn,
  submitJoinCode,
  T0,
  together,
} from "./helpers";

const CONFIG = { key: "phc_test_key", host: "https://ph.example.com", environment: "dev" as const };
/** On every event, whatever it is about. */
const ALWAYS = ["$geoip_disable", "$lib", "environment"];

interface Sent {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

/** A Portico with analytics on, and what it posted to PostHog so far. */
function start(opts: Parameters<typeof makePortico>[0] = {}) {
  const posts = fakeWebhooks();
  const p = makePortico({ ...opts, config: { analytics: CONFIG, ...opts.config }, analyticsPost: posts.post });
  /** Every event posted so far, oldest first, after what is still on its way has left. */
  const events = async (): Promise<Sent[]> => {
    await flush();
    await p.analytics.flush();
    return posts.sent.flatMap((req) => (JSON.parse(req.body) as { batch: Sent[] }).batch);
  };
  const named = async (name: string) => (await events()).filter((e) => e.event === name);
  /** The keys an event carries besides the ones every event has. */
  const keys = (e: Sent) => Object.keys(e.properties).filter((key) => !ALWAYS.includes(key)).sort();
  return { p, posts, events, named, keys };
}

const rpc = (method: string, params: unknown = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const tool = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });
const toolAnswer = async <T>(res: Response | Promise<Response>) =>
  JSON.parse(((await (await res).json()) as { result: { content: { text: string }[] } }).result.content[0]!.text) as T;

/** What the browser module posts. */
function report(p: ReturnType<typeof makePortico>, body: unknown, headers: Record<string, string> = {}) {
  return p.app.request(`${PUBLIC_URL}/api/analytics`, {
    method: "POST",
    headers: { host: "portico.example.com", origin: PUBLIC_URL, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const page = async (p: ReturnType<typeof makePortico>, path: string, cookie: string | null = null, headers: Record<string, string> = {}) => {
  const res = await p.app.request(`${PUBLIC_URL}${path}`, { headers: { host: "portico.example.com", ...(cookie ? { cookie } : {}), ...headers } });
  return { status: res.status, html: await res.text() };
};
const TAG = '<script type="module" src="/assets/analytics.js"';
/** The same Portico as a browser that sends these headers with every request, as Do Not Track and Global Privacy Control are sent. */
const browserWith = (p: ReturnType<typeof makePortico>, headers: Record<string, string>) => ({
  app: { request: (path: string, init: RequestInit = {}) => p.app.request(path, { ...init, headers: { ...(init.headers as Record<string, string>), ...headers } }) },
});

afterEach(() => captureLogs(null));

describe("analytics is off without a key", () => {
  test("no route, no script tag, no capture and no post", async () => {
    const posts = fakeWebhooks();
    const p = makePortico({ analyticsPost: posts.post });
    const chris = await addOwner(p);
    expect(p.config.analytics).toBeNull();
    expect(p.analytics.on).toBe(false);
    expect((await report(p, { event: "pageview", anon_id: "anon-12345678", path: "/" })).status).toBe(404);
    const signInPage = await page(p, "/sign-in");
    expect(signInPage.status).toBe(200);
    expect(signInPage.html).not.toContain("analytics.js");
    expect((await page(p, "/", signIn(p, chris))).html).not.toContain("analytics.js");
    // The module is one of the browser modules either way; no page asks for it.
    expect((await p.app.request("/assets/analytics.js")).status).toBe(200);

    const grok = addAppAgent(p, chris, "grok-bot");
    addAppAgent(p, chris, "muse");
    expect((await callAs(p, { token: grok.token }, "POST", "/mcp", tool("send_message", { to: "muse", subject: "s", text: "t" }))).status).toBe(200);
    expect((await callAs(p, { token: grok.token }, "GET", "/api/agent/agents")).status).toBe(200);
    p.analytics.capture("anything", chris.id, { a: 1 });
    p.analytics.identify(chris.id, "anon-12345678");
    let ran = false;
    p.analytics.track(() => (ran = true));
    expect(ran).toBe(false);
    await flush();
    await p.analytics.flush();
    expect(posts.sent).toEqual([]);
  });
});

describe("which pages load the module", () => {
  test("sign-in, welcome, the signed-in pages and Settings do; pages with a secret or a code never do", async () => {
    const { p } = start({ accountCheck: fakeAccounts, setup: false });
    const signInPage = await page(p, "/sign-in");
    expect(signInPage.html).toContain(`${TAG} data-view="sign-in"></script>`);
    expect((await page(p, "/")).html).toContain(`${TAG} data-view="sign-in"></script>`);
    // The script comes after the page's first data, which other code reads as the first JSON script.
    expect(signInPage.html.indexOf('id="first-data"')).toBeLessThan(signInPage.html.indexOf(TAG));

    const session = await callPerson(p, null, "POST", "/api/session", { token: "account:acct-ada:ada@example.com:Ada" });
    const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await page(p, "/welcome", cookie)).html).toContain(`${TAG} data-view="page"></script>`);

    // A join waiting on the consent page, and the same page once it shows the code.
    const asked = await askToJoin(p, { kind: "agent", name: "helper" });
    const consent = await page(p, `/c/${asked.id}`, cookie);
    expect(consent.status).toBe(200);
    expect(consent.html).not.toContain("analytics.js");
    expect((await answerConsent(p, cookie, asked.id, { decision: "approve", person: "Ada", handle: "ada" })).status).toBe(200);
    const code = await page(p, `/c/${asked.id}`, cookie);
    expect(code.html).toContain('class="join-code"');
    expect(code.html).not.toContain("analytics.js");

    for (const path of ["/", "/activity", "/settings"]) {
      const res = await page(p, path, cookie);
      expect(`${path} ${res.status} ${res.html.includes(`${TAG} data-view="page"></script>`)}`).toBe(`${path} 200 true`);
    }
    const join = await page(p, "/join");
    expect(join.status).toBe(200);
    expect(join.html).not.toContain("analytics.js");

    // A held message's page.
    const ada = p.people.byExternalId("acct-ada")!;
    const one = addAppAgent(p, ada, "one");
    addAppAgent(p, ada, "two", { approvalRequired: true });
    const held = p.messages.send(one.agent, { to: "two", subject: "s", text: "t" }).message;
    expect(held.status).toBe("held");
    const heldPage = await page(p, `/held/${held.id}`, cookie);
    expect(heldPage.status).toBe(200);
    expect(heldPage.html).not.toContain("analytics.js");

    // No policy changed for the script: it is Portico's own, and reports to Portico.
    const res = await p.app.request(`${PUBLIC_URL}/settings`, { headers: { cookie } });
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self';");
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self';");
  });

  test("a browser that says Do Not Track or Global Privacy Control gets no script tag", async () => {
    const { p } = start();
    const chris = await addOwner(p);
    const cookie = signIn(p, chris);
    expect((await page(p, "/sign-in")).html).toContain(TAG);
    expect((await page(p, "/sign-in", null, { DNT: "1" })).html).not.toContain("analytics.js");
    expect((await page(p, "/sign-in", null, { "Sec-GPC": "1" })).html).not.toContain("analytics.js");
    expect((await page(p, "/", cookie)).html).toContain(TAG);
    expect((await page(p, "/", cookie, { DNT: "1" })).html).not.toContain("analytics.js");
    expect((await page(p, "/settings", cookie, { "Sec-GPC": "1" })).html).not.toContain("analytics.js");
  });

  test("the sign-in page as Markdown reads the same with analytics on", async () => {
    const markdown = async (p: ReturnType<typeof makePortico>) => (await p.app.request(`${PUBLIC_URL}/sign-in`, { headers: { accept: "text/markdown" } })).text();
    const on = await markdown(start({ accountCheck: fakeAccounts, setup: false }).p);
    expect(on).toContain("# Sign in to Portico");
    expect(on).not.toContain("analytics");
    expect(on).toBe(await markdown(makePortico({ accountCheck: fakeAccounts, setup: false })));
  });
});

describe("POST /api/analytics", () => {
  test("a page view is sent on as the page's shape, never the address itself", async () => {
    const { p, events, keys } = start();
    const chris = await addOwner(p);
    const grok = addAppAgent(p, chris, "grok-bot");
    const paths: [string, string][] = [
      ["/", "/"],
      ["/sign-in", "/sign-in"],
      ["/welcome", "/welcome"],
      ["/activity", "/activity"],
      ["/settings", "/settings"],
      [`/a/${grok.agent.id}`, "/a/:id"],
      [`/p/${p.workspaces.personal(chris.id).id}`, "/p/:id"],
      ["/c/consent-id-1234", "other"],
      ["/held/message-id", "other"],
      ["/share", "other"],
      ["/sign-in?next=/c/secret-request", "other"],
      ["/a/x#secret-fragment", "other"],
      ["/a/one/two", "other"],
    ];
    for (const [path] of paths) {
      const res = await report(p, { event: "pageview", anon_id: "anon-12345678", path });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    const sent = (await events()).filter((e) => e.event === "$pageview");
    expect(sent.map((e) => e.properties.$pathname)).toEqual(paths.map(([, shape]) => shape));
    expect(sent[5]!.properties.$current_url).toBe(`${PUBLIC_URL}/a/:id`);
    expect(sent[7]!.properties.$current_url).toBe(PUBLIC_URL);
    expect(sent.every((e) => e.distinct_id === "anon-12345678" && e.properties.signed_in === false)).toBe(true);
    expect(keys(sent[0]!)).toEqual(["$current_url", "$pathname", "signed_in"]);
    const all = JSON.stringify(sent);
    for (const never of [grok.agent.id, "secret", "consent-id", "message-id", "next="]) expect(all).not.toContain(never);
  });

  test("signed in, the event is the person's; the sign-in page's own event goes on by name", async () => {
    const { p, events } = start();
    const chris = await addOwner(p);
    const cookie = signIn(p, chris);
    await report(p, { event: "pageview", anon_id: "anon-12345678", path: "/settings" }, { cookie });
    await report(p, { event: "pageview", path: "/activity" }, { cookie });
    await report(p, { event: "sign_in_viewed", anon_id: "anon-12345678", path: "/sign-in" });
    const sent = await events();
    expect(sent.map((e) => [e.event, e.distinct_id, e.properties.signed_in, e.properties.$pathname])).toEqual([
      ["$pageview", chris.id, true, "/settings"],
      ["$pageview", chris.id, true, "/activity"],
      ["sign_in_viewed", "anon-12345678", false, "/sign-in"],
    ]);
  });

  test("the referrer is cut to its host, and campaign tags are checked one by one", async () => {
    const { p, events, keys } = start();
    await report(p, {
      event: "pageview",
      anon_id: "anon-12345678",
      path: "/sign-in",
      referrer: "https://news.example.org/item?id=123#comment",
      utm: { source: "newsletter", medium: "email", campaign: "launch week", term: "<script>", content: "x".repeat(101), extra: "no" },
    });
    await report(p, { event: "pageview", anon_id: "anon-12345678", path: "/", referrer: `${PUBLIC_URL}/c/secret-request`, utm: "source=x" });
    await report(p, { event: "pageview", anon_id: "anon-12345678", path: "/", referrer: "javascript:alert(1)" });
    await report(p, { event: "pageview", anon_id: "anon-12345678", path: "/", referrer: "not an address" });
    const sent = await events();
    expect(keys(sent[0]!)).toEqual(["$current_url", "$pathname", "$referring_domain", "$set_once", "signed_in", "utm_campaign", "utm_medium", "utm_source"]);
    expect(sent[0]!.properties).toMatchObject({
      $referring_domain: "news.example.org",
      utm_source: "newsletter",
      utm_medium: "email",
      utm_campaign: "launch week",
      $set_once: { initial_utm_source: "newsletter", initial_utm_medium: "email", initial_utm_campaign: "launch week" },
    });
    // Portico's own pages are no referrer, and nothing else that isn't a web address is.
    for (const e of sent.slice(1)) expect(keys(e)).toEqual(["$current_url", "$pathname", "signed_in"]);
    expect(JSON.stringify(sent)).not.toContain("secret-request");
    expect(JSON.stringify(sent)).not.toContain("comment");
  });

  test("dropped, and still 204: Do Not Track, Global Privacy Control, a bad ID, an unknown event, a body that isn't the form", async () => {
    const { p, events, posts } = start();
    const good = { event: "pageview", anon_id: "anon-12345678", path: "/" };
    const dropped: [unknown, Record<string, string>][] = [
      [good, { DNT: "1" }],
      [good, { "Sec-GPC": "1" }],
      [{ ...good, anon_id: "short" }, {}],
      [{ ...good, anon_id: "has spaces in the id" }, {}],
      [{ ...good, anon_id: "x".repeat(129) }, {}],
      [{ ...good, anon_id: 12345678 }, {}],
      [{ event: "pageview", path: "/" }, {}],
      [{ ...good, event: "clicked" }, {}],
      [{ ...good, event: "$identify" }, {}],
      ["not json", {}],
      ["[]", {}],
      ["null", {}],
      [{ ...good, padding: "x".repeat(2100) }, {}],
    ];
    for (const [body, headers] of dropped) {
      const res = await report(p, body, headers);
      expect(res.status).toBe(204);
    }
    expect(await events()).toEqual([]);
    expect(posts.sent).toEqual([]);
    // Another site can't report here at all.
    expect((await report(p, good, { origin: "https://evil.example" })).status).toBe(403);
    expect(await events()).toEqual([]);
  });

  test("600 an hour from one address, then dropped until the hour moves on", async () => {
    const { p, named } = start();
    const good = { event: "pageview", anon_id: "anon-12345678", path: "/" };
    for (let n = 0; n < 605; n++) expect((await report(p, good)).status).toBe(204);
    expect(await named("$pageview")).toHaveLength(600);
    p.clock.advance(61 * 60_000);
    await report(p, good);
    expect(await named("$pageview")).toHaveLength(601);
  });
});

describe("what goes to PostHog", () => {
  test("a batch to <host>/batch/ with the key, and each event's ID, time and environment", async () => {
    const { p, posts } = start();
    p.analytics.capture("thing_happened", "person-1", { kind: "agent", count: 3, ok: true, none: null, missing: undefined, long: "x".repeat(500) });
    p.analytics.identify("person-1", "anon-12345678");
    // Not an anonymous ID, or the person's own: nothing to tie together.
    p.analytics.identify("person-1", "bad id");
    p.analytics.identify("person-1", "person-1");
    await p.analytics.flush();
    expect(posts.sent).toHaveLength(1);
    expect(posts.sent[0]!.url).toBe("https://ph.example.com/batch/");
    expect(posts.sent[0]!.headers).toEqual({ "content-type": "application/json" });
    const body = JSON.parse(posts.sent[0]!.body) as { api_key: string; batch: Sent[] };
    expect(Object.keys(body).sort()).toEqual(["api_key", "batch"]);
    expect(body.api_key).toBe("phc_test_key");
    expect(body.batch).toEqual([
      {
        event: "thing_happened",
        distinct_id: "person-1",
        timestamp: T0.toISOString(),
        properties: { kind: "agent", count: 3, ok: true, none: null, long: "x".repeat(200), environment: "dev", $lib: "portico-server", $geoip_disable: true },
      },
      {
        event: "$identify",
        distinct_id: "person-1",
        timestamp: T0.toISOString(),
        properties: { $anon_distinct_id: "anon-12345678", environment: "dev", $lib: "portico-server", $geoip_disable: true },
      },
    ]);
    // Nothing waits: a second flush posts nothing.
    await p.analytics.flush();
    expect(posts.sent).toHaveLength(1);
  });

  test("50 waiting events leave at once; a slow PostHog costs the oldest events beyond 1,000, and a failed post is logged without its events", async () => {
    const sent: WebhookRequest[] = [];
    let release: (result: WebhookResult) => void = () => {};
    let slow = true;
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    const analytics = new Analytics({
      config: CONFIG,
      now: () => T0,
      log: (level, msg, fields) => lines.push(JSON.stringify({ level, msg, ...fields })),
      post: (req) => {
        sent.push(req);
        return slow ? new Promise<WebhookResult>((resolve) => (release = resolve)) : Promise.resolve({ status: 200, body: "" });
      },
    });
    for (let n = 0; n < 49; n++) analytics.capture("e", "p", { n });
    expect(sent).toHaveLength(0);
    analytics.capture("e", "p", { n: 49 });
    expect(sent).toHaveLength(1);
    // The first post hangs while 1,100 more arrive.
    for (let n = 50; n < 1150; n++) analytics.capture("e", "p", { n });
    expect(sent).toHaveLength(1);
    slow = false;
    release({ status: 503, body: "" });
    await analytics.flush();
    const numbers = sent.slice(1).flatMap((req) => (JSON.parse(req.body) as { batch: Sent[] }).batch.map((e) => e.properties.n as number));
    expect(numbers).toHaveLength(1000);
    expect(numbers[0]).toBe(150);
    expect(numbers.at(-1)).toBe(1149);
    expect(sent.every((req) => (JSON.parse(req.body) as { batch: Sent[] }).batch.length <= 50)).toBe(true);
    // The failed post: one line, with the status and a count, and nothing of what the events said.
    expect(lines).toEqual([JSON.stringify({ level: "warn", msg: "analytics_flush_failed", status: 503, events: 50 })]);
  });

  test("a post that rejects or answers nothing never reaches the caller", async () => {
    const lines: string[] = [];
    let mode: "reject" | "none" = "reject";
    const analytics = new Analytics({
      config: CONFIG,
      now: () => T0,
      log: (_level, msg, fields) => lines.push(`${msg} ${JSON.stringify(fields)}`),
      post: () => (mode === "reject" ? Promise.reject(new TypeError("network down phc_test_key")) : Promise.resolve({ status: null, error: "timeout" })),
    });
    analytics.capture("e", "p");
    await analytics.flush();
    mode = "none";
    analytics.capture("e", "p");
    await analytics.flush();
    expect(lines).toEqual(['analytics_flush_failed {"error":"TypeError","events":1}', 'analytics_flush_failed {"error":"timeout","events":1}']);
  });
});

describe("a capture can't break a request", () => {
  test("a capture that throws, and a post that rejects, leave every answer as it was", async () => {
    const p = makePortico({
      config: { analytics: CONFIG },
      accountCheck: fakeAccounts,
      setup: false,
      analyticsPost: () => Promise.reject(new Error("down")),
    });
    const run = async () => {
      const session = await callPerson(p, null, "POST", "/api/session", { token: `account:acct-${p.people.list().length}:x${p.people.list().length}@example.com:Ada`, anon_id: "anon-12345678" });
      expect(session.status).toBe(200);
      const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0]!;
      const handle = `ada${p.people.list().length}`;
      expect((await callPerson(p, cookie, "POST", "/api/welcome", { name: "Ada", handle })).status).toBe(200);
      const joined = await finishJoin(p, cookie, await askToJoin(p, { kind: "agent", name: "helper" }), { mine: true });
      const ada = p.people.list().at(-1)!;
      addAppAgent(p, ada, "second");
      const send = await callAs(p, { token: joined.token }, "POST", "/mcp", tool("send_message", { to: "second", subject: "s", text: "t" }));
      expect(((await send.json()) as { result: { isError: boolean } }).result.isError).toBe(false);
      expect((await callAs(p, { token: joined.token }, "POST", "/mcp", tool("no_such_tool"))).status).toBe(200);
      expect((await callAs(p, { token: joined.token }, "GET", "/api/agent/agents")).status).toBe(200);
      expect((await callAs(p, { token: joined.token }, "POST", "/api/agent/messages", { to: "second", subject: "s", text: "t" })).status).toBe(201);
      expect((await report(p, { event: "pageview", anon_id: "anon-12345678", path: "/" })).status).toBe(204);
      await flush();
      await p.analytics.flush();
    };
    // The post rejects.
    await run();
    // And every capture throws.
    p.analytics.capture = () => {
      throw new Error("boom");
    };
    p.analytics.identify = () => {
      throw new Error("boom");
    };
    await run();
  });
});

describe("server events", () => {
  /** Hosted sign-in: an account signs in, and the cookie comes back. */
  const signInWith = async (p: ReturnType<typeof makePortico>, token: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const res = await p.app.request(`${PUBLIC_URL}/api/session`, {
      method: "POST",
      headers: { host: "portico.example.com", origin: PUBLIC_URL, "content-type": "application/json", ...headers },
      body: JSON.stringify({ token, ...extra }),
    });
    expect(res.status).toBe(200);
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  /** Each event's keys besides the three every event has: the ones always there, and the ones there only sometimes. */
  const SHAPES: Record<string, { always: string[]; sometimes?: string[] }> = {
    $identify: { always: ["$anon_distinct_id"] },
    signed_up: { always: [] },
    welcome_completed: { always: ["via"] },
    portico_created: { always: ["kind", "portico_id", "via"] },
    join_code_created: { always: ["agent_kind", "kind"] },
    agent_joined: { always: ["agent_kind", "kind", "vouched"], sometimes: ["agent_id", "computer_id"] },
    approval_decided: { always: ["decision", "kind"], sometimes: ["held_for"] },
    message_sent: { always: ["agent_id", "cross_owner", "delivery", "has_files", "is_reply", "no_reply_needed", "portico_id", "to_agent_id"], sometimes: ["held_for"] },
    first_message_sent: { always: ["agent_id", "cross_owner", "delivery", "has_files", "is_reply", "no_reply_needed", "portico_id", "to_agent_id"], sometimes: ["held_for"] },
    task_completed: { always: ["by_agent_id", "cross_owner", "minutes", "task_id"] },
    mcp_tool_called: { always: ["agent_id", "agent_kind", "agent_type", "client_name", "client_version", "duration_ms", "outcome", "tool_name"], sometimes: ["error_code"] },
    agent_api_called: { always: ["agent_id", "agent_kind", "agent_type", "duration_ms", "method", "outcome", "route", "status"], sometimes: ["tool_name"] },
    $pageview: { always: ["$current_url", "$pathname", "signed_in"] },
    sign_in_viewed: { always: ["$current_url", "$pathname", "signed_in"] },
  };

  test("a whole first hour: every event once, with only its documented keys, and nothing anyone wrote", async () => {
    const { p, events, keys } = start({ accountCheck: fakeAccounts, setup: false });
    // Text people and agents wrote, each a word found nowhere else.
    const wrote = {
      name: "Adalovelace Byronsdottir",
      handle: "zqxhandle",
      email: "countess@difference-engine.example",
      agent: "babbage-helper",
      second: "jacquard-loom",
      subject: "Quarterly figures for the Bernoulli numbers",
      text: "The engine weaves algebraical patterns",
      summary: "Punched the cards and ran the mill",
      file: "bernoulli-notes.txt",
      fileText: "note G, diagram of the computation",
      portico: "Analytical Society",
      doing: "carding wool for the mill",
      bobName: "Babbagecharles",
      bobSubject: "Request about the difference engine",
      bobText: "Lend the cogwheel drawings",
    };

    // The sign-in page is seen, then the account signs in with the page's anonymous ID.
    await report(p, { event: "sign_in_viewed", anon_id: "anon-visit-0001", path: "/sign-in" });
    await report(p, { event: "pageview", anon_id: "anon-visit-0001", path: "/sign-in" });
    const cookie = await signInWith(p, `account:acct-ada:${wrote.email}:${wrote.name}`, { anon_id: "anon-visit-0001" });
    const ada = p.people.byExternalId("acct-ada")!;
    expect((await callPerson(p, cookie, "POST", "/api/welcome", { name: wrote.name, handle: wrote.handle })).status).toBe(200);
    // Signing in again is no second sign-up, and ties the browser's new ID to the same person.
    await signInWith(p, `account:acct-ada:${wrote.email}:${wrote.name}`, { anon_id: "anon-visit-0002" });

    // An agent joins with the code.
    const asked = await askToJoin(p, { kind: "agent", name: wrote.agent, client: "grok-bot" });
    expect((await answerConsent(p, cookie, asked.id, { decision: "approve", mine: true })).status).toBe(200);
    // Allow pressed again shows the same code, and counts nothing.
    expect((await answerConsent(p, cookie, asked.id, { decision: "approve", mine: true })).status).toBe(200);
    const code = (await joinCodeOn(p, cookie, asked.id))!;
    const joinedRes = await submitJoinCode(p, asked, code);
    expect(joinedRes.status).toBe(200);
    const token = ((await joinedRes.json()) as { token: string }).token;
    const helper = p.agents.ownedBy(ada.id).find((a) => a.name === wrote.agent)!;
    const second = addAppAgent(p, ada, wrote.second);

    // The agent says what it does, uploads a file and sends it; the other agent answers through the REST API.
    const mcp = (body: unknown) => callAs(p, { token }, "POST", "/mcp", body);
    await mcp(tool("update_profile", { doing: wrote.doing }));
    const upload = await toolAnswer<{ file: { id: string } }>(mcp(tool("create_upload", { name: wrote.file, text: wrote.fileText })));
    const sent = await toolAnswer<{ message: { id: string } }>(mcp(tool("send_message", { to: wrote.second, subject: wrote.subject, text: wrote.text, attachments: [upload.file.id] })));
    await flush();
    expect((await callAs(p, { token: second.token }, "GET", "/api/agent/inbox")).status).toBe(200);
    p.clock.advance(7.5 * 60_000);
    expect((await callAs(p, { token: second.token }, "POST", "/api/agent/messages", { reply_to: sent.message.id, subject: `Re: ${wrote.subject}`, text: wrote.text, summary: wrote.summary })).status).toBe(201);
    expect((await callAs(p, { token: second.token }, "POST", "/api/agent/portico-tools/list_porticos", {})).status).toBe(200);

    // A Portico made on the page, and another person's agent whose first message is held for Ada.
    const made = await callPerson(p, cookie, "POST", "/api/porticos", { name: wrote.portico });
    expect(made.status).toBeLessThan(300);
    const shared = p.workspaces.forPerson(ada.id).find((w) => w.name === wrote.portico)!;
    await signInWith(p, `account:acct-bob:bob@example.com:${wrote.bobName}`);
    const bob = p.people.setHandle(p.people.byExternalId("acct-bob")!.id, "bobhandle");
    const scout = addAppAgent(p, bob, "scout");
    p.workspaces.admit(shared.id, bob.id);
    p.workspaces.addAgent(ada.id, shared.id, helper.id);
    p.workspaces.addAgent(bob.id, shared.id, scout.agent.id);
    const held = p.messages.send(scout.agent, { to: `${wrote.handle}/${wrote.agent}`, subject: wrote.bobSubject, text: wrote.bobText }).message;
    expect(held).toMatchObject({ status: "held", heldFor: "first_contact" });
    await flush();
    expect((await callPerson(p, cookie, "POST", `/api/approvals/held/${held.id}`, { decision: "allow_once" })).status).toBe(200);
    await report(p, { event: "pageview", anon_id: "anon-visit-0002", path: `/a/${helper.id}` }, { cookie });

    const all = await events();
    const count = (name: string) => all.filter((e) => e.event === name).length;
    const one = (name: string, where: (e: Sent) => boolean = () => true) => {
      const found = all.filter((e) => e.event === name && where(e));
      expect(`${name}: ${found.length}`).toBe(`${name}: 1`);
      return found[0]!;
    };

    // The visit before sign-in becomes Ada's, before the sign-up itself.
    const order = all.map((e) => e.event);
    expect(order.slice(0, 4)).toEqual(["sign_in_viewed", "$pageview", "$identify", "signed_up"]);
    expect(all[2]).toMatchObject({ distinct_id: ada.id, properties: { $anon_distinct_id: "anon-visit-0001" } });
    expect(count("$identify")).toBe(2);
    expect(one("signed_up", (e) => e.distinct_id === ada.id).properties).toMatchObject({ environment: "dev", $lib: "portico-server", $geoip_disable: true });
    expect(one("welcome_completed").properties.via).toBe("welcome");
    // Ada's own Portico and the shared one she starts with, made for her; then the one she made on the page.
    const porticos = all.filter((e) => e.event === "portico_created" && e.distinct_id === ada.id);
    expect(porticos.map((e) => [e.properties.kind, e.properties.via]).sort()).toEqual([
      ["personal", "auto"],
      ["shared", "auto"],
      ["shared", "page"],
    ]);
    expect(porticos.find((e) => e.properties.via === "page")!.properties.portico_id).toBe(shared.id);
    expect(one("join_code_created").properties).toMatchObject({ kind: "agent", agent_kind: "grok-bot" });
    expect(one("agent_joined")).toMatchObject({ distinct_id: ada.id, properties: { agent_id: helper.id, kind: "agent", agent_kind: "grok-bot", vouched: true } });

    const first = one("message_sent", (e) => e.properties.agent_id === helper.id);
    expect(first).toMatchObject({
      distinct_id: ada.id,
      properties: { to_agent_id: second.agent.id, portico_id: p.workspaces.personal(ada.id).id, delivery: "queued", is_reply: false, cross_owner: false, has_files: true, no_reply_needed: false },
    });
    expect(one("first_message_sent", (e) => e.distinct_id === ada.id).properties).toEqual(first.properties);
    expect(one("message_sent", (e) => e.properties.agent_id === second.agent.id).properties).toMatchObject({ is_reply: true, has_files: false });
    // The reply came from the same person: no second first message for her. Bob's is his first.
    expect(count("first_message_sent")).toBe(2);
    expect(one("message_sent", (e) => e.distinct_id === bob.id).properties).toMatchObject({ delivery: "held", held_for: "first_contact", cross_owner: true });
    expect(one("task_completed")).toMatchObject({ distinct_id: ada.id, properties: { task_id: sent.message.id, by_agent_id: second.agent.id, cross_owner: false, minutes: 7 } });
    expect(one("approval_decided")).toMatchObject({ distinct_id: ada.id, properties: { kind: "held_message", decision: "allow_once", held_for: "first_contact" } });

    expect(all.filter((e) => e.event === "mcp_tool_called").map((e) => [e.properties.tool_name, e.properties.outcome])).toEqual([
      ["update_profile", "success"],
      ["create_upload", "success"],
      ["send_message", "success"],
    ]);
    expect(all.filter((e) => e.event === "agent_api_called").map((e) => [e.properties.method, e.properties.route, e.properties.status, e.properties.outcome, e.properties.tool_name])).toEqual([
      ["GET", "/inbox", 200, "success", undefined],
      ["POST", "/messages", 201, "success", undefined],
      ["POST", "/portico-tools/:name", 200, "success", "list_porticos"],
    ]);
    expect(one("$pageview", (e) => e.properties.signed_in === true)).toMatchObject({ distinct_id: ada.id, properties: { $pathname: "/a/:id" } });

    // Every event is one of the documented ones, with its documented keys and nothing more.
    for (const e of all) {
      const shape = SHAPES[e.event];
      expect(`${e.event} ${shape !== undefined}`).toBe(`${e.event} true`);
      const allowed = [...shape!.always, ...(shape!.sometimes ?? [])];
      expect(`${e.event}: ${keys(e).filter((key) => !allowed.includes(key))}`).toBe(`${e.event}: `);
      expect(`${e.event}: ${shape!.always.filter((key) => !(key in e.properties))}`).toBe(`${e.event}: `);
      expect(e.properties).toMatchObject({ environment: "dev", $lib: "portico-server", $geoip_disable: true });
      // An ID is a person's, or the browser's own anonymous one.
      expect([ada.id, bob.id, "anon-visit-0001"]).toContain(e.distinct_id);
    }

    // Nothing anyone wrote left this server: not whole, and not a word of it.
    const everything = JSON.stringify(all).toLowerCase();
    const words = [...Object.values(wrote), code, "bobhandle", "scout", "bob@example.com"].flatMap((value) => [value, ...value.split(/[\s,]+/).filter((word) => word.length >= 6)]);
    for (const word of words) expect(`${word}: ${everything.includes(word.toLowerCase())}`).toBe(`${word}: false`);
  });

  test("only a real anonymous ID is tied to the person", async () => {
    const { p, events } = start({ accountCheck: fakeAccounts, setup: false });
    await signInWith(p, "account:acct-3:three@example.com:Three", { anon_id: "not an id" });
    await signInWith(p, "account:acct-4:four@example.com:Four");
    await signInWith(p, "account:acct-5:five@example.com:Five", { anon_id: "anon-12345678" });
    expect((await events()).map((e) => e.event)).toEqual(["signed_up", "signed_up", "$identify", "signed_up"]);
  });

  test("Do Not Track or Global Privacy Control at sign-in leaves the person out of everything, across a restart, until a visit without either", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "portico-analytics-"));
    const posts = fakeWebhooks();
    const open = () => makePortico({ dataDir, config: { analytics: CONFIG }, analyticsPost: posts.post, accountCheck: fakeAccounts, setup: false });
    const sent = async (p: ReturnType<typeof makePortico>) => {
      await flush();
      await p.analytics.flush();
      return posts.sent.flatMap((req) => (JSON.parse(req.body) as { batch: Sent[] }).batch);
    };
    let p = open();
    const ada = await signInWith(p, "account:acct-ada:ada@example.com:Ada", { anon_id: "anon-12345678" }, { DNT: "1" });
    const bob = await signInWith(p, "account:acct-bob:bob@example.com:Bob", { anon_id: "anon-87654321" }, { "Sec-GPC": "1" });
    const adaId = p.people.byExternalId("acct-ada")!.id;
    const bobId = p.people.byExternalId("acct-bob")!.id;
    expect(p.settings.get("analytics_opt_out")).toBe(JSON.stringify([adaId, bobId]));
    // A browser sends its preference with every request, so every call of Ada's and Bob's carries it.
    const adaBrowser = browserWith(p, { DNT: "1" });
    for (const [browser, cookie, handle] of [[adaBrowser, ada, "ada"], [browserWith(p, { "Sec-GPC": "1" }), bob, "bob"]] as const) {
      expect((await callPerson(browser, cookie, "POST", "/api/welcome", { name: "A Person", handle })).status).toBe(200);
    }
    const joined = await finishJoin(adaBrowser as never, ada, await askToJoin(p, { kind: "agent", name: "helper" }), { mine: true });
    const second = addAppAgent(p, p.people.require(adaId), "second");
    const mcp = (q: ReturnType<typeof makePortico>, body: unknown) => callAs(q, { token: joined.token }, "POST", "/mcp", body);
    const message = await toolAnswer<{ message: { id: string } }>(mcp(p, tool("send_message", { to: "second", subject: "s", text: "t" })));
    expect((await callAs(p, { token: second.token }, "POST", "/api/agent/messages", { reply_to: message.message.id, subject: "s", text: "t" })).status).toBe(201);
    // The browser module isn't on the page, and a report sent anyway is dropped.
    expect((await page(p, "/", ada, { DNT: "1" })).html).not.toContain("analytics.js");
    await report(p, { event: "pageview", anon_id: "anon-12345678", path: "/" }, { cookie: ada, DNT: "1" });
    // Someone else, with neither header, is counted as ever.
    await signInWith(p, "account:acct-cy:cy@example.com:Cy");
    const cyId = p.people.byExternalId("acct-cy")!.id;
    expect((await sent(p)).map((e) => [e.event, e.distinct_id])).toEqual([["signed_up", cyId]]);

    // A restart: the same data folder, a new process's memory.
    p.close();
    p.db.close();
    p = open();
    await mcp(p, tool("list_agents"));
    expect((await callAs(p, { token: second.token }, "GET", "/api/agent/agents")).status).toBe(200);
    expect(await sent(p)).toHaveLength(1);

    // Ada comes back with a browser that says neither: counted again, and her page loads the module.
    expect((await page(p, "/", ada)).html).toContain(TAG);
    expect(p.settings.get("analytics_opt_out")).toBe(JSON.stringify([bobId]));
    await mcp(p, tool("list_agents"));
    expect((await callAs(p, { token: second.token }, "GET", "/api/agent/agents")).status).toBe(200);
    await report(p, { event: "pageview", anon_id: "anon-12345678", path: "/" }, { cookie: ada });
    expect((await sent(p)).slice(1).map((e) => [e.event, e.distinct_id])).toEqual([
      ["mcp_tool_called", adaId],
      ["agent_api_called", adaId],
      ["$pageview", adaId],
    ]);
    // And out again with the header on any page that counts; a second such visit writes nothing new.
    await page(p, "/settings", ada, { "Sec-GPC": "1" });
    await page(p, "/settings", ada, { "Sec-GPC": "1" });
    expect(p.settings.get("analytics_opt_out")).toBe(JSON.stringify([bobId, adaId]));
    await mcp(p, tool("list_agents"));
    expect(await sent(p)).toHaveLength(4);
    // A person who is removed isn't kept on the list.
    p.people.remove(bobId);
    expect(p.settings.get("analytics_opt_out")).toBe(JSON.stringify([adaId]));
    p.close();
    p.db.close();
  });

  test("with analytics off, a browser's preference is never written down", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    expect((await page(p, "/", signIn(p, chris), { DNT: "1" })).status).toBe(200);
    expect((await callPerson(p, null, "POST", "/api/session", { name: "Chris", password: "wrong" })).status).not.toBe(200);
    p.analytics.setOptOut(chris.id, true);
    expect(p.settings.get("analytics_opt_out")).toBeNull();
  });

  test("a server with its own sign-in takes the preference at sign-in too, and drops what already waits", async () => {
    const { p, events } = start();
    const chris = await addOwner(p);
    p.analytics.capture("waiting", chris.id);
    p.analytics.capture("waiting", "someone-else");
    const res = await p.app.request(`${PUBLIC_URL}/api/session`, {
      method: "POST",
      headers: { host: "portico.example.com", origin: PUBLIC_URL, "content-type": "application/json", DNT: "1" },
      body: JSON.stringify({ name: "Chris", password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    p.analytics.capture("later", chris.id);
    p.analytics.identify(chris.id, "anon-12345678");
    expect((await events()).map((e) => [e.event, e.distinct_id])).toEqual([["waiting", "someone-else"]]);
  });

  test("a handle picked on the consent page or a connector's page completes the welcome there", async () => {
    const { p, named, events, keys } = start({ accountCheck: fakeAccounts, setup: false });
    const ada = await signInWith(p, "account:acct-ada:ada@example.com:Ada");
    // A computer joins, and the person picks the handle with the same Allow.
    const asked = await askToJoin(p, { kind: "computer", name: "macbook", client: "codex" });
    const joined = await finishJoin(p, ada, asked, { person: "Ada", handle: "ada" });
    expect(joined.token).toBeString();
    expect((await named("welcome_completed")).map((e) => e.properties.via)).toEqual(["consent"]);
    expect((await named("join_code_created"))[0]!.properties).toMatchObject({ kind: "computer", agent_kind: "codex" });
    const computer = (await named("agent_joined"))[0]!;
    expect(keys(computer)).toEqual(["agent_kind", "computer_id", "kind", "vouched"]);
    expect(computer.properties).toMatchObject({ kind: "computer", agent_kind: "codex", vouched: false, computer_id: joined.computer.id });
    // A second join with the handle already there is no second welcome.
    await finishJoin(p, ada, await askToJoin(p, { kind: "agent", name: "helper" }));
    expect(await named("welcome_completed")).toHaveLength(1);

    // A connector authorised by a person with no handle yet.
    const bob = await signInWith(p, "account:acct-bob:bob@example.com:Bob");
    const registered = await p.app.request(`${PUBLIC_URL}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Duet", redirect_uris: ["http://localhost:4567/callback"], token_endpoint_auth_method: "none" }),
    });
    const clientId = ((await registered.json()) as { client_id: string }).client_id;
    const challenge = createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url");
    const authorize = (cookie: string, fields: Record<string, unknown>) =>
      p.app.request(`${PUBLIC_URL}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: PUBLIC_URL, host: "portico.example.com", cookie },
        body: JSON.stringify({ client_id: clientId, redirect_uri: "http://localhost:4567/callback", code_challenge: challenge, code_challenge_method: "S256", kind: "claude-duet", ...fields }),
      });
    expect((await authorize(bob, { name: "duet", handle: "bob", mine: true })).status).toBe(200);
    expect((await authorize(bob, { name: "duet-2" })).status).toBe(200);
    const bobId = p.people.byExternalId("acct-bob")!.id;
    expect((await named("welcome_completed")).map((e) => [e.distinct_id === bobId, e.properties.via])).toEqual([[false, "consent"], [true, "connector"]]);
    const connectors = (await named("agent_joined")).filter((e) => e.properties.kind === "connector");
    expect(connectors.map((e) => [e.distinct_id, e.properties.agent_kind, e.properties.vouched])).toEqual([[bobId, "claude-duet", true], [bobId, "claude-duet", false]]);
    expect(keys(connectors[0]!)).toEqual(["agent_id", "agent_kind", "kind", "vouched"]);
    // A refused authorisation joins nothing.
    expect((await authorize(bob, { name: "duet" })).status).toBe(409);
    expect((await named("agent_joined")).filter((e) => e.properties.kind === "connector")).toHaveLength(2);
    expect((await events()).filter((e) => e.event === "portico_created").map((e) => e.properties.via)).toEqual(["auto", "auto", "auto", "auto"]);
  });

  test("a consent that isn't a join is an approval decided; a join turned down is one too", async () => {
    const { p, named, keys } = start();
    const chris = await addOwner(p);
    const cookie = signIn(p, chris);
    const grok = addAppAgent(p, chris, "grok-bot");
    const den = p.workspaces.create(chris.id, "Den");
    const deleting = p.consents.ask(grok.agent, "delete", den.id);
    expect((await answerConsent(p, cookie, deleting.id, { decision: "approve" })).status).toBe(200);
    const sharing = p.consents.ask(grok.agent, "share", p.workspaces.create(chris.id, "Other").id);
    expect((await answerConsent(p, cookie, sharing.id, { decision: "deny" })).status).toBe(200);
    const join = await askToJoin(p, { kind: "agent", name: "helper" });
    expect((await answerConsent(p, cookie, join.id, { decision: "deny" })).status).toBe(200);
    // Allowed, then turned down while the code waits.
    const second = await askToJoin(p, { kind: "computer", name: "macbook" });
    expect((await answerConsent(p, cookie, second.id, { decision: "approve" })).status).toBe(200);
    expect((await answerConsent(p, cookie, second.id, { decision: "deny" })).status).toBe(200);
    // An answer that is refused counts nothing.
    expect((await answerConsent(p, cookie, second.id, { decision: "approve" })).status).toBe(409);
    expect((await answerConsent(p, cookie, "no-such-request", { decision: "approve" })).status).toBe(404);

    const decided = await named("approval_decided");
    expect(decided.map((e) => [e.distinct_id, e.properties.kind, e.properties.decision])).toEqual([
      [chris.id, "delete", "allow"],
      [chris.id, "share", "deny"],
      [chris.id, "join", "deny"],
      [chris.id, "join", "deny"],
    ]);
    expect(keys(decided[0]!)).toEqual(["decision", "kind"]);
    expect(await named("join_code_created")).toHaveLength(1);
    expect(await named("agent_joined")).toHaveLength(0);
    // Made by code here, as the page's own call makes one.
    expect((await named("portico_created")).filter((e) => e.properties.via === "page")).toHaveLength(2);
  });

  test("a Portico an agent makes says so, and one that asks first says consent", async () => {
    const { p, named } = start();
    const chris = await addOwner(p);
    const cookie = signIn(p, chris);
    const grok = addAppAgent(p, chris, "grok-bot");
    expect((await callAs(p, { token: grok.token }, "POST", "/api/agent/portico-tools/create_portico", { name: "Made by agent" })).status).toBe(200);
    // An agent nobody vouched for asks its person first.
    p.agents.markUnproven({ agentId: grok.agent.id });
    expect((await callAs(p, { token: grok.token }, "POST", "/api/agent/portico-tools/create_portico", { name: "Asked first" })).status).toBe(200);
    expect((await named("portico_created")).filter((e) => e.properties.via !== "auto").map((e) => e.properties.via)).toEqual(["agent"]);
    const request = p.consents.waitingFor(chris.id)[0]!;
    expect((await answerConsent(p, cookie, request.id, { decision: "approve" })).status).toBe(200);
    expect((await named("portico_created")).filter((e) => e.properties.via !== "auto").map((e) => e.properties.via)).toEqual(["agent", "consent"]);
    expect((await named("approval_decided")).map((e) => [e.properties.kind, e.properties.decision])).toEqual([["create", "allow"]]);
  });

  test("a held message decided each way, with why it was held, also for one let go by the sender's person", async () => {
    const { p, named } = start();
    const chris = await addOwner(p);
    const maya = await addMember(p);
    const cookie = signIn(p, chris);
    const grok = addAppAgent(p, chris, "grok-bot");
    const muse = addAppAgent(p, chris, "muse", { approvalRequired: true });
    const decide = (person: string, id: string, decision: string) => callPerson(p, person, "POST", `/api/approvals/held/${id}`, { decision });
    const send = () => p.messages.send(grok.agent, { to: "muse", subject: "s", text: "t" }).message;
    expect((await decide(cookie, send().id, "deny")).status).toBe(200);
    expect((await decide(cookie, send().id, "always_allow")).status).toBe(200);
    expect((await decide(cookie, "no-such-message", "deny")).status).toBe(404);
    expect((await decide(cookie, send().id, "maybe")).status).toBe(400);

    // Held on its way out for Chris, then held again for Maya: two decisions, each with its own reason.
    const scout = addAppAgent(p, maya, "scout");
    const shared = p.workspaces.create(chris.id, "Launch");
    p.workspaces.admit(shared.id, maya.id);
    p.workspaces.addAgent(chris.id, shared.id, grok.agent.id);
    p.workspaces.addAgent(maya.id, shared.id, scout.agent.id);
    const holding = p.agents.update(chris.id, grok.agent.id, { outboundHold: true });
    const out = p.messages.send(holding, { to: "maya/scout", subject: "s", text: "t" }).message;
    expect(out.heldFor).toBe("outbound");
    expect((await decide(cookie, out.id, "allow_once")).status).toBe(200);
    expect((await decide(signIn(p, maya), out.id, "allow_once")).status).toBe(200);

    expect((await named("approval_decided")).map((e) => [e.distinct_id, e.properties.kind, e.properties.decision, e.properties.held_for])).toEqual([
      [chris.id, "held_message", "deny", "approval"],
      [chris.id, "held_message", "always_allow", "approval"],
      [chris.id, "held_message", "allow_once", "outbound"],
      [maya.id, "held_message", "allow_once", "first_contact"],
    ]);
    // One send is one message_sent, however many times the message was held.
    const sends = (await named("message_sent")).filter((e) => e.properties.to_agent_id === scout.agent.id);
    expect(sends.map((e) => [e.properties.delivery, e.properties.held_for, e.properties.cross_owner])).toEqual([["held", "outbound", true]]);
  });

  test("a task completes once: a final answer from the agent asked, or a note that needs no reply picked up", async () => {
    const { p, named } = start();
    const chris = await addOwner(p);
    const maya = await addMember(p);
    const grok = addAppAgent(p, chris, "grok-bot");
    const scout = addAppAgent(p, maya, "scout");
    together(p, grok.agent, scout.agent);

    const asked = p.messages.send(grok.agent, { to: "maya/scout", subject: "s", text: "t" }).message;
    p.messages.inbox(scout.agent);
    // The asker writing again, and an update with more to come, complete nothing.
    p.messages.send(grok.agent, { replyTo: asked.id, subject: "s", text: "more" });
    const update = p.messages.send(scout.agent, { replyTo: asked.id, subject: "s", text: "working", done: false }).message;
    expect(await named("task_completed")).toHaveLength(0);
    p.clock.advance(3 * 60 * 60_000 + 59_000);
    p.messages.send(scout.agent, { replyTo: update.id, subject: "s", text: "done" });
    p.messages.send(scout.agent, { replyTo: asked.id, subject: "s", text: "done again" });
    const done = await named("task_completed");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ distinct_id: chris.id, properties: { task_id: asked.id, by_agent_id: scout.agent.id, cross_owner: true, minutes: 180 } });

    // A note: done when picked up, not when sent.
    const note = p.messages.send(scout.agent, { to: "chris/grok-bot", subject: "s", text: "fyi", noReplyNeeded: true }).message;
    expect(await named("task_completed")).toHaveLength(1);
    p.clock.advance(2 * 60_000);
    p.messages.inbox(grok.agent);
    const noted = (await named("task_completed"))[1]!;
    expect(noted).toMatchObject({ distinct_id: maya.id, properties: { task_id: note.id, by_agent_id: grok.agent.id, cross_owner: true, minutes: 2 } });
    expect((await named("message_sent")).find((e) => e.properties.no_reply_needed === true)!.properties.agent_id).toBe(scout.agent.id);

    // A final answer that is held completes the task when a person lets it through.
    const muse = addAppAgent(p, chris, "muse", { approvalRequired: true });
    const home = p.messages.send(muse.agent, { to: "grok-bot", subject: "s", text: "t" }).message;
    p.messages.inbox(grok.agent);
    p.clock.advance(25 * 60 * 60_000);
    const late = p.messages.send(grok.agent, { replyTo: home.id, subject: "s", text: "late answer" }).message;
    expect(late.status).toBe("held");
    expect(await named("task_completed")).toHaveLength(2);
    p.approvals.decide(chris.id, late.id, "allow_once");
    const last = (await named("task_completed"))[2]!;
    expect(last).toMatchObject({ distinct_id: chris.id, properties: { task_id: home.id, by_agent_id: grok.agent.id, cross_owner: false } });
  });

  test("first_message_sent is the message with nothing saved before it, from any of the person's agents", async () => {
    const { p, named } = start();
    const chris = await addOwner(p);
    const grok = addAppAgent(p, chris, "grok-bot");
    const muse = addAppAgent(p, chris, "muse");
    // Two messages saved before either notice is handled: the first one is the first, and it is counted.
    const first = p.messages.send(grok.agent, { to: "muse", subject: "s", text: "t" }).message;
    const second = p.messages.send(muse.agent, { to: "grok-bot", subject: "s", text: "t" }).message;
    expect(p.messages.sentEarlier(chris.id, first)).toBeNull();
    expect(p.messages.sentEarlier(chris.id, second)).toBe(first.createdAt);
    const counted = await named("first_message_sent");
    expect(counted).toHaveLength(1);
    expect(counted[0]!.properties.agent_id).toBe(grok.agent.id);
    p.messages.send(grok.agent, { to: "muse", subject: "s", text: "again" });
    expect(await named("first_message_sent")).toHaveLength(1);

    // Another person: nothing of hers is stored, and other people's messages don't count as hers.
    const maya = await addMember(p);
    const scout = addAppAgent(p, maya, "scout");
    addAppAgent(p, maya, "dots");
    const hers = p.messages.send(scout.agent, { to: "dots", subject: "s", text: "t" }).message;
    expect(p.messages.sentEarlier(maya.id, hers)).toBeNull();
    expect(p.messages.sentEarlier("no-such-person", hers)).toBeNull();
    expect((await named("first_message_sent")).map((e) => e.distinct_id)).toEqual([chris.id, maya.id]);
  });

  test("first_message_sent is counted once across a restart, also when the first two messages were saved in one moment", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "portico-analytics-"));
    const posts = fakeWebhooks();
    const open = () => makePortico({ dataDir, config: { analytics: CONFIG }, analyticsPost: posts.post });
    const firsts = async (p: ReturnType<typeof makePortico>) => {
      await flush();
      await p.analytics.flush();
      return posts.sent.flatMap((req) => (JSON.parse(req.body) as { batch: Sent[] }).batch).filter((e) => e.event === "first_message_sent");
    };
    let p = open();
    const chris = await addOwner(p);
    const grok = addAppAgent(p, chris, "grok-bot");
    const muse = addAppAgent(p, chris, "muse");
    p.messages.send(grok.agent, { to: "muse", subject: "s", text: "t" });
    p.messages.send(muse.agent, { to: "grok-bot", subject: "s", text: "t" });
    expect(await firsts(p)).toHaveLength(1);
    p.close();
    p.db.close();
    p = open();
    p.clock.advance(60_000);
    p.messages.send(p.agents.get(grok.agent.id)!, { to: "muse", subject: "s", text: "after the restart" });
    p.messages.send(p.agents.get(muse.agent.id)!, { to: "grok-bot", subject: "s", text: "and once more" });
    expect(await firsts(p)).toHaveLength(1);
  });

  test("a note picked up is completed once: an answer to it later, also after a restart, completes nothing more", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "portico-analytics-"));
    const posts = fakeWebhooks();
    const open = () => makePortico({ dataDir, config: { analytics: CONFIG }, analyticsPost: posts.post });
    const completions = async (p: ReturnType<typeof makePortico>) => {
      await flush();
      await p.analytics.flush();
      return posts.sent.flatMap((req) => (JSON.parse(req.body) as { batch: Sent[] }).batch).filter((e) => e.event === "task_completed");
    };
    let p = open();
    const chris = await addOwner(p);
    const grok = addAppAgent(p, chris, "grok-bot");
    const muse = addAppAgent(p, chris, "muse");
    const note = p.messages.send(grok.agent, { to: "muse", subject: "s", text: "fyi", noReplyNeeded: true }).message;
    p.messages.inbox(muse.agent);
    expect((await completions(p)).map((e) => e.properties.task_id)).toEqual([note.id]);
    // In the same process, and then in a new one: the receiver answers the note after all.
    p.messages.send(muse.agent, { replyTo: note.id, subject: "s", text: "thanks" });
    expect(await completions(p)).toHaveLength(1);
    p.close();
    p.db.close();
    p = open();
    p.messages.send(p.agents.get(muse.agent.id)!, { replyTo: note.id, subject: "s", text: "thanks again" });
    expect(await completions(p)).toHaveLength(1);
  });

  test("a task counted as completed is not counted again after a restart, nor when an answer held earlier is let through", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "portico-analytics-"));
    const posts = fakeWebhooks();
    const open = () => makePortico({ dataDir, config: { analytics: CONFIG }, analyticsPost: posts.post });
    const completions = async (p: ReturnType<typeof makePortico>) => {
      await flush();
      await p.analytics.flush();
      return posts.sent.flatMap((req) => (JSON.parse(req.body) as { batch: Sent[] }).batch).filter((e) => e.event === "task_completed");
    };
    let p = open();
    const chris = await addOwner(p);
    const grok = addAppAgent(p, chris, "grok-bot", { approvalRequired: true });
    const muse = addAppAgent(p, chris, "muse");
    const dots = addAppAgent(p, chris, "dots");
    const asked = p.messages.send(muse.agent, { to: "dots", subject: "s", text: "t" }).message;
    p.messages.inbox(dots.agent);
    p.messages.send(dots.agent, { replyTo: asked.id, subject: "s", text: "done" });
    expect(await completions(p)).toHaveLength(1);

    // A final answer held first, and let through only after another one went through: still one for that task.
    const second = p.messages.send(grok.agent, { to: "dots", subject: "s", text: "t" }).message;
    p.messages.inbox(dots.agent);
    p.clock.advance(25 * 60 * 60_000);
    const held = p.messages.send(dots.agent, { replyTo: second.id, subject: "s", text: "late answer" }).message;
    expect(held.status).toBe("held");
    expect(await completions(p)).toHaveLength(1);
    p.approvals.decide(chris.id, held.id, "always_allow");
    expect((await completions(p)).map((e) => e.properties.task_id)).toEqual([asked.id, second.id]);
    const other = p.messages.send(dots.agent, { replyTo: second.id, subject: "s", text: "and again" }).message;
    expect(other.status).not.toBe("held");
    expect(await completions(p)).toHaveLength(2);

    // A restart: the same data folder, a new process's memory. Another final answer to each task.
    p.close();
    p.db.close();
    p = open();
    const again = p.agents.get(dots.agent.id)!;
    p.messages.send(again, { replyTo: asked.id, subject: "s", text: "done, once more" });
    p.messages.send(again, { replyTo: second.id, subject: "s", text: "done, once more" });
    expect(await completions(p)).toHaveLength(2);
  });
});

describe("a person left out is left out of other people's events, and wherever the preference is seen", () => {
  test("another person's events don't name an opted-out person's agents", async () => {
    const { p, events } = start();
    const bob = await addOwner(p, "Bob");
    const alice = await addMember(p, "Alice");
    const asker = addAppAgent(p, bob, "grok-bot");
    const answerer = addAppAgent(p, alice, "scout");
    together(p, asker.agent, answerer.agent);
    // Alice's browser says Global Privacy Control on any page or call of hers.
    expect((await page(p, "/settings", signIn(p, alice), { "Sec-GPC": "1" })).status).toBe(200);
    expect(p.settings.get("analytics_opt_out")).toBe(JSON.stringify([alice.id]));

    const asked = p.messages.send(asker.agent, { to: "alice/scout", subject: "s", text: "t" }).message;
    expect(asked.status).toBe("pending");
    p.messages.inbox(answerer.agent);
    p.messages.send(answerer.agent, { replyTo: asked.id, subject: "s", text: "done" });

    const all = await events();
    const sent = all.find((e) => e.event === "message_sent")!;
    expect(sent.distinct_id).toBe(bob.id);
    expect(sent.properties).toMatchObject({ agent_id: asker.agent.id, to_agent_id: null, cross_owner: true });
    const done = all.find((e) => e.event === "task_completed")!;
    expect(done.distinct_id).toBe(bob.id);
    expect(done.properties).toMatchObject({ task_id: asked.id, by_agent_id: null, cross_owner: true });
    // Nothing anywhere names Alice or her agent: not as the one an event is about, and not inside someone else's.
    const text = JSON.stringify(all);
    expect(text).not.toContain(alice.id);
    expect(text).not.toContain(answerer.agent.id);
  });

  test("events still waiting lose an agent's ID when that agent's person opts out", async () => {
    const { p, events } = start();
    const bob = await addOwner(p, "Bob");
    const alice = await addMember(p, "Alice");
    const asker = addAppAgent(p, bob, "grok-bot");
    const answerer = addAppAgent(p, alice, "scout");
    together(p, asker.agent, answerer.agent);
    p.messages.send(asker.agent, { to: "alice/scout", subject: "s", text: "t" });
    await flush();
    p.analytics.setOptOut(alice.id, true);
    const sent = (await events()).find((e) => e.event === "message_sent")!;
    expect(sent.properties.to_agent_id).toBeNull();
    expect(JSON.stringify(await events())).not.toContain(answerer.agent.id);
  });

  test("a consent page opened directly records the preference: allowing a join there is not counted, nor what the agent does after", async () => {
    const { p, events } = start();
    const chris = await addOwner(p);
    const cookie = signIn(p, chris);
    // No page with the analytics module was ever opened: the first thing this browser does is the consent page.
    const asked = await askToJoin(p, { kind: "agent", name: "helper" });
    const browser = browserWith(p, { "Sec-GPC": "1" });
    const consent = await browser.app.request(`${PUBLIC_URL}/c/${asked.id}`, { headers: { host: "portico.example.com", cookie } });
    expect(consent.status).toBe(200);
    expect(await consent.text()).not.toContain("analytics.js");
    expect(p.settings.get("analytics_opt_out")).toBe(JSON.stringify([chris.id]));
    const joined = await finishJoin(browser as never, cookie, asked, { mine: true });
    expect(await callAs(p, { token: joined.token }, "POST", "/mcp", tool("list_agents"))).toBeDefined();
    expect((await callAs(p, { token: joined.token }, "GET", "/api/agent/agents")).status).toBe(200);
    expect(await events()).toEqual([]);

    // The same on a call alone, with no page at all: a person's call that says Do Not Track is enough.
    const maya = await addMember(p);
    const hers = signIn(p, maya);
    expect((await callPerson(browserWith(p, { DNT: "1" }), hers, "GET", "/api/me")).status).toBe(200);
    expect(JSON.parse(p.settings.get("analytics_opt_out")!)).toEqual([chris.id, maya.id]);
    // And a request without either brings the person back.
    expect((await callPerson(p, hers, "GET", "/api/me")).status).toBe(200);
    expect(JSON.parse(p.settings.get("analytics_opt_out")!)).toEqual([chris.id]);
  });
});

describe("mcp_tool_called", () => {
  async function world() {
    const s = start();
    const chris = await addOwner(s.p);
    const grok = addAppAgent(s.p, chris, "grok-bot", { kind: "grok-bot" });
    const muse = addAppAgent(s.p, chris, "muse", { approvalRequired: true });
    const dots = addAppAgent(s.p, chris, "dots");
    const mcp = (body: unknown, headers: Record<string, string> = {}, token = grok.token) =>
      s.p.app.request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { ...s, chris, grok, muse, dots, mcp };
  }

  test("one event per call: success, an error with its code, a held send, the rate limit, and a tool Portico doesn't have", async () => {
    const { p, chris, grok, mcp, named, keys } = await world();
    await mcp(tool("list_agents"));
    await mcp(tool("send_message", { to: "nobody-here", subject: "A subject line", text: "argument text" }));
    await mcp(tool("send_message", { to: "muse", subject: "A subject line", text: "argument text" }));
    await mcp(tool("send_message", { to: "dots", subject: "A subject line", text: "argument text" }));
    await mcp(tool("portico_status"));
    const made = await mcp(tool("delete_everything_now", { secret: "argument text" }));
    expect(((await made.json()) as { error: { code: number } }).error.code).toBe(-32602);
    // Not a string at all.
    await mcp(rpc("tools/call", { name: { nested: "argument text" } }));
    // Other methods are no tool call.
    await mcp(rpc("tools/list"));
    await mcp(rpc("ping"));
    // No credential, no person: nothing to count.
    expect((await p.app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tool("list_agents")) })).status).toBe(401);
    // The hourly limit.
    for (let n = 0; n < LIMITS.messagesPerHour + 5; n++) {
      try {
        p.messages.send(grok.agent, { to: "dots", subject: "s", text: "t" });
      } catch {
        break;
      }
      // Past the loop guard between the same two agents.
      p.clock.advance(11 * 60_000);
      if (n % 5 === 4) p.clock.advance(-55 * 60_000);
    }
    const limited = await mcp(tool("send_message", { to: "dots", subject: "A subject line", text: "argument text" }));
    expect(JSON.stringify(await limited.json())).toContain("rate_limited");

    const calls = await named("mcp_tool_called");
    expect(calls.map((e) => [e.properties.tool_name, e.properties.outcome, e.properties.error_code])).toEqual([
      ["list_agents", "success", undefined],
      ["send_message", "error", "unknown_agent"],
      ["send_message", "held", undefined],
      ["send_message", "success", undefined],
      ["portico_status", "success", undefined],
      ["unknown", "error", "unknown_tool"],
      ["unknown", "error", "unknown_tool"],
      ["send_message", "rate_limited", "rate_limited"],
    ]);
    for (const e of calls) {
      expect(e.distinct_id).toBe(chris.id);
      expect(e.properties).toMatchObject({ agent_id: grok.agent.id, agent_type: "app", agent_kind: "grok-bot" });
      expect(typeof e.properties.duration_ms).toBe("number");
      expect(e.properties.duration_ms as number).toBeGreaterThanOrEqual(0);
      expect(keys(e)).toEqual(
        ["agent_id", "agent_kind", "agent_type", "client_name", "client_version", "duration_ms", "outcome", "tool_name", ...(e.properties.error_code === undefined ? [] : ["error_code"])].sort(),
      );
    }
    // Never an argument, nor the name of a tool that isn't Portico's.
    const all = JSON.stringify(calls);
    for (const never of ["argument text", "A subject line", "delete_everything_now", "nobody-here", "nested"]) expect(all).not.toContain(never);
  });

  test("the client's name: from the User-Agent, then from what initialize said, cleaned", async () => {
    const { muse, mcp, named } = await world();
    await mcp(tool("list_agents"));
    await mcp(tool("list_agents"), { "user-agent": "claude-code/2.1.0 (external, cli)" });
    await mcp(tool("list_agents"), { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" });
    await mcp(tool("list_agents"), { "user-agent": "no product token here" });
    await mcp(rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "Dots <b>desktop</b> (beta)\n", version: `1.2.3-${"9".repeat(80)}` } }), { "user-agent": "node" });
    await mcp(tool("list_agents"), { "user-agent": "node" });
    // Another agent's calls never take this one's name.
    await mcp(tool("list_agents"), { "user-agent": "curl/8.5.0" }, muse.token);
    // An initialize without a usable name leaves the header to speak.
    await mcp(rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: 42 } }), {}, muse.token);
    await mcp(tool("list_agents"), { "user-agent": "curl/8.5.0" }, muse.token);
    expect((await named("mcp_tool_called")).map((e) => [e.properties.client_name, e.properties.client_version])).toEqual([
      [null, null],
      ["claude-code", "2.1.0"],
      ["Mozilla", "5.0"],
      [null, null],
      ["Dots bdesktop/b (beta)", `1.2.3-${"9".repeat(54)}`],
      ["curl", "8.5.0"],
      ["curl", "8.5.0"],
    ]);
  });
});

describe("agent_api_called", () => {
  test("one event per REST call, named by the route's pattern, never the path", async () => {
    const { p, named, keys } = start();
    const chris = await addOwner(p);
    const grok = addAppAgent(p, chris, "grok-bot", { kind: "grok-bot" });
    addAppAgent(p, chris, "muse");
    const call = (method: string, path: string, body?: unknown) => callAs(p, { token: grok.token }, method, `/api/agent${path}`, body);
    const sent = (await (await call("POST", "/messages", { to: "muse", subject: "A subject line", text: "body text here" })).json()) as { message: { id: string } };
    expect((await call("GET", `/tasks/${sent.message.id}`)).status).toBe(200);
    expect((await call("GET", "/tasks/no-such-task")).status).toBe(404);
    expect((await call("POST", "/portico-tools/list_porticos", {})).status).toBe(200);
    expect((await call("POST", "/portico-tools/made_up_tool_name", {})).status).toBe(404);
    expect((await call("GET", "/no/such/route")).status).toBe(404);
    expect((await call("POST", "/messages", { to: "muse" })).status).toBe(400);
    // Only sessions report status.
    expect((await call("POST", "/status", { status: "busy" })).status).toBe(403);
    // No credential: no person, no event.
    expect((await p.app.request("/api/agent/agents")).status).toBe(401);
    // The live stream is another router: opening it is not a call here.
    expect((await p.app.request("/api/agent/stream", { headers: { authorization: `Bearer ${grok.token}` } })).status).not.toBe(200);

    const calls = await named("agent_api_called");
    expect(calls.map((e) => [e.properties.method, e.properties.route, e.properties.status, e.properties.outcome, e.properties.tool_name])).toEqual([
      ["POST", "/messages", 201, "success", undefined],
      ["GET", "/tasks/:id", 200, "success", undefined],
      ["GET", "/tasks/:id", 404, "error", undefined],
      ["POST", "/portico-tools/:name", 200, "success", "list_porticos"],
      ["POST", "/portico-tools/:name", 404, "error", undefined],
      ["GET", "other", 404, "error", undefined],
      ["POST", "/messages", 400, "error", undefined],
      ["POST", "/status", 403, "error", undefined],
    ]);
    for (const e of calls) {
      expect(e.distinct_id).toBe(chris.id);
      expect(e.properties).toMatchObject({ agent_id: grok.agent.id, agent_type: "app", agent_kind: "grok-bot" });
      expect(typeof e.properties.duration_ms).toBe("number");
      expect(keys(e)).toEqual(["agent_id", "agent_kind", "agent_type", "duration_ms", "method", "outcome", "route", "status", ...(e.properties.tool_name === undefined ? [] : ["tool_name"])].sort());
    }
    const all = JSON.stringify(calls);
    for (const never of [sent.message.id, "no-such-task", "made_up_tool_name", "A subject line", "body text here", "/no/such"]) expect(all).not.toContain(never);
  });

  test("a refused send for the hourly limit is rate_limited", async () => {
    const { p, named } = start();
    const chris = await addOwner(p);
    const grok = addAppAgent(p, chris, "grok-bot");
    addAppAgent(p, chris, "muse");
    let status = 0;
    for (let n = 0; n < 30 && status !== 429; n++) status = (await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "muse", subject: "s", text: "t" })).status;
    expect(status).toBe(429);
    const last = (await named("agent_api_called")).at(-1)!;
    expect(last.properties).toMatchObject({ route: "/messages", status: 429, outcome: "rate_limited" });
  });
});

describe("the visit ID (web/client/visit-id.ts)", () => {
  const MINUTE = 60_000;
  const fresh = () => "new-visit-id";

  test("a kept ID ends 30 minutes after it was first kept, however often the page is opened", () => {
    const start = 1_800_000_000_000;
    let stored = JSON.stringify(resolveVisit(null, null, start, fresh));
    // Opening the sign-in page every 20 minutes: the ID is used again, and what goes back into storage keeps its first time.
    const again = resolveVisit(null, readKept(stored, start + 20 * MINUTE), start + 20 * MINUTE, () => "another-id");
    expect(again).toEqual({ id: "new-visit-id", at: start });
    stored = JSON.stringify(again);
    expect(readKept(stored, start + 30 * MINUTE - 1)).toEqual({ id: "new-visit-id", at: start });
    expect(readKept(stored, start + 30 * MINUTE)).toBeNull();
    expect(resolveVisit(null, readKept(stored, start + 40 * MINUTE), start + 40 * MINUTE, () => "another-id")).toEqual({ id: "another-id", at: start + 40 * MINUTE });
  });

  test("an ID a link carries replaces a kept one and starts its own time; the same one carried again doesn't start over", () => {
    const kept = { id: "kept-visit-id", at: 1000 };
    expect(resolveVisit("from-the-link", kept, 5000, fresh)).toEqual({ id: "from-the-link", at: 5000 });
    expect(resolveVisit("kept-visit-id", kept, 5000, fresh)).toEqual(kept);
    expect(resolveVisit("no", kept, 5000, fresh)).toEqual(kept);
    expect(resolveVisit("<script>", null, 5000, fresh)).toEqual({ id: "new-visit-id", at: 5000 });
  });

  test("what is kept is read only when it is a visit ID with a time that makes sense", () => {
    for (const raw of [null, "", "not json", "{}", JSON.stringify({ id: "short", at: 1 }), JSON.stringify({ id: "kept-visit-id" }), JSON.stringify({ id: "kept-visit-id", at: 9e15 })]) {
      expect(readKept(raw, 10_000)).toBeNull();
    }
  });
});
