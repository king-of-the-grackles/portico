import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, setPasswordCostForTests } from "../src/core/accounts";
import { type FileStore, FolderStore } from "../src/core/file-store";
import type { Registration } from "../src/core/agents";
import type { AccountCheck } from "../src/core/descope";
import type { Workspace } from "../src/core/types";
import { PorticoError } from "../src/core/errors";
import type { Agent, AgentKind, Computer, Notice, Person, PorticoConfig } from "../src/core/types";
import { openDb } from "../src/db";
import { createPortico, type Portico } from "../src/portico";
import type { WebhookRequest, WebhookResult } from "../src/core/webhooks";
import type { HelloEvent, StreamConnection } from "../src/agent-api/stream";

// The tests stand behind a proxy of their own: each names its client's address in X-Forwarded-For, which Portico reads
// only where the deploy says a proxy writes that header.
process.env.PORTICO_TRUST_FORWARDED_FOR = "1";

export const T0 = new Date("2026-10-27T12:00:00.000Z");
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const PUBLIC_URL = "https://portico.example.com";
export const PASSWORD = "correct-horse-battery";

/** The secrets key every test Portico gets: 32 bytes, base64, and nothing anyone runs a server with. */
export const TEST_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

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
    secretsKey: TEST_SECRETS_KEY,
    secretsKeyOld: null,
    webhooksAllowPrivate: false,
    retiredHosts: [],
    feedbackReviewToken: null,
    joinStartsPerClient: 10,
    commit: "unknown",
    mail: null,
    files: null,
    descopeProjectId: null,
    analytics: null,
    ...overrides,
  };
}

/**
 * Stands in for Descope: sign-in tokens are `account:<id>:<email>:<name>`. Passed as `accountCheck`, it makes a Portico
 * where signing in creates the person, who then picks a handle on the welcome page.
 */
export const fakeAccounts: AccountCheck = {
  accountFor: async (token) => (await fakeAccounts.account!(token)).id,
  account: async (token) => {
    const [kind, id, email, name] = String(token).split(":");
    if (kind !== "account" || !id) throw new PorticoError("unauthorized", "The sign-in didn't check out. Sign in again.");
    return { id, email: email || null, name: name || null };
  },
};

// Password hashes made in tests are cheap ones: the suites check wrong passwords by the dozen to test the sign-in
// limits, and at full cost (64 MiB a check) those tests ran for seconds and timed out when the machine was busy.
setPasswordCostForTests({ memoryCost: 8, timeCost: 1 });

/** A hashed test password, made once. */
let passwordHash: Promise<string> | null = null;
function testPasswordHash(): Promise<string> {
  passwordHash ??= hashPassword(PASSWORD);
  return passwordHash;
}

let stores = 0;

/**
 * A bucket in memory: addresses under https://bucket.example, and `put` standing in for the PUT an agent makes to an
 * upload address.
 */
export function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  let version = 0;
  const etags = new Map<string, string>();
  const store: FileStore = {
    uploadUrl: (key, seconds) => `https://bucket.example/${key}?upload=${seconds}`,
    downloadUrl: (key, name, seconds) => `https://bucket.example/${key}?download=${encodeURIComponent(name)}&for=${seconds}`,
    write: async (key, bytes) => put(key, bytes),
    stat: async (key) => {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, etag: etags.get(key)! } : null;
    },
    copy: async (fromKey, toKey) => {
      const bytes = objects.get(fromKey);
      if (!bytes) throw new Error(`nothing stored at ${fromKey}`);
      put(toKey, bytes);
    },
    remove: async (key) => {
      objects.delete(key);
    },
  };
  function put(key: string, bytes: Uint8Array | string): void {
    objects.set(key, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
    etags.set(key, `etag-${++version}`);
  }
  return { store, objects, put };
}

export interface TestPortico extends Portico {
  clock: ReturnType<typeof testClock>;
  notices: Notice[];
}

/**
 * Portico over an in-memory directory, with each workspace's content database in memory too, a fake clock and counting
 * IDs. With `dataDir`, everything is on disk in that folder instead, as a real server keeps it: `portico.db`, and
 * `porticos/<workspace ID>/` with `content.db` and the workspace's files. With `setup` (the default), setup is marked
 * done, so Portico is open; the owner still has to be added with addOwner.
 */
