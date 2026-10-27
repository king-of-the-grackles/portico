import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Agent } from "../../server/src/core/types";
import type { DialogRunner } from "../src/popup";
import { PorticoClient } from "../src/portico-client";
import { agentAt, appAgent, connected, fakeRunner, joinTestComputer, startPortico, startSession, type TestPortico, waitFor } from "./helpers";

let p: TestPortico;
let token: string;
let computerId: string;
let grok: Agent;
const cleanup: (() => Promise<void>)[] = [];

async function setUp(opts: { newNonce?: () => string } = {}) {
  // Real time, so held messages expire a day from now and their panels show.
  p = await startPortico({ realTime: true, newNonce: opts.newNonce });
  ({ token, computerId } = joinTestComputer(p, "macbook"));
  grok = appAgent(p, "grok", { kind: "grok-bot" }).agent;
  appAgent(p, "muse", { approvalRequired: true });
}

beforeEach(() => setUp());
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  p.stop();
});

async function session(key: string, repo: string, folderId: string, runner: DialogRunner | null, client?: PorticoClient) {
  const s = await startSession(p, { token, key, repo, folderId, runner, client });
  cleanup.push(s.stop);
  return s;
}

/** The computer's pop-up sessions, by address. */
const popups = () => p.agentStreams.popupSessions(computerId).map((id) => p.agents.address(p.agents.get(id)!));
const hold = (subject = "Read the inbox", text = "Summarize the inbox") =>
  p.messages.send(grok, { to: "muse", subject, text }).message;
const status = (id: string) => p.messages.get(id)?.status;

test("a held message pops up in the computer's oldest session only, and Allow once there delivers the message", async () => {
  const first = fakeRunner();
  const second = fakeRunner();
  await session("key-first-0001", "api", "a".repeat(64), first.runner);
  await waitFor(() => popups().length === 1);
  await session("key-second-002", "web", "b".repeat(64), second.runner);
  await waitFor(() => popups().length === 2);
  const message = hold();
  expect(message.status).toBe("held");
  await waitFor(() => first.panels.length === 1);
  expect(first.panels[0]!.prompt).toMatchObject({
    messageId: message.id,
    from: "grok",
    to: "muse",
    subject: "Read the inbox",
    text: "Summarize the inbox",
  });
  first.panels[0]!.answer({ kind: "answered", decision: "allow_once" });
  await waitFor(() => status(message.id) === "pending");
  expect(p.messages.get(message.id)?.decision).toBe("allow_once");
  await Bun.sleep(50);
  expect(second.panels).toEqual([]);
});

test("Always allow adds the sender to the allow list, and Deny declines", async () => {
  const runner = fakeRunner();
  await session("key-first-0001", "api", "a".repeat(64), runner.runner);
  await waitFor(() => popups().length === 1);
  const denied = hold("First", "x");
  await waitFor(() => runner.panels.length === 1);
  runner.panels[0]!.answer({ kind: "answered", decision: "deny" });
  await waitFor(() => status(denied.id) === "declined");

  const allowed = hold("Second", "y");
  await waitFor(() => runner.panels.length === 2);
  runner.panels[1]!.answer({ kind: "answered", decision: "always_allow" });
  await waitFor(() => status(allowed.id) === "pending");
  const muse = agentAt(p, "muse")!;
  expect(p.allowList.has(muse.id, grok.id)).toBe(true);
  // From now on, grok's messages to muse go straight through.
  expect(hold("Third", "z").status).toBe("pending");
});

test("deciding on Home closes the panel", async () => {
  const runner = fakeRunner();
  await session("key-first-0001", "api", "a".repeat(64), runner.runner);
  await waitFor(() => popups().length === 1);
  const message = hold();
  await waitFor(() => runner.panels.length === 1);
  p.approvals.decide(p.owner.id, message.id, "allow_once");
  await waitFor(() => runner.panels[0]!.killed);
});

test("when the session holding the panel stops, the other session on the computer shows it", async () => {
  const first = fakeRunner();
  const second = fakeRunner();
  const holder = await session("key-first-0001", "api", "a".repeat(64), first.runner);
  await waitFor(() => popups().length === 1);
  await session("key-second-002", "web", "b".repeat(64), second.runner);
  await waitFor(() => popups().length === 2);
  const message = hold();
  await waitFor(() => first.panels.length === 1);
  await holder.plugin.stop();
  expect(first.panels[0]!.killed).toBe(true);
  await waitFor(() => second.panels.length === 1);
  expect(second.panels[0]!.prompt.messageId).toBe(message.id);
});

test("a dropped stream kills the panel, and the reconnect brings it back with the same nonce", async () => {
  p.stop();
  let made = 0;
  await setUp({ newNonce: () => `nonce-${++made}-aaaaaaaaaaaaaaaa` });
  const runner = fakeRunner();
  const nonces: string[] = [];
  const client = new PorticoClient({ url: p.url, token, sessionKey: "key-first-0001" });
  const answer = client.answerApproval.bind(client);
  client.answerApproval = (messageId, body) => {
    nonces.push(body.nonce);
    return answer(messageId, body);
  };
  await session("key-first-0001", "api", "a".repeat(64), runner.runner, client);
  await waitFor(() => popups().length === 1);
  const message = hold();
  await waitFor(() => runner.panels.length === 1);
  p.agentStreams.closeAll([agentAt(p, "api-claude@macbook")!.id]);
  await waitFor(() => runner.panels[0]!.killed);
  await waitFor(() => runner.panels.length === 2);
  expect(runner.panels[1]!.prompt.messageId).toBe(message.id);
  runner.panels[1]!.answer({ kind: "answered", decision: "allow_once" });
  await waitFor(() => status(message.id) === "pending");
  expect(made).toBe(1);
  expect(nonces).toEqual(["nonce-1-aaaaaaaaaaaaaaaa"]);
});

test("a session whose panel fails to show reconnects without pop-ups, and the next session on the computer gets the request", async () => {
  const broken = fakeRunner();
  const working = fakeRunner();
  await session("key-first-0001", "api", "a".repeat(64), broken.runner);
  await waitFor(() => popups().length === 1);
  await session("key-second-002", "web", "b".repeat(64), working.runner);
  await waitFor(() => popups().length === 2);
  const message = hold();
  await waitFor(() => broken.panels.length === 1);
  broken.panels[0]!.answer({ kind: "failed", code: 1 });
  await waitFor(() => working.panels.length === 1);
  expect(working.panels[0]!.prompt.messageId).toBe(message.id);
  // The failed session is back on Portico, but no longer as a pop-up session.
  await waitFor(() => connected(p, "api-claude@macbook") && popups().join() === "web-claude@macbook");
  working.panels[0]!.answer({ kind: "answered", decision: "allow_once" });
  await waitFor(() => status(message.id) === "pending");
  expect(broken.panels).toHaveLength(1);
});

test("a session without a runner never declares pop-ups", async () => {
  await session("key-nopopup-01", "api", "a".repeat(64), null);
  await waitFor(() => connected(p, "api-claude@macbook"));
  expect(popups()).toEqual([]);
});
