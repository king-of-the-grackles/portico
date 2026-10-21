import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridgePlugin, createIdleServer, type BridgePlugin } from "../src/plugin";
import { captureLog, fakeHost, fakeInboxSocket, type FakeInboxSocket, hubClient, startHub, type TestHub, TOKENS, waitFor } from "./helpers";

let hub: TestHub;
let sock: FakeInboxSocket;
const cleanup: (() => Promise<void>)[] = [];

beforeEach(async () => {
  hub = startHub();
  sock = await fakeInboxSocket();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  hub.stop();
  await sock.close();
});

function plugin(): BridgePlugin {
  const p = createBridgePlugin({
    config: { url: hub.url, token: TOKENS["claude-code"], permissionRelay: false, source: "env", machine: null },
    client: hubClient(hub, "claude-code"),
    log: captureLog().log,
    socket: sock.socket,
  });
  cleanup.push(() => p.stop());
  return p;
}

async function connected() {
  const host = await fakeHost(plugin());
  cleanup.push(() => host.close());
  return host;
}

function text(result: unknown): string {
  return (result as { content: { type: string; text: string }[] }).content.map((c) => c.text).join("\n");
}

describe("the plugin's MCP server", () => {
  test("declares the tools, and no Claude Code channel without permission relay", async () => {
    const { host } = await connected();
    expect(host.getServerCapabilities()).toMatchObject({ tools: {} });
    expect(host.getServerCapabilities()?.experimental).toBeUndefined();
  });

  test("never negotiates MCP 2026-07-28, which Claude Code won't register as a channel", async () => {
    for (const [asked, answered] of [
      ["2026-07-28", "2025-11-25"],
      ["2025-06-18", "2025-06-18"],
    ]) {
      const [hostSide, pluginSide] = InMemoryTransport.createLinkedPair();
      const p = plugin();
      await p.server.connect(pluginSide);
      const replies: JSONRPCMessage[] = [];
      hostSide.onmessage = (message) => replies.push(message);
      await hostSide.start();
      await hostSide.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: "fake", version: "1" } },
      });
      await waitFor(() => replies.length > 0);
      expect((replies[0] as unknown as { result: { protocolVersion: string } }).result.protocolVersion).toBe(answered!);
      await hostSide.close();
    }
  });

  test("lists the seven bridge tools", async () => {
    const { host } = await connected();
    const { tools } = await host.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_inbox",
      "finish_task",
      "get_task",
      "list_agents",
      "report_event",
      "send_message",
      "send_task",
    ]);
  });

  test("send_message passes through and returns the tier", async () => {
    const { host } = await connected();
    const sent = await host.callTool({ name: "send_message", arguments: { to: "grok-bot", text: "Ready when you are" } });
    expect(sent.isError).toBeFalsy();
    const { message, delivery } = JSON.parse(text(sent)) as { message: { id: string; to_agent: string }; delivery: string };
    expect(message.to_agent).toBe("grok-bot");
    expect(delivery).toBe("queued");
    expect(hub.store.getMessage(message.id)?.text).toBe("Ready when you are");

    // A reply needs only reply_to and text.
    const { message: question } = hub.service.sendMessage("muse", { to: "claude-code", text: "Which branch?" });
    const reply = await host.callTool({ name: "send_message", arguments: { reply_to: question.id, text: "main" } });
    expect(JSON.parse(text(reply))).toMatchObject({ message: { to_agent: "muse", reply_to: question.id }, delivery: "queued" });

    const missing = await host.callTool({ name: "send_message", arguments: { to: "grok-bot" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toBe("bad_request: text is required.");
  });

  test("tool calls pass through to the hub", async () => {
    const p = plugin();
    const { host } = await fakeHost(p);
    cleanup.push(() => host.close());
    const sent = await host.callTool({ name: "send_task", arguments: { to: "grok-bot", instructions: "Look this up" } });
    expect(sent.isError).toBeFalsy();
    const { task } = JSON.parse(text(sent)) as { task: { id: string; status: string } };
    expect(task.status).toBe("queued");

    const read = await host.callTool({ name: "get_task", arguments: { task_id: task.id } });
    expect(JSON.parse(text(read)).task.id).toBe(task.id);

    // Stop the plugin's own delivery, so only the explicit check_inbox below claims the task.
    await p.stop();
    hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "Write the changelog" });
    const inbox = await host.callTool({ name: "check_inbox", arguments: {} });
    expect(text(inbox)).toContain("New tasks (1):");
    expect(text(inbox)).toContain("Write the changelog");
  });

  test("hub errors and missing arguments come back as tool errors", async () => {
    const { host } = await connected();
    const unknown = await host.callTool({ name: "send_task", arguments: { to: "nobody", instructions: "x" } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toStartWith("unknown_agent:");

    const missing = await host.callTool({ name: "finish_task", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toBe("bad_request: task_id is required.");
  });
});

describe("the idle server", () => {
  test("has no tools and no channel", async () => {
    const host = await fakeHost({ server: createIdleServer() });
    cleanup.push(() => host.close());
    const capabilities = host.host.getServerCapabilities() ?? {};
    expect(capabilities.tools).toBeUndefined();
    expect(capabilities.experimental).toBeUndefined();
  });
});
