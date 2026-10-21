import { afterEach, beforeEach, expect, test } from "bun:test";
import { BASE_YAML, testConfig } from "../../hub/test/helpers";
import { HubClient } from "../src/hub-client";
import { createBridgePlugin } from "../src/plugin";
import type { OwnSession } from "../src/registry";
import { SessionWatcher } from "../src/status";
import { captureLog, fakeHost, fakeInboxSocket, type FakeInboxSocket, joinTestMachine, startHub, type TestHub, waitFor } from "./helpers";

// Sessions are reached through a kind rule, as on a real network.
const YAML = BASE_YAML.replace("rules:\n", 'rules:\n  - { from: grok-bot, to: "kind:claude-code", action: allow }\n');

let hub: TestHub;
let logs: ReturnType<typeof captureLog>;
const cleanup: (() => Promise<void>)[] = [];

beforeEach(() => {
  hub = startHub(testConfig(YAML));
  logs = captureLog();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  hub.stop();
});

interface SessionOpts {
  token: string;
  key: string;
  repo: string;
  folderId: string;
  status?: string;
  doing?: string;
}

/** A plugin in machine mode, as main.ts builds it, with a fake registry, git and inbox socket. */
async function machinePlugin(opts: SessionOpts): Promise<{ sock: FakeInboxSocket; session: OwnSession }> {
  const sock = await fakeInboxSocket();
  const session: OwnSession = {
    pid: 4242,
    sessionId: `s-${opts.key}`,
    cwd: `/w/${opts.repo}`,
    status: opts.status ?? "busy",
    name: null,
    messagingSocketPath: sock.path,
  };
  const client = new HubClient({ url: hub.url, token: opts.token, sessionKey: opts.key });
  const watcher = new SessionWatcher({
    locate: () => session,
    cwd: session.cwd,
    transcriptOf: () => null,
    git: async () => ({ repo: opts.repo, branch: "main" }),
    report: (r) => client.reportStatus(opts.doing ? { ...r, doing: opts.doing } : r),
    log: logs.log,
    pollMs: 20,
  });
  const plugin = createBridgePlugin({
    config: { url: hub.url, token: opts.token, permissionRelay: false, source: "machine", machine: "macbook" },
    client,
    log: logs.log,
    socket: sock.socket,
    registration: async () => ({ repo: opts.repo, folderId: opts.folderId }),
    watcher,
    stream: { initialBackoffMs: 10 },
    deliveryRetryMs: [30],
  });
  const host = await fakeHost(plugin);
  cleanup.push(async () => {
    await plugin.stop();
    await host.close();
    await sock.close();
  });
  return { sock, session };
}

test("a machine-mode plugin registers as <repo>-claude@<machine> and reports its status", async () => {
  const { token } = joinTestMachine(hub, "macbook");
  const doing = "Secret plan · Adding tests";
  const folderId = "a".repeat(64);
  await machinePlugin({ token, key: "key-aaaaaaaa", repo: "dialog", folderId, doing });
  await waitFor(
    () => hub.streams.isConnected("dialog-claude@macbook") && hub.presence.get("dialog-claude@macbook")?.status === "busy",
    3000,
  );
  expect(hub.presence.get("dialog-claude@macbook")).toMatchObject({ status: "busy", doing, repo: "dialog", branch: "main" });
  expect(logs.lines).toContainEqual({ level: "info", msg: "session_registered", fields: { address: "dialog-claude@macbook" } });
  // Nothing private in the logs: not the doing text, the folder ID, the session key or the token.
  const logged = JSON.stringify(logs.lines);
  for (const secret of ["Secret plan", folderId, "key-aaaaaaaa", token]) expect(logged).not.toContain(secret);
});

