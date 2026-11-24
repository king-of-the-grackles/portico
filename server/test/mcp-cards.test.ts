import { describe, expect, test } from "bun:test";
import { cardPage } from "../src/agent-api/card-page";
import { CARD_MIME_TYPE, CARD_STATES, CARD_URI, cardText, type StatusCard } from "../src/agent-api/cards";
import { appTools, mcpTools, MODERN_PROTOCOL_VERSION, UI_EXTENSION } from "../src/agent-api/mcp";
import { porticoTools } from "../src/agent-api/portico-tools";
import { wakeSteps } from "../src/core/wake-setup";
import type { Person } from "../src/core/types";
import { addAppAgent, addComputer, addMember, addOwner, addSession, answerConsent, askToJoin, callAs, copyProblems, DAY, HOUR, joinCodeOn, makePortico, PUBLIC_URL, signIn, submitJoinCode, type TestPortico, wordProblems } from "./helpers";

/**
 * The status card: portico_status, the page a host draws from its answer, and the text every other client reads.
 * The card shows and links; nothing on the card decides anything.
 */

type Auth = { token: string; key?: string };
type Answer = { content: { type: string; text: string }[]; structuredContent?: StatusCard; isError?: boolean };

function addConnector(p: TestPortico, owner: Person, name: string) {
  const agent = p.agents.create({ ownerId: owner.id, name, kind: "dots", type: "connector" });
  return { agent, token: p.agents.issueToken(agent.id, "api") };
}

async function world() {
  const p = makePortico();
  const chris = await addOwner(p);
  const dot = addConnector(p, chris, "dot");
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  const muse = addAppAgent(p, chris, "muse", { approvalRequired: true });
  const { computer, token: computerToken } = addComputer(p, chris);
  const { key } = addSession(p, computer, { repo: "api" });
  const session: Auth = { token: computerToken, key };
  return { p, chris, dot, grok, muse, session };
}

/** A second person, Maya, with an agent that shares a Portico with Chris's agents. Nobody has allowed the other yet. */
async function withMaya(w: Awaited<ReturnType<typeof world>>) {
  const maya = await addMember(w.p, "Maya");
  const scout = addAppAgent(w.p, maya, "scout");
  const pair = w.p.workspaces.create(w.chris.id, "Pair");
  w.p.workspaces.admit(pair.id, maya.id);
  for (const agent of [w.dot.agent, w.grok.agent]) w.p.workspaces.addAgent(w.chris.id, pair.id, agent.id);
  w.p.workspaces.addAgent(maya.id, pair.id, scout.agent.id);
  return { maya, scout, pair };
}

const legacy = async (p: TestPortico, who: Auth, method: string, params: unknown = {}) => {
  const res = await callAs(p, who, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params });
  return { status: res.status, body: (await res.json()) as { result?: Record<string, any>; error?: { code: number; message: string; data?: unknown } } };
};

