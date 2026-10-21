import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChannelNotification, fakeInboxSocket, type FakeInboxSocket, startHub, type TestHub, TOKENS, waitFor, writeSessionFile } from "./helpers";

const MAIN = join(import.meta.dir, "../src/main.ts");

let hub: TestHub | null = null;
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
 * CLAUDE_CODE_MESSAGING_SOCKET and would post into that session.
 */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = tempFolder("bridge-home-");
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    BRIDGE_CLAUDE_HOME: join(home, ".claude"),
    BRIDGE_MACHINE_CONFIG: join(home, "machine.json"),
    ...extra,
  };
}

async function launch(env: Record<string, string>) {
  // An empty working folder, so Bun can't load a developer's .env into the plugin.
  const transport = new StdioClientTransport({ command: "bun", args: [MAIN], env, cwd: tempFolder("bridge-plugin-"), stderr: "pipe" });
  const host = new Client({ name: "fake-claude-code", version: "1.0.0" });
  const channel: string[] = [];
  const errors: Error[] = [];
  host.setNotificationHandler(ChannelNotification, ({ params }) => {
    channel.push(params.content);
  });
  host.onerror = (err) => errors.push(err);
  await host.connect(transport);
  return { host, channel, errors };
}

describe("the plugin over stdio", () => {
  test("serves the tools and posts tasks into the inbox socket, with nothing but MCP on stdout", async () => {
    hub = startHub();
    sock = await fakeInboxSocket();
    const env = childEnv({
      BRIDGE_URL: hub.url,
      BRIDGE_TOKEN: TOKENS["claude-code"],
      CLAUDE_CODE_MESSAGING_SOCKET: sock.path,
      CLAUDE_CODE_MESSAGING_TOKEN: "stdio-inbox-token",
    });
    const { host, channel, errors } = await launch(env);
    try {
      expect((await host.listTools()).tools).toHaveLength(6);
      await waitFor(() => hub!.streams.isConnected("claude-code"), 5000);
      const task = hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "Over stdio" });
      await waitFor(() => sock!.posts.length === 1, 5000);
      expect(sock.posts[0]).toEqual({ auth: "stdio-inbox-token", content: expect.stringContaining("Over stdio\n</bridge-task>") });
      await waitFor(() => hub!.service.findTask(task.id)?.status === "working", 5000);
      expect(channel).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test("finds the inbox socket through the session registry when the environment doesn't name it", async () => {
    hub = startHub();
    sock = await fakeInboxSocket();
    const env = childEnv({ BRIDGE_URL: hub.url, BRIDGE_TOKEN: TOKENS["claude-code"] });
    // The plugin's parent is this test process, so it plays the Claude Code session.
    const sessions = join(env.BRIDGE_CLAUDE_HOME!, "sessions");
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

  test("idles with no tools and no channel when BRIDGE_URL and BRIDGE_TOKEN are unset", async () => {
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
      cwd: tempFolder("bridge-plugin-"),
      env: childEnv({ BRIDGE_URL: "http://bridge.example.com" }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("BRIDGE_TOKEN is not set");
    expect(stderr).toContain("https://");
    expect(await new Response(proc.stdout).text()).toBe("");
  });
});
