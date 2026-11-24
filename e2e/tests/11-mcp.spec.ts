// The MCP endpoint: an agent's token on /mcp, JSON-RPC over HTTP, the same tools as the REST API.
import { BASE_URL } from "../lib/env";
import { CARD_HOST, cardMessages, cardPage, drawCard, openCardHost } from "../lib/card-host";
import { expect, test, unique } from "../lib/fixtures";

let nextId = 1;
async function rpc(token: string | null, method: string, params?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) }),
  });
  const text = await res.text();
  return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
}

/** A tool's answer: MCP wraps the same JSON the REST API gives in one text block. */
async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { status, body } = await rpc(token, "tools/call", { name, arguments: args });
  expect(status).toBe(200);
  expect(body.error, JSON.stringify(body.error)).toBeUndefined();
  expect(body.result.isError ?? false, body.result.content?.[0]?.text).toBe(false);
  return JSON.parse(body.result.content[0].text);
}

test("an agent connects to /mcp with its token, lists agents and sends a message", async ({ world }) => {
  const probe = await world.agent("alice", "probe");
  const helper = await world.agent("alice", "helper");

  // No token, no MCP.
  expect((await rpc(null, "tools/list")).status).toBe(401);

  const hello = await rpc(probe.token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "portico-e2e", version: "1" } });
  expect(hello.status).toBe(200);
  expect(hello.body.result.serverInfo.name).toBe("portico");

  const tools = (await rpc(probe.token, "tools/list")).body.result.tools.map((t: any) => t.name);
  expect(tools).toEqual(expect.arrayContaining(["list_agents", "send_message", "check_inbox", "list_porticos"]));

  const listed = await tool(probe.token, "list_agents");
  expect(listed.agents.map((a: any) => a.name)).toContain("helper");

  const subject = unique("Sent over MCP");
  const sent = await tool(probe.token, "send_message", { to: "helper", subject, text: "Hello from the MCP side." });
  expect(sent.message.subject).toBe(subject);
  expect((await helper.receive(subject)).text).toBe("Hello from the MCP side.");
});

test("a client that draws no cards gets a held message's standing as text, with the link to its page", async ({ world }) => {
  const alice = await world.person("alice");
  const probe = await world.agent("alice", "probe");
  await world.agent("alice", "helper");
  const api = await world.apiFor(alice);
  const helperId = await world.agentId("alice", "helper");
  const requireApproval = (on: boolean) => api.patch(`/api/agents/${helperId}`, { data: { approvalRequired: on } });
  expect((await requireApproval(true)).ok()).toBe(true);
  let held: string | null = null;
  try {
    // A plain client: no capabilities, so nothing says it can draw a card. It never reads the card's page.
    const hello = await rpc(probe.token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "portico-e2e-plain", version: "1" } });
    expect(hello.body.result.capabilities.resources).toEqual({});
    const listed = (await rpc(probe.token, "tools/list")).body.result.tools.find((t: any) => t.name === "portico_status");
    expect(listed._meta).toEqual({ ui: { resourceUri: "ui://portico/status-v1.html" } });
    expect(listed.annotations).toEqual({ readOnlyHint: true });

    const subject = unique("Held over MCP");
    const send = (await rpc(probe.token, "tools/call", { name: "send_message", arguments: { to: "helper", subject, text: "May this go through?" } })).body.result;
    const sent = JSON.parse(send.content[0].text);
    expect(sent.delivery).toBe("held");
    held = sent.message.id;
    const link = `${BASE_URL}/held/${held}`;
    // The send's own answer already carries the page.
    expect(send.content[1].text).toContain(link);

    const status = (await rpc(probe.token, "tools/call", { name: "portico_status", arguments: { message: held } })).body.result;
    expect(status.isError).toBe(false);
    const text: string = status.content[0].text;
    expect(text.split("\n").slice(0, 3)).toEqual(["Portico: Message to helper is held", "Status: Held", `Subject: ${subject}`]);
    expect(text).toContain(`Review on Portico: ${link}`);
    expect(text).not.toMatch(/[{}<>]/);
    expect(status.structuredContent.link.url).toBe(link);

    // With no arguments: that this agent is on Portico, and Home.
    const joined = (await rpc(probe.token, "tools/call", { name: "portico_status", arguments: {} })).body.result;
    expect(joined.content[0].text).toContain("Portico: probe is on Portico\nStatus: Joined\n");
    expect(joined.content[0].text).toContain(`${BASE_URL}/`);

    // Someone else's message, or none: the same answer.
    const other = (await rpc(probe.token, "tools/call", { name: "portico_status", arguments: { message: "00000000-0000-4000-8000-000000000000" } })).body.result;
    expect(other.isError).toBe(true);
    expect(other.content[0].text).toBe("not_found: No such message.");
  } finally {
    if (held) await world.decide("alice", held, "deny");
    await requireApproval(false);
    await api.dispose();
  }
});