const modern = async (p: TestPortico, who: Auth, method: string, params: Record<string, unknown> = {}) => {
  const meta = { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION, "io.modelcontextprotocol/clientCapabilities": {} };
  const res = await p.app.request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${who.token}`, "content-type": "application/json", "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "mcp-method": method },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
  });
  return { status: res.status, body: (await res.json()) as { result?: Record<string, any>; error?: { code: number; message: string } } };
};

const tool = async (p: TestPortico, who: Auth, name: string, args: Record<string, unknown> = {}): Promise<Answer> =>
  (await legacy(p, who, "tools/call", { name, arguments: args })).body.result as Answer;
const status = (p: TestPortico, who: Auth, args: Record<string, unknown> = {}) => tool(p, who, "portico_status", args);
const sent = (answer: Answer) => (JSON.parse(answer.content[0]!.text) as { message: { id: string }; delivery: string }).message.id;
const texts = (answer: Answer) => answer.content.map((block) => block.text);

describe("the tool list", () => {
  test("portico_status names the card's page and says it only reads; no other tool gained _meta or a hint", async () => {
    const { p, dot, grok } = await world();
    for (const who of [dot, grok]) {
      const tools = (await legacy(p, who, "tools/list")).body.result!.tools as { name: string; _meta?: unknown; annotations?: unknown; inputSchema: { properties: Record<string, unknown> } }[];
      const card = tools.find((t) => t.name === "portico_status")!;
      expect(card._meta).toEqual({ ui: { resourceUri: "ui://portico/status-v1.html" } });
      expect(card.annotations).toEqual({ readOnlyHint: true });
      expect(Object.keys(card.inputSchema.properties)).toEqual(["message", "request"]);
      const others = tools.filter((t) => t.name !== "portico_status");
      expect(others.length).toBeGreaterThan(15);
      for (const other of others) expect([other.name, other._meta, other.annotations]).toEqual([other.name, undefined, undefined]);
    }
    const modernTools = (await modern(p, dot, "tools/list")).body.result!.tools as { name: string; _meta?: unknown }[];
    expect(modernTools.filter((t) => t._meta !== undefined).map((t) => t.name)).toEqual(["portico_status"]);
    expect(CARD_URI).toBe("ui://portico/status-v1.html");
  });

  test("a session isn't offered the tool and can't call it; the plugin's two lists don't hold it", async () => {
    const { p, session } = await world();
    const tools = (await legacy(p, session, "tools/list")).body.result!.tools as { name: string }[];
    expect(tools.map((t) => t.name)).not.toContain("portico_status");
    expect((await legacy(p, session, "tools/call", { name: "portico_status", arguments: {} })).body.error).toMatchObject({ code: -32602, message: "Unknown tool." });
    // The plugin's tool list is tested to equal these two: the tool is in neither, so the plugin stays as it was.
    expect([...mcpTools(), ...porticoTools()].map((t) => t.name)).not.toContain("portico_status");
    expect(appTools().map((t) => t.name)).toContain("portico_status");
  });

  test("the tool's own words follow the copy rules", () => {
    expect(copyProblems(JSON.stringify(appTools()))).toEqual([]);
    expect(JSON.stringify(appTools())).not.toMatch(/workspace|personal/i);
  });
});

describe("the card's page as a resource", () => {
  test("the initialize-based versions: the capability, resources/list and resources/read", async () => {
    const { p, dot } = await world();
    const init = await legacy(p, dot, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    expect(init.body.result!.capabilities).toEqual({ tools: { listChanged: false }, resources: {}, extensions: { [UI_EXTENSION]: {} } });
    expect((await legacy(p, dot, "resources/list")).body.result).toEqual({
      resources: [{ uri: CARD_URI, name: "portico_status_card", title: "Portico status card", description: expect.any(String), mimeType: "text/html;profile=mcp-app" }],
    });
    expect((await legacy(p, dot, "resources/templates/list")).body.result).toEqual({ resourceTemplates: [] });
    const read = (await legacy(p, dot, "resources/read", { uri: CARD_URI })).body.result!;
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]).toMatchObject({ uri: CARD_URI, mimeType: "text/html;profile=mcp-app" });
    expect(read.contents[0].text).toBe(cardPage(PUBLIC_URL));
    // ChatGPT opens a card's link only to a site the page's resource names, and the page asks for nothing else.
    expect(read.contents[0]._meta).toEqual({ ui: { prefersBorder: false }, "openai/widgetCSP": { connect_domains: [], resource_domains: [], redirect_domains: [PUBLIC_URL] } });
    expect(CARD_MIME_TYPE).toBe("text/html;profile=mcp-app");
  });

  test("2026-07-28: the capability in server/discover, and the same page", async () => {
    const { p, dot } = await world();
    const discover = (await modern(p, dot, "server/discover")).body.result!;
    expect(discover.capabilities).toMatchObject({ tools: {}, resources: {}, extensions: { [UI_EXTENSION]: {} } });
    const list = await modern(p, dot, "resources/list");
    expect(list.status).toBe(200);
    expect(list.body.result).toMatchObject({ resultType: "complete", resources: [{ uri: CARD_URI, mimeType: "text/html;profile=mcp-app" }], ttlMs: HOUR, cacheScope: "public" });
    const read = await modern(p, dot, "resources/read", { uri: CARD_URI });
    expect(read.status).toBe(200);
    expect(read.body.result).toMatchObject({ resultType: "complete", contents: [{ uri: CARD_URI, mimeType: "text/html;profile=mcp-app", text: cardPage(PUBLIC_URL) }] });
    expect((await modern(p, dot, "resources/templates/list")).body.result).toMatchObject({ resultType: "complete", resourceTemplates: [] });
  });

  test("another address is an error in each version's own code, and no token means no page", async () => {
    const { p, dot } = await world();
    for (const uri of ["ui://portico/other.html", "file:///etc/passwd", "", 7]) {
      const old = await legacy(p, dot, "resources/read", { uri });
      expect(old.body.result).toBeUndefined();
      expect(old.body.error).toMatchObject({ code: -32002, message: "Resource not found" });
      const now = await modern(p, dot, "resources/read", { uri });
      expect(now.body.result).toBeUndefined();
      expect(now.body.error).toMatchObject({ code: -32602, message: "Resource not found" });
    }
    const res = await p.app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: CARD_URI } }) });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("<!doctype");
  });
});

describe("the page", () => {
  const page = cardPage(PUBLIC_URL);
  const script = /<script>([\s\S]*)<\/script>/.exec(page)![1]!;

  test("is one document that loads nothing: no address but Portico's own, written in by the server", () => {
    expect(page).toStartWith("<!doctype html>");
    expect(page).toContain(`var ORIGIN = "${PUBLIC_URL}";`);
    expect(page.split(PUBLIC_URL)).toHaveLength(2);
    // Nothing that fetches: no address, no element or style that loads one.
    expect(page.replace(PUBLIC_URL, "")).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(page).not.toMatch(/<(img|link|iframe|object|embed|audio|video|source|form|base|a)\b/i);
    expect(page).not.toMatch(/\b(src|href|srcset|action)\s*=/i);
    expect(/<style>([\s\S]*)<\/style>/.exec(page)![1]).not.toMatch(/url\(|@import|@font-face|image-set/i);
    expect(page.match(/<script/g)).toHaveLength(1);
  });

  test("calls no tool, makes no network request, and sets text only as text", () => {
    expect(script).not.toMatch(/tools\/call|resources\/read|ui\/message|sampling/);
    expect(script).not.toMatch(/\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|\bimport\s*\(|new Image|new Worker/);
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\b|new Function|setAttribute\("(on|src|href|style)/);
    expect(script).not.toMatch(/window\.open\(|location\.(href|assign|replace)|\.submit\(|navigator\./);
    expect(script).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    // Every place the page puts a string on screen.
    expect(script.match(/\.textContent = /g)).toHaveLength(4);
    expect(script).not.toMatch(/createElement|appendChild|cloneNode/);
    // Every message the page can send or act on.
    expect([...new Set(script.match(/"(ui\/[a-z/-]+|ping)"/g))].sort()).toEqual(
      ['"ping"', '"ui/initialize"', '"ui/notifications/host-context-changed"', '"ui/notifications/initialized"', '"ui/notifications/size-changed"', '"ui/notifications/tool-result"', '"ui/open-link"', '"ui/resource-teardown"'],
    );
    // Messages come only from the host's window, and the button opens only what safeLink let through.
    expect(script).toContain("if (event.source !== window.parent) return;");
    expect(script).toContain("url.origin === ORIGIN");
    expect(script.match(/linkUrl/g)!.length).toBeGreaterThan(5);
    expect(script).not.toMatch(/openExternal\(\{ href: (?!linkUrl)/);
    expect(script).toContain('request("ui/open-link", { url: linkUrl })');
  });

  test("a public URL can't end the script, and the page follows the server's address", () => {
    expect(cardPage("https://portico.example.com/base/path")).toContain('var ORIGIN = "https://portico.example.com";');
    expect(cardPage("http://localhost:4000")).toContain('var ORIGIN = "http://localhost:4000";');
    expect(page).not.toContain("__PORTICO_ORIGIN__");
  });
});

describe("joined", () => {
  test("a fresh connector: complete text first, and the same card as data", async () => {
    const { p, dot } = await world();
    const answer = await status(p, dot);
    expect(answer.isError).toBe(false);
    expect(answer.content[0]!.text).toBe(
      [
        "Portico: dot is on Portico",
        "Status: Joined",
        "Joined as dot, managed by “Chris”. Agents that share a Portico with dot can message this agent.",
        "- Not getting new messages automatically yet",
        "- Nothing waits for a decision by “Chris”",
        `Open Portico: ${PUBLIC_URL}/`,
        "Opens portico.example.com.",
      ].join("\n"),
    );
    expect(answer.structuredContent).toEqual({
      state: "joined",
      status: "joined",
      display: { header: "dot is on Portico", note: "Not getting new messages automatically yet." },
      pill: { text: "Joined", tone: "ok" },
      title: "dot is on Portico",
      lines: ["Joined as dot, managed by “Chris”. Agents that share a Portico with dot can message this agent."],
      facts: [
        { text: "Not getting new messages automatically yet", tone: "warn" },
        { text: "Nothing waits for a decision by “Chris”", tone: "ok" },
      ],
      link: { label: "Open Portico", url: `${PUBLIC_URL}/`, primary: false, help: "Opens portico.example.com." },
    });
    expect(answer.content[0]!.text).toBe(cardText(answer.structuredContent!));
    expect(copyProblems(answer.content[0]!.text)).toEqual([]);
  });

  test("a stated schedule, and messages that wait for the person, show on the card", async () => {
    const { p, dot, grok } = await world();
    await tool(p, dot, "set_inbox_schedule", { minutes: 30 });
    await tool(p, grok, "send_message", { to: "muse", subject: "One", text: "t" });
    await tool(p, grok, "send_message", { to: "muse", subject: "Two", text: "t" });
    const card = (await status(p, dot)).structuredContent!;
    expect(card.facts).toEqual([
      { text: "This agent checks for new messages every 30 minutes", tone: "warn" },
      { text: "2 messages wait for a decision by “Chris”", tone: "warn" },
    ]);
    // Home, where the person finds what waits: never which messages, or from whom.
    expect(card.link).toEqual({ label: "Review on Portico", url: `${PUBLIC_URL}/`, primary: true, help: "Opens portico.example.com. Decisions happen there, after “Chris” signs in." });
    expect(JSON.stringify(card)).not.toMatch(/One|Two|grok|muse/);
  });

  test("the tool only reads: asking changes nothing an agent or a person can see", async () => {
    const { p, dot } = await world();
    const before = JSON.stringify([p.agents.get(dot.agent.id), p.messages.unreadCount(dot.agent.id)]);
    await status(p, dot);
    await status(p, dot, { message: "nope" });
    expect(JSON.stringify([p.agents.get(dot.agent.id), p.messages.unreadCount(dot.agent.id)])).toBe(before);
  });

  test("joining ends with the card for a connector, and the join page says so for ChatGPT", async () => {
    const { p } = await world();
    expect(wakeSteps({ publicUrl: PUBLIC_URL, kind: "dots", type: "connector" }).at(-1)).toContain("Then call portico_status once");
    expect(wakeSteps({ publicUrl: PUBLIC_URL, kind: "muse", type: "app" }).join(" ")).not.toContain("portico_status");
    const join = await (await p.app.request("/join")).text();
    const chatgpt = join.slice(join.indexOf("<h2>ChatGPT and dots</h2>"), join.indexOf("<h2>Muse, Grok Bot"));
    expect(chatgpt).toContain("Then call <code>portico_status</code> once");
    expect(join.split("portico_status")).toHaveLength(2);
  });
});

describe("a held message", () => {
  test("the sender's own person decides: the send's answer and the card both carry the message's own page", async () => {
    const { p, chris, dot } = await world();
    const send = await tool(p, dot, "send_message", { to: "muse", subject: "Notes from Tuesday", text: "t" });
    const id = sent(send);
    const link = `${PUBLIC_URL}/held/${id}`;
    // The hold's own sentence, then the page, for every client.
    expect(texts(send)[1]).toStartWith("Held: muse requires approval for new conversations.");
    expect(texts(send)[1]).toEndWith(`“Chris” decides on Portico's page: ${link}`);

    const answer = await status(p, dot, { message: id });
    expect(answer.content[0]!.text).toBe(
      [
        "Portico: Message to muse is held",
        "Status: Held",
        "Subject: Notes from Tuesday",
        "muse requires approval for new conversations.",
        "Nothing is delivered until “Chris” decides on Portico.",
        `The message waits until ${p.messages.get({ agent: dot.agent.id }, id)!.expiresAt}.`,
        `Review on Portico: ${link}`,
        "Opens portico.example.com. Allowing happens there, after “Chris” signs in.",
      ].join("\n"),
    );
    expect(answer.structuredContent).toMatchObject({ state: "message", status: "held", id, quote: "Notes from Tuesday", pill: { text: "Held", tone: "wait" }, link: { label: "Review on Portico", url: link, primary: true } });
    expect(answer.content[0]!.text).toBe(cardText(answer.structuredContent!));
    expect(copyProblems(answer.content[0]!.text)).toEqual([]);
    // The page behind the link is the one that person decides on.
    const held = await p.app.request(`/held/${id}`, { headers: { cookie: signIn(p, chris) } });
    expect(held.status).toBe(200);
  });

  test("the same over REST: the note carries the page", async () => {
    const { p, grok } = await world();
    const res = (await (await callAs(p, grok, "POST", "/api/agent/messages", { to: "muse", subject: "s", text: "t" })).json()) as { message: { id: string }; note: string };
    expect(res.note).toEndWith(`“Chris” decides on Portico's page: ${PUBLIC_URL}/held/${res.message.id}`);
  });

  test("a new agent's first message to another agent of the same person: the link, after whatever the hold's own sentence says", async () => {
    const { p, dot } = await world();
    p.agents.markUnproven({ agentId: dot.agent.id });
    const send = await tool(p, dot, "send_message", { to: "grok", subject: "First", text: "t" });
    const id = sent(send);
    expect(JSON.parse(send.content[0]!.text)).toMatchObject({ delivery: "held" });
    expect(texts(send)[1]).toEndWith(`“Chris” decides on Portico's page: ${PUBLIC_URL}/held/${id}`);
    const card = (await status(p, dot, { message: id })).structuredContent!;
    expect(card.lines[0]).toBe("This agent is new and “Chris” hasn't confirmed this agent yet, so “Chris” is asked once before this agent's first message reaches grok.");
    expect(card.link!.url).toBe(`${PUBLIC_URL}/held/${id}`);
  });

  test("another person decides: no link in the send's answer, and no button on the card", async () => {
    const w = await world();
    const { p, dot } = w;
    await withMaya(w);
    const send = await tool(p, dot, "send_message", { to: "maya/scout", subject: "Hello", text: "t" });
    const id = sent(send);
    expect(texts(send).join("\n")).not.toContain("/held/");
    const answer = await status(p, dot, { message: id });
    expect(answer.structuredContent!.link).toBeUndefined();
    expect(answer.structuredContent!.lines).toEqual([
      "“Maya”, who manages maya/scout, hasn't allowed messages from “Chris”'s agents yet.",
      "Nothing is delivered until “Maya” decides on Portico. Only “Maya” can open that page.",
    ]);
    expect(answer.content[0]!.text).not.toMatch(/https?:/);
    expect(answer.content[0]!.text).toBe(cardText(answer.structuredContent!));
    expect(copyProblems(answer.content[0]!.text)).toEqual([]);
  });

  test("a person who asked to see what an agent sends to other people's agents decides first, with the link", async () => {
    const w = await world();
    const { p, chris, dot } = w;
    await withMaya(w);
    p.agents.update(chris.id, dot.agent.id, { outboundHold: true });
    const send = await tool(p, dot, "send_message", { to: "maya/scout", subject: "Hello", text: "t" });
    const id = sent(send);
    // The outbound hold's own sentence names the page already: the page is said once.
    expect(texts(send).join("\n").split(`${PUBLIC_URL}/held/${id}`)).toHaveLength(2);
    const card = (await status(p, dot, { message: id })).structuredContent!;
    expect(card.lines[0]).toBe("“Chris” asked to see each message this agent sends to other people's agents first.");
    expect(card.link!.url).toBe(`${PUBLIC_URL}/held/${id}`);
  });

  test("once decided, the card says how the message ended, with no button", async () => {
    const { p, chris, dot, muse } = await world();
    const allowed = sent(await tool(p, dot, "send_message", { to: "muse", subject: "First", text: "t" }));
    p.approvals.decide(chris.id, allowed, "allow_once");
    let card = (await status(p, dot, { message: allowed })).structuredContent!;
    expect(card).toMatchObject({ status: "pending", pill: { text: "Allowed", tone: "ok" }, title: "Message to muse is on the way", lines: ["“Chris” allowed the message. muse hasn't picked the message up yet."] });
    expect(card.link).toBeUndefined();
    await tool(p, muse, "check_inbox");
    card = (await status(p, dot, { message: allowed })).structuredContent!;
    expect(card).toMatchObject({ status: "delivered", pill: { text: "Allowed", tone: "ok" }, title: "Message to muse was delivered" });

    const denied = sent(await tool(p, dot, "send_message", { to: "muse", subject: "Second", text: "t" }));
    p.approvals.decide(chris.id, denied, "deny");
    card = (await status(p, dot, { message: denied })).structuredContent!;
    expect(card).toMatchObject({ status: "declined", pill: { text: "Not allowed", tone: "no" }, title: "Message to muse was not delivered", lines: ["“Chris” chose Don't allow on Portico. Nothing was delivered."] });
    expect(card.link).toBeUndefined();

    const late = sent(await tool(p, dot, "send_message", { to: "muse", subject: "Third", text: "t" }));
    p.clock.advance(8 * DAY);
    card = (await status(p, dot, { message: late })).structuredContent!;
    expect(card).toMatchObject({ status: "expired", pill: { text: "Expired", tone: "quiet" }, lines: ["Nobody decided in time. Nothing was delivered."] });
    expect(card.link).toBeUndefined();
  });

  test("a message that was never held says where the message stands", async () => {
    const { p, dot, grok } = await world();
    const id = sent(await tool(p, dot, "send_message", { to: "grok", subject: "Plain", text: "t" }));
    expect((await status(p, dot, { message: id })).structuredContent).toMatchObject({ status: "pending", pill: { text: "Sent", tone: "quiet" }, lines: ["grok hasn't picked the message up yet."] });
    await tool(p, grok, "check_inbox");
    expect((await status(p, dot, { message: id })).structuredContent).toMatchObject({ status: "delivered", pill: { text: "Delivered", tone: "ok" }, lines: ["grok has the message now."] });
  });

  test("a subject full of markup arrives as the plain text it is", async () => {
    const { p, dot } = await world();
    const subject = `<img src=x onerror="alert(1)"><script>fetch('//evil.example')</script>`;
    const id = sent(await tool(p, dot, "send_message", { to: "muse", subject, text: "t" }));
    const answer = await status(p, dot, { message: id });
    expect(answer.structuredContent!.quote).toBe(subject);
    expect(answer.content[0]!.text).toContain(`Subject: ${subject}`);
    // The only address on the card is the one the server wrote.
    expect(answer.structuredContent!.link!.url).toBe(`${PUBLIC_URL}/held/${id}`);
  });
});

