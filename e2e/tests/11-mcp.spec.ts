// The MCP endpoint: an agent's token on /mcp, JSON-RPC over HTTP, the same tools as the REST API.
import { BASE_URL } from "../lib/env";
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
