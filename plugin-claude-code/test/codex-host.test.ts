import { afterEach, describe, expect, test } from "bun:test";
import { CODEX_HOST } from "../src/codex/server";
import { createPorticoPlugin, createWaitingServer, type PorticoPlugin } from "../src/plugin";
import { PorticoClient } from "../src/portico-client";
import { appAgent, captureLog, fakeHost, joinTestComputer, startPortico, type TestPortico, waitFor } from "./helpers";

let p: TestPortico | null = null;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  p?.stop();
  p = null;
});

type Text = { content: { text: string }[]; isError?: boolean };
const text = (result: unknown) => (result as Text).content.map((item) => item.text);

/** A Codex conversation's server, as the bridge builds it, connected to a stand-in for Codex. */
async function conversation(opts: { client?: (real: PorticoClient) => PorticoClient; off?: boolean } = {}) {
  p = await startPortico();
  const { token } = joinTestComputer(p, "macbook");
  const key = "codex-conversation-1";
  const real = new PorticoClient({ url: p.url, token, sessionKey: key });
  const plugin: PorticoPlugin = createPorticoPlugin({
    client: opts.client ? opts.client(real) : real,
    log: captureLog().log,
    socket: null,
    host: CODEX_HOST,
    folder: { off: opts.off ?? false, record: () => {} },
    registration: async () => ({ repo: "api", folderId: "c".repeat(64), client: "codex" }),
  });
  const host = await fakeHost(plugin);
  stops.push(async () => {
    await plugin.stop();
    await host.close();
  });
  return { p, plugin, host: host.host, key };
}

describe("a Codex conversation's server", () => {
  test("when the ack doesn't go through, the Stop hook hands over nothing and the message waits", async () => {
    let acks = 0;
    const { p, host } = await conversation({
      client: (real) =>
        Object.assign(Object.create(real) as PorticoClient, {
          ackDeliveries: async () => {
            acks++;
            throw new Error("Portico was too slow");
          },
        }),
    });
    await waitFor(() => p.agents.byAddress("api-codex@macbook") !== null && p.agentStreams.isConnected(p.agents.byAddress("api-codex@macbook")!.id), 5000);
    const codex = p.agents.byAddress("api-codex@macbook")!;
    p.messages.send(appAgent(p, "grok", { kind: "grok-bot" }).agent, { to: "api-codex", subject: "Hi", text: "Hello" });
    expect(text(await host.callTool({ name: "check_inbox", arguments: { stop_hook: true } }))).toEqual([""]);
    expect(acks).toBe(1);
    expect(p.messages.unreadCount(codex.id)).toBe(1);
  });

  test("a Portico tool call shows the conversation working; the Stop hook at the turn's end shows it available", async () => {
    const { p, host } = await conversation();
    await waitFor(() => p.agents.byAddress("api-codex@macbook") !== null && p.agentStreams.isConnected(p.agents.byAddress("api-codex@macbook")!.id), 5000);
    const codex = () => p.agents.entry(p.agents.byAddress("api-codex@macbook")!);
    expect(codex().status).toBe("idle");
    await host.callTool({ name: "list_agents", arguments: {} });
    await waitFor(() => codex().status === "busy");
    await host.callTool({ name: "check_inbox", arguments: { stop_hook: true } });
    await waitFor(() => codex().status === "idle");
  });

  test("in a folder that's off, the tools stay listed so the Stop hook finds check_inbox, and the hook says nothing", async () => {
    const { host } = await conversation({ off: true });
    expect((await host.listTools()).tools.map((tool) => tool.name)).toEqual(["list_agents", "send_message", "check_inbox"]);
    expect(text(await host.callTool({ name: "check_inbox", arguments: { stop_hook: true } }))).toEqual([""]);
    const call = (await host.callTool({ name: "list_agents", arguments: {} })) as Text;
    expect(call.isError).toBe(true);
    expect(text(call)[0]).toBe(CODEX_HOST.folderOffNote);
  });

  test("on a computer that hasn't joined, Codex still gets its instructions and the tools, and the hook says nothing", async () => {
    const server = createWaitingServer(CODEX_HOST);
    const host = await fakeHost({ server });
    stops.push(() => host.close());
    expect(host.host.getInstructions()).toBe(CODEX_HOST.instructions);
    expect((await host.host.listTools()).tools).toHaveLength(3);
    expect(text(await host.host.callTool({ name: "check_inbox", arguments: { stop_hook: true } }))).toEqual([""]);
    expect(text(await host.host.callTool({ name: "check_inbox", arguments: {} }))[0]).toBe(CODEX_HOST.notJoinedNote);
  });
});
