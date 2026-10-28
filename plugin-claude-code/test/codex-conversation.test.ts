import { describe, expect, test } from "bun:test";
import { AppServerError } from "../src/codex/app-server";
import { CodexConversation, IDENTIFY_TOOL } from "../src/codex/conversation";
import type { DeliveryAck, Inbox, MessageDelivery } from "../src/portico-client";
import { captureLog, type FakeThread, fakeCodex, waitFor } from "./helpers";

const FOLDER = "/work/api";

const waiting = (count: number): Inbox => ({
  messages: Array.from({ length: count }, (_, i) => ({ id: `m${i}`, framed_message: `<portico-message id="m${i}">hi</portico-message>` }) as MessageDelivery),
  updates: [],
});

/** Conversations in Codex, a link per bridge, and a stand-in Portico that holds `inbox` until it's acked. */
function setup(threads: Record<string, FakeThread>, opts: { inbox?: Inbox; noAppServer?: boolean } = {}) {
  const codex = fakeCodex(threads);
  const acks: DeliveryAck[] = [];
  let inbox = opts.inbox ?? waiting(0);
  const client = {
    pendingDeliveries: async () => inbox,
    ackDeliveries: async (ack: DeliveryAck) => {
      acks.push(ack);
      inbox = waiting(0);
      return { acked: { messages: ack.messages.length, updates: ack.updates.length } };
    },
  };
  const links = new Map<string, CodexConversation>();
  codex.routeTools(async (threadId, tool, args) => {
    const link = links.get(threadId);
    if (!link) return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
    return link.called(tool, args, { threadId });
  });
  const logs = captureLog();
  const bridge = (threadId: string, cwd = FOLDER) => {
    const reports: string[] = [];
    let wakeChanges = 0;
    const link = new CodexConversation({
      cwd,
      connect: opts.noAppServer ? () => Promise.reject(new AppServerError("closed", "No Codex app-server is running.")) : codex.connect,
      client,
      prompt: (items) => `Portico: ${items.messages.map((m) => m.id).join(", ")}`,
      log: logs.log,
      report: (status) => void reports.push(status),
      wakeChanged: () => void wakeChanges++,
      findRetryMs: [5, 5, 5],
      wakeRetryMs: 20,
      nonce: `nonce-${threadId}`,
    });
    links.set(threadId, link);
    return { link, reports, wakeChanges: () => wakeChanges };
  };
  return { codex, acks, bridge, logs, hold: (next: Inbox) => void (inbox = next) };
}

const idle = { type: "idle" };

