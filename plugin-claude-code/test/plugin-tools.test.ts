import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { copyProblems } from "../../server/test/helpers";
import {
  createPorticoPlugin,
  createWaitingServer,
  FOLDER_OFF_NOTE,
  JOINING_NOTE,
  joinedNotice,
  NOT_JOINED_NOTE,
} from "../src/plugin";
import { PorticoClient } from "../src/portico-client";
import {
  agentAt,
  appAgent,
  captureLog,
  connected,
  fakeHost,
  fakeInboxSocket,
  joinTestComputer,
  startPortico,
  startSession,
  type TestPortico,
  waitFor,
} from "./helpers";

let p: TestPortico;
let token: string;
const cleanup: (() => Promise<void>)[] = [];

beforeEach(async () => {
  p = await startPortico();
  token = joinTestComputer(p).token;
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  p.stop();
});

const ADDRESS = "api-claude@macbook";

async function session(opts: Partial<Parameters<typeof startSession>[1]> = {}) {
  const s = await startSession(p, { token, key: "key-tools-0001", ...opts });
  cleanup.push(s.stop);
  return s;
}

/** A session whose stream is open, so Portico knows it. */
async function registered() {
  const s = await session();
  await waitFor(() => connected(p, ADDRESS));
  return s;
}

function text(result: unknown): string {
  return (result as { content: { type: string; text: string }[] }).content.map((c) => c.text).join("\n");
}

