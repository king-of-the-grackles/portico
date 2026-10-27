import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sessionBaseName } from "../../server/src/core/sessions";
import { writeMachineFile } from "../src/machine";
import {
  ChannelNotification,
  fakeInboxSocket,
  type FakeInboxSocket,
  joinTestMachine,
  startPortico,
  type TestPortico,
  TOKENS,
  waitFor,
  writeSessionFile,
} from "./helpers";

const MAIN = join(import.meta.dir, "../src/main.ts");

let hub: TestPortico | null = null;
let sock: FakeInboxSocket | null = null;
const dirs: string[] = [];
afterEach(async () => {
  hub?.stop();
  hub = null;
  await sock?.close();
  sock = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFolder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * The child's environment, built from scratch: never the test run's own, which inside a Claude Code session carries
 * CLAUDE_CODE_MESSAGING_SOCKET and would post into that session. PORTICO_POPUP=off: a launched plugin never starts a
 * real approval panel.
 */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = tempFolder("portico-home-");
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    PORTICO_CLAUDE_HOME: join(home, ".claude"),
    PORTICO_MACHINE_CONFIG: join(home, "machine.json"),
    PORTICO_POPUP: "off",
    ...extra,
  };
}

/** The plugin's stderr log lines with this msg. */
function logged(stderr: string, msg: string): Record<string, unknown>[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.msg === msg);
}

async function launch(env: Record<string, string>) {
  // An empty working folder, so Bun can't load a developer's .env into the plugin.
  const transport = new StdioClientTransport({ command: "bun", args: [MAIN], env, cwd: tempFolder("portico-plugin-"), stderr: "pipe" });
  const host = new Client({ name: "fake-claude-code", version: "1.0.0" });
  const channel: string[] = [];
  const errors: Error[] = [];
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  host.setNotificationHandler(ChannelNotification, ({ params }) => {
    channel.push(params.content);
  });
  host.onerror = (err) => errors.push(err);
  await host.connect(transport);
  return { host, channel, errors, stderr: () => stderr.join("") };
}

