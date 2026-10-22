import type { Hono } from "hono";
import { createHub } from "../src/hub";
import { parseConfig } from "../src/config";
import { addressOf, Directory } from "../src/core/directory";
import { BridgeError } from "../src/core/errors";
import type { NetworkService } from "../src/core/network";
import { Presence } from "../src/core/presence";
import { BridgeService } from "../src/core/service";
import { hashSecret } from "../src/core/tokens";
import type { Assistant, AssistantKind, BridgeConfig, Machine, Notice, SessionRecord } from "../src/core/types";
import { OWNER } from "../src/core/types";
import { openDb, Store } from "../src/db";
import { NetworkStore } from "../src/network-store";
import type { HelloEvent, StreamConnection } from "../src/ways-in/stream";

export const T0 = new Date("2026-10-20T12:00:00.000Z");
export const HOUR = 3_600_000;

export function testClock(start: Date = T0) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

// Rules cover every case: allow, ask, an explicit block, and pairs with no rule (blocked).
export const BASE_YAML = `
agents:
  - { name: grok-bot, description: Grok Bot, delivery: pull }
  - { name: claude-code, description: Claude Code, delivery: push }
  - { name: muse, description: Meta Muse, delivery: pull }
  - { name: codex, description: Codex, delivery: pull }
rules:
  - { from: grok-bot, to: claude-code, action: allow }
  - { from: claude-code, to: grok-bot, action: allow }
  - { from: muse, to: claude-code, action: allow }
  - { from: codex, to: grok-bot, action: allow }
  - { from: "*", to: muse, action: ask }
  - { from: codex, to: claude-code, action: block }
triggers:
  - name: bug-to-claude
    when: { agent: muse, event: bug_report_received }
    send: { to: claude-code, instructions: "Investigate: {{event.details}}" }
  - name: bug-to-grok
    when: { agent: muse, event: bug_report_received }
    send: { to: grok-bot, instructions: "Research: {{event.details}}" }
`;

export const TOKENS = {
  "grok-bot": "grok-token-0123456789abcdef",
  "claude-code": "claude-token-0123456789abcdef",
  muse: "muse-token-0123456789abcdef01",
  codex: "codex-token-0123456789abcdef",
} as const;

export type TestAgent = keyof typeof TOKENS;

export function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    BRIDGE_PUBLIC_URL: "https://bridge.test",
    BRIDGE_TOKEN_GROK_BOT: TOKENS["grok-bot"],
    BRIDGE_TOKEN_CLAUDE_CODE: TOKENS["claude-code"],
    BRIDGE_TOKEN_MUSE: TOKENS.muse,
    BRIDGE_TOKEN_CODEX: TOKENS.codex,
    BRIDGE_SIGNING_SECRET: "test-signing-secret-0123456789abcdef",
    BRIDGE_ADMIN_PASSWORD: "test-admin-password",
    ...extra,
  };
}

export function testConfig(yaml: string = BASE_YAML, extraEnv: Record<string, string> = {}): BridgeConfig {
  return parseConfig(yaml, testEnv(extraEnv));
}

/** A service over an in-memory database. Add an address to `connected` to give it an open stream. */
export function makeService(config: BridgeConfig = testConfig()) {
  const db = openDb(":memory:");
  const store = new Store(db);
  const network = new NetworkStore(db);
  const clock = testClock();
  const presence = new Presence();
  const connected = new Set<string>();
  const directory = new Directory({
    config,
    network,
    presence,
    isConnected: (address) => connected.has(address),
    now: clock.now,
  });
  const notices: Notice[] = [];
  let counter = 0;
  const service = new BridgeService({
    store,
    config,
    directory,
    presence,
    now: clock.now,
    newId: () => `id-${++counter}`,
    notify: (notice) => notices.push(notice),
  });
  return { service, store, network, directory, presence, connected, config, clock, notices };
}

/**
 * Stores a session as if its plugin had registered, adding its machine first when it's missing. The session is
 * last seen now by the context's clock (T0 without one).
 */
export function addSession(
  ctx: { network: NetworkStore; clock?: { now: () => Date } },
  input: { name: string; machine: string; key?: string; folder?: string; folderId?: string; lastSeenAt?: string },
): { address: string; machine: Machine; session: SessionRecord } {
  const at = input.lastSeenAt ?? (ctx.clock?.now() ?? T0).toISOString();
  let machine = ctx.network.machineByName(input.machine);
  if (!machine) {
    machine = { id: `m-${input.machine}`, owner: OWNER, name: input.machine, createdAt: at, lastSeenAt: null };
    ctx.network.insertMachine(machine, hashSecret(`t-${input.machine}`));
  }
  const session: SessionRecord = {
    id: `s-${input.name}-${input.machine}`,
    owner: OWNER,
    machineId: machine.id,
    machine: machine.name,
    name: input.name,
    key: input.key ?? `key-${input.name}`,
    folder: input.folder ?? input.name.replace(/-claude.*$/, ""),
    folderId: input.folderId ?? "f".repeat(64),
    createdAt: at,
    lastSeenAt: at,
  };
  ctx.network.insertSession(session);
  return { address: addressOf(session.name, machine.name), machine, session };
}

/** Connects an assistant as the hub page would, returning its one-time token. */
export function mintAssistant(
  ctx: { networkService: NetworkService },
  name: string,
  kind: AssistantKind = "other",
): { token: string; assistant: Assistant } {
  return ctx.networkService.createAssistant({ name, kind });
}