test("tasks for the session arrive through its socket", async () => {
  const { token } = joinTestMachine(hub, "macbook");
  const { sock } = await machinePlugin({ token, key: "key-aaaaaaaa", repo: "dialog", folderId: "a".repeat(64) });
  await waitFor(() => hub.streams.isConnected("dialog-claude@macbook"), 3000);
  const task = hub.service.sendTask("grok-bot", { to: "dialog-claude@macbook", instructions: "Check the login page" });
  expect(task.status).toBe("queued");
  await waitFor(() => sock.posts.length === 1, 3000);
  expect(sock.posts[0]!.content).toContain("Check the login page\n</bridge-task>");
  await waitFor(() => hub.service.findTask(task.id)?.status === "working", 3000);
});

test("two plugins on one machine, in different folders, both stay connected", async () => {
  const { token } = joinTestMachine(hub, "macbook");
  await machinePlugin({ token, key: "key-aaaaaaaa", repo: "dialog", folderId: "a".repeat(64), status: "busy" });
  await machinePlugin({ token, key: "key-bbbbbbbb", repo: "dialog", folderId: "b".repeat(64), status: "waiting" });
  await waitFor(
    () =>
      hub.presence.get("dialog-claude@macbook")?.status === "busy" &&
      hub.presence.get("dialog-claude-2@macbook")?.status === "waiting",
    3000,
  );
  await Bun.sleep(150);
  expect(hub.streams.isConnected("dialog-claude@macbook")).toBe(true);
  expect(hub.streams.isConnected("dialog-claude-2@macbook")).toBe(true);
  expect(logs.lines.map((l) => l.msg)).not.toContain("stream_replaced");
});

test("the status watcher starts on the first hello, resends on a later hello, and stops on onStop", async () => {
  const { token } = joinTestMachine(hub, "macbook");
  const sock = await fakeInboxSocket();
  const calls: string[] = [];
  const watcher = {
    start: () => void calls.push("start"),
    resend: () => void calls.push("resend"),
    stop: () => void calls.push("stop"),
  };
  // The stream can't open, so no hello comes, until the gate is released.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const plugin = createBridgePlugin({
    config: { url: hub.url, token, permissionRelay: false, source: "machine", machine: "macbook" },
    client: new HubClient({ url: hub.url, token, sessionKey: "key-aaaaaaaa" }),
    log: logs.log,
    socket: sock.socket,
    registration: async () => {
      await gate;
      return { repo: "dialog", folderId: "a".repeat(64) };
    },
    watcher,
    stream: { initialBackoffMs: 10 },
  });
  const host = await fakeHost(plugin);
  cleanup.push(async () => {
    await plugin.stop();
    await host.close();
    await sock.close();
  });
  await Bun.sleep(100);
  expect(calls).toEqual([]); // the MCP handshake alone starts nothing

  release();
  await waitFor(() => calls.length === 1, 3000);
  expect(calls).toEqual(["start"]);

  // The stream drops and reconnects: a second hello.
  hub.streams.close("dialog-claude@macbook");
  await waitFor(() => calls.length === 2, 3000);
  expect(calls).toEqual(["start", "resend"]);

  // The machine is removed: the reconnect gets 401, and the stream stops for good.
  hub.networkService.removeMachine("macbook");
  hub.streams.close("dialog-claude@macbook");
  await waitFor(() => calls.length === 3, 3000);
  expect(calls).toEqual(["start", "resend", "stop"]);
});

test("a removed machine's session is told to join again", async () => {
  const { token } = joinTestMachine(hub, "macbook");
  const { sock } = await machinePlugin({ token, key: "key-aaaaaaaa", repo: "dialog", folderId: "a".repeat(64) });
  await waitFor(() => hub.streams.isConnected("dialog-claude@macbook"), 3000);
  hub.networkService.removeMachine("macbook");
  hub.streams.close("dialog-claude@macbook");
  await waitFor(() => sock.posts.length === 1, 3000);
  expect(sock.posts[0]!.content).toContain("the hub no longer accepts this machine's token");
  expect(sock.posts[0]!.content).toContain("Join again with a new join line");
});
