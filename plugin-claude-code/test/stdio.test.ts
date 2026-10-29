import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sessionBaseName } from "../../server/src/core/agents";
import { folderId, readComputerFile, writeComputerFile } from "../src/computer";
import {
  agentAt,
  appAgent,
  ChannelNotification,
  ToolListChanged,
  connected,
  fakeInboxSocket,
  type FakeInboxSocket,
  joinTestComputer,
  startPortico,
  type TestPortico,
  waitFor,
  writeSessionFile,
} from "./helpers";

const MAIN = join(import.meta.dir, "../src/main.ts");

let p: TestPortico | null = null;
let sock: FakeInboxSocket | null = null;
const dirs: string[] = [];
afterEach(async () => {
  p?.stop();
  p = null;
  await sock?.close();
  sock = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFolder(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
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
    PORTICO_COMPUTER_CONFIG: join(home, ".portico", "computer.json"),
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

/** A joined computer in a fresh home, with a project folder the session runs in. */
async function joinedComputer(extra: Record<string, string> = {}) {
  p = await startPortico();
  const { token, computer } = joinTestComputer(p, "macbook");
  const project = tempFolder("portico-proj-");
  const env = childEnv(extra);
  writeComputerFile(env.PORTICO_COMPUTER_CONFIG!, { url: p.url, computer, token, off: [] });
  const address = `${sessionBaseName(basename(project))}@macbook`;
  return { p, token, project, env, address };
}

describe("the plugin over stdio", () => {
  test("registers the session, serves the tools and posts messages into the inbox socket, with nothing but MCP on stdout", async () => {
    sock = await fakeInboxSocket();
    const { p, token, project, env, address } = await joinedComputer({
      CLAUDE_CODE_MESSAGING_SOCKET: sock.path,
      CLAUDE_CODE_MESSAGING_TOKEN: "stdio-inbox-token",
    });
    registerSession(env, { sessionId: "s-stdio", cwd: project, status: "busy" });
    const { host, channel, errors, stderr } = await launch(env);
    try {
      expect((await host.listTools()).tools.map((tool) => tool.name)).toEqual(["list_agents", "send_message", "check_inbox", "list_tasks", "get_task", "update_profile"]);
      await waitFor(() => connected(p, address), 5000);
      await waitFor(() => p.presence.get(agentAt(p, address)!.id)?.status === "busy", 5000);
      // Outside git, the repo is the folder's basename; never the path.
      expect(p.presence.get(agentAt(p, address)!.id)).toMatchObject({ repo: basename(project), branch: null });
      expect(agentAt(p, address)?.folder).toBe(basename(project));
      expect(agentAt(p, address)?.folderId).toBe(folderId(token, project));

      const { agent } = appAgent(p, "grok", { kind: "grok-bot" });
      p.messages.send(agent, { to: sessionBaseName(basename(project)), subject: "Stdio", text: "Over stdio" });
      await waitFor(() => sock!.posts.length === 1, 5000);
      expect(sock.posts[0]).toEqual({ auth: "stdio-inbox-token", content: expect.stringContaining("Over stdio\n</portico-message>") });
      expect(channel).toEqual([]);
      // PORTICO_POPUP=off: no pop-ups, said once at start, and the stream never declares them.
      expect(logged(stderr(), "approval_popup_unavailable")).toEqual([
        expect.objectContaining({ level: "warn", platform: process.platform, reason: "off" }),
      ]);
      expect(logged(stderr(), "plugin_started")).toEqual([expect.objectContaining({ computer: "macbook", popup: false, folder_off: false })]);
      expect(p.agentStreams.popupSessions(p.computers.byName("macbook")!.id)).toEqual([]);
      expect(errors).toEqual([]);
      for (const secret of [token, project, "Over stdio"]) expect(stderr()).not.toContain(secret);
    } finally {
      await host.close();
    }
  });

  test("finds the inbox socket through the session registry when the environment doesn't name it", async () => {
    sock = await fakeInboxSocket();
    const { p, project, env, address } = await joinedComputer();
    registerSession(env, { sessionId: "s-registry", cwd: project, messagingSocketPath: sock.path });
    const { host } = await launch(env);
    try {
      await waitFor(() => connected(p, address), 5000);
      const { agent } = appAgent(p, "grok", { kind: "grok-bot" });
      p.messages.send(agent, { to: sessionBaseName(basename(project)), subject: "Registry", text: "Through the registry" });
      await waitFor(() => sock!.posts.length === 1, 5000);
      expect(sock.posts[0]).toEqual({ auth: null, content: expect.stringContaining("Through the registry") });
    } finally {
      await host.close();
    }
  });

  test("on a computer that hasn't joined, waits with no tools, then joins when computer.json appears and says so", async () => {
    sock = await fakeInboxSocket();
    p = await startPortico();
    const { token, computer } = joinTestComputer(p, "macbook");
    const project = tempFolder("portico-proj-");
    const env = childEnv({ CLAUDE_CODE_MESSAGING_SOCKET: sock.path });
    registerSession(env, { sessionId: "s-waiting", cwd: project, status: "idle" });
    const { host, stderr } = await launch(env);
    let changes = 0;
    host.setNotificationHandler(ToolListChanged, () => {
      changes++;
    });
    try {
      expect(host.getServerCapabilities()?.experimental).toBeUndefined();
      expect((await host.listTools()).tools).toEqual([]);
      await waitFor(() => logged(stderr(), "plugin_idle").length === 1, 5000);

      // The join in this session writes the computer file.
      writeComputerFile(env.PORTICO_COMPUTER_CONFIG!, { url: p.url, computer, token, off: [] });
      const address = `${sessionBaseName(basename(project))}@macbook`;
      await waitFor(() => connected(p!, address), 8000);
      await waitFor(() => changes === 1, 5000);
      expect((await host.listTools()).tools).toHaveLength(6);
      await waitFor(() => sock!.posts.length === 1, 5000);
      expect(sock.posts[0]!.content).toContain(`Joined Portico as \`${sessionBaseName(basename(project))}\`.`);
      expect(logged(stderr(), "computer_joined")).toEqual([expect.objectContaining({ computer: "macbook" })]);
    } finally {
      await host.close();
    }
  });

  test("exits with the problem when the address in computer.json isn't https", async () => {
    const env = childEnv();
    writeComputerFile(env.PORTICO_COMPUTER_CONFIG!, { url: "http://portico.example.com", computer: "macbook", token: "pc_secret", off: [] });
    const proc = Bun.spawn(["bun", MAIN], { cwd: tempFolder("portico-plugin-"), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(1);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("the Portico address in computer.json must start with https://");
    expect(stderr).not.toContain("pc_secret");
    expect(await new Response(proc.stdout).text()).toBe("");
  });

  test("in a folder that is off Portico, stays quiet: no tools, no notice, no path in the log", async () => {
    sock = await fakeInboxSocket();
    const { p, token, project, env, address } = await joinedComputer();
    p.computers.setFolder(p.computers.byName("macbook")!.id, folderId(token, project), basename(project), false);
    env.CLAUDE_CODE_MESSAGING_SOCKET = sock.path;
    registerSession(env, { sessionId: "s-off", cwd: project, status: "busy" });
    const { host, stderr } = await launch(env);
    try {
      await waitFor(() => logged(stderr(), "stream_refused").length === 1, 5000);
      expect(logged(stderr(), "stream_refused")).toEqual([expect.objectContaining({ level: "info", status: 403, code: "folder_off" })]);
      expect((await host.listTools()).tools).toEqual([]);
      // The local copy now has the folder off, so the next start is quiet before Portico answers.
      await waitFor(() => readComputerFile(env.PORTICO_COMPUTER_CONFIG!)?.off.length === 1, 5000);
      expect(readComputerFile(env.PORTICO_COMPUTER_CONFIG!)?.off).toEqual([project]);
      await Bun.sleep(150);
      expect(sock.posts).toEqual([]);
      expect(agentAt(p, address)).toBeNull();
      expect(stderr()).not.toContain(project);
    } finally {
      await host.close();
    }
  });

  test("exits with a JSON error line, naming no path, when computer.json is broken", async () => {
    const env = childEnv();
    mkdirSync(join(env.HOME!, ".portico"), { recursive: true });
    writeFileSync(env.PORTICO_COMPUTER_CONFIG!, "{ not json");
    const proc = Bun.spawn(["bun", MAIN], { cwd: tempFolder("portico-plugin-"), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(1);
    const stderr = await new Response(proc.stderr).text();
    const lines = stderr.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ level: "error", msg: "computer_file_invalid", error: "ComputerFileError" }));
    expect(stderr).not.toContain(env.PORTICO_COMPUTER_CONFIG!);
    expect(await new Response(proc.stdout).text()).toBe("");
  });
});