describe("a Codex conversation's link to its conversation", () => {
  test("finds its own conversation among the folder's, says it can wake, and reports Codex's status", async () => {
    const { codex, bridge } = setup({ a: { cwd: FOLDER, status: idle }, b: { cwd: FOLDER, status: idle }, c: { cwd: "/work/web", status: idle } });
    const a = bridge("a");
    const b = bridge("b");
    a.link.start();
    b.link.start();
    await a.link.settled(1000);
    await b.link.settled(1000);
    expect(a.link.canWake).toBe(true);
    expect(b.link.canWake).toBe(true);
    expect(a.wakeChanges()).toBe(1);
    expect(a.reports).toEqual(["idle"]);
    // Only conversations in the bridge's folder are asked.
    const asked = codex.requests.filter((r) => r.method === "mcpServer/tool/call").map((r) => r.params.threadId);
    expect(asked).not.toContain("c");
    codex.setStatus("a", { type: "active", activeFlags: [] });
    codex.setStatus("a", { type: "active", activeFlags: ["waitingOnApproval"] });
    expect(a.reports).toEqual(["idle", "busy", "waiting"]);
    expect(b.reports).toEqual(["idle"]);
  });

  test("answers another bridge's identify call without taking its conversation", () => {
    const { bridge } = setup({});
    const { link } = bridge("a");
    const answer = link.called(IDENTIFY_TOOL, { nonce: "someone-else", thread: "b" }, { threadId: "b" });
    expect(answer?.content).toEqual([{ type: "text", text: "Another conversation." }]);
    expect(link.called("list_agents", {}, { threadId: "b" })).toBeNull();
  });

  test("a subagent's bridge never wakes or reports", async () => {
    const { bridge } = setup({ s: { cwd: FOLDER, status: idle, source: { subAgent: { thread_spawn: {} } }, parentThreadId: "a" } });
    const s = bridge("s");
    s.link.start();
    await s.link.settled(1000);
    expect(s.link.canWake).toBe(false);
    expect(s.wakeChanges()).toBe(0);
    expect(s.reports).toEqual([]);
  });

  test("without Codex's app-server, the link gives up at once and messages wait for the Stop hook", async () => {
    const { bridge, logs } = setup({}, { noAppServer: true });
    const { link } = bridge("a");
    link.start();
    const started = Date.now();
    await link.settled(5000);
    expect(Date.now() - started).toBeLessThan(500);
    expect(link.canWake).toBe(false);
    expect(logs.lines.map((l) => l.msg)).toContain("codex_app_server_unavailable");
  });

  test("a conversation the app-server doesn't list yet is found on a later search", async () => {
    const { codex, bridge } = setup({ a: { cwd: FOLDER, status: idle, listed: false } });
    const { link } = bridge("a");
    link.start();
    setTimeout(() => (codex.threads.a!.listed = true), 3);
    await link.settled(1000);
    expect(link.canWake).toBe(true);
  });

  test("a nudge while idle starts a turn with what's waiting, then acks it", async () => {
    const { codex, acks, bridge } = setup({ a: { cwd: FOLDER, status: idle } }, { inbox: waiting(2) });
    const a = bridge("a");
    a.link.start();
    await a.link.settled(1000);
    a.link.nudge();
    await waitFor(() => acks.length === 1);
    expect(codex.turns).toEqual([{ threadId: "a", text: "Portico: m0, m1" }]);
    expect(acks[0]).toEqual({ messages: ["m0", "m1"], updates: [] });
    expect(a.reports).toEqual(["idle", "busy"]);
  });

  test("a nudge while busy waits for the turn to end; a nudge with nothing waiting starts nothing", async () => {
    const { codex, acks, bridge, hold } = setup({ a: { cwd: FOLDER, status: { type: "active", activeFlags: [] } } });
    const { link } = bridge("a");
    link.start();
    await link.settled(1000);
    hold(waiting(1));
    link.nudge();
    await Bun.sleep(20);
    expect(codex.turns).toEqual([]);
    codex.setStatus("a", idle);
    await waitFor(() => acks.length === 1);
    expect(codex.turns.map((t) => t.text)).toEqual(["Portico: m0"]);
    // The turn ends with nothing more waiting.
    codex.setStatus("a", idle);
    link.nudge();
    await Bun.sleep(20);
    expect(codex.turns).toHaveLength(1);
    expect(acks).toHaveLength(1);
  });

  test("a turn that doesn't start acks nothing, and is tried again", async () => {
    const { codex, acks, bridge, logs } = setup({ a: { cwd: FOLDER, status: idle } }, { inbox: waiting(1) });
    const { link } = bridge("a");
    link.start();
    await link.settled(1000);
    codex.failTurns(true);
    link.nudge();
    await waitFor(() => logs.lines.some((l) => l.msg === "wake_failed"));
    expect(acks).toEqual([]);
    codex.failTurns(false);
    await waitFor(() => acks.length === 1);
    expect(codex.turns).toHaveLength(1);
  });

  test("when the app-server goes away, the link can't wake and says so", async () => {
    const { codex, bridge } = setup({ a: { cwd: FOLDER, status: idle } });
    const a = bridge("a");
    a.link.start();
    await a.link.settled(1000);
    expect(a.link.canWake).toBe(true);
    codex.closeAll();
    expect(a.link.canWake).toBe(false);
    expect(a.wakeChanges()).toBe(2);
  });
});
