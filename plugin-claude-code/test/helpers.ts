import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { BridgeConfig } from "../../hub/src/core/types";
import { joinMachine, makeApp, TOKENS, type TestAgent, testConfig } from "../../hub/test/helpers";
import { HubClient } from "../src/hub-client";
import type { Logger } from "../src/log";
import type { ApprovalPrompt, DialogRunner, PanelOutcome } from "../src/popup";
import { InboxSocket } from "../src/socket";

export { TOKENS };

/** A real hub (in-memory database, fake clock, 50 ms heartbeats) on a random local port. */
export function startHub(config: BridgeConfig = testConfig(), opts: { newNonce?: () => string } = {}) {
  const hub = makeApp(config, opts);
  const server = Bun.serve({ port: 0, fetch: hub.app.fetch, idleTimeout: 60 });
  return { ...hub, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export type TestHub = ReturnType<typeof startHub>;

export function hubClient(hub: TestHub, agent: TestAgent): HubClient {
  return new HubClient({ url: hub.url, token: TOKENS[agent] });
}

/** Joins a machine to the test hub, as the plugin's join would: its machine token and name. */
export function joinTestMachine(hub: TestHub, name = "macbook"): { token: string; machine: string } {
  const { machine, token } = joinMachine(hub, name);
  return { token, machine: machine.name };
}

export interface LogLine {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

export function captureLog(): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    log: (level, msg, fields = {}) => {
      lines.push({ level, msg, fields });
    },
  };
}

export const ChannelNotification = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
});

export interface ChannelMessage {
  content: string;
  meta: Record<string, string>;
}

/** Stands in for Claude Code: connects to the plugin's MCP server and records what the plugin sends. */
export async function fakeHost(plugin: { server: Server }) {
  const [hostSide, pluginSide] = InMemoryTransport.createLinkedPair();
  const host = new Client({ name: "fake-claude-code", version: "1.0.0" });
  const channel: ChannelMessage[] = [];
  host.setNotificationHandler(ChannelNotification, ({ params }) => {
    channel.push({ content: params.content, meta: params.meta ?? {} });
  });
  await plugin.server.connect(pluginSide);
  await host.connect(hostSide);
  return { host, channel, close: () => host.close() };
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

const tempDirs: string[] = [];
process.on("exit", () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A new empty folder under the system temp folder, removed when the test run exits. Short, so socket paths fit. */
export function tempDir(prefix = "ab-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Writes `<dir>/<pid>.json` the way Claude Code's session registry does. */
export function writeSessionFile(
  dir: string,
  pid: number,
  fields: Partial<{ sessionId: string; cwd: string; status: string; name: string; messagingSocketPath: string }>,
): string {
  const path = join(dir, `${pid}.json`);
  const record = {
    pid,
    sessionId: fields.sessionId ?? `session-${pid}`,
    cwd: fields.cwd ?? "/work",
    status: fields.status ?? "idle",
    kind: "interactive",
    name: fields.name,
    messagingSocketPath: fields.messagingSocketPath,
    updatedAt: Date.now(),
  };
  writeFileSync(path, JSON.stringify(record));
  return path;
}

export interface FakeInboxSocket {
  path: string;
  /** Each accepted post, with the auth token sent before it (null when none was). */
  posts: { auth: string | null; content: string }[];
  /** "error" answers every post with an error line instead of accepting it. */
  mode: "accept" | "error";
  /** An InboxSocket pointed at this fake. */
  socket: InboxSocket;
  close(): Promise<void>;
}

/** Stands in for Claude Code's inbox socket: reads the auth and user lines, records the post, and closes. */
export async function fakeInboxSocket(opts: { token?: string | null; settleMs?: number } = {}): Promise<FakeInboxSocket> {
  const path = join(tempDir(), "s.sock");
  const posts: { auth: string | null; content: string }[] = [];
  const fake = { path, posts, mode: "accept" as "accept" | "error" } as FakeInboxSocket;
  const server = createServer((conn) => {
    let buffer = "";
    let auth: string | null = null;
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        if (line.type === "auth") auth = line.token;
        else if (line.type === "user") {
          if (fake.mode === "error") conn.end(`${JSON.stringify({ type: "error", error: "refused" })}\n`);
          else {
            posts.push({ auth, content: line.message.content });
            conn.end();
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const token = opts.token === undefined ? "inbox-token" : opts.token;
  fake.socket = new InboxSocket({ path: () => path, token: () => token, settleMs: opts.settleMs ?? 20 });
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}

export interface FakePanel {
  prompt: ApprovalPrompt;
  killed: boolean;
  answer(outcome: PanelOutcome): void;
}

/** A dialog runner that shows nothing: each panel waits for the test to answer it, or for a kill. */
export function fakeRunner(): { runner: DialogRunner; panels: FakePanel[] } {
  const panels: FakePanel[] = [];
  const runner: DialogRunner = (prompt) => {
    let settle!: (outcome: PanelOutcome) => void;
    const result = new Promise<PanelOutcome>((resolve) => (settle = resolve));
    const panel: FakePanel = { prompt, killed: false, answer: (outcome) => settle(outcome) };
    panels.push(panel);
    return {
      result,
      kill: () => {
        panel.killed = true;
        settle({ kind: "dismissed" });
      },
    };
  };
  return { runner, panels };
}