describe("a request that waits for the person", () => {
  test("waiting: what was asked, when the request runs out, and the request's own page", async () => {
    const { p, dot } = await world();
    const asked = JSON.parse((await tool(p, dot, "share_portico", { portico: "Chris's shared Portico" })).content[0]!.text) as { request: { id: string; link: string; expires_at: string } };
    const answer = await status(p, dot, { request: asked.request.id });
    expect(answer.content[0]!.text).toBe(
      [
        "Portico: Allow sharing “Chris's shared Portico” with one more person?",
        "Status: Waiting",
        "dot asks “Chris” to allow sharing “Chris's shared Portico” with one more person. Nothing has changed yet.",
        `The request runs out at ${asked.request.expires_at}.`,
        `Review on Portico: ${PUBLIC_URL}/c/${asked.request.id}`,
        "Opens portico.example.com. Allowing happens there, after “Chris” signs in.",
      ].join("\n"),
    );
    expect(asked.request.link).toBe(`${PUBLIC_URL}/c/${asked.request.id}`);
    expect(answer.structuredContent).toMatchObject({ state: "request", status: "pending", id: asked.request.id, ends: { label: "The request runs out at", at: asked.request.expires_at }, link: { url: asked.request.link, primary: true } });
    expect(answer.content[0]!.text).toBe(cardText(answer.structuredContent!));
    expect(copyProblems(answer.content[0]!.text)).toEqual([]);
  });

  test("allowed, turned down and run out: the outcome, no button, and never the share link", async () => {
    const { p, chris, dot } = await world();
    const ask = async (name: string, args: Record<string, unknown>) => (JSON.parse((await tool(p, dot, name, args)).content[0]!.text) as { request: { id: string } }).request.id;
    const shared = await ask("share_portico", { portico: "Chris's shared Portico" });
    const decided = p.consents.decide(chris.id, shared, { decision: "approve" });
    const secret = p.shares.secretFor(chris.id, decided.share!.id)!;
    expect(secret.length).toBeGreaterThan(10);
    const allowed = await status(p, dot, { request: shared });
    expect(allowed.structuredContent).toMatchObject({ status: "approved", pill: { text: "Allowed", tone: "ok" }, title: "Sharing “Chris's shared Portico” with one more person was allowed", lines: ["“Chris” chose Allow on Portico. list_porticos shows the share link to the agent that asked."] });
    expect(allowed.structuredContent!.link).toBeUndefined();
    expect(JSON.stringify(allowed)).not.toContain(secret);
    expect(JSON.stringify(allowed)).not.toContain("/share#");

    const deleted = await ask("delete_portico", { portico: "Chris's shared Portico" });
    p.consents.decide(chris.id, deleted, { decision: "deny" });
    const denied = (await status(p, dot, { request: deleted })).structuredContent!;
    expect(denied).toMatchObject({ status: "denied", pill: { text: "Not allowed", tone: "no" }, lines: ["“Chris” chose Don't allow on Portico. Nothing has changed."] });
    expect(denied.link).toBeUndefined();

    const late = await ask("delete_portico", { portico: "Chris's shared Portico" });
    p.clock.advance(DAY);
    const expired = (await status(p, dot, { request: late })).structuredContent!;
    expect(expired).toMatchObject({ status: "expired", pill: { text: "Ran out", tone: "quiet" }, title: "The request ran out" });
    expect(expired.link).toBeUndefined();
  });
});