describe("the plugin's MCP server", () => {
  test("declares tools that can change, and no Claude Code channel", async () => {
    const { host } = await session();
    expect(host.getServerCapabilities()).toMatchObject({ tools: { listChanged: true } });
    expect(host.getServerCapabilities()?.experimental).toBeUndefined();
  });

  test("never negotiates MCP 2026-07-28, which Claude Code won't register as a channel", async () => {
    const sock = await fakeInboxSocket();
    cleanup.push(() => sock.close());
    for (const [asked, answered] of [
      ["2026-07-28", "2025-11-25"],
      ["2025-06-18", "2025-06-18"],
    ]) {
      const [hostSide, pluginSide] = InMemoryTransport.createLinkedPair();
      const plugin = createPorticoPlugin({
        client: new PorticoClient({ url: p.url, token, sessionKey: "key-proto-0001" }),
        log: captureLog().log,
        socket: sock.socket,
      });
      cleanup.push(() => plugin.stop());
      await plugin.server.connect(pluginSide);
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

  test("lists the three Portico tools", async () => {
    const { host } = await session();
    const { tools } = await host.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_agents", "send_message", "check_inbox"]);
  });

  test("list_agents shows the other agents", async () => {
    appAgent(p, "grok", { kind: "grok-bot" });
    appAgent(p, "muse", { approvalRequired: true });
    const { host } = await registered();
    const listed = await host.callTool({ name: "list_agents", arguments: {} });
    expect(listed.isError).toBeFalsy();
    const { agents } = JSON.parse(text(listed)) as { agents: { name: string; approval_required: boolean; owner: string }[] };
    expect(agents.map((a) => [a.name, a.approval_required, a.owner])).toEqual(
      expect.arrayContaining([
        ["grok", false, "Chris"],
        ["muse", true, "Chris"],
      ]),
    );
    expect(agents.map((a) => a.name)).not.toContain("api-claude");
  });

  test("send_message passes through with its subject and returns the tier", async () => {
    const grok = appAgent(p, "grok", { kind: "grok-bot" });
    const { host, sock } = await registered();
    const sent = await host.callTool({
      name: "send_message",
      arguments: { to: "grok", subject: "Release date", text: "Ready when you are" },
    });
    expect(sent.isError).toBeFalsy();
    const { message, delivery } = JSON.parse(text(sent)) as { message: { id: string; to: string; subject: string }; delivery: string };
    expect(message).toMatchObject({ to: "grok", subject: "Release date" });
    expect(delivery).toBe("queued");
    expect(p.messages.get(message.id)?.text).toBe("Ready when you are");

    // A reply needs only reply_to, a subject and the text.
    const question = p.messages.send(grok.agent, { to: "api-claude", subject: "Which branch?", text: "Which branch?" });
    const reply = await host.callTool({
      name: "send_message",
      arguments: { reply_to: question.message.id, subject: "Branch", text: "main" },
    });
    expect(JSON.parse(text(reply))).toMatchObject({ message: { to: "grok", reply_to: question.message.id }, delivery: "queued" });

    // The question went to this plugin's own live session: let that delivery finish before teardown.
    await waitFor(() => sock.posts.length === 1);
    await waitFor(() => p.messages.get(question.message.id)?.status === "delivered");
  });

  test("a message to an agent that requires approval comes back held, with the note as a second line", async () => {
    appAgent(p, "muse", { approvalRequired: true });
    const { host } = await registered();
    const sent = await host.callTool({ name: "send_message", arguments: { to: "muse", subject: "Read the inbox", text: "x" } });
    const content = sent.content as { type: string; text: string }[];
    expect(JSON.parse(content[0]!.text)).toMatchObject({ message: { status: "held" }, delivery: "held" });
    expect(content).toHaveLength(2);
    expect(content[1]!.text).not.toBe("");
  });

  test("Portico's errors and missing fields come back as tool errors", async () => {
    appAgent(p, "grok", { kind: "grok-bot" });
    const { host } = await registered();
    const unknown = await host.callTool({ name: "send_message", arguments: { to: "nobody", subject: "s", text: "x" } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toStartWith("unknown_agent:");

    const noSubject = await host.callTool({ name: "send_message", arguments: { to: "grok", text: "x" } });
    expect(noSubject.isError).toBe(true);
    expect(text(noSubject)).toBe("bad_request: subject is required: one line saying what the message asks for.");

    const noText = await host.callTool({ name: "send_message", arguments: { to: "grok", subject: "s" } });
    expect(noText.isError).toBe(true);
    expect(text(noText)).toStartWith("bad_request: text");

    const other = await host.callTool({ name: "send_task", arguments: {} });
    expect(other.isError).toBe(true);
  });

  test("check_inbox picks up messages", async () => {
    const grok = appAgent(p, "grok", { kind: "grok-bot" });
    const s = await registered();
    // Stop the plugin's own delivery, so only the explicit check_inbox below picks the message up.
    await s.plugin.stop();
    p.messages.send(grok.agent, { to: "api-claude", subject: "Changelog", text: "Write the changelog" });
    const inbox = await s.host.callTool({ name: "check_inbox", arguments: {} });
    expect(text(inbox)).toContain("Messages (1):");
    expect(text(inbox)).toContain("Write the changelog");
  });
});

describe("a folder that is off Portico", () => {
  test("Portico's folder_off refusal makes the session quiet: no tools, a note, no notice, one log line, no retry", async () => {
    const folderId = "c".repeat(64);
    p.computers.setFolder(p.computers.byName("macbook")!.id, folderId, "api", false);
    const recorded: boolean[] = [];
    let opens = 0;
    const client = new PorticoClient({ url: p.url, token, sessionKey: "key-quiet-0001" });
    const open = client.openStream.bind(client);
    client.openStream = (...args) => {
      opens++;
      return open(...args);
    };
    const s = await session({ key: "key-quiet-0001", folderId, client, folder: { off: false, record: (off) => recorded.push(off) } });
    await waitFor(() => recorded.length === 1);
    expect(recorded).toEqual([true]);
    await waitFor(() => s.toolListChanges() === 1);
    expect((await s.host.listTools()).tools).toEqual([]);
    const call = await s.host.callTool({ name: "list_agents", arguments: {} });
    expect(call).toEqual({ content: [{ type: "text", text: FOLDER_OFF_NOTE }], isError: true });
    await Bun.sleep(150);
    expect(opens).toBe(1);
    expect(s.sock.posts).toEqual([]);
    expect(s.logs.lines.filter((line) => line.level !== "info" || line.msg === "stream_refused")).toEqual([
      { level: "info", msg: "stream_refused", fields: { status: 403, code: "folder_off" } },
    ]);
    expect(agentAt(p, ADDRESS)).toBeNull();
  });

  test("a session whose local copy says off starts with no tools, and gets them when Portico registers it", async () => {
    const recorded: boolean[] = [];
    // The stream can't open until the gate is released, so Portico can't answer before the first look at the tools.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = await session({
      folder: { off: true, record: (off) => recorded.push(off) },
      registration: async () => {
        await gate;
        return { repo: "api", folderId: "a".repeat(64) };
      },
    });
    expect((await s.host.listTools()).tools).toEqual([]);
    release();
    await waitFor(() => connected(p, ADDRESS));
    await waitFor(() => recorded.length === 1);
    expect(recorded).toEqual([false]);
    await waitFor(() => s.toolListChanges() === 1);
    expect((await s.host.listTools()).tools).toHaveLength(3);
  });

  test("while quiet, a tool call gets the note", async () => {
    // Portico can't be reached, so only the local copy speaks.
    const sock = await fakeInboxSocket();
    cleanup.push(() => sock.close());
    const plugin = createPorticoPlugin({
      client: new PorticoClient({ url: "http://127.0.0.1:1", token, sessionKey: "key-offline-01" }),
      log: captureLog().log,
      socket: sock.socket,
      folder: { off: true, record: () => {} },
      stream: { initialBackoffMs: 10_000 },
    });
    const host = await fakeHost(plugin);
    cleanup.push(async () => {
      await plugin.stop();
      await host.close();
    });
    expect((await host.host.listTools()).tools).toEqual([]);
    expect(await host.host.callTool({ name: "check_inbox", arguments: {} })).toEqual({
      content: [{ type: "text", text: FOLDER_OFF_NOTE }],
      isError: true,
    });
  });
});

describe("a computer that hasn't joined", () => {
  test("the waiting server lists no tools, gives no instructions and no channel, and a call gets a note", async () => {
    const host = await fakeHost({ server: createWaitingServer() });
    cleanup.push(() => host.close());
    expect(host.host.getServerCapabilities()?.experimental).toBeUndefined();
    expect(host.host.getInstructions()).toBeUndefined();
    expect((await host.host.listTools()).tools).toEqual([]);
    expect(await host.host.callTool({ name: "list_agents", arguments: {} })).toEqual({
      content: [{ type: "text", text: NOT_JOINED_NOTE }],
      isError: true,
    });
  });

  test("once the computer joins, the plugin takes the waiting server over, offers the tools when Portico registers the session, and says so", async () => {
    const server = createWaitingServer();
    const host = await fakeHost({ server });
    cleanup.push(() => host.close());
    const sock = await fakeInboxSocket();
    cleanup.push(() => sock.close());
    const plugin = createPorticoPlugin({
      client: new PorticoClient({ url: p.url, token, sessionKey: "key-joining-001" }),
      log: captureLog().log,
      socket: sock.socket,
      registration: async () => ({ repo: "api", folderId: "a".repeat(64) }),
      server,
      joining: true,
      stream: { initialBackoffMs: 10 },
    });
    cleanup.push(() => plugin.stop());
    // Before Portico registers the session, still no tools.
    expect((await host.host.listTools()).tools).toEqual([]);
    expect(await host.host.callTool({ name: "list_agents", arguments: {} })).toEqual({
      content: [{ type: "text", text: JOINING_NOTE }],
      isError: true,
    });
    plugin.start(); // the handshake happened before the takeover, so the session starts the stream itself
    await waitFor(() => connected(p, ADDRESS));
    await waitFor(() => host.toolListChanges() === 1);
    expect((await host.host.listTools()).tools).toHaveLength(3);
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toBe(`<portico-notice>\n${joinedNotice("api-claude")}\n</portico-notice>`);
    expect(copyProblems(joinedNotice("api-claude"))).toEqual([]);
    for (const note of [FOLDER_OFF_NOTE, JOINING_NOTE, NOT_JOINED_NOTE]) expect(copyProblems(note)).toEqual([]);
  });
});
