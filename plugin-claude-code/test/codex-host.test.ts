import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexConversation } from "../src/codex/conversation";
import { CODEX_HOST } from "../src/codex/server";
import { createPorticoPlugin, createWaitingServer, type PorticoPlugin, porticoPrompt, stopHookOutput } from "../src/plugin";
import { PorticoClient } from "../src/portico-client";
import { DELIVERY_BATCH_MAX } from "../../server/src/core/messages";
import { NO_WAIT_NOTE, WAKE_HINT } from "../src/tools";
import { appAgent, captureLog, fakeCodex, fakeHost, joinTestComputer, startPortico, type TestPortico, waitFor } from "./helpers";

let p: TestPortico | null = null;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  p?.stop();
  p = null;
});

type Text = { content: { text: string }[]; isError?: boolean };
const text = (result: unknown) => (result as Text).content.map((item) => item.text);

/**
 * A Codex conversation's server, as the bridge builds it, connected to a stand-in for Codex. With `codex`, a stand-in for
 * Codex's app-server too, whose conversation in `folder` is this server's.
 */
async function conversation(
  opts: { client?: (real: PorticoClient) => PorticoClient; off?: boolean; codex?: ReturnType<typeof fakeCodex>; folder?: string } = {},
) {
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
    conversation: opts.codex
      ? (hooks) =>
          new CodexConversation({
            ...hooks,
            cwd: opts.folder!,
            client: real,
            log: captureLog().log,
            prompt: porticoPrompt,
            connect: opts.codex!.connect,
            findRetryMs: [10, 10],
          })
      : undefined,
  });
  // Codex calls portico_identify on the conversation's own server, with the conversation's ID.
  opts.codex?.routeTools((threadId, name, args) => host.host.callTool({ name, arguments: args, _meta: { threadId } }));
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

  test("with Codex's app-server, a message to the idle conversation starts a turn there, and replies needn't be waited for", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "portico-codex-folder-")));
    stops.push(async () => rmSync(folder, { recursive: true, force: true }));
    const codex = fakeCodex({ "thread-1": { cwd: folder, status: { type: "idle" } } });
    const { p, host } = await conversation({ codex, folder });
    const agent = () => p.agents.byAddress("api-codex@macbook");
    await waitFor(() => agent() !== null && p.agentStreams.canWake(agent()!.id), 5000);
    const grok = appAgent(p, "grok", { kind: "grok-bot" }).agent;
    expect(p.messages.send(grok, { to: "api-codex", subject: "Ready?", text: "Ready for the deploy?" }).delivery).toBe("pushed");
    await waitFor(() => codex.turns.length === 1, 5000);
    expect(codex.turns[0]!.text).toStartWith("Portico: new items arrived for this conversation from other AI agents");
    expect(codex.turns[0]!.text).toContain("Ready for the deploy?");
    await waitFor(() => p.messages.unreadCount(agent()!.id) === 0);
    // Codex says the conversation is working, and a tool call no longer stands in for that.
    await waitFor(() => p.agents.entry(agent()!).status === "busy");
    expect(text(await host.callTool({ name: "check_inbox", arguments: { wait: 40 } })).at(-1)).toBe(NO_WAIT_NOTE);
    expect(text(await host.callTool({ name: "send_message", arguments: { to: "grok", subject: "Yes", text: "Ready." } })).at(-1)).toBe(WAKE_HINT);
    codex.setStatus("thread-1", { type: "idle" });
    await waitFor(() => p.agents.entry(agent()!).status === "idle");
    await host.callTool({ name: "list_agents", arguments: {} });
    await Bun.sleep(50);
    expect(p.agents.entry(agent()!).status).toBe("idle");
  });

  test("with Codex's app-server, a conversation that asked its person and stopped is started again by the answer, once; who came into a Portico starts no turn", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "portico-codex-folder-")));
    stops.push(async () => rmSync(folder, { recursive: true, force: true }));
    const codex = fakeCodex({ "thread-1": { cwd: folder, status: { type: "idle" } } });
    const { p, host } = await conversation({ codex, folder });
    const agent = () => p.agents.byAddress("api-codex@macbook");
    await waitFor(() => agent() !== null && p.agentStreams.canWake(agent()!.id), 5000);

    // The conversation asks its person and ends its turn: nothing is in the inbox, and Codex reports it idle.
    const asked = JSON.parse(text(await host.callTool({ name: "request_input", arguments: { question: "Ship today?", options: ["Yes", "No"] } }))[0]!) as { question: { id: string } };
    await Bun.sleep(60);
    expect(codex.turns).toEqual([]);

    // The owner answers, as the person API does for a signed-in browser. The inbox holds the answer notice and nothing else.
    p.questions.answer(p.owner.id, asked.question.id, { option: 0 }, "web");
    expect(p.messages.unreadCount(agent()!.id)).toBe(1);
    await waitFor(() => codex.turns.length === 1, 5000);
    expect(codex.turns[0]!.threadId).toBe("thread-1");
    expect(codex.turns[0]!.text).toStartWith("Portico: Portico's own notice arrived for this conversation.");
    expect(codex.turns[0]!.text).toContain(`<portico-answer question_id="${asked.question.id}" status="answered" level="checked" via="web">`);
    expect(codex.turns[0]!.text).toContain("\nAnswer: Yes\n");
    expect(codex.turns[0]!.text).not.toContain("from other AI agents");
    // Acked once: the notice is gone from Portico, and nothing starts a second turn for it.
    await waitFor(() => p.agentNotices.waiting(agent()!.id).length === 0);
    codex.setStatus("thread-1", { type: "idle" });
    await Bun.sleep(100);
    expect(codex.turns).toHaveLength(1);

    // A skip wakes the same way.
    const second = JSON.parse(text(await host.callTool({ name: "request_input", arguments: { question: "And tomorrow?" } }))[0]!) as { question: { id: string } };
    codex.setStatus("thread-1", { type: "idle" });
    p.questions.skip(p.owner.id, second.question.id, "web");
    await waitFor(() => codex.turns.length === 2, 5000);
    expect(codex.turns[1]!.text).toContain(`<portico-answer question_id="${second.question.id}" status="skipped"`);
    await waitFor(() => p.agentNotices.waiting(agent()!.id).length === 0);
    codex.setStatus("thread-1", { type: "idle" });

    // Portico's notice about a Portico the agent came into: the stream is nudged, and no turn starts. The notice waits.
    const launch = p.workspaces.create(p.owner.id, "Launch");
    p.workspaces.addAgent(p.owner.id, launch.id, agent()!.id);
    await waitFor(() => p.agentNotices.waiting(agent()!.id).length === 1);
    await Bun.sleep(150);
    expect(codex.turns).toHaveLength(2);
    expect(p.agentNotices.waiting(agent()!.id)).toHaveLength(1);
  });

  test("with a full batch of older notices in front of the answer, the answer still starts exactly one turn, and the notice left out comes later", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "portico-codex-folder-")));
    stops.push(async () => rmSync(folder, { recursive: true, force: true }));
    const codex = fakeCodex({ "thread-1": { cwd: folder, status: { type: "idle" } } });
    const { p, host } = await conversation({ codex, folder });
    const agent = () => p.agents.byAddress("api-codex@macbook");
    await waitFor(() => agent() !== null && p.agentStreams.canWake(agent()!.id), 5000);

    // As many notices about who came or went as one batch holds: none starts a turn, and none is acked.
    for (let i = 0; i < DELIVERY_BATCH_MAX; i++) p.agentNotices.add(agent()!.id, `“Dana” (dana) came into the Portico “Launch ${i}”.`);
    const asked = JSON.parse(text(await host.callTool({ name: "request_input", arguments: { question: "Ship today?" } }))[0]!) as { question: { id: string } };
    await Bun.sleep(80);
    expect(codex.turns).toEqual([]);
    expect(p.agentNotices.count(agent()!.id)).toBe(DELIVERY_BATCH_MAX);

    // The owner answers, later than every one of them.
    p.clock.advance(60_000);
    p.questions.answer(p.owner.id, asked.question.id, { text: "Yes, ship." }, "web");
    await waitFor(() => codex.turns.length === 1, 5000);
    expect(codex.turns[0]!.text.match(/<portico-answer /g)).toHaveLength(1);
    expect(codex.turns[0]!.text).toContain(`<portico-answer question_id="${asked.question.id}" status="answered" level="checked" via="web">`);
    expect(codex.turns[0]!.text).toContain("\nAnswer: Yes, ship.\n");
    // The batch is acked once: the answer and the notices that rode along are gone, and the one left out still waits.
    await waitFor(() => p.agentNotices.count(agent()!.id) === 1);
    const left = p.agentNotices.waiting(agent()!.id);
    expect(left.map((n) => [n.text, n.wake])).toEqual([[`“Dana” (dana) came into the Portico “Launch ${DELIVERY_BATCH_MAX - 1}”.`, false]]);
    expect(codex.turns[0]!.text).not.toContain(left[0]!.text);
    codex.setStatus("thread-1", { type: "idle" });
    await Bun.sleep(120);
    expect(codex.turns).toHaveLength(1);

    // Nothing is lost: the notice left out is handed over with the next message.
    p.messages.send(appAgent(p, "grok", { kind: "grok-bot" }).agent, { to: "api-codex", subject: "Ready?", text: "Ready for the deploy?" });
    await waitFor(() => codex.turns.length === 2, 5000);
    expect(codex.turns[1]!.text).toContain(left[0]!.text);
    expect(codex.turns[1]!.text).not.toContain("<portico-answer ");
    await waitFor(() => p.agentNotices.count(agent()!.id) === 0);
  });

  test("the Stop hook hands a stopped conversation the answer to its question and acks it; who came into a Portico keeps no conversation going", async () => {
    const { p, host } = await conversation();
    await waitFor(() => p.agents.byAddress("api-codex@macbook") !== null && p.agentStreams.isConnected(p.agents.byAddress("api-codex@macbook")!.id), 5000);
    const agent = p.agents.byAddress("api-codex@macbook")!;
    const stopHook = async () => text(await host.callTool({ name: "check_inbox", arguments: { stop_hook: true } }));

    // A notice about a Portico alone: the hook says nothing, and the notice stays for the next message or check.
    const launch = p.workspaces.create(p.owner.id, "Launch");
    p.workspaces.addAgent(p.owner.id, launch.id, agent.id);
    expect(p.agentNotices.waiting(agent.id)).toHaveLength(1);
    expect(await stopHook()).toEqual([""]);
    expect(p.agentNotices.waiting(agent.id)).toHaveLength(1);

    // The conversation asks and stops; the question alone gives the hook nothing to hand over.
    const asked = JSON.parse(text(await host.callTool({ name: "request_input", arguments: { question: "Ship today?" } }))[0]!) as { question: { id: string } };
    expect(await stopHook()).toEqual([""]);

    // The owner answers: the hook blocks with the answer as the next prompt, and acks what it handed over.
    p.questions.answer(p.owner.id, asked.question.id, { text: "Yes, after lunch." }, "web");
    const [output] = await stopHook();
    const decision = JSON.parse(output!) as { decision: string; reason: string };
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain(`<portico-answer question_id="${asked.question.id}" status="answered" level="checked" via="web">`);
    expect(decision.reason).toContain("\nAnswer: Yes, after lunch.\n");
    // The notice that waited rides along, and both are acked: the next hook has nothing.
    expect(decision.reason).toContain("This agent is in the Portico “Launch” now");
    expect(p.agentNotices.waiting(agent.id)).toEqual([]);
    expect(await stopHook()).toEqual([""]);

    // The same rule as a function: a message, an outcome or a waking notice blocks; any other notice, or a notice
    // from a Portico server that doesn't say whether it wakes, does not.
    const notice = { id: "n1", at: "2026-10-27T10:00:00.000Z", text: "x", framed_message: "<portico-notice>x</portico-notice>" };
    expect(stopHookOutput({ messages: [], updates: [] })).toBe("");
    expect(stopHookOutput({ messages: [], updates: [], notices: [notice] })).toBe("");
    expect(stopHookOutput({ messages: [], updates: [], notices: [{ ...notice, wake: false }] })).toBe("");
    expect(JSON.parse(stopHookOutput({ messages: [], updates: [], notices: [{ ...notice, wake: true }] }))).toMatchObject({ decision: "block" });
  });

  test("in a folder that's off, the tools stay listed so the Stop hook finds check_inbox, and the hook says nothing", async () => {
    const { host } = await conversation({ off: true });
    expect((await host.listTools()).tools.map((tool) => tool.name)).toEqual(["list_agents", "send_message", "create_upload", "check_inbox", "list_tasks", "get_task", "update_profile", "submit_feedback", "request_input", "list_porticos", "create_portico", "add_to_portico", "remove_from_portico", "rename_portico", "delete_portico", "share_portico", "join_portico"]);
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
    expect((await host.host.listTools()).tools).toHaveLength(17);
    expect(text(await host.host.callTool({ name: "check_inbox", arguments: { stop_hook: true } }))).toEqual([""]);
    expect(text(await host.host.callTool({ name: "check_inbox", arguments: {} }))[0]).toBe(CODEX_HOST.notJoinedNote);
  });
});
