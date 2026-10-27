import { hashPassword } from "../src/core/accounts";
import type { Registration } from "../src/core/agents";
import { PorticoError } from "../src/core/errors";
import type { Agent, AgentKind, Computer, Notice, Person, PorticoConfig } from "../src/core/types";
import { openDb } from "../src/db";
import { createPortico, type Portico } from "../src/portico";
import type { HelloEvent, StreamConnection } from "../src/agent-api/stream";

export const T0 = new Date("2026-10-27T12:00:00.000Z");
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const PUBLIC_URL = "https://portico.example.com";
export const PASSWORD = "correct-horse-battery";

export function testClock(start: Date = T0) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export function testConfig(overrides: Partial<PorticoConfig> = {}): PorticoConfig {
  return {
    port: 8790,
    dbPath: ":memory:",
    dataDir: ".",
    pluginSource: null,
    publicUrl: PUBLIC_URL,
    signingKey: "a".repeat(64),
    ...overrides,
  };
}

/** A hashed test password, made once: argon2id is slow on purpose. */
let passwordHash: Promise<string> | null = null;
function testPasswordHash(): Promise<string> {
  passwordHash ??= hashPassword(PASSWORD);
  return passwordHash;
}

export interface TestPortico extends Portico {
  clock: ReturnType<typeof testClock>;
  notices: Notice[];
}

/**
 * Portico over an in-memory database, with a fake clock and counting IDs. With `setup` (the default), setup is marked
 * done, so Portico is open; the owner still has to be added with addOwner.
 */
export function makePortico(opts: { config?: Partial<PorticoConfig>; setup?: boolean; newNonce?: () => string } = {}): TestPortico {
  const clock = testClock();
  const notices: Notice[] = [];
  let counter = 0;
  const portico = createPortico(testConfig(opts.config), {
    db: openDb(":memory:"),
    now: clock.now,
    newId: () => `id-${String(++counter).padStart(4, "0")}`,
    newNonce: opts.newNonce,
    heartbeatMs: 50,
    onNotice: (notice) => notices.push(notice),
  });
  if (opts.setup !== false) portico.settings.set("setup_done_at", T0.toISOString());
  return Object.assign(portico, { clock, notices });
}

export async function addOwner(p: Portico, name = "Chris"): Promise<Person> {
  return p.people.create({ name, role: "owner", status: "active", passwordHash: await testPasswordHash() });
}

export async function addMember(p: Portico, name = "Maya", status: "active" | "pending" = "active"): Promise<Person> {
  return p.people.create({ name, role: "member", status, passwordHash: await testPasswordHash() });
}

/** A browser sign-in for the person: the Cookie header value to send. */
export function signIn(p: Portico, person: Person): string {
  const { token } = p.accounts.startSession(person.id);
  return `portico_session=${token}`;
}

/** An app agent with its API token. */
export function addAppAgent(
  p: Portico,
  owner: Person,
  name: string,
  opts: { kind?: AgentKind; approvalRequired?: boolean } = {},
): { agent: Agent; token: string } {
  let agent = p.agents.create({ ownerId: owner.id, name, kind: opts.kind ?? "muse", type: "app" });
  if (opts.approvalRequired) agent = p.agents.update(owner.id, agent.id, { approvalRequired: true });
  return { agent, token: p.agents.issueToken(agent.id, "api") };
}

export function addComputer(p: Portico, owner: Person, name = "macbook"): { computer: Computer; token: string } {
  return p.computers.create(owner.id, name);
}

let keys = 0;

/** Registers a session on the computer as its plugin's stream would, without opening a stream. */
export function addSession(
  p: Portico,
  computer: Computer,
  opts: Partial<Registration> & { approvalRequired?: boolean } = {},
): { agent: Agent; key: string } {
  const key = opts.key ?? `session-key-${++keys}`;
  let { agent } = p.agents.registerSession(computer, {
    key,
    repo: opts.repo ?? "api",
    folderId: opts.folderId ?? `${keys}`.padStart(64, "0"),
  });
  if (opts.approvalRequired) agent = p.agents.update(computer.ownerId, agent.id, { approvalRequired: true });
  return { agent, key };
}

/** Calls the app with a bearer token, plus a session key when given. */
export async function callAs(
  p: { app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> } },
  auth: { token: string; key?: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${auth.token}` };
  if (auth.key !== undefined) headers["x-portico-session"] = auth.key;
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }
  return await p.app.request(path, { method, headers, body: payload });
}

/** Calls the person API as a signed-in browser would: the cookie, JSON, and the page's own Origin on changes. */
export async function callPerson(
  p: { app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> } },
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { host: "portico.example.com" };
  if (cookie) headers.cookie = cookie;
  if (method !== "GET") headers.origin = PUBLIC_URL;
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return await p.app.request(`${PUBLIC_URL}${path}`, { method, headers, body: payload });
}

/** Opens a session's live stream as the plugin does, and reads its hello. `popup` declares pop-ups. */
export async function openSessionStream(
  p: { app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> } },
  token: string,
  opts: { key: string; repo?: string; folderId?: string; popup?: boolean },
): Promise<{ res: Response; events: ReturnType<typeof sseReader>; hello: HelloEvent }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-portico-session": opts.key,
    "x-portico-folder": opts.folderId ?? "a".repeat(64),
  };
  if (opts.popup) headers["x-portico-popup"] = "1";
  const res = await p.app.request(`/api/agent/stream?repo=${encodeURIComponent(opts.repo ?? "api")}`, { headers });
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

/** Runs fn and returns the PorticoError code it threw, or null if it didn't throw. */
export function errorCode(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof PorticoError) return err.code;
    throw err;
  }
  return null;
}

/** Lets queued microtasks and zero-delay timers run, e.g. notices and change batches. */
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

// ---- copy sweeps ----

/** Pronouns Portico's copy never uses. Errs strict: it also flags "i.e.". */
export const PRONOUNS = /\b(i|me|my|we|us|our|you|your|it|its|they|them|their)\b/i;

/** The one phrase the owner chose to keep: the empty-state heading. */
const ALLOWED_PHRASES = [/\badd your first agent\b/gi];

/** The retired word. */
export const HUB = /\bhubs?\b/i;

/**
 * The copy a reader sees on a page. Paste-ready text is exempt, so <pre>, <code> and <textarea> are dropped with their
 * content, as are <style>, <script> (including first data), tags and entities. Attribute text a reader also sees or
 * hears (placeholder, aria-label, title, alt) is added back. The allowed phrase is removed.
 */
export function visibleCopy(page: string): string {
  const attributes = [...page.matchAll(/\s(?:placeholder|aria-label|title|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
  let text = [page.replace(/<(style|script|pre|code|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "), ...attributes]
    .join(" ")
    .replace(/&[a-z0-9#]+;/gi, " ");
  for (const phrase of ALLOWED_PHRASES) text = text.replace(phrase, " ");
  return text;
}

/** The words that break the copy rules in a piece of copy: pronouns and "hub". Empty when the copy is clean. */
export function copyProblems(copy: string): string[] {
  const problems: string[] = [];
  for (const re of [new RegExp(PRONOUNS.source, "gi"), new RegExp(HUB.source, "gi")]) {
    for (const match of copy.matchAll(re)) {
      const start = Math.max(0, match.index! - 30);
      problems.push(`"${match[0]}" in …${copy.slice(start, match.index! + match[0].length + 30).replace(/\s+/g, " ")}…`);
    }
  }
  return problems;
}
