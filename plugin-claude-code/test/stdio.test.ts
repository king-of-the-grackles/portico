import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ChannelNotification, startHub, type TestHub, TOKENS, waitFor } from "./helpers";

const MAIN = join(import.meta.dir, "../src/main.ts");
const baseEnv = () => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });

let hub: TestHub | null = null;
let dir: string | null = null;
afterEach(() => {
  hub?.stop();
  hub = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** An empty working folder, so Bun can't load a developer's .env into the plugin. */
function emptyDir(): string {
  dir = mkdtempSync(join(tmpdir(), "bridge-plugin-"));
  return dir;
}

async function launch(env: Record<string, string>) {
  const transport = new StdioClientTransport({ command: "bun", args: [MAIN], env: { ...baseEnv(), ...env }, cwd: emptyDir(), stderr: "pipe" });
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
  test("serves the tools and pushes tasks as channel messages, with nothing but MCP on stdout", async () => {
    hub = startHub();
    const { host, channel, errors } = await launch({ BRIDGE_URL: hub.url, BRIDGE_TOKEN: TOKENS["claude-code"] });
    try {
      expect((await host.listTools()).tools).toHaveLength(6);
      await waitFor(() => hub!.streams.isConnected("claude-code"), 5000);
      hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "Over stdio" });
      await waitFor(() => channel.length === 1, 5000);
      expect(channel[0]).toEndWith("Over stdio");
      expect(errors).toEqual([]);
    } finally {
      await host.close();
    }
  });

  test("idles with no tools and no channel when BRIDGE_URL and BRIDGE_TOKEN are unset", async () => {
    const { host } = await launch({});
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
      cwd: emptyDir(),
      env: { ...baseEnv(), BRIDGE_URL: "http://bridge.example.com" },
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