export function makePortico(
  opts: {
    config?: Partial<PorticoConfig>;
    setup?: boolean;
    webhooks?: FakeWebhooks;
    fileStore?: FileStore;
    /** Where share emails go: a fake's `post`. */
    mailPost?: FakeWebhooks["post"];
    /** Sign-in with an outside account, as Descope does it: who a sign-in token belongs to. */
    accountCheck?: AccountCheck;
    /** Where analytics events go: a fake's `post`. */
    analyticsPost?: FakeWebhooks["post"];
    /** A real data folder: the directory, every content database and the files are written there. */
    dataDir?: string;
  } = {},
): TestPortico {
  const clock = testClock();
  const notices: Notice[] = [];
  let counter = 0;
  const onDisk = opts.dataDir ? { dataDir: opts.dataDir, dbPath: join(opts.dataDir, "portico.db") } : {};
  const config = testConfig({ ...onDisk, ...opts.config });
  const portico = createPortico(config, {
    db: openDb(config.dbPath),
    now: clock.now,
    newId: () => `id-${String(++counter).padStart(4, "0")}`,
    heartbeatMs: 50,
    onNotice: (notice) => notices.push(notice),
    // A folder of its own per Portico, made only when a test writes a file; the data folder itself when there is one.
    fileStore: opts.fileStore ?? new FolderStore(opts.dataDir ?? join(tmpdir(), `portico-test-files-${process.pid}-${++stores}`)),
    webhookPost: opts.webhooks?.post,
    // Never the network: a test without a fake gets an email that didn't go out.
    mailPost: opts.mailPost ?? (async () => ({ status: null, error: "no_mail_in_tests" })),
    schedule: opts.webhooks?.schedule,
    accountCheck: opts.accountCheck,
    // Never the network.
    analyticsPost: opts.analyticsPost ?? (async () => ({ status: null, error: "no_analytics_in_tests" })),
  });
  if (opts.setup !== false) portico.settings.set("setup_done_at", T0.toISOString());
  return Object.assign(portico, { clock, notices });
}

/**
 * People made here get a handle from the name (`chris`, `maya`), as every person on a server with its own sign-in
 * does. With `accountCheck`, a person starts without one, as before the welcome page.
 */
export async function addOwner(p: Portico, name = "Chris"): Promise<Person> {
  return p.people.create({ name, role: "owner", status: "active", passwordHash: await testPasswordHash() });
}

export async function addMember(p: Portico, name = "Maya", status: "active" | "pending" = "active"): Promise<Person> {
  return p.people.create({ name, role: "member", status, passwordHash: await testPasswordHash() });
}

/**
 * Puts agents of different people where they reach each other: a shared workspace owned by the first agent's owner,
 * with every other owner admitted and every agent added by its own owner. Agents of one person already reach each
 * other through that person's personal workspace.
 */
export function together(p: Portico, ...agents: Agent[]): Workspace {
  const [first, ...rest] = agents;
  if (!first) throw new Error("together needs at least one agent");
  // Two Porticos one person is in can't read the same, so a second one gets a number.
  const taken = new Set(p.workspaces.forPerson(first.ownerId).map((w) => w.name));
  let name = "Together";
  for (let n = 2; taken.has(name); n++) name = `Together ${n}`;
  const workspace = p.workspaces.create(first.ownerId, name);
  for (const agent of rest) if (!p.workspaces.hasPerson(workspace.id, agent.ownerId)) p.workspaces.admit(workspace.id, agent.ownerId);
  for (const agent of agents) p.workspaces.addAgent(agent.ownerId, workspace.id, agent.id);
  acquaint(p, ...agents.map((agent) => agent.ownerId));
  // What Portico told each agent about the others coming in is not what these tests are about.
  for (const agent of agents) p.agentNotices.take(agent.id);
  return workspace;
}

/**
 * The people have each said "always for this person" about the others, so their agents' messages aren't held as a
 * first contact. Tests of the first-contact rule itself leave this out.
 */
export function acquaint(p: Portico, ...personIds: string[]): void {
  for (const a of personIds) for (const b of personIds) if (a !== b) p.contacts.add(a, b, T0.toISOString());
}

/** A browser sign-in for the person: the Cookie header value to send. */
/**
 * The plan's worked example. Chris has grok-bot, claude-code and muse. Three Porticos: his own (all three), an unnamed
 * one with Robert, so "Chris and Robert" (grok-bot, robert/dots), and "Launch" with Robert, Bill and Dana (grok-bot,
 * robert/dots, bill/scout, dana/muse).
 */
