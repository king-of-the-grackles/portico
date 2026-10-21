import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BASE_YAML, TOKENS, type TestAgent, makeApp, testConfig } from "./helpers";

let ctx: ReturnType<typeof makeApp>;
let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  ctx = makeApp();
  server = Bun.serve({ port: 0, fetch: ctx.app.fetch });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

async function connect(agent: TestAgent): Promise<Client> {
  const client = new Client({ name: `test-${agent}`, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKENS[agent]}` } },
  });
  await client.connect(transport);
  return client;
}

function text(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content;
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

describe("MCP with the official SDK client", () => {
  test("lists the seven tools, with send_message third", async () => {
    const client = await connect("grok-bot");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_agents",
      "send_task",
      "send_message",
      "check_inbox",
      "finish_task",
      "get_task",
      "report_event",
    ]);
    await client.close();
  });

  test("a full handoff through tool calls", async () => {
    const grok = await connect("grok-bot");
    const claude = await connect("claude-code");

    const sent = await grok.callTool({
      name: "send_task",
      arguments: { to: "claude-code", instructions: "Write the changelog" },
    });
    expect(sent.isError).toBe(false);
    const taskId = JSON.parse(text(sent)).task.id as string;

    const inbox = await claude.callTool({ name: "check_inbox", arguments: {} });
    expect(text(inbox)).toContain(`**Task \`${taskId}\` from agent \`grok-bot\` via the bridge.**`);
    expect(text(inbox)).toContain("Write the changelog");

    const finished = await claude.callTool({
      name: "finish_task",
      arguments: { task_id: taskId, result: "Changelog written." },
    });
    expect(JSON.parse(text(finished)).task.status).toBe("done");

    const back = await grok.callTool({ name: "check_inbox", arguments: {} });
    expect(text(back)).toContain(`Task ${taskId} to claude-code: done`);
    expect(text(back)).toContain("Changelog written.");

    await grok.close();
    await claude.close();
  });

  test("bridge errors come back as tool errors, not protocol errors", async () => {
    const client = await connect("grok-bot");
    const res = await client.callTool({ name: "send_task", arguments: { to: "nobody", instructions: "x" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toStartWith("unknown_agent:");
    await client.close();
  });

  test("list_agents, report_event and get_task through tool calls", async () => {
    const muse = await connect("muse");
    const codex = await connect("codex");
    try {
      const listed = JSON.parse(text(await muse.callTool({ name: "list_agents", arguments: {} })));
      expect(listed.agents.map((agent: { name: string }) => agent.name).sort()).toEqual(["claude-code", "codex", "grok-bot"]);

      const reported = await muse.callTool({
        name: "report_event",
        arguments: { name: "bug_report_received", details: "Login fails" },
      });
      expect(reported.isError).toBe(false);
      const { event, tasks } = JSON.parse(text(reported));
      expect(event.name).toBe("bug_report_received");
      expect(tasks.map((task: { to_agent: string }) => task.to_agent).sort()).toEqual(["claude-code", "grok-bot"]);

      const first = tasks[0].id as string;
      const read = await muse.callTool({ name: "get_task", arguments: { task_id: first } });
      expect(JSON.parse(text(read)).task.id).toBe(first);

      const outsider = await codex.callTool({ name: "get_task", arguments: { task_id: first } });
      expect(outsider.isError).toBe(true);
      expect(text(outsider)).toStartWith("not_allowed:");
    } finally {
      await muse.close();
      await codex.close();
    }
  });
});

describe("MCP endpoint details", () => {
  function rpc(agent: TestAgent | null, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (agent) headers.authorization = `Bearer ${TOKENS[agent]}`;
    return Promise.resolve(ctx.app.request("/mcp", { method: "POST", headers, body: JSON.stringify(body) }));
  }

  const initialize = (protocolVersion: string) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: { name: "t", version: "1" } },
  });

  test("requires a token", async () => {
    const res = await rpc(null, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("echoes a supported protocol version and otherwise offers the newest", async () => {
    const supported = await (await rpc("muse", initialize("2025-06-18"))).json();
    expect(supported.result.protocolVersion).toBe("2025-06-18");
    expect(supported.result.serverInfo.name).toBe("agent-bridge");
    expect(supported.result.capabilities).toEqual({ tools: { listChanged: false } });
    const unknown = await (await rpc("muse", initialize("1999-01-01"))).json();
    expect(unknown.result.protocolVersion).toBe("2025-11-25");
  });

  test("accepts notifications with 202 and no body", async () => {
    const res = await rpc("muse", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("rejects unknown methods, unknown tools and batches", async () => {
    const method = await (await rpc("muse", { jsonrpc: "2.0", id: 2, method: "resources/list" })).json();
    expect(method.error.code).toBe(-32601);
    const tool = await (
      await rpc("muse", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } })
    ).json();
    expect(tool.error.code).toBe(-32602);
    const batch = await rpc("muse", [{ jsonrpc: "2.0", id: 4, method: "ping" }]);
    expect(batch.status).toBe(400);
    expect((await batch.json()).error.code).toBe(-32600);
  });

  test("doesn't offer a server-to-client stream", async () => {
    expect((await ctx.app.request("/mcp")).status).toBe(405);
  });

  test("send_task accepts an idempotency key", async () => {
    const client = await connect("codex");
    const args = { to: "grok-bot", instructions: "Look this up", idempotency_key: "mcp-retry-1" };
    const first = JSON.parse(text(await client.callTool({ name: "send_task", arguments: args })));
    const second = JSON.parse(text(await client.callTool({ name: "send_task", arguments: args })));
    expect(second.task.id).toBe(first.task.id);
  });
});

describe("messages, the live directory and the unread line", () => {
  type ToolResult = { content: { type: string; text: string }[]; isError: boolean };

  async function callTool(app: ReturnType<typeof makeApp>, agent: TestAgent, name: string, args: Record<string, unknown> = {}) {
    const res = await app.call(agent, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return ((await res.json()) as { result: ToolResult }).result;
  }

  const UNREAD = "1 unread on the bridge: call check_inbox.";

  test("send_message's size note follows max_message_kb", async () => {
    const textNote = async (app: ReturnType<typeof makeApp>) => {
      const res = await app.call("muse", "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
      const { tools } = ((await res.json()) as { result: { tools: { name: string; inputSchema: any }[] } }).result;
      return tools.find((tool) => tool.name === "send_message")!.inputSchema.properties.text.description;
    };
    expect(await textNote(makeApp())).toBe("The message, in plain text. Up to 64 KB.");
    const small = makeApp(testConfig(BASE_YAML.replace("triggers:", "limits:\n  max_message_kb: 32\ntriggers:")));
    expect(await textNote(small)).toBe("The message, in plain text. Up to 32 KB.");
  });

  test("send_message returns the message and how it will arrive", async () => {
    const app = makeApp();
    const result = await callTool(app, "grok-bot", "send_message", { to: "muse", text: "Lunch at noon?" });
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      message: { from_agent: "grok-bot", to_agent: "muse", text: "Lunch at noon?", reply_to: null, delivered_at: null },
      delivery: "queued",
    });
  });

  test("send_task returns the delivery tier too", async () => {
    const app = makeApp();
    const result = await callTool(app, "grok-bot", "send_task", { to: "claude-code", instructions: "Write the changelog" });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ task: { status: "queued" }, delivery: "offline" });
  });

  test("a pull caller with mail waiting gets the unread line after any tool but check_inbox, errors included", async () => {
    const app = makeApp();
    app.service.sendTask("claude-code", { to: "grok-bot", instructions: "Research this" });
    const listed = await callTool(app, "grok-bot", "list_agents");
    expect(listed.content).toHaveLength(2);
    expect(listed.content.at(-1)).toEqual({ type: "text", text: UNREAD });
    const failed = await callTool(app, "grok-bot", "send_task", { to: "nobody", instructions: "x" });
    expect(failed.isError).toBe(true);
    expect(failed.content.at(-1)).toEqual({ type: "text", text: UNREAD });

    const inbox = await callTool(app, "grok-bot", "check_inbox");
    expect(inbox.content).toHaveLength(2);
    expect(inbox.content.some((item) => item.text.includes("unread on the bridge"))).toBe(false);
    // Picked up, so nothing is unread now.
    expect((await callTool(app, "grok-bot", "list_agents")).content).toHaveLength(1);
  });

  test("a push caller with waiting work gets no unread line", async () => {
    const app = makeApp();
    app.service.sendTask("grok-bot", { to: "claude-code", instructions: "Write the changelog" });
    app.service.sendMessage("muse", { to: "claude-code", text: "Ping" });
    expect(app.service.unreadCount("claude-code")).toBe(2);
    expect((await callTool(app, "claude-code", "list_agents")).content).toHaveLength(1);
  });

  test("list_agents returns live directory entries", async () => {
    const app = makeApp();
    const { agents } = JSON.parse((await callTool(app, "muse", "list_agents")).content[0]!.text);
    expect(Object.keys(agents[0]).sort()).toEqual([
      "address",
      "branch",
      "delivery",
      "description",
      "doing",
      "kind",
      "last_seen",
      "machine",
      "name",
      "repo",
      "status",
    ]);
    expect(agents.find((a: { name: string }) => a.name === "claude-code")).toMatchObject({
      address: "claude-code",
      kind: "claude-code",
      delivery: "push",
      status: "offline",
    });
  });

  test("check_inbox shows messages in their frames", async () => {
    const app = makeApp();
    const { message } = app.service.sendMessage("grok-bot", { to: "muse", text: "Lunch at noon?" });
    const inbox = await callTool(app, "muse", "check_inbox");
    const [readable, data] = inbox.content;
    expect(readable!.text).toContain("Messages (1):");
    expect(readable!.text).toContain(`<bridge-message id="${message.id}" from="grok-bot">`);
    expect(readable!.text).toContain("Lunch at noon?\n</bridge-message>");
    const parsed = JSON.parse(data!.text);
    expect(parsed.messages.map((m: { id: string }) => m.id)).toEqual([message.id]);
    expect(parsed.messages[0].framed_message).toStartWith(`<bridge-message id="${message.id}"`);
    expect((await callTool(app, "muse", "check_inbox")).content[0]!.text).toContain("No new messages.");
  });
});
