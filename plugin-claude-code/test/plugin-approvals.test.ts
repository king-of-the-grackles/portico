import { afterEach, beforeEach, expect, test } from "bun:test";
import { signIn, testConfig } from "../../hub/test/helpers";
import { HubClient } from "../src/hub-client";
import { createPorticoPlugin } from "../src/plugin";
import type { DialogRunner } from "../src/popup";
import { captureLog, fakeHost, fakeInboxSocket, fakeRunner, hubClient, joinTestMachine, startHub, type TestHub, waitFor } from "./helpers";

// BASE_YAML sends every task for muse through an ask rule.
let hub: TestHub;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  hub = realTimeHub();
});

/**
 * A test hub whose clock reads the real time, so its tasks expire a day from now: the plugin's panels compare the
 * expiry with the real clock, and a task already expired shows no panel.
 */
function realTimeHub(opts: Parameters<typeof startHub>[1] = {}): TestHub {
  const started = startHub(testConfig(), opts);
  started.clock.advance(Date.now() - started.clock.now().getTime());
  return started;
}
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  hub.stop();
});

async function session(token: string, key: string, repo: string, folderId: string, runner: DialogRunner | null) {
  const sock = await fakeInboxSocket();
  const client = new HubClient({ url: hub.url, token, sessionKey: key });
  const plugin = createPorticoPlugin({
    config: { url: hub.url, token, source: "machine", machine: "macbook" },
    client,
    log: captureLog().log,
    socket: sock.socket,
    registration: async () => ({ repo, folderId }),
    popup: runner,
    answerRetryMs: [5],
    stream: { initialBackoffMs: 10 },
  });
  const host = await fakeHost(plugin);
  cleanup.push(async () => {
    await plugin.stop();
    await host.close();
    await sock.close();
  });
  return { plugin, client };
}

test("an ask task pops up in the machine's oldest session only, and Approve there queues the task", async () => {
  const { token } = joinTestMachine(hub, "macbook");
  const first = fakeRunner();
  const second = fakeRunner();
  await session(token, "key-first-0001", "api", "a".repeat(64), first.runner);
  await waitFor(() => hub.streams.popupSessions("macbook").length === 1);
  await session(token, "key-second-002", "web", "b".repeat(64), second.runner);
  await waitFor(() => hub.streams.popupSessions("macbook").length === 2);
  const task = hub.service.sendTask("grok-bot", { to: "muse", instructions: "Summarize the inbox" });
  await waitFor(() => first.panels.length === 1);
  expect(first.panels[0]!.prompt).toMatchObject({ taskId: task.id, from: "grok-bot", to: "muse", instructions: "Summarize the inbox" });
  first.panels[0]!.answer({ kind: "answered", decision: "approve", note: "" });
  await waitFor(() => hub.service.findTask(task.id)?.status === "queued");
  await Bun.sleep(50);
  expect(second.panels).toEqual([]);
});

test("Deny with a note denies the task with the note as its reason", async () => {
  const { token } = joinTestMachine(hub, "macbook");
  const runner = fakeRunner();
  await session(token, "key-first-0001", "api", "a".repeat(64), runner.runner);
  await waitFor(() => hub.streams.popupSessions("macbook").length === 1);
  const task = hub.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
  await waitFor(() => runner.panels.length === 1);
  runner.panels[0]!.answer({ kind: "answered", decision: "deny", note: "Not this week" });
  await waitFor(() => hub.service.findTask(task.id)?.status === "denied");
  expect(hub.service.findTask(task.id)?.reason).toBe("Not this week");
});

test("approving on the hub page closes the panel", async () => {
  const { token } = joinTestMachine(hub, "macbook");
  const runner = fakeRunner();
  await session(token, "key-first-0001", "api", "a".repeat(64), runner.runner);
  await waitFor(() => hub.streams.popupSessions("macbook").length === 1);
  const task = hub.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
  await waitFor(() => runner.panels.length === 1);
  const cookie = await signIn(hub.app);
  expect((await hub.app.request(`/hub/tasks/${task.id}/approve`, { method: "POST", headers: { cookie } })).status).toBe(200);
  await waitFor(() => runner.panels[0]!.killed);
});