export async function workedExample(p: Portico) {
  const person = async (name: string, owner = false) =>
    p.people.setHandle((owner ? await addOwner(p, name) : await addMember(p, name)).id, name.toLowerCase());
  const chris = await person("Chris", true);
  const robert = await person("Robert");
  const bill = await person("Bill");
  const dana = await person("Dana");
  const grok = addAppAgent(p, chris, "grok-bot", { kind: "grok-bot" });
  const claude = addAppAgent(p, chris, "claude-code", { kind: "other" });
  const muse = addAppAgent(p, chris, "muse");
  const dots = addAppAgent(p, robert, "dots", { kind: "dots" });
  const scout = addAppAgent(p, bill, "scout", { kind: "other" });
  const dmuse = addAppAgent(p, dana, "muse");
  const own = p.workspaces.personal(chris.id);
  const pair = p.workspaces.create(chris.id);
  p.workspaces.admit(pair.id, robert.id);
  p.workspaces.addAgent(chris.id, pair.id, grok.agent.id);
  p.workspaces.addAgent(robert.id, pair.id, dots.agent.id);
  const launch = p.workspaces.create(chris.id, "Launch");
  for (const other of [robert, bill, dana]) p.workspaces.admit(launch.id, other.id);
  p.workspaces.addAgent(chris.id, launch.id, grok.agent.id);
  p.workspaces.addAgent(robert.id, launch.id, dots.agent.id);
  p.workspaces.addAgent(bill.id, launch.id, scout.agent.id);
  p.workspaces.addAgent(dana.id, launch.id, dmuse.agent.id);
  acquaint(p, chris.id, robert.id, bill.id, dana.id);
  for (const { agent } of [grok, claude, muse, dots, scout, dmuse]) p.agentNotices.take(agent.id);
  return { chris, robert, bill, dana, grok, claude, muse, dots, scout, dmuse, own, pair: p.workspaces.get(pair.id)!, launch };
}

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
    client: opts.client ?? "claude-code",
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

export interface AskedToJoin {
  id: string;
  link: string;
  poll_secret: string;
  expires_at: string;
  show: string;
}

type App = { app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> } };