describe("only the agent's own", () => {
  test("another agent's message or request, a received message, and an unknown ID all answer not_found the same way", async () => {
    const w = await world();
    const { p, dot, grok, muse } = w;
    const { scout } = await withMaya(w);
    const theirs = sent(await tool(p, scout, "send_message", { to: "chris/grok", subject: "Private zebra", text: "t" }));
    const sameOwner = sent(await tool(p, grok, "send_message", { to: "muse", subject: "Private zebra", text: "t" }));
    const toDot = sent(await tool(p, grok, "send_message", { to: "dot", subject: "Private zebra", text: "t" }));
    const unknown = await status(p, dot, { message: "no-such-id" });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toBeUndefined();
    expect(unknown.content[0]).toEqual({ type: "text", text: "not_found: No such message." });
    for (const id of [theirs, sameOwner, toDot]) expect(await status(p, dot, { message: id })).toEqual(unknown);
    // The receiver doesn't read a held message's standing either.
    expect((await status(p, muse, { message: sameOwner })).content[0]).toEqual(unknown.content[0]!);

    const request = (JSON.parse((await tool(p, grok, "share_portico", { portico: "Pair" })).content[0]!.text) as { request: { id: string } }).request.id;
    const noRequest = await status(p, dot, { request: "no-such-id" });
    expect(noRequest.content[0]).toEqual({ type: "text", text: "not_found: No such request." });
    expect(noRequest.structuredContent).toBeUndefined();
    expect(await status(p, dot, { request })).toEqual(noRequest);
    expect((await status(p, scout, { request })).content[0]).toEqual(noRequest.content[0]!);
    // The asker itself reads the request.
    expect((await status(p, grok, { request })).structuredContent).toMatchObject({ state: "request", status: "pending" });

    expect((await status(p, dot, { message: theirs, request })).content[0]!.text).toBe("bad_request: Give message or request, not both.");
    expect((await status(p, dot, { message: 7 })).content[0]!.text).toBe("bad_request: message must be an ID.");
  });

  test("an agent's own join is never shown, and no answer or page holds a code, a token or a secret", async () => {
    const { p, chris, dot, grok } = await world();
    const cookie = signIn(p, chris);
    // An app agent joins with a link and a code. The request is the agent's own, and its page held the code.
    const asked = await askToJoin(p, { kind: "agent", name: "newcomer", client: "muse" });
    expect((await answerConsent(p, cookie, asked.id, { decision: "approve" })).status).toBe(200);
    const code = (await joinCodeOn(p, cookie, asked.id))!;
    expect(code).toMatch(/^[0-9]{4}$/);
    const joined = (await (await submitJoinCode(p, asked, code)).json()) as { token: string };
    const newcomer = { token: joined.token };
    expect(p.consents.get(asked.id)!.agentId).toBe(p.agents.byAddress("newcomer")!.id);
    const own = await status(p, newcomer, { request: asked.id });
    expect(own).toEqual({ content: [{ type: "text", text: "not_found: No such request." }], isError: true });

    const share = (JSON.parse((await tool(p, dot, "share_portico", { portico: "Chris's shared Portico" })).content[0]!.text) as { request: { id: string } }).request.id;
    const made = p.consents.decide(chris.id, share, { decision: "approve" });
    const held = sent(await tool(p, dot, "send_message", { to: "muse", subject: "s", text: "t" }));
    const everything = JSON.stringify([
      own,
      await status(p, newcomer),
      await status(p, dot),
      await status(p, dot, { message: held }),
      await status(p, dot, { request: share }),
      (await legacy(p, dot, "resources/read", { uri: CARD_URI })).body,
      (await legacy(p, dot, "resources/list")).body,
      appTools().find((t) => t.name === "portico_status"),
    ]);
    for (const secret of [dot.token, grok.token, newcomer.token, asked.poll_secret, p.shares.secretFor(chris.id, made.share!.id)!]) expect(everything).not.toContain(secret);
    expect(everything.match(/pt_[A-Za-z0-9_-]{8,}|poll_secret|Bearer|"code\\?"|\/share#/g)).toBeNull();
    // The four digits appear nowhere on a card: not as a field, and not in any sentence.
    for (const answer of [await status(p, newcomer), await status(p, dot)]) expect(JSON.stringify(answer)).not.toContain(code);
  });

  test("every link an answer carries starts with Portico's public URL", async () => {
    const { p, dot } = await world();
    const held = sent(await tool(p, dot, "send_message", { to: "muse", subject: "s", text: "t" }));
    const share = (JSON.parse((await tool(p, dot, "share_portico", { portico: "Chris's shared Portico" })).content[0]!.text) as { request: { id: string } }).request.id;
    for (const args of [{}, { message: held }, { request: share }]) {
      const answer = await status(p, dot, args);
      expect(answer.structuredContent!.link!.url).toStartWith(`${PUBLIC_URL}/`);
      const addresses = JSON.stringify(answer).match(/https?:\/\/[^\s"\\]+/g) ?? [];
      expect(addresses.length).toBeGreaterThan(1);
      for (const address of addresses) expect(address).toStartWith(`${PUBLIC_URL}/`);
    }
  });
});

describe("the nudge", () => {
  test("a connector is told to show a held message on a card; an app with a token and a session are not", async () => {
    const { p, dot, grok, session } = await world();
    const fromDot = await tool(p, dot, "send_message", { to: "muse", subject: "s", text: "t" });
    expect(texts(fromDot)).toContain(`Then call portico_status with message: "${sent(fromDot)}": in an app that draws cards, the person sees a card that says where the message stands.`);
    for (const who of [grok, session]) {
      const answer = await tool(p, who, "send_message", { to: "muse", subject: "s", text: "t" });
      expect(JSON.parse(answer.content[0]!.text)).toMatchObject({ delivery: "held" });
      expect(texts(answer).join("\n")).not.toContain("portico_status");
      // The link to the message's own page is for every client.
      expect(texts(answer)[1]).toContain(`/held/${sent(answer)}`);
    }
    // A message that isn't held asks for no card.
    expect(texts(await tool(p, dot, "send_message", { to: "grok", subject: "s", text: "t" })).join("\n")).not.toContain("portico_status");
  });

  test("the same for a request that waits: only a connector's answer has the next step", async () => {
    const { p, dot, grok, session } = await world();
    const answer = JSON.parse((await tool(p, dot, "delete_portico", { portico: "Chris's shared Portico" })).content[0]!.text) as { next: string; request: { id: string } };
    expect(answer.next).toBe(`Then call portico_status with request: "${answer.request.id}": in an app that draws cards, the person sees a card that says where the request stands.`);
    for (const who of [grok, session]) {
      const plain = await tool(p, who, "share_portico", { portico: "Chris's shared Portico" });
      expect(JSON.parse(plain.content[0]!.text)).toMatchObject({ status: "waiting_for_person" });
      expect(plain.content[0]!.text).not.toContain("portico_status");
    }
    const rest = await (await callAs(p, grok, "POST", "/api/agent/portico-tools/delete_portico", { portico: "Chris's shared Portico" })).text();
    expect(rest).not.toContain("portico_status");
  });
});

describe("what the card itself shows", () => {
  /** Everything a card draws: the header, the subject, the button's label, and the one quiet line. */
  const drawn = (card: StatusCard) => ({ ...card.display, ...(card.link ? { button: card.link.label } : {}) });

  test("joined: the header and the button, and decisions that wait become the card's point", async () => {
    const { p, dot, grok } = await world();
    expect(drawn((await status(p, dot)).structuredContent!)).toEqual({ header: "dot is on Portico", note: "Not getting new messages automatically yet.", button: "Open Portico" });
    await tool(p, dot, "set_inbox_schedule", { minutes: 30 });
    expect(drawn((await status(p, dot)).structuredContent!)).toEqual({ header: "dot is on Portico", note: "Checks for new messages every 30 minutes.", button: "Open Portico" });
    await tool(p, grok, "send_message", { to: "muse", subject: "One", text: "t" });
    expect(drawn((await status(p, dot)).structuredContent!)).toEqual({ header: "1 message waits for your decision", button: "Review on Portico" });
    await tool(p, grok, "send_message", { to: "muse", subject: "Two", text: "t" });
    expect(drawn((await status(p, dot)).structuredContent!).header).toBe("2 messages wait for your decision");
  });

  test("a held message says 'you' when the agent's own person decides, and names the person when someone else does", async () => {
    const w = await world();
    const { p, chris, dot } = w;
    await withMaya(w);
    const own = sent(await tool(p, dot, "send_message", { to: "muse", subject: "Notes from Tuesday", text: "t" }));
    const expiresAt = p.messages.get({ agent: dot.agent.id }, own)!.expiresAt;
    const ownAnswer = await status(p, dot, { message: own });
    expect(drawn(ownAnswer.structuredContent!)).toEqual({ header: "Your message to muse is held", subject: "Notes from Tuesday", note: "Waits for your decision until", noteAt: expiresAt, button: "Review on Portico" });
    // The text is for the agent, which is not "you": the person stays named there, and the card's own words stay out.
    expect(ownAnswer.content[0]!.text).toContain("Nothing is delivered until “Chris” decides on Portico.");
    expect(ownAnswer.content[0]!.text).not.toMatch(/\byou\b|\byour\b/i);
    expect(JSON.stringify(ownAnswer.structuredContent!.display)).not.toContain("Chris");

    const theirs = sent(await tool(p, dot, "send_message", { to: "maya/scout", subject: "Hello", text: "t" }));
    const other = (await status(p, dot, { message: theirs })).structuredContent!;
    expect(drawn(other)).toEqual({ header: "Your message to maya/scout is held", subject: "Hello", note: "Waits for “Maya” to decide until", noteAt: expiresAt });

    p.agents.markUnproven({ agentId: dot.agent.id });
    const first = sent(await tool(p, dot, "send_message", { to: "grok", subject: "First", text: "t" }));
    expect(drawn((await status(p, dot, { message: first })).structuredContent!)).toEqual({ header: "Your message to grok is held", subject: "First", note: "New agent, not confirmed yet.", button: "Review on Portico" });

    p.approvals.decide(chris.id, own, "deny");
    expect(drawn((await status(p, dot, { message: own })).structuredContent!)).toEqual({ header: "Your message to muse was not allowed", subject: "Notes from Tuesday", note: "You chose Don't allow." });
    p.approvals.decide(chris.id, first, "allow_once");
    expect(drawn((await status(p, dot, { message: first })).structuredContent!)).toEqual({ header: "Your message to grok is on the way", subject: "First" });
  });

  test("a request: what was asked in a few words, the button while the request waits, and the outcome after", async () => {
    const { p, chris, dot } = await world();
    const ask = async (name: string, args: Record<string, unknown>) => (JSON.parse((await tool(p, dot, name, args)).content[0]!.text) as { request: { id: string; expires_at: string } }).request;
    const share = await ask("share_portico", { portico: "Chris's shared Portico" });
    expect(drawn((await status(p, dot, { request: share.id })).structuredContent!)).toEqual({
      header: "Share “Chris's shared Portico” with one more person?",
      note: "Asked by dot. Runs out at",
      noteAt: share.expires_at,
      button: "Review on Portico",
    });
    p.consents.decide(chris.id, share.id, { decision: "approve" });
    expect(drawn((await status(p, dot, { request: share.id })).structuredContent!)).toEqual({ header: "Allowed: share “Chris's shared Portico” with one more person" });
    const gone = await ask("delete_portico", { portico: "Chris's shared Portico" });
    expect(drawn((await status(p, dot, { request: gone.id })).structuredContent!).header).toBe("Delete “Chris's shared Portico”?");
    p.consents.decide(chris.id, gone.id, { decision: "deny" });
    expect(drawn((await status(p, dot, { request: gone.id })).structuredContent!)).toEqual({ header: "Not allowed: delete “Chris's shared Portico”" });
  });

  test("the card's own words follow the copy rules, and never go into the text answer", async () => {
    const { p, dot } = await world();
    const held = sent(await tool(p, dot, "send_message", { to: "muse", subject: "s", text: "t" }));
    for (const args of [{}, { message: held }]) {
      const answer = await status(p, dot, args);
      expect(wordProblems(JSON.stringify(answer.structuredContent!.display))).toEqual([]);
      expect(answer.content[0]!.text).toBe(cardText(answer.structuredContent!));
      expect(cardText({ ...answer.structuredContent!, display: { header: "x" } })).toBe(answer.content[0]!.text);
    }
  });
});

test("the list of card states is the one place a new state is added", () => {
  expect([...CARD_STATES]).toEqual(["joined", "message", "request"]);
});
