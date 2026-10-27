#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  claudeHome,
  type ComputerFile,
  ComputerFileError,
  computerConfigPath,
  folderId,
  isOff,
  readComputerFile,
  setFolderOff,
} from "./computer";
import { type PluginConfig, PluginConfigError, parsePluginConfig } from "./config";
import { errorName, stderrLog as log } from "./log";
import { createPorticoPlugin, createWaitingServer, type PorticoPlugin } from "./plugin";
import { popupPlatform, systemRunner } from "./popup";
import { PorticoClient, type StreamRegistration } from "./portico-client";
import { SessionLocator } from "./registry";
import { InboxSocket, socketTarget } from "./socket";
import { gitInfo, SessionWatcher } from "./status";
import { findTranscript } from "./transcript";

type Running = { server: Server; stop: () => Promise<void> };

/** How often a session on a computer that hasn't joined looks for computer.json. */
const JOIN_POLL_MS = 2_000;

const env = process.env;
const configPath = computerConfigPath(env);
const home = claudeHome(env);
const locator = new SessionLocator({ sessionsDir: join(home, "sessions") });

/** The session's working folder, from Claude Code's registry: the plugin's own is its install folder. */
function sessionFolder(): string {
  return locator.current()?.cwd ?? env.CLAUDE_PROJECT_DIR ?? env.PWD ?? process.cwd();
}

/** The full plugin for a joined computer. With `server`, it takes over a waiting server the session already uses. */
function joinedPlugin(config: PluginConfig, file: ComputerFile, opts: { server?: Server; joining?: boolean } = {}): PorticoPlugin {
  const cwd = sessionFolder();
  const popupOff = (env.PORTICO_POPUP ?? "").trim().toLowerCase() === "off";
  const platform = popupPlatform(process.platform, env, existsSync);
  const runner = !popupOff && platform ? systemRunner(platform, env) : null;
  if (!runner) log("warn", "approval_popup_unavailable", { platform: process.platform, reason: popupOff ? "off" : "no_desktop" });
  const startsOff = isOff(file, cwd);
  log("info", "plugin_started", { origin: new URL(config.url).origin, computer: config.computer, popup: runner !== null, folder_off: startsOff });

  // Stable for this process: a reconnect is the same session, a restart a new one.
  const sessionKey = crypto.randomUUID();
  const client = new PorticoClient({ url: config.url, token: config.token, sessionKey });
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
    client,
    log,
    watcher,
    popup: runner,
    server: opts.server,
    joining: opts.joining,
    folder: {
      off: startsOff,
      // The local copy follows what Portico said. A failed write only means the next start asks Portico again.
      record: (off) => {
        try {
          setFolderOff(configPath, cwd, off);
        } catch (err) {
          log("warn", "folder_copy_failed", { error: errorName(err) });
        }
      },
    },
    // CLAUDE_CODE_MESSAGING_SOCKET names the inbox socket; without it, the session's registry file does.
    socket: new InboxSocket(socketTarget(env, () => locator.current())),
    registration: () =>
      (registration ??= gitInfo(cwd).then(({ repo }) => ({ repo: repo ?? basename(cwd), folderId: folderId(token, cwd) }))),
  });
}

/**
 * The settings in computer.json, or null when there is no usable file. With `fatal`, a broken file ends the process
 * with the problem; otherwise it counts as no file yet.
 */
function readConfig(fatal: boolean): { config: PluginConfig; file: ComputerFile } | null {
  let file: ComputerFile | null;
  try {
    file = readComputerFile(configPath);
  } catch (err) {
    if (!(err instanceof ComputerFileError)) throw err;
    if (!fatal) return null;
    // The error's message names the file's path, so only its name is logged.
    log("error", "computer_file_invalid", { error: "ComputerFileError" });
    process.exit(1);
  }
  try {
    const config = parsePluginConfig(file);
    return config && file ? { config, file } : null;
  } catch (err) {
    if (!(err instanceof PluginConfigError)) throw err;
    if (!fatal) return null;
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}

/**
 * A computer that hasn't joined: no tools. computer.json is looked for every 2 s, so a session open during the join
 * (say, the one that ran it) joins as soon as the file is written, and says so in the session.
 */
function waiting(): Running {
  log("info", "plugin_idle", { note: "this computer hasn't joined Portico; no tools until it joins" });
  const server = createWaitingServer();
  let initialized = false;
  server.oninitialized = () => {
    initialized = true;
  };
  let plugin: PorticoPlugin | null = null;
  let broken = false;
  const timer = setInterval(() => {
    if (!existsSync(configPath)) return;
    // A broken or half-written file is logged once and looked at again on the next round.
    const found = readConfig(false);
    if (!found) {
      if (!broken) log("warn", "computer_file_not_ready", {});
      broken = true;
      return;
    }
    clearInterval(timer);
    log("info", "computer_joined", { computer: found.config.computer });
    plugin = joinedPlugin(found.config, found.file, { server, joining: true });
    if (initialized) plugin.start();
  }, JOIN_POLL_MS);
  timer.unref();
  return {
    server,
    stop: async () => {
      clearInterval(timer);
      await plugin?.stop();
    },
  };
}

function setUp(): Running {
  const found = readConfig(true);
  return found ? joinedPlugin(found.config, found.file) : waiting();
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
