#!/usr/bin/env bun
import { homedir } from "node:os";
import { join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type PluginConfig, PluginConfigError, parsePluginConfig } from "./config";
import { HubClient } from "./hub-client";
import { errorName, stderrLog as log } from "./log";
import { createBridgePlugin, createIdleServer } from "./plugin";
import { SessionLocator } from "./registry";
import { InboxSocket, socketTarget } from "./socket";

function setUp(): { server: Server; stop: () => Promise<void> } {
  let config: PluginConfig | null;
  try {
    config = parsePluginConfig(process.env);
  } catch (err) {
    if (err instanceof PluginConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  if (!config) {
    log("info", "plugin_idle", { note: "BRIDGE_URL and BRIDGE_TOKEN are not set; no tools and no channel in this session" });
    return { server: createIdleServer(), stop: async () => {} };
  }
  log("info", "plugin_started", { origin: new URL(config.url).origin, permission_relay: config.permissionRelay });
  // CLAUDE_CODE_MESSAGING_SOCKET names the inbox socket; without it, the session's registry file does.
  const claudeHome = process.env.BRIDGE_CLAUDE_HOME?.trim() || join(homedir(), ".claude");
  const locator = new SessionLocator({ sessionsDir: join(claudeHome, "sessions") });
  return createBridgePlugin({
    config,
    client: new HubClient({ url: config.url, token: config.token }),
    log,
    socket: new InboxSocket(socketTarget(process.env, () => locator.current())),
  });
}

const plugin = setUp();

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await plugin.stop().catch(() => {});
  process.exit(0);
}

process.on("unhandledRejection", (err) => log("error", "unhandled_rejection", { error: errorName(err) }));
process.on("uncaughtException", (err) => log("error", "uncaught_exception", { error: errorName(err) }));
// Claude Code closes stdin when the session ends. Without this, the open stream would keep the process alive.
process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void shutdown());

await plugin.server.connect(new StdioServerTransport());
