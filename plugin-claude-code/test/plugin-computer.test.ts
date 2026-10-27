import { afterEach, beforeEach, expect, test } from "bun:test";
import { PorticoClient } from "../src/portico-client";
import type { OwnSession } from "../src/registry";
import { SessionWatcher } from "../src/status";
import { runTool } from "../src/tools";
import { agentAt, captureLog, connected, joinTestComputer, startPortico, startSession, type TestPortico, waitFor } from "./helpers";

let p: TestPortico;
let token: string;
let logs: ReturnType<typeof captureLog>;
const cleanup: (() => Promise<void>)[] = [];

beforeEach(async () => {
  p = await startPortico();
  token = joinTestComputer(p, "macbook").token;
  logs = captureLog();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  p.stop();
});

interface SessionOpts {
  key: string;
  repo: string;
  folderId: string;
  status?: string;
  doing?: string;
}

/** A plugin as main.ts builds it, with a fake registry, git and inbox socket, and a real status watcher. */
async function computerPlugin(opts: SessionOpts) {
  const session: OwnSession = {
    pid: 4242,
    sessionId: `s-${opts.key}`,
    cwd: `/w/${opts.repo}`,
    status: opts.status ?? "busy",
    name: null,
    messagingSocketPath: null,
  };
  const client = new PorticoClient({ url: p.url, token, sessionKey: opts.key });
  const watcher = new SessionWatcher({
    locate: () => session,
    cwd: session.cwd,
    transcriptOf: () => null,
    git: async () => ({ repo: opts.repo, branch: "main" }),
    report: (r) => client.reportStatus(opts.doing ? { ...r, doing: opts.doing } : r),
    log: logs.log,
    pollMs: 20,
  });
  const s = await startSession(p, { token, key: opts.key, repo: opts.repo, folderId: opts.folderId, client, watcher, log: logs.log });
  cleanup.push(s.stop);
  return s;
}

const presence = (address: string) => {
  const agent = agentAt(p, address);
  return agent ? p.presence.get(agent.id) : null;
};

test("a plugin registers as <repo>-claude@<computer> and reports its status", async () => {
  const doing = "Secret plan · Adding tests";
  const folderId = "a".repeat(64);
  await computerPlugin({ key: "key-aaaaaaaa", repo: "dialog", folderId, doing });
  await waitFor(() => connected(p, "dialog-claude@macbook") && presence("dialog-claude@macbook")?.status === "busy", 3000);
  expect(presence("dialog-claude@macbook")).toMatchObject({ status: "busy", doing, repo: "dialog", branch: "main" });
  expect(logs.lines).toContainEqual({ level: "info", msg: "session_registered", fields: { address: "dialog-claude@macbook" } });
  // Nothing private in the logs: not the doing text, the folder ID, the session key or the token.
  const logged = JSON.stringify(logs.lines);
  for (const secret of ["Secret plan", folderId, "key-aaaaaaaa", token]) expect(logged).not.toContain(secret);
});

test("a tool call before the session registers says so, rather than blaming the token", async () => {
  const client = new PorticoClient({ url: p.url, token, sessionKey: "key-not-registered" });
  expect(await runTool(client, "list_agents", {})).toEqual({
    content: [
      {
        type: "text",
        text: "unauthorized: This session isn't registered with Portico yet. The session registers when its live stream connects; check the plugin log.",
      },
    ],
    isError: true,
  });
});

test("two plugins on one computer, in different folders, both stay connected", async () => {
  await computerPlugin({ key: "key-aaaaaaaa", repo: "dialog", folderId: "a".repeat(64), status: "busy" });
  await computerPlugin({ key: "key-bbbbbbbb", repo: "dialog", folderId: "b".repeat(64), status: "waiting" });
  await waitFor(
    () => presence("dialog-claude@macbook")?.status === "busy" && presence("dialog-claude-2@macbook")?.status === "waiting",
    3000,
  );
  await Bun.sleep(150);
  expect(connected(p, "dialog-claude@macbook")).toBe(true);
  expect(connected(p, "dialog-claude-2@macbook")).toBe(true);
  expect(logs.lines.map((l) => l.msg)).not.toContain("stream_replaced");
});

test("the status watcher starts on the first hello, resends on a later hello, and stops on a permanent stop", async () => {
  const calls: string[] = [];
  const watcher = {
    start: () => void calls.push("start"),
    resend: () => void calls.push("resend"),
    stop: () => void calls.push("stop"),
  };
  // The stream can't open, so no hello comes, until the gate is released.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const s = await startSession(p, {
    token,
    key: "key-aaaaaaaa",
    watcher,
    registration: async () => {
      await gate;
      return { repo: "dialog", folderId: "a".repeat(64) };
    },
  });
  cleanup.push(s.stop);
  await Bun.sleep(100);
  expect(calls).toEqual([]); // the MCP handshake alone starts nothing

  release();
  await waitFor(() => calls.length === 1, 3000);
  expect(calls).toEqual(["start"]);

  // The stream drops and reconnects: a second hello.
  const id = agentAt(p, "dialog-claude@macbook")!.id;
  p.agentStreams.closeAll([id]);
  await waitFor(() => calls.length === 2, 3000);
  expect(calls).toEqual(["start", "resend"]);

  // The computer is removed: the reconnect gets 401, and the stream stops for good.
  p.agents.forget(p.computers.remove(p.computers.byName("macbook")!.id));
  await waitFor(() => calls.length === 3, 3000);
  expect(calls).toEqual(["start", "resend", "stop"]);
});

test("a removed computer's session is told to join again", async () => {
  const { sock } = await computerPlugin({ key: "key-aaaaaaaa", repo: "dialog", folderId: "a".repeat(64) });
  await waitFor(() => connected(p, "dialog-claude@macbook"), 3000);
  p.agents.forget(p.computers.remove(p.computers.byName("macbook")!.id));
  await waitFor(() => sock.posts.length === 1, 3000);
  expect(sock.posts[0]!.content).toContain("Portico no longer accepts this computer's token");
  expect(sock.posts[0]!.content).toContain("Join again with a new join line");
});
