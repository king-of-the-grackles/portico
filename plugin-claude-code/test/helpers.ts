import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { Agent, AgentKind, Person } from "../../server/src/core/types";
import { addAppAgent, addComputer, addOwner, makePortico } from "../../server/test/helpers";
import type { Logger } from "../src/log";
import { createPorticoPlugin, type FolderSwitch, type PorticoPlugin } from "../src/plugin";
import type { ApprovalPrompt, DialogRunner, PanelOutcome } from "../src/popup";
import { PorticoClient, type StreamRegistration } from "../src/portico-client";
import { InboxSocket } from "../src/socket";
import type { SessionWatcher } from "../src/status";

/**
 * A real Portico (in-memory database, fake clock, 50 ms heartbeats) on a random local port, set up, with its owner.
 * With `realTime`, its clock starts at the real time, so held messages expire a day from now: the plugin's panels
 * compare the expiry with the real clock, and a request already expired shows no panel.
 */
export async function startPortico(opts: { newNonce?: () => string; realTime?: boolean } = {}) {
  const p = makePortico({ newNonce: opts.newNonce });
  if (opts.realTime) p.clock.advance(Date.now() - p.clock.now().getTime());
  const owner: Person = await addOwner(p);
  const server = Bun.serve({ port: 0, fetch: p.app.fetch, idleTimeout: 60 });
  return Object.assign(p, { owner, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) });
}

export type TestPortico = Awaited<ReturnType<typeof startPortico>>;

/** A computer of the owner's, as a join makes it: its token and name. */
export function joinTestComputer(p: TestPortico, name = "macbook"): { token: string; computer: string; computerId: string } {
  const { computer, token } = addComputer(p, p.owner, name);
  return { token, computer: computer.name, computerId: computer.id };
}

/** An app agent of the owner's, with its API token. */
export function appAgent(
  p: TestPortico,
  name: string,
  opts: { kind?: AgentKind; approvalRequired?: boolean } = {},
): { agent: Agent; token: string } {
  return addAppAgent(p, p.owner, name, opts);
}

/** The agent at the address, or null. */
export function agentAt(p: TestPortico, address: string): Agent | null {
  return p.agents.byAddress(address);
}

