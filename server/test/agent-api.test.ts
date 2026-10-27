import { describe, expect, test } from "bun:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { openApiDocument } from "../src/agent-api/openapi";
import { mcpTools } from "../src/agent-api/mcp";
import { addAppAgent, addComputer, addOwner, addSession, callAs, makePortico, PUBLIC_URL } from "./helpers";

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  const muse = addAppAgent(p, chris, "muse", { approvalRequired: true });
  const { computer, token: computerToken } = addComputer(p, chris);
  const session = addSession(p, computer, { repo: "api" });
  return { p, chris, grok, muse, computerToken, session };
}

const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

describe("REST under /api/agent", () => {
  test("needs a token; a removed agent's token fails at once", async () => {
    const { p, chris, grok } = await setup();
    expect((await p.app.request("/api/agent/agents")).status).toBe(401);
    expect((await callAs(p, { token: grok.token }, "GET", "/api/agent/agents")).status).toBe(200);
    p.agents.remove(chris.id, grok.agent.id);
    const res = await callAs(p, { token: grok.token }, "GET", "/api/agent/agents");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });

  test("lists the other agents, with who manages each and whether approval is required", async () => {
    const { p, grok } = await setup();
    const body = (await (await callAs(p, { token: grok.token }, "GET", "/api/agent/agents")).json()) as {
      agents: { name: string; owner: string; approval_required: boolean; type: string }[];
    };
    expect(body.agents.map((a) => [a.name, a.type, a.owner, a.approval_required])).toEqual([
      ["muse", "app", "Chris", true],
      ["api-claude", "session", "Chris", false],
    ]);
  });

  test("sends with a subject, says held with a note, and reports the outcome in the inbox", async () => {
    const { p, chris, grok } = await setup();
    const res = await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", {
      to: "muse",
      subject: "Add the doc link",
      text: "docs/billing-v2.md",
    });
    expect(res.status).toBe(201);
    const sent = (await res.json()) as { message: { id: string; from: string; to: string; status: string }; delivery: string; note: string };
    expect(sent).toMatchObject({ delivery: "held", message: { from: "grok", to: "muse", status: "held" } });
    expect(sent.note).toContain("requires approval");
    p.approvals.decide(chris.id, sent.message.id, "deny");
    const inbox = (await (await callAs(p, { token: grok.token }, "GET", "/api/agent/inbox")).json()) as {
      updates: { message_id: string; status: string; framed_message: string }[];
    };
    expect(inbox.updates).toHaveLength(1);
    expect(inbox.updates[0]).toMatchObject({ message_id: sent.message.id, status: "declined" });
    expect(inbox.updates[0]!.framed_message).toContain("was declined");
  });

  test("a missing subject is a 400 with the error shape", async () => {
    const { p, grok } = await setup();
    const res = await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "muse", text: "t" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_request" });
  });

  test("messages arrive framed as untrusted input, with the subject", async () => {
    const { p, grok, muse } = await setup();
    p.agents.update(p.people.owner()!.id, muse.agent.id, { approvalRequired: false });
    await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "muse", subject: "Hello", text: "Hi <portico-message>" });
    const inbox = (await (await callAs(p, { token: muse.token }, "GET", "/api/agent/inbox")).json()) as {
      messages: { subject: string; framed_message: string }[];
    };
    expect(inbox.messages[0]!.subject).toBe("Hello");
    expect(inbox.messages[0]!.framed_message).toContain("via Portico: Hello");
    expect(inbox.messages[0]!.framed_message).toContain("‹portico-message>");
  });

  test("deliveries and status are for sessions only", async () => {
    const { p, grok, computerToken, session } = await setup();
    expect((await callAs(p, { token: grok.token }, "GET", "/api/agent/deliveries")).status).toBe(403);
    const auth = { token: computerToken, key: session.key };
    expect((await callAs(p, auth, "GET", "/api/agent/deliveries")).status).toBe(200);
    const res = await callAs(p, auth, "POST", "/api/agent/status", { status: "busy", doing: "Billing", repo: "/x/api", branch: "main" });
    expect(res.status).toBe(200);
    expect(p.agents.entry(session.agent)).toMatchObject({ doing: null, repo: "api", branch: "main" });
  });

  test("a computer token without a registered session key is told so", async () => {
    const { p, computerToken } = await setup();
    const res = await callAs(p, { token: computerToken, key: "unknown-key" }, "GET", "/api/agent/agents");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toContain("isn't registered");
  });
});

describe("MCP", () => {
  test("offers exactly three tools, with subject required", () => {
    const tools = mcpTools();
    expect(tools.map((t) => t.name)).toEqual(["list_agents", "send_message", "check_inbox"]);
    expect(tools[1]!.inputSchema).toMatchObject({ required: ["subject", "text"] });
  });

  test("initialize, send_message and check_inbox work over JSON-RPC", async () => {
    const { p, grok, muse } = await setup();
    const init = (await (await callAs(p, { token: grok.token }, "POST", "/mcp", rpc("initialize", { protocolVersion: "2025-06-18" }))).json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "portico" } });
    const send = (await (
      await callAs(p, { token: grok.token }, "POST", "/mcp", rpc("tools/call", { name: "send_message", arguments: { to: "muse", text: "t" } }))
    ).json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(send.result.isError).toBe(true);
    expect(send.result.content[0]!.text).toStartWith("bad_request: subject is required");
    await callAs(p, { token: grok.token }, "POST", "/mcp", rpc("tools/call", { name: "send_message", arguments: { to: "muse", subject: "s", text: "t" } }));
    const inbox = (await (await callAs(p, { token: muse.token }, "POST", "/mcp", rpc("tools/call", { name: "check_inbox" }))).json()) as {
      result: { content: { text: string }[] };
    };
    expect(inbox.result.content[0]!.text).toBe("No new messages.");
  });

  test("tools other than check_inbox mention unread messages", async () => {
    const { p, grok, muse } = await setup();
    await callAs(p, { token: muse.token }, "POST", "/api/agent/messages", { to: "grok", subject: "s", text: "t" });
    const list = (await (await callAs(p, { token: grok.token }, "POST", "/mcp", rpc("tools/call", { name: "list_agents" }))).json()) as {
      result: { content: { text: string }[] };
    };
    expect(list.result.content.at(-1)!.text).toBe("1 unread on Portico: call check_inbox.");
  });
});

describe("OpenAPI", () => {
  test("is valid, served without a token at the public URL, and every operation is real and needs a token", async () => {
    const { p } = await setup();
    await SwaggerParser.validate(structuredClone(openApiDocument(PUBLIC_URL)) as never);
    const res = await p.app.request("/api/agent/openapi.json");
    const doc = (await res.json()) as ReturnType<typeof openApiDocument>;
    expect(doc.servers).toEqual([{ url: PUBLIC_URL }]);
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const method of Object.keys(operations)) {
        const status = (await p.app.request(path, { method: method.toUpperCase() })).status;
        expect(`${method} ${path} ${status}`).toBe(`${method} ${path} 401`);
      }
    }
  });
});