/** Joins a machine as `bridge join` would, returning its one-time token. */
export function joinMachine(ctx: { networkService: NetworkService }, name = "macbook"): { machine: Machine; token: string } {
  const { code } = ctx.networkService.createJoinCode();
  return ctx.networkService.redeemJoinCode(code, name);
}

/** Calls the app with any bearer token, plus a session key when given. */
export async function callAs(
  ctx: { app: Hono },
  auth: { token: string; key?: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${auth.token}` };
  if (auth.key !== undefined) headers["x-bridge-session"] = auth.key;
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  return await ctx.app.request(path, { method, headers, body: payload });
}

/** Opens a session's live stream as the plugin does in machine mode, and reads its hello. `popup` declares pop-ups. */
export async function openSessionStream(
  ctx: { app: Hono },
  token: string,
  opts: { key: string; repo: string; folderId?: string; popup?: boolean },
): Promise<{ res: Response; events: ReturnType<typeof sseReader>; hello: HelloEvent }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-bridge-session": opts.key,
    "x-bridge-folder": opts.folderId ?? "a".repeat(64),
  };
  if (opts.popup) headers["x-bridge-popup"] = "1";
  const res = await ctx.app.request(`/api/stream?repo=${encodeURIComponent(opts.repo)}`, { headers });
  if (res.status !== 200) throw new Error(`stream open failed with ${res.status}: ${await res.text()}`);
  const events = sseReader(res);
  const first = await events.next();
  if (first.event !== "hello") throw new Error(`expected hello, got ${first.event}`);
  return { res, events, hello: first.data as HelloEvent };
}

/** A stream connection that records what it's sent, and throws once closed, as a dead stream does. */
export function fakeConnection() {
  const sent: { event: string; data: Record<string, unknown> }[] = [];
  let closed = false;
  const conn: StreamConnection = {
    send: (event, data) => {
      if (closed) throw new Error("closed");
      sent.push({ event, data });
    },
    close: () => {
      closed = true;
    },
  };
  return { conn, sent, isClosed: () => closed };
}

/** Runs fn and returns the BridgeError code it threw, or null if it didn't throw. */
export function errorCode(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof BridgeError) return err.code;
    throw err;
  }
  return null;
}

/** A hub over an in-memory database with a fake clock. `newNonce` replaces the approval nonces' random source. */
export function makeApp(config: BridgeConfig = testConfig(), opts: { newNonce?: () => string } = {}) {
  const clock = testClock();
  const notices: Notice[] = [];
  let counter = 0;
  const hub = createHub(config, {
    db: openDb(":memory:"),
    now: clock.now,
    newId: () => `id-${++counter}`,
    newNonce: opts.newNonce,
    heartbeatMs: 50,
    onNotice: (notice) => notices.push(notice),
  });
  const { app } = hub;
  async function call(agent: TestAgent | null, method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (agent) headers.authorization = `Bearer ${TOKENS[agent]}`;
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
    return await app.request(path, { method, headers, body: payload });
  }
  return { ...hub, config, clock, notices, call };
}

/** Lets queued microtasks and zero-delay timers run, e.g. the notifier's work after a transaction. */
export function flush(): Promise<void> {
  return Bun.sleep(1);
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/** Reads server-sent events from a streaming response, skipping heartbeat comments. */
export function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Kept across calls: a read that loses a timeout race still owns the next chunk.
  let pending: ReturnType<typeof reader.read> | null = null;
  return {
    async next(timeoutMs = 2000): Promise<SseEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = block.split("\n").filter((line) => line !== "" && !line.startsWith(":"));
          if (lines.length === 0) continue; // a heartbeat comment
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          return { event, data: data ? JSON.parse(data) : null };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timed out waiting for a stream event");
        pending ??= reader.read();
        const chunk = await Promise.race([pending, Bun.sleep(remaining).then(() => null)]);
        if (chunk === null) throw new Error("timed out waiting for a stream event");
        pending = null;
        if (chunk.done) throw new Error("stream ended");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => {});
    },
  };
}

/** Pronouns that hub pages and CLI output never use. Errs strict: it also flags "i.e.". */
export const PRONOUNS = /\b(i|me|my|we|us|our|you|your|it|its|they|them|their)\b/i;

/**
 * The copy a reader sees on a page, for the pronoun and app-name sweep. Paste-ready text is exempt, so <pre>, <code>
 * and <textarea> are dropped with their content, as are <style>, tags and entities. Attribute text a reader also
 * sees or hears (placeholder, aria-label, title, alt) is added back.
 */
export function visibleCopy(page: string): string {
  const attributes = [...page.matchAll(/\s(?:placeholder|aria-label|title|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
  const text = page
    .replace(/<(style|pre|code|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return [text, ...attributes].join(" ").replace(/&[a-z0-9#]+;/gi, " ");
}

export const ADMIN_PASSWORD = "test-admin-password";

/** Signs in to the hub page and returns the Cookie header value to send. */
export async function signIn(app: Hono, password = ADMIN_PASSWORD): Promise<string> {
  const res = await app.request("/hub/login", { method: "POST", body: new URLSearchParams({ password }) });
  const setCookie = res.headers.get("set-cookie");
  if (res.status !== 303 || !setCookie) throw new Error(`sign-in failed with ${res.status}`);
  return setCookie.split(";")[0]!;
}