/** Whether the agent at the address has its live stream open. */
export function connected(p: TestPortico, address: string): boolean {
  const agent = agentAt(p, address);
  return agent !== null && p.agentStreams.isConnected(agent.id);
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

export const ToolListChanged = z.object({ method: z.literal("notifications/tools/list_changed") });

export interface ChannelMessage {
  content: string;
  meta: Record<string, string>;
}

/** Stands in for Claude Code: connects to the plugin's MCP server and records what the plugin sends. */
export async function fakeHost(plugin: { server: Server }) {
  const [hostSide, pluginSide] = InMemoryTransport.createLinkedPair();
  const host = new Client({ name: "fake-claude-code", version: "1.0.0" });
  const channel: ChannelMessage[] = [];
  let toolListChanges = 0;
  host.setNotificationHandler(ChannelNotification, ({ params }) => {
    channel.push({ content: params.content, meta: params.meta ?? {} });
  });
  host.setNotificationHandler(ToolListChanged, () => {
    toolListChanges++;
  });
  await plugin.server.connect(pluginSide);
  await host.connect(hostSide);
  return { host, channel, toolListChanges: () => toolListChanges, close: () => host.close() };
}

export interface SessionOptions {
  token: string;
  key: string;
  repo?: string;
  folderId?: string;
  /** Replaces the registration made from repo and folderId. */
  registration?: () => Promise<StreamRegistration>;
  runner?: DialogRunner | null;
  folder?: FolderSwitch;
  watcher?: Pick<SessionWatcher, "start" | "stop" | "resend"> | null;
  client?: PorticoClient;
  socket?: Pick<InboxSocket, "post">;
  log?: Logger;
  deliveryRetryMs?: number[];
}

/**
 * A plugin for one session on a joined computer, as main.ts builds it, connected to a fake Claude Code host, with a
 * fake inbox socket. `stop` stops the plugin, the host and the socket.
 */
export async function startSession(p: TestPortico, opts: SessionOptions) {
  const sock = await fakeInboxSocket();
  const client = opts.client ?? new PorticoClient({ url: p.url, token: opts.token, sessionKey: opts.key });
  const logs = captureLog();
  const plugin: PorticoPlugin = createPorticoPlugin({
    client,
    log: opts.log ?? logs.log,
    socket: opts.socket ?? sock.socket,
    registration: opts.registration ?? (async () => ({ repo: opts.repo ?? "api", folderId: opts.folderId ?? "a".repeat(64) })),
    popup: opts.runner ?? null,
    folder: opts.folder,
    watcher: opts.watcher ?? null,
    answerRetryMs: [5],
    deliveryRetryMs: opts.deliveryRetryMs ?? [30],
    stream: { initialBackoffMs: 10 },
  });
  const host = await fakeHost(plugin);
  const stop = async () => {
    await plugin.stop();
    await host.close();
    await sock.close();
  };
  return { plugin, client, sock, logs, ...host, stop };
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
export function tempDir(prefix = "po-"): string {
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

/**
 * A stand-in for Portico's computer API, which another track builds, following the shared contract:
 * - `POST /api/computer/join { token, computer }` → 201 `{ computer: { id, name }, token }`, each join token once;
 * - `PUT /api/computer/folders/:folderId { joins, name }` → `{ folder: { folder_id, name, joins } }`;
 * - `DELETE /api/computer` → 204.
 * The last two need a computer token it gave out. `joinTokens` are the join lines' tokens it accepts.
 */
export function contractPortico(joinTokens: string[] = []) {
  const unused = new Set(joinTokens);
  const computers = new Map<string, string>(); // token → name
  const folders = new Map<string, { name: string; joins: boolean }>();
  let made = 0;
  const fake = fakePortico(({ method, path, body }) => {
    const request = fake.requests.at(-1)!;
    const json = (status: number, value: unknown) => Response.json(value, { status });
    if (method === "POST" && path === "/api/computer/join") {
      const { token, computer } = (body ?? {}) as { token?: string; computer?: string };
      if (!token || !unused.delete(token)) {
        return json(404, { error: "not_found", message: "The join line isn't valid any more. Ask for a new one." });
      }
      let name = computer ?? "computer";
      const taken = new Set(computers.values());
      for (let n = 2; taken.has(name); n++) name = `${computer}-${n}`;
      const issued = `pc_token-${++made}-aaaaaaaaaaaaaaaaaaaaaaaa`;
      computers.set(issued, name);
      return json(201, { computer: { id: `c${made}`, name }, token: issued });
    }
    if (!request.token || !computers.has(request.token)) return json(401, { error: "unauthorized", message: "Missing or invalid bearer token." });
    const folder = /^\/api\/computer\/folders\/([a-f0-9]{64})$/.exec(path);
    if (method === "PUT" && folder) {
      const { joins, name } = body as { joins: boolean; name: string };
      folders.set(`${request.token}:${folder[1]}`, { name, joins });
      return json(200, { folder: { folder_id: folder[1], name, joins } });
    }
    if (method === "DELETE" && path === "/api/computer") {
      computers.delete(request.token);
      return new Response(null, { status: 204 });
    }
    return json(404, { error: "not_found", message: "No such endpoint." });
  });
  return { ...fake, computers, folders, addJoinToken: (token: string) => void unused.add(token) };
}

/**
 * A stand-in Portico: answers each request with `answer`, and records the method, path, bearer token and body of every
 * request.
 */
export function fakePortico(answer: (req: { method: string; path: string; body: unknown }) => Response | Promise<Response>) {
  const requests: { method: string; path: string; token: string | null; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const text = await req.text();
      const body = text ? JSON.parse(text) : null;
      const auth = req.headers.get("authorization");
      const entry = { method: req.method, path: new URL(req.url).pathname, token: auth?.replace(/^Bearer /, "") ?? null, body };
      requests.push(entry);
      return answer(entry);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}