/** A computer or an app agent asks to join, as anyone can: POST /api/join with no credential. */
export async function askToJoin(p: App, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<AskedToJoin> {
  const res = await p.app.request("/api/join", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (res.status !== 201) throw new Error(`asking to join failed with ${res.status}: ${await res.text()}`);
  return (await res.json()) as AskedToJoin;
}

/** The asker's poll, with its poll secret. */
export async function pollJoin(p: App, asked: Pick<AskedToJoin, "id" | "poll_secret">): Promise<Record<string, any>> {
  const res = await p.app.request(`/api/join/${asked.id}`, { headers: { authorization: `Bearer ${asked.poll_secret}` } });
  return (await res.json()) as Record<string, any>;
}

/** The asker hands in the code its person read on the consent page, with its poll secret. */
export async function submitJoinCode(p: App, asked: Pick<AskedToJoin, "id" | "poll_secret">, code: string): Promise<Response> {
  return await p.app.request(`/api/join/${asked.id}/code`, {
    method: "POST",
    headers: { authorization: `Bearer ${asked.poll_secret}`, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

/** The code the consent page shows the signed-in person after Allow, read off the page as that person would, or null. */
export async function joinCodeOn(p: App, cookie: string | null, id: string): Promise<string | null> {
  const res = await p.app.request(`/c/${id}`, { headers: cookie ? { cookie } : {} });
  return /<p class="join-code"[^>]*>([0-9]{4})<\/p>/.exec(await res.text())?.[1] ?? null;
}

/**
 * A whole join, as its person and its asker do it: Allow on the page (with whatever else the form sends), the code
 * read off the page, and the asker handing the code in. Returns the asker's answer: the token, once.
 */
export async function finishJoin(p: App, cookie: string, asked: Pick<AskedToJoin, "id" | "poll_secret">, form: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const allowed = await answerConsent(p, cookie, asked.id, { decision: "approve", ...form });
  if (allowed.status !== 200) throw new Error(`Allow failed with ${allowed.status}: ${await allowed.text()}`);
  const code = await joinCodeOn(p, cookie, asked.id);
  if (!code) throw new Error("The page showed no code after Allow.");
  const res = await submitJoinCode(p, asked, code);
  if (res.status !== 200) throw new Error(`Handing in the code failed with ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, any>;
}

/** The person's answer on the consent page: the form's POST. */
export function answerConsent(p: App, cookie: string | null, id: string, body: Record<string, unknown>): Promise<Response> {
  return callPerson(p, cookie, "POST", `/api/consents/${id}`, body);
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

/** Opens a session's live stream as the plugin does, and reads its hello. `wake` declares waking. */
export async function openSessionStream(
  p: { app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> } },
  token: string,
  opts: { key: string; repo?: string; folderId?: string; wake?: boolean; client?: "claude-code" | "codex" },
): Promise<{ res: Response; events: ReturnType<typeof sseReader>; hello: HelloEvent }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-portico-session": opts.key,
    "x-portico-folder": opts.folderId ?? "a".repeat(64),
  };
  if (opts.wake) headers["x-portico-wake"] = "1";
  if (opts.client) headers["x-portico-client"] = opts.client;
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

/**
 * Stands in for the network when Portico posts to wake URLs and event callbacks: records each post and answers with
 * `answer`. Retries wait in `timers` until runTimers.
 */
export function fakeWebhooks(answer: (req: WebhookRequest) => WebhookResult = () => ({ status: 200, body: "" })) {
  const hooks = {
    sent: [] as WebhookRequest[],
    timers: [] as { fn: () => void; ms: number }[],
    /** Replace to change how later posts are answered. */
    answer,
    post: async (req: WebhookRequest): Promise<WebhookResult> => {
      hooks.sent.push(req);
      return hooks.answer(req);
    },
    schedule: (fn: () => void, ms: number) => {
      hooks.timers.push({ fn, ms });
    },
    runTimers() {
      for (const timer of hooks.timers.splice(0)) timer.fn();
    },
  };
  return hooks;
}

export type FakeWebhooks = ReturnType<typeof fakeWebhooks>;

/**
 * How many WebCrypto calls are under way. Encrypting and decrypting a stored secret is WebCrypto's work on another
 * thread, so how long one takes depends on how busy the computer is: flush() waits on this count, not on a guess.
 */
let cryptoPending = 0;
{
  const subtle = crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of ["encrypt", "decrypt", "importKey", "digest", "sign", "verify", "deriveBits", "deriveKey"]) {
    const real = subtle[name]!;
    subtle[name] = function (this: unknown, ...args: unknown[]) {
      cryptoPending++;
      return real.apply(this, args).finally(() => cryptoPending--);
    };
  }
}

/**
 * Lets queued microtasks and zero-delay timers run, e.g. notices and change batches, and waits for a wake or an event
 * to leave. Each of those decrypts its key first, a few WebCrypto steps one after another; flush() is done once two
 * looks in a row, 5 ms apart, find none of them under way. A fixed sleep here failed whenever the computer was busy.
 */
export async function flush(): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (let quiet = 0; quiet < 2; ) {
    await Bun.sleep(cryptoPending > 0 ? 1 : 5);
    quiet = cryptoPending === 0 ? quiet + 1 : 0;
    if (Date.now() > deadline) throw new Error("flush(): WebCrypto work was still under way after 10 seconds.");
  }
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

import { wordProblems } from "./copy-source";
export { wordProblems };

/**
 * Pronouns Portico's copy never uses. Errs strict: it also flags "i.e.". Portico speaks to the reader in short, plain
 * words, so "you", "your", "it" and "its" are fine; Portico never speaks as "I" or "we", and never says "they".
 */
export const PRONOUNS = /\b(i|me|my|mine|myself|we|us|our|ours|ourselves|yourself|yourselves|itself|they|them|their|theirs|themselves)\b/i;

/**
 * The phrases the owner chose to keep: the empty-state heading, and the name of a person's own Portico on that person's
 * pages.
 */
const ALLOWED_PHRASES = [/\badd your first agent\b/gi, /\byour portico\b/gi];

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

/**
 * The words that break the copy rules in a piece of copy: pronouns, "hub", and the word rule for Porticos (never
 * "workspace" or "Personal"; an installation is a Portico server). Empty when the copy is clean.
 */
export function copyProblems(copy: string): string[] {
  const problems: string[] = wordProblems(copy);
  for (const re of [new RegExp(PRONOUNS.source, "gi"), new RegExp(HUB.source, "gi")]) {
    for (const match of copy.matchAll(re)) {
      const start = Math.max(0, match.index! - 30);
      problems.push(`"${match[0]}" in …${copy.slice(start, match.index! + match[0].length + 30).replace(/\s+/g, " ")}…`);
    }
  }
  return problems;
}