test("when the session holding the panel stops, the other session on the machine shows it", async () => {
  const { token } = joinTestMachine(hub, "macbook");
  const first = fakeRunner();
  const second = fakeRunner();
  const holder = await session(token, "key-first-0001", "api", "a".repeat(64), first.runner);
  await waitFor(() => hub.streams.popupSessions("macbook").length === 1);
  await session(token, "key-second-002", "web", "b".repeat(64), second.runner);
  await waitFor(() => hub.streams.popupSessions("macbook").length === 2);
  const task = hub.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
  await waitFor(() => first.panels.length === 1);
  await holder.plugin.stop();
  expect(first.panels[0]!.killed).toBe(true);
  await waitFor(() => second.panels.length === 1);
  expect(second.panels[0]!.prompt.taskId).toBe(task.id);
});

test("a dropped stream kills the panel, and the reconnect brings it back with the same nonce", async () => {
  hub.stop();
  let made = 0;
  hub = realTimeHub({ newNonce: () => `nonce-${++made}-aaaaaaaaaaaaaaaa` });
  const { token } = joinTestMachine(hub, "macbook");
  const runner = fakeRunner();
  const { client } = await session(token, "key-first-0001", "api", "a".repeat(64), runner.runner);
  const nonces: string[] = [];
  const answer = client.answerApproval.bind(client);
  client.answerApproval = (taskId, body) => {
    nonces.push(body.nonce);
    return answer(taskId, body);
  };
  await waitFor(() => hub.streams.popupSessions("macbook").length === 1);
  const task = hub.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
  await waitFor(() => runner.panels.length === 1);
  hub.streams.close("api-claude@macbook");
  await waitFor(() => runner.panels[0]!.killed);
  await waitFor(() => runner.panels.length === 2);
  expect(runner.panels[1]!.prompt.taskId).toBe(task.id);
  runner.panels[1]!.answer({ kind: "answered", decision: "approve", note: "" });
  await waitFor(() => hub.service.findTask(task.id)?.status === "queued");
  expect(made).toBe(1);
  expect(nonces).toEqual(["nonce-1-aaaaaaaaaaaaaaaa"]);
});

test("a session whose panel fails to show reconnects without pop-ups, and the next session on the machine gets the request", async () => {
  const { token } = joinTestMachine(hub, "macbook");
  const broken = fakeRunner();
  const working = fakeRunner();
  await session(token, "key-first-0001", "api", "a".repeat(64), broken.runner);
  await waitFor(() => hub.streams.popupSessions("macbook").length === 1);
  await session(token, "key-second-002", "web", "b".repeat(64), working.runner);
  await waitFor(() => hub.streams.popupSessions("macbook").length === 2);
  const task = hub.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
  await waitFor(() => broken.panels.length === 1);
  broken.panels[0]!.answer({ kind: "failed", code: 1 });
  await waitFor(() => working.panels.length === 1);
  expect(working.panels[0]!.prompt.taskId).toBe(task.id);
  // The failed session is back on the network, but no longer as a pop-up session.
  await waitFor(
    () =>
      hub.streams.isConnected("api-claude@macbook") &&
      hub.streams.popupSessions("macbook").join() === "web-claude@macbook",
  );
  expect(hub.service.approvalFor(hub.service.findTask(task.id)!)?.popups).toEqual(["macbook"]);
  working.panels[0]!.answer({ kind: "answered", decision: "approve", note: "" });
  await waitFor(() => hub.service.findTask(task.id)?.status === "queued");
  expect(broken.panels).toHaveLength(1);
});

test("a session without a runner never declares pop-ups, and send_task says no machine is online", async () => {
  const { token } = joinTestMachine(hub, "macbook");
  await session(token, "key-nopopup-01", "api", "a".repeat(64), null);
  await waitFor(() => hub.streams.isConnected("api-claude@macbook"));
  expect(hub.streams.popupSessions("macbook")).toEqual([]);
  const sent = await hubClient(hub, "grok-bot").sendTask({ to: "muse", instructions: "x" });
  expect(sent.approval?.popups).toEqual([]);
});