/** A session registry file naming this test process, which is the plugin's parent, as the Claude Code session. */
function registerSession(env: Record<string, string>, fields: Parameters<typeof writeSessionFile>[2]): void {
  const sessions = join(env.PORTICO_CLAUDE_HOME!, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeSessionFile(sessions, process.pid, fields);
}

describe("the plugin over stdio", () => {
  test("serves the tools and posts tasks into the inbox socket, with nothing but MCP on stdout", async () => {
    hub = startPortico();
    sock = await fakeInboxSocket();
    const env = childEnv({
      PORTICO_URL: hub.url,
      PORTICO_TOKEN: TOKENS["claude-code"],
      CLAUDE_CODE_MESSAGING_SOCKET: sock.path,
      CLAUDE_CODE_MESSAGING_TOKEN: "stdio-inbox-token",
    });
    const { host, channel, errors, stderr } = await launch(env);
    try {
      expect((await host.listTools()).tools).toHaveLength(7);
      await waitFor(() => hub!.streams.isConnected("claude-code"), 5000);
      const task = hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "Over stdio" });
      await waitFor(() => sock!.posts.length === 1, 5000);
      expect(sock.posts[0]).toEqual({ auth: "stdio-inbox-token", content: expect.stringContaining("Over stdio\n</portico-task>") });
      await waitFor(() => hub!.service.findTask(task.id)?.status === "working", 5000);
      expect(channel).toEqual([]);
      // Env mode never has pop-ups, and says nothing about them.
      expect(logged(stderr(), "approval_popup_unavailable")).toEqual([]);
      expect(logged(stderr(), "plugin_started")).toEqual([expect.objectContaining({ mode: "env", popup: false })]);
      expect(errors).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test("finds the inbox socket through the session registry when the environment doesn't name it", async () => {
    hub = startPortico();
    sock = await fakeInboxSocket();
    const env = childEnv({ PORTICO_URL: hub.url, PORTICO_TOKEN: TOKENS["claude-code"] });
    // The plugin's parent is this test process, so it plays the Claude Code session.
    const sessions = join(env.PORTICO_CLAUDE_HOME!, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeSessionFile(sessions, process.pid, { sessionId: "s-stdio", cwd: "/work", messagingSocketPath: sock.path });
    const { host } = await launch(env);
    try {
      await waitFor(() => hub!.streams.isConnected("claude-code"), 5000);
      hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "Through the registry" });
      await waitFor(() => sock!.posts.length === 1, 5000);
      expect(sock.posts[0]).toEqual({ auth: null, content: expect.stringContaining("Through the registry") });
    } finally {
      await host.close();
    }
  });

  test("idles with no tools and no channel when PORTICO_URL and PORTICO_TOKEN are unset", async () => {
    const { host } = await launch(childEnv());
    try {
      const capabilities = host.getServerCapabilities() ?? {};
      expect(capabilities.tools).toBeUndefined();
      expect(capabilities.experimental).toBeUndefined();
    } finally {
      await host.close();
    }
  });

  test("exits with the problems when the settings are half there", async () => {
    const proc = Bun.spawn(["bun", MAIN], {
      cwd: tempFolder("portico-plugin-"),
      env: childEnv({ PORTICO_URL: "http://portico.example.com" }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("PORTICO_TOKEN is not set");
    expect(stderr).toContain("https://");
    expect(await new Response(proc.stdout).text()).toBe("");
  });

  test("idles when the session's folder is off", async () => {
    const project = tempFolder("portico-proj-");
    const env = childEnv();
    writeMachineFile(env.PORTICO_MACHINE_CONFIG!, {
      hub: "http://127.0.0.1:9",
      machine: "macbook",
      token: "bm_test-machine-token",
      off: [project],
    });
    registerSession(env, { sessionId: "s-off", cwd: project, status: "busy" });
    const { host, stderr } = await launch(env);
    try {
      const capabilities = host.getServerCapabilities() ?? {};
      expect(capabilities.tools).toBeUndefined();
      expect(capabilities.experimental).toBeUndefined();
      await waitFor(() => stderr().includes('"plugin_idle"'), 5000);
      expect(stderr()).not.toContain(project);
      expect(stderr()).not.toContain(realpathSync(project));
    } finally {
      await host.close();
    }
  });

  test("in machine mode, registers and serves the tools", async () => {
    hub = startPortico();
    sock = await fakeInboxSocket();
    const { token, machine } = joinTestMachine(hub, "macbook");
    const project = tempFolder("portico-proj-");
    const env = childEnv();
    writeMachineFile(env.PORTICO_MACHINE_CONFIG!, { hub: hub.url, machine, token, off: [] });
    registerSession(env, { sessionId: "s-machine", cwd: project, status: "busy", messagingSocketPath: sock.path });
    const address = `${sessionBaseName(basename(project))}@macbook`;
    const { host, errors, stderr } = await launch(env);
    try {
      expect((await host.listTools()).tools).toHaveLength(7);
      await waitFor(() => hub!.streams.isConnected(address), 5000);
      await waitFor(() => hub!.presence.get(address)?.status === "busy", 5000);
      // Outside git, the repo is the folder's basename; never the path.
      expect(hub.presence.get(address)).toMatchObject({ repo: basename(project), branch: null });
      expect(hub.network.sessionByAddress(sessionBaseName(basename(project)), "macbook")?.folder).toBe(basename(project));
      // PORTICO_POPUP=off: no pop-ups, said once at start, and the stream never declares them.
      expect(logged(stderr(), "approval_popup_unavailable")).toEqual([
        expect.objectContaining({ level: "warn", platform: process.platform, reason: "off" }),
      ]);
      expect(logged(stderr(), "plugin_started")).toEqual([expect.objectContaining({ mode: "machine", popup: false })]);
      expect(hub.streams.popupSessions("macbook")).toEqual([]);
      expect(errors).toEqual([]);
      for (const secret of [token, project, realpathSync(project)]) expect(stderr()).not.toContain(secret);
    } finally {
      await host.close();
    }
  });

  test("exits with a JSON error line, naming no path, when machine.json is broken", async () => {
    const env = childEnv();
    writeFileSync(env.PORTICO_MACHINE_CONFIG!, "{ not json");
    const proc = Bun.spawn(["bun", MAIN], { cwd: tempFolder("portico-plugin-"), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(1);
    const stderr = await new Response(proc.stderr).text();
    const lines = stderr.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ level: "error", msg: "machine_file_invalid", error: "MachineFileError" }));
    expect(stderr).not.toContain(env.PORTICO_MACHINE_CONFIG!);
    expect(await new Response(proc.stdout).text()).toBe("");
  });
});
