#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type PluginConfig, PluginConfigError, parsePluginConfig } from "./config";
import { HubClient, type StreamRegistration } from "./hub-client";
import { errorName, stderrLog as log } from "./log";
import { claudeHome, isOff, type MachineFile, MachineFileError, machineConfigPath, readMachineFile } from "./machine";
import { createIdleServer, createPorticoPlugin } from "./plugin";
import { popupPlatform, systemRunner } from "./popup";
import { SessionLocator } from "./registry";
import { InboxSocket, socketTarget } from "./socket";
import { folderId, gitInfo, SessionWatcher } from "./status";
import { findTranscript } from "./transcript";

type Running = { server: Server; stop: () => Promise<void> };

/** No tools. The note is fixed text: never a folder or a path. */
function idle(note: string): Running {
  log("info", "plugin_idle", { note });
  return { server: createIdleServer(), stop: async () => {} };
}

function setUp(): Running {
  const env = process.env;
  let machineFile: MachineFile | null = null;
  let machineFileBroken = false;
  try {
    machineFile = readMachineFile(machineConfigPath(env));
  } catch (err) {
    if (!(err instanceof MachineFileError)) throw err;
    machineFileBroken = true; // only fatal when nothing else configures the plugin
  }
  let config: PluginConfig | null;
  try {
    config = parsePluginConfig(env, machineFile);
  } catch (err) {
    if (err instanceof PluginConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  if (!config && machineFileBroken) {
    // The error's message names the file's path, so only its name is logged.
    log("error", "machine_file_invalid", { error: "MachineFileError" });
    process.exit(1);
  }
  if (!config) return idle("PORTICO_URL and PORTICO_TOKEN are not set and this machine hasn't joined; no tools in this session");

  const home = claudeHome(env);
  const locator = new SessionLocator({ sessionsDir: join(home, "sessions") });
  // The session's working folder, from Claude Code's registry: the plugin's own is its install folder.
  const cwd = locator.current()?.cwd ?? env.CLAUDE_PROJECT_DIR ?? env.PWD ?? process.cwd();
  // The env-var override ignores the off list (spec §9).
  if (config.source === "machine" && machineFile && isOff(machineFile, cwd)) return idle("this folder is off the network");

  const popupOff = (env.PORTICO_POPUP ?? "").trim().toLowerCase() === "off";
  const platform = popupPlatform(process.platform, env, existsSync);
  // Only a session on a joined machine can answer an approval, so env mode never shows pop-ups.
  const runner = config.source === "machine" && !popupOff && platform ? systemRunner(platform, env) : null;
  if (config.source === "machine" && !runner) {
    log("warn", "approval_popup_unavailable", { platform: process.platform, reason: popupOff ? "off" : "no_desktop" });
  }
  log("info", "plugin_started", {
    origin: new URL(config.url).origin,
    mode: config.source,
    machine: config.machine,
    popup: runner !== null,
  });

  // Stable for this process: a reconnect is the same session, a restart a new one.
  const sessionKey = crypto.randomUUID();
  const client = new HubClient({ url: config.url, token: config.token, sessionKey });
  const watcher = new SessionWatcher({
    locate: () => locator.current(),
    cwd,
    transcriptOf: (id) => findTranscript(join(home, "projects"), id),
    git: (dir) => gitInfo(dir),
    report: (r) => client.reportStatus(r),
    log,
  });
  const token = config.token;
  let registration: Promise<StreamRegistration> | null = null;
  return createPorticoPlugin({
    config,
    client,
    log,
    watcher,
    popup: runner,
    // CLAUDE_CODE_MESSAGING_SOCKET names the inbox socket; without it, the session's registry file does.
    socket: new InboxSocket(socketTarget(env, () => locator.current())),
    registration: () =>
      (registration ??= gitInfo(cwd).then(({ repo }) => ({ repo: repo ?? basename(cwd), folderId: folderId(token, cwd) }))),
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
