import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOKENS, type TestAgent, makeApp } from "./helpers";

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
  test("lists the six tools", async () => {
    const client = await connect("grok-bot");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "check_inbox",
      "finish_task",
      "get_task",
      "list_agents",
      "report_event",
      "send_task",
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
});