test("the card's page, drawn as a host draws it: text only, no request of its own, and one link to Portico", async ({ world, page }) => {
  const alice = await world.person("alice");
  const probe = await world.agent("alice", "probe");
  await world.agent("alice", "helper");
  const api = await world.apiFor(alice);
  const helperId = await world.agentId("alice", "helper");
  const requireApproval = (on: boolean) => api.patch(`/api/agents/${helperId}`, { data: { approvalRequired: on } });
  expect((await requireApproval(true)).ok()).toBe(true);
  let held: string | null = null;
  try {
    const subject = `<img src=x onerror="document.title='hit'"> ${unique("Card")}`;
    const send = (await rpc(probe.token, "tools/call", { name: "send_message", arguments: { to: "helper", subject, text: "t" } })).body.result;
    held = JSON.parse(send.content[0].text).message.id;
    const result = (await rpc(probe.token, "tools/call", { name: "portico_status", arguments: { message: held } })).body.result;
    // The page as the server serves it, under the content policy a host applies when the resource asks for nothing.
    const html = await cardPage(probe.token);

    const HOST = CARD_HOST;
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    // Anything but the stand-in host's own page is refused, and would show in the list below.
    await page.route("**/*", (route) => route.abort());
    await openCardHost(page);
    const draw = (toolResult: unknown) => drawCard(page, html, toolResult, "dark");
    const seen = () => cardMessages(page);
    const card = page.frameLocator("iframe");

    await draw(result);
    await expect(card.getByRole("heading", { level: 1 })).toHaveText("Your message to helper is held");
    // The subject is shown as the text it is: no element came of it, and nothing in it ran.
    await expect(card.locator("#quote")).toHaveText(subject);
    await expect(card.locator("img")).toHaveCount(0);
    expect(await card.locator("html").getAttribute("data-theme")).toBe("dark");
    const link = `${BASE_URL}/held/${held}`;
    // All the card holds: the header, the subject, one button and one quiet line.
    await expect(card.locator("#card > *:visible")).toHaveCount(4);
    await expect(card.locator("button, a, input, [tabindex]")).toHaveCount(1);
    await card.getByRole("button", { name: "Review on Portico" }).click();
    await expect.poll(async () => (await seen()).filter((m) => m.method === "ui/open-link").map((m) => m.params)).toEqual([{ url: link }]);

    // Everything the page said to the host: the handshake, its size and the one link. No tool call.
    const methods = [...new Set((await seen()).map((m) => m.method))];
    expect(methods.sort()).toEqual(["ui/initialize", "ui/notifications/initialized", "ui/notifications/size-changed", "ui/open-link"]);
    expect((await seen()).find((m) => m.method === "ui/initialize").params).toMatchObject({ protocolVersion: "2026-01-26", appCapabilities: {} });

    // A card whose data points anywhere but Portico shows no button, and markup in any field stays text.
    for (const url of ["https://portico.example.net/held/1", "javascript:alert(1)", `${BASE_URL}.evil.example/`, "//evil.example/"]) {
      await draw({ content: [{ type: "text", text: "x" }], structuredContent: { ...result.structuredContent, display: { header: "<b>Bold</b><script>document.title='hit'</script>", subject: "<i>s</i>", note: "<a href='https://evil.example'>here</a>" }, link: { label: "Go", url, primary: true, help: "x" } } });
      await expect(card.getByRole("heading", { level: 1 })).toHaveText("<b>Bold</b><script>document.title='hit'</script>");
      await expect(card.getByRole("button")).toHaveCount(0);
      await expect(card.locator("#note")).toHaveText("<a href='https://evil.example'>here</a>");
      await expect(card.locator("a, b, i, #card script")).toHaveCount(0);
    }
    // An answer with no card data (a refusal) shows its own text.
    await draw({ content: [{ type: "text", text: "not_found: No such message." }], isError: true });
    await expect(card.getByRole("heading", { level: 1 })).toHaveText("not_found: No such message.");
    await expect(card.getByRole("button")).toHaveCount(0);

    expect(await page.title()).toBe("host");
    // The one request of the whole test is the stand-in host's own page: the card asked the network for nothing.
    expect(requests).toEqual([HOST]);
  } finally {
    if (held) await world.decide("alice", held, "deny");
    await requireApproval(false);
    await api.dispose();
  }
});
