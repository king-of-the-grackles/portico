import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODERN_PROTOCOL_VERSION } from "../src/agent-api/mcp";
import { serveCommand } from "../src/commands/serve";
import type { CliIo } from "../src/commands/io";
import { ConfigError, loadConfig, parseEnv } from "../src/config";
import { EventSubscriptions } from "../src/core/events";
import { FolderStore } from "../src/core/file-store";
import { INVITE_SEAL, People } from "../src/core/people";
import { SHARE_SEAL, Shares } from "../src/core/shares";
import { seal } from "../src/core/tokens";
import { newSecretsKey, Secrets, SECRETS_KEY_MISSING, secretsKeyBytes, secretsKeyId } from "../src/core/secrets";
import { EVENT_SECRET_LOST, WAKE_KEY_LOST } from "../src/core/stored-secrets";
import { WakeUrls } from "../src/core/wake-urls";
import { verifyWebhook, type WebhookRequest } from "../src/core/webhooks";
import { openDb } from "../src/db";
import { captureLogs } from "../src/log";
import { createPortico } from "../src/portico";
import { startServer } from "../src/server";
import {
  addAppAgent,
  addComputer,
  addOwner,
  addSession,
  callAs,
  copyProblems,
  fakeWebhooks,
  flush,
  makePortico,
  PUBLIC_URL,
  signIn,
  T0,
  TEST_SECRETS_KEY,
  testClock,
  testConfig,
  visibleCopy,
} from "./helpers";

const HOOK = "https://api.x.ai/v1/routines/rt_1/trigger";
const CALLBACK = "https://chatgpt.com/mcp-events/callback_123";
const WAKE_KEY = "wk_live_4f9c2d7a1b8e6035";
const EVENT_SECRET = `whsec_${Buffer.from("event-signing-secret-0123456789ab").toString("base64")}`;
const OTHER_SECRET = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
const KEY_2 = Buffer.alloc(32, 21).toString("base64");
const KEY_3 = Buffer.alloc(32, 33).toString("base64url");

type P = ReturnType<typeof makePortico>;

const echoChallenge = (req: WebhookRequest) => {
  const body = JSON.parse(req.body) as { type?: string; challenge?: string };
  return body.type === "verification" ? { status: 200, body: JSON.stringify({ challenge: body.challenge }) } : { status: 200, body: "" };
};

async function mcp(p: P, token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await p.app.request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "mcp-protocol-version": MODERN_PROTOCOL_VERSION },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION } } }),
  });
  return (await res.json()) as { result?: Record<string, any>; error?: { code: number; message: string; data?: unknown } };
}

const subscribe = (p: P, token: string, secret = EVENT_SECRET) =>
  mcp(p, token, "events/subscribe", { name: "message.received", arguments: {}, delivery: { mode: "webhook", url: CALLBACK, secret } });

const dirs: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "portico-secrets-"));
  dirs.push(dir);
  return dir;
};

let starts = 0;

/** A Portico over the data folder, as one start of the server: IDs of its own, so a later start never repeats an earlier one's. */
function start(dir: string, config: { secretsKey?: string; secretsKeyOld?: string | null }) {
  const hooks = fakeWebhooks(echoChallenge);
  const run = ++starts;
  let counter = 0;
  const clock = testClock();
  const full = testConfig({ dataDir: dir, dbPath: join(dir, "portico.db"), ...config });
  const portico = createPortico(full, {
    db: openDb(full.dbPath),
    now: clock.now,
    newId: () => `s${run}-${String(++counter).padStart(4, "0")}`,
    heartbeatMs: 50,
    fileStore: new FolderStore(dir),
    webhookPost: hooks.post,
    mailPost: async () => ({ status: null, error: "no_mail_in_tests" }),
    schedule: hooks.schedule,
  });
  portico.settings.set("setup_done_at", T0.toISOString());
  return { p: Object.assign(portico, { clock, notices: [] }) as P, hooks };
}

/** A Portico on disk with an owner, `grok` (a wake URL) and `dot` (an event subscription), and `muse` to write to them. */
async function world(dir: string, config: { secretsKey?: string; secretsKeyOld?: string | null } = {}) {
  const { p, hooks } = start(dir, config);
  const chris = await addOwner(p);
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  const dot = addAppAgent(p, chris, "dot", { kind: "dots" });
  const muse = addAppAgent(p, chris, "muse");
  await p.secretsReady;
  return { p, hooks, chris, grok, dot, muse };
}

/** The same data folder, opened again as a restart would: with whatever keys this start has. */
async function restart(dir: string, config: { secretsKey?: string; secretsKeyOld?: string | null } = {}) {
  const { p, hooks } = start(dir, config);
  await p.secretsReady;
  const agent = (name: string) => p.agents.require((p.db.query("SELECT id FROM agents WHERE name = $name").get({ name }) as { id: string }).id);
  const token = (name: string) => ({ agent: agent(name), token: p.agents.issueToken(agent(name).id, "api") });
  return { p, hooks, grok: token("grok"), dot: token("dot"), muse: token("muse") };
}

function shut(p: P): void {
  p.close();
  p.db.close();
}

const send = (p: P, from: { agent: { id: string } }, to: string) => p.messages.send(p.agents.require(from.agent.id), { to, subject: "Ping", text: "Hello" });
const stored = (p: P) => ({
  wake: (p.db.query("SELECT key, last_status FROM wake_urls").get() as { key: string; last_status: string | null } | null) ?? null,
  sub: (p.db.query("SELECT id, secret, previous_secret, last_status FROM event_subscriptions").get() as { id: string; secret: string; previous_secret: string | null; last_status: string | null } | null) ?? null,
});

/** Every invite's and share link's stored secret, as the rows hold them. */
const boxes = (p: P) =>
  (p.db.query("SELECT secret_box FROM invites UNION ALL SELECT secret_box FROM shares").all() as { secret_box: string | null }[]).map((row) => row.secret_box ?? "");

/** Every file under the folder, as bytes. */
function filesIn(dir: string): { path: string; bytes: Buffer }[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, bytes: readFileSync(path) };
    });
}

/** The forms a value could be read back from: as it is, and its usual encodings. */
function forms(value: string): Buffer[] {
  const raw = Buffer.from(value);
  return [raw, Buffer.from(raw.toString("base64")), Buffer.from(raw.toString("base64url")), Buffer.from(raw.toString("hex")), Buffer.from(value, "utf16le")];
}

afterEach(() => captureLogs(null));

describe("the secrets key", () => {
  test("a key is 32 bytes of base64 or base64url, and nothing else", () => {
    expect(secretsKeyBytes(TEST_SECRETS_KEY)).toHaveLength(32);
    expect(secretsKeyBytes(KEY_3)).toHaveLength(32);
    expect(secretsKeyBytes(newSecretsKey())).toHaveLength(32);
    for (const bad of ["", "short", Buffer.alloc(16).toString("base64"), Buffer.alloc(48).toString("base64"), "not base64 at all!", "a".repeat(64) + "!"]) {
      expect(secretsKeyBytes(bad)).toBeNull();
    }
    expect(secretsKeyId(secretsKeyBytes(TEST_SECRETS_KEY)!)).toMatch(/^[0-9a-f]{8}$/);
  });

  test("the server refuses to start without the key, and says how to make one", async () => {
    const dir = folder();
    const problem = (env: Record<string, string>) => {
      try {
        loadConfig({ PORTICO_DATA_DIR: dir, ...env });
        return null;
      } catch (err) {
        return err instanceof ConfigError ? err.message : String(err);
      }
    };
    expect(problem({})).toContain("PORTICO_SECRETS_KEY isn't set");
    expect(problem({})).toContain("openssl rand -base64 32");
    expect(copyProblems(SECRETS_KEY_MISSING)).toEqual([]);
    // Refused before anything is made: no signing key, no database.
    expect(readdirSync(dir)).toEqual([]);
    expect(problem({ PORTICO_SECRETS_KEY: TEST_SECRETS_KEY })).toBeNull();

    // A key that is malformed or the wrong length is refused too, and the message never repeats the value.
    for (const bad of ["hunter2-hunter2", Buffer.alloc(31, 1).toString("base64"), Buffer.alloc(64, 1).toString("base64")]) {
      const said = problem({ PORTICO_SECRETS_KEY: bad })!;
      expect(said).toContain("PORTICO_SECRETS_KEY must be 32 random bytes as base64");
      expect(said).toContain("openssl rand -base64 32");
      expect(said).not.toContain(bad);
    }
    expect(problem({ PORTICO_SECRETS_KEY: TEST_SECRETS_KEY, PORTICO_SECRETS_KEY_OLD: "nope" })).toContain("PORTICO_SECRETS_KEY_OLD must be");
    expect(problem({ PORTICO_SECRETS_KEY: TEST_SECRETS_KEY, PORTICO_SECRETS_KEY_OLD: TEST_SECRETS_KEY })).toContain("the same key");

    // `portico serve` answers with the message and a failing exit, and nothing listens.
    const err: string[] = [];
    const io: CliIo = { env: { PORTICO_DATA_DIR: dir }, cwd: "/", out: () => {}, err: (line) => err.push(line) };
    expect(await serveCommand(io)).toBe(1);
    expect(err.join("\n")).toContain("PORTICO_SECRETS_KEY isn't set");
    expect(copyProblems(err.join("\n"))).toEqual([]);

    // Whatever builds the config, nothing serves without a key.
    const keyless = { ...testConfig(), secretsKey: null };
    expect(() => createPortico(keyless, { db: openDb(":memory:") })).toThrow(ConfigError);
    expect(() => startServer({ ...keyless, dataDir: dir, dbPath: join(dir, "portico.db") }, { port: 0 })).toThrow(ConfigError);
    // Commands that only read settings (portico setup, portico doctor) still run without one.
    expect(parseEnv({}, "").secretsKey).toBeNull();
  });
});

describe("wake URL keys and event secrets at rest", () => {
  test("nothing in the data folder holds a wake key or an event secret in a readable form, signing.key included", async () => {
    const dir = folder();
    // As a real data folder has it: the signing key lies beside the database.
    writeFileSync(join(dir, "signing.key"), `${testConfig().signingKey}\n`);
    const { p, hooks, chris, grok, dot, muse } = await world(dir);
    expect((await callAs(p, grok, "PUT", "/api/agent/wake", { url: HOOK, key: WAKE_KEY })).status).toBe(200);
    expect((await subscribe(p, dot.token)).result).toMatchObject({ id: expect.any(String) });
    // A rotation keeps the secret before it for a while: that one is encrypted too.
    expect((await subscribe(p, dot.token, OTHER_SECRET)).result).toBeDefined();

    // A live invite link and a live share link, whose secrets Portico keeps to show the links again.
    const invite = p.people.createInvite(chris.id, "Maya");
    const shared = p.workspaces.create(chris.id, "Launch");
    const share = p.shares.create(chris.id, shared.id);
    expect(p.people.inviteSecret(invite.invite.id)).toBe(invite.secret);
    expect(p.shares.secretFor(chris.id, share.share.id)).toBe(share.secret);
    for (const box of boxes(p)) expect(box).toStartWith("enc:v1:");

    const { wake, sub } = stored(p);
    expect(wake!.key).toMatch(new RegExp(`^enc:v1:${p.config.secretsKey && secretsKeyId(secretsKeyBytes(TEST_SECRETS_KEY)!)}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$`));
    expect(sub!.secret).toStartWith("enc:v1:");
    expect(sub!.previous_secret).toStartWith("enc:v1:");

    // The database, its WAL and everything else in the folder, while the server runs and after it has shut down.
    const scan = () => {
      const files = filesIn(dir);
      expect(files.map((file) => file.path).some((path) => path.endsWith("portico.db"))).toBe(true);
      const secrets = [WAKE_KEY, EVENT_SECRET, EVENT_SECRET.slice("whsec_".length), OTHER_SECRET, TEST_SECRETS_KEY, invite.secret, share.secret];
      const rawKeys = [Buffer.from(EVENT_SECRET.slice("whsec_".length), "base64"), Buffer.from(secretsKeyBytes(TEST_SECRETS_KEY)!)];
      for (const file of files) {
        for (const needle of [...secrets.flatMap(forms), ...rawKeys]) {
          if (file.bytes.includes(needle)) throw new Error(`${file.path} holds a secret in a readable form`);
        }
      }
      return files.length;
    };
    expect(scan()).toBeGreaterThan(1);

    // And both still work: the wake carries the key, the event is signed with the newest secret (and the one before).
    send(p, muse, "grok");
    send(p, muse, "dot");
    await flush();
    const wakePost = hooks.sent.find((req) => req.url === HOOK)!;
    expect(wakePost.headers.authorization).toBe(`Bearer ${WAKE_KEY}`);
    const event = hooks.sent.filter((req) => req.url === CALLBACK).at(-1)!;
    const check = (secret: string) => verifyWebhook(secret, event.headers["webhook-id"]!, Number(event.headers["webhook-timestamp"]), event.body, event.headers["webhook-signature"]!);
    expect(check(OTHER_SECRET)).toBe(true);
    expect(check(EVENT_SECRET)).toBe(true);
    expect(event.headers["webhook-signature"]!.split(" ")).toHaveLength(2);

    p.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    scan();
    shut(p);
    scan();
  });

  test("an encrypted value copied to another row, or another column, doesn't open there", async () => {
    const dir = folder();
    const { p, hooks, chris, grok, dot, muse } = await world(dir);
    const other = addAppAgent(p, chris, "other", { kind: "grok-bot" });
    await p.wakeUrls.set(grok.agent, chris.id, { url: HOOK, key: WAKE_KEY });
    await p.wakeUrls.set(other.agent, chris.id, { url: "https://attacker.example/collect", key: "k_other" });
    await subscribe(p, dot.token);
    // Someone who can write the database moves grok's key under the row whose address they chose.
    const grokKey = (p.db.query("SELECT key FROM wake_urls WHERE agent_id = $id").get({ id: grok.agent.id }) as { key: string }).key;
    p.db.query("UPDATE wake_urls SET key = $key WHERE agent_id = $id").run({ key: grokKey, id: other.agent.id });
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    send(p, muse, "other");
    await flush();
    expect(hooks.sent.filter((req) => req.url.includes("attacker.example"))).toEqual([]);
    expect(p.wakeUrls.view(other.agent.id)).toMatchObject({ lastStatus: "secret_unreadable" });
    expect(lines.some((line) => line.includes("wake_key_unreadable") && line.includes(other.agent.id))).toBe(true);
    expect(lines.join("\n")).not.toContain(WAKE_KEY);
    // The same holds for the pieces themselves: another row, another column, another table.
    const secrets = Secrets.from(TEST_SECRETS_KEY);
    const sealed = await secrets.seal(WakeUrls.place("agent-1"), "value");
    expect(await secrets.open(WakeUrls.place("agent-1"), sealed)).toEqual({ ok: true, value: "value", current: true });
    for (const place of [WakeUrls.place("agent-2"), EventSubscriptions.place("agent-1"), EventSubscriptions.place("agent-1", "previous_secret")]) {
      expect(await secrets.open(place, sealed)).toEqual({ ok: false, reason: "damaged" });
    }
    // A wake key moved into a subscription's secret signs nothing either.
    p.db.query("UPDATE event_subscriptions SET secret = $key").run({ key: grokKey });
    const before = hooks.sent.length;
    send(p, muse, "dot");
    await flush();
    expect(hooks.sent).toHaveLength(before);
    expect(stored(p).sub!.last_status).toBe("secret_unreadable");
    // Two encryptions of one value never look alike, so equal keys can't be told from the rows.
    expect(await secrets.seal(WakeUrls.place("agent-1"), "value")).not.toBe(sealed);
    shut(p);
  });

  test("rows an earlier Portico stored in plain text are encrypted in place at start", async () => {
    const dir = folder();
    const first = await world(dir);
    await first.p.wakeUrls.set(first.grok.agent, first.chris.id, { url: HOOK, key: "placeholder" });
    await subscribe(first.p, first.dot.token);
    await subscribe(first.p, first.dot.token, OTHER_SECRET);
    // As the database was before: the values themselves in the columns.
    first.p.db.query("UPDATE wake_urls SET key = $key").run({ key: WAKE_KEY });
    first.p.db.query("UPDATE event_subscriptions SET secret = $secret, previous_secret = $before").run({ secret: OTHER_SECRET, before: EVENT_SECRET });
    shut(first.p);
    expect(filesIn(dir).some((file) => file.bytes.includes(Buffer.from(WAKE_KEY)))).toBe(true);

    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    const { p, hooks, muse } = await restart(dir);
    const { wake, sub } = stored(p);
    for (const value of [wake!.key, sub!.secret, sub!.previous_secret!]) expect(value).toStartWith("enc:v1:");
    expect(lines.some((line) => line.includes("stored_secrets_checked") && line.includes('"encrypted":3'))).toBe(true);
    send(p, muse, "grok");
    send(p, muse, "dot");
    await flush();
    expect(hooks.sent.find((req) => req.url === HOOK)!.headers.authorization).toBe(`Bearer ${WAKE_KEY}`);
    const event = hooks.sent.find((req) => req.url === CALLBACK)!;
    expect(verifyWebhook(OTHER_SECRET, event.headers["webhook-id"]!, Number(event.headers["webhook-timestamp"]), event.body, event.headers["webhook-signature"]!)).toBe(true);
    expect(verifyWebhook(EVENT_SECRET, event.headers["webhook-id"]!, Number(event.headers["webhook-timestamp"]), event.body, event.headers["webhook-signature"]!)).toBe(true);
    // Once that pass is done, a value that isn't encrypted no longer counts as one.
    p.db.query("UPDATE wake_urls SET key = 'planted', last_status = NULL, last_at = NULL").run();
    const sent = hooks.sent.length;
    p.clock.advance(60 * 60_000);
    send(p, muse, "grok");
    await flush();
    expect(hooks.sent.filter((req) => req.url === HOOK)).toHaveLength(hooks.sent.slice(0, sent).filter((req) => req.url === HOOK).length);
    expect(stored(p).wake!.last_status).toBe("secret_unreadable");
    shut(p);
  });

  test("a change of key: with the old key given, a start moves every value to the new one", async () => {
    const dir = folder();
    const first = await world(dir);
    await first.p.wakeUrls.set(first.grok.agent, first.chris.id, { url: HOOK, key: WAKE_KEY });
    await subscribe(first.p, first.dot.token);
    const was = stored(first.p);
    shut(first.p);

    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    const second = await restart(dir, { secretsKey: KEY_2, secretsKeyOld: TEST_SECRETS_KEY });
    const now = stored(second.p);
    const id2 = secretsKeyId(secretsKeyBytes(KEY_2)!);
    expect(now.wake!.key).toStartWith(`enc:v1:${id2}:`);
    expect(now.sub!.secret).toStartWith(`enc:v1:${id2}:`);
    expect(now.wake!.key).not.toBe(was.wake!.key);
    expect(lines.some((line) => line.includes("stored_secrets_checked") && line.includes('"rekeyed":2'))).toBe(true);
    shut(second.p);

    // The old key can go: the new one alone opens everything.
    const third = await restart(dir, { secretsKey: KEY_2 });
    expect(stored(third.p).wake!.last_status).toBeNull();
    send(third.p, third.muse, "grok");
    send(third.p, third.muse, "dot");
    await flush();
    expect(third.hooks.sent.find((req) => req.url === HOOK)!.headers.authorization).toBe(`Bearer ${WAKE_KEY}`);
    const event = third.hooks.sent.find((req) => req.url === CALLBACK)!;
    expect(verifyWebhook(EVENT_SECRET, event.headers["webhook-id"]!, Number(event.headers["webhook-timestamp"]), event.body, event.headers["webhook-signature"]!)).toBe(true);
    shut(third.p);
  });

  test("under a key Portico wasn't given, the wake URL and the subscription stop, say so, and work again once set again", async () => {
    const dir = folder();
    const first = await world(dir);
    await first.p.wakeUrls.set(first.grok.agent, first.chris.id, { url: HOOK, key: WAKE_KEY });
    await subscribe(first.p, first.dot.token);
    shut(first.p);

    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    const { p, hooks, grok, dot, muse } = await restart(dir, { secretsKey: KEY_3 });
    // The start goes on, the rows stay, and each says what happened.
    expect(stored(p)).toMatchObject({ wake: { last_status: "secret_unreadable" }, sub: { last_status: "secret_unreadable" } });
    expect(lines.some((line) => line.includes("wake_key_unreadable") && line.includes(grok.agent.id))).toBe(true);
    expect(lines.some((line) => line.includes("event_secret_unreadable"))).toBe(true);
    expect(lines.some((line) => line.includes("stored_secrets_checked") && line.includes('"unreadable":2'))).toBe(true);
    send(p, muse, "grok");
    send(p, muse, "dot");
    await flush();
    expect(hooks.sent).toEqual([]);
    // The agent is told in Portico's own words at its next check, once.
    const inbox = (await (await callAs(p, grok, "GET", "/api/agent/inbox")).json()) as { notices: { text: string }[] };
    expect(inbox.notices.map((notice) => notice.text)).toEqual([WAKE_KEY_LOST]);
    const dots = (await (await callAs(p, dot, "GET", "/api/agent/inbox")).json()) as { notices: { text: string }[] };
    expect(dots.notices.map((notice) => notice.text)).toEqual([EVENT_SECRET_LOST]);
    expect(copyProblems(`${WAKE_KEY_LOST}\n${EVENT_SECRET_LOST}`)).toEqual([]);
    // The person's page no longer counts the agent as woken.
    expect(p.wakeUrls.view(grok.agent.id)).toMatchObject({ lastStatus: "secret_unreadable" });
    shut(p);

    // Another start with the same wrong key neither crashes nor tells the agents again.
    const again = await restart(dir, { secretsKey: KEY_3 });
    expect(again.p.agentNotices.waiting(again.grok.agent.id)).toEqual([]);
    // Setting each again is all it takes.
    expect((await callAs(again.p, again.grok, "PUT", "/api/agent/wake", { url: HOOK, key: "k_new" })).status).toBe(200);
    const resubscribed = await subscribe(again.p, again.dot.token, OTHER_SECRET);
    expect(resubscribed.result).toMatchObject({ deliveryStatus: { lastError: "secret_unreadable" } });
    send(again.p, again.muse, "grok");
    send(again.p, again.muse, "dot");
    await flush();
    expect(again.hooks.sent.find((req) => req.url === HOOK)!.headers.authorization).toBe("Bearer k_new");
    const event = again.hooks.sent.find((req) => req.url === CALLBACK && req.headers["webhook-id"]!.startsWith("evt_"))!;
    expect(verifyWebhook(OTHER_SECRET, event.headers["webhook-id"]!, Number(event.headers["webhook-timestamp"]), event.body, event.headers["webhook-signature"]!)).toBe(true);
    expect(event.headers["webhook-signature"]!.split(" ")).toHaveLength(1);
    shut(again.p);

    // With the right key back, what was set meanwhile still stands and nothing is lost.
    const back = await restart(dir, { secretsKey: KEY_3, secretsKeyOld: TEST_SECRETS_KEY });
    expect(stored(back.p).wake!.key).toStartWith(`enc:v1:${secretsKeyId(secretsKeyBytes(KEY_3)!)}:`);
    shut(back.p);
  });
});

describe("invite and share link secrets at rest", () => {
  /** An owner with one open invite and one open share link. */
  async function links(dir: string, config: { secretsKey?: string; secretsKeyOld?: string | null } = {}) {
    const { p } = start(dir, config);
    const chris = await addOwner(p);
    const invite = p.people.createInvite(chris.id, "Maya");
    const launch = p.workspaces.create(chris.id, "Launch");
    const share = p.shares.create(chris.id, launch.id);
    return { p, chris, invite, share, launch };
  }
  const reopen = (dir: string, config: { secretsKey?: string; secretsKeyOld?: string | null } = {}) => start(dir, config).p;

  test("a secret copied to another row doesn't open there", async () => {
    const { p, chris, invite, share } = await links(folder());
    const second = p.people.createInvite(chris.id, "Robert");
    const [first] = boxes(p);
    p.db.query("UPDATE invites SET secret_box = $box WHERE id = $id").run({ box: first!, id: second.invite.id });
    expect(p.people.inviteSecret(second.invite.id)).toBeNull();
    expect(p.people.inviteSecret(invite.invite.id)).toBe(invite.secret);
    p.db.query("UPDATE shares SET secret_box = $box").run({ box: first! });
    expect(p.shares.secretFor(chris.id, share.share.id)).toBeNull();
    // Either way of sealing is read by either way of opening.
    const secrets = Secrets.from(TEST_SECRETS_KEY);
    const place = People.invitePlace("invite-1");
    expect(await secrets.open(place, secrets.sealSync(place, "value"))).toMatchObject({ ok: true, value: "value" });
    expect(secrets.openSync(place, await secrets.seal(place, "value"))).toMatchObject({ ok: true, value: "value" });
    expect(secrets.openSync(Shares.place("invite-1"), secrets.sealSync(place, "value"))).toEqual({ ok: false, reason: "damaged" });
    expect(secrets.openSync(place, "value")).toEqual({ ok: false, reason: "plain" });
    shut(p);
  });

  test("secrets an earlier Portico sealed with the signing key are encrypted again at start, under the secrets key", async () => {
    const dir = folder();
    const first = await links(dir);
    const signingKey = first.p.config.signingKey;
    // As the rows were before: sealed with the key that lies in the data folder.
    first.p.db.query("UPDATE invites SET secret_box = $box").run({ box: seal(signingKey, INVITE_SEAL, first.invite.secret) });
    first.p.db.query("UPDATE shares SET secret_box = $box").run({ box: seal(signingKey, SHARE_SEAL, first.share.secret) });
    shut(first.p);
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    const p = reopen(dir);
    for (const box of boxes(p)) expect(box).toStartWith("enc:v1:");
    expect(lines.some((line) => line.includes("stored_link_secrets_checked") && line.includes('"encrypted":2'))).toBe(true);
    expect(p.people.inviteSecret(first.invite.invite.id)).toBe(first.invite.secret);
    expect(p.shares.secretFor(first.chris.id, first.share.share.id)).toBe(first.share.secret);
    shut(p);
  });

  test("a change of key moves them too, and under a key Portico wasn't given a link can't be shown again, which the pages say", async () => {
    const dir = folder();
    const first = await links(dir);
    shut(first.p);
    const id2 = secretsKeyId(secretsKeyBytes(KEY_2)!);
    const second = reopen(dir, { secretsKey: KEY_2, secretsKeyOld: TEST_SECRETS_KEY });
    for (const box of boxes(second)) expect(box).toStartWith(`enc:v1:${id2}:`);
    expect(second.people.inviteSecret(first.invite.invite.id)).toBe(first.invite.secret);
    shut(second);

    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    const lost = reopen(dir, { secretsKey: KEY_3 });
    expect(lines.filter((line) => line.includes("link_secret_unreadable"))).toHaveLength(2);
    expect(lines.some((line) => line.includes("stored_link_secrets_checked") && line.includes('"unreadable":2'))).toBe(true);
    expect(lost.people.inviteSecret(first.invite.invite.id)).toBeNull();
    expect(lost.shares.secretFor(first.chris.id, first.share.share.id)).toBeNull();
    // The links themselves still work: only showing them again is gone, and each page says what to do.
    expect(lost.people.openInvite(first.invite.secret).id).toBe(first.invite.invite.id);
    expect(lost.shares.usable(first.share.secret).id).toBe(first.share.share.id);
    const cookie = signIn(lost, lost.people.require(first.chris.id));
    const settings = await (await lost.app.request(`${PUBLIC_URL}/settings`, { headers: { cookie } })).text();
    expect(settings).toContain("Portico can't show this link again.");
    expect(settings).toContain("revoke this invite and make a new one");
    const page = await (await lost.app.request(`${PUBLIC_URL}/p/${first.launch.id}`, { headers: { cookie } })).text();
    expect(page).toContain("end this link and make a new one");
    expect(copyProblems(visibleCopy(settings))).toEqual([]);
    expect(copyProblems(visibleCopy(page))).toEqual([]);
    // A new link made now shows as ever.
    const fresh = lost.people.createInvite(first.chris.id, "Dana");
    expect(lost.people.inviteSecret(fresh.invite.id)).toBe(fresh.secret);
    shut(lost);

    // With the key back as the old one, the stored secrets come back too.
    const back = reopen(dir, { secretsKey: KEY_3, secretsKeyOld: KEY_2 });
    expect(back.people.inviteSecret(first.invite.invite.id)).toBe(first.invite.secret);
    expect(back.shares.secretFor(first.chris.id, first.share.share.id)).toBe(first.share.secret);
    shut(back);
  });
});

describe("what a start replaces doesn't stay readable in the files", () => {
  const SESSION_KEY = "session-key-kept-secret-7f3a";
  /** Which of the values some file in the folder still holds, in any of their forms. */
  const found = (dir: string, values: Record<string, string>) =>
    Object.entries(values)
      .filter(([, value]) => filesIn(dir).some((file) => forms(value).some((needle) => file.bytes.includes(needle))))
      .map(([name]) => name);

  /**
   * A data folder as an earlier Portico left one: the wake key, the event secrets and the session key as they were,
   * and the link secrets sealed with the signing key that lies beside them. Written through a plain connection, the
   * way that Portico wrote, and checkpointed into the main file.
   */
  async function oldFolder() {
    const dir = folder();
    const first = await world(dir);
    const { computer } = addComputer(first.p, first.chris);
    addSession(first.p, computer, { key: "placeholder-session-key" });
    await first.p.wakeUrls.set(first.grok.agent, first.chris.id, { url: HOOK, key: "placeholder" });
    await subscribe(first.p, first.dot.token);
    await subscribe(first.p, first.dot.token, OTHER_SECRET);
    const invite = first.p.people.createInvite(first.chris.id, "Maya");
    const share = first.p.shares.create(first.chris.id, first.p.workspaces.create(first.chris.id, "Launch").id);
    const signingKey = first.p.config.signingKey;
    shut(first.p);
    writeFileSync(join(dir, "signing.key"), `${signingKey}\n`);
    const old = {
      wakeKey: WAKE_KEY,
      eventSecret: OTHER_SECRET,
      eventSecretBefore: EVENT_SECRET,
      sessionKey: SESSION_KEY,
      inviteBox: seal(signingKey, INVITE_SEAL, invite.secret),
      shareBox: seal(signingKey, SHARE_SEAL, share.secret),
    };
    const raw = new Database(join(dir, "portico.db"), { strict: true });
    raw.run("PRAGMA secure_delete = OFF");
    raw.query("UPDATE wake_urls SET key = $key").run({ key: old.wakeKey });
    raw.query("UPDATE event_subscriptions SET secret = $secret, previous_secret = $before").run({ secret: old.eventSecret, before: old.eventSecretBefore });
    raw.query("UPDATE agent_runs SET session_key = $key").run({ key: old.sessionKey });
    raw.query("UPDATE invites SET secret_box = $box").run({ box: old.inviteBox });
    raw.query("UPDATE shares SET secret_box = $box").run({ box: old.shareBox });
    // A table that came and went, as tables do: its pages return to the free list with their bytes.
    raw.run("DELETE FROM settings WHERE key IN ('scrubbed_at', 'scrub_pending')");
    raw.run("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    return { dir, old, invite, share };
  }

  /**
   * Bytes of a value in pages the database no longer uses, as replacing a row leaves them in a file of real size: rows
   * that held the value and are gone, in pages of their own that went back to the free list as they were.
   */
  function leaveBehind(raw: Database, value: string): void {
    raw.run("CREATE TABLE gone (v TEXT)");
    const insert = raw.query("INSERT INTO gone (v) VALUES ($v)");
    for (let i = 0; i < 200; i++) insert.run({ v: value });
    raw.run("DROP TABLE gone");
  }

  test("after the start that encrypts them, no file in the data folder holds the old values, running or stopped", async () => {
    const { dir, old, invite, share } = await oldFolder();
    expect(found(dir, old).sort()).toEqual(Object.keys(old).sort());

    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    const { p, hooks, grok, muse } = await restart(dir);
    expect(lines.some((line) => line.includes("database_scrubbed") && line.includes("stored_secrets_replaced"))).toBe(true);
    // While the server runs: the database, its write-ahead log and everything beside them.
    expect(found(dir, { ...old, invite: invite.secret, share: share.secret })).toEqual([]);
    // Everything still works with what the rows hold now.
    send(p, muse, "grok");
    await flush();
    expect(hooks.sent.find((req) => req.url === HOOK)!.headers.authorization).toBe(`Bearer ${WAKE_KEY}`);
    expect(p.people.inviteSecret(invite.invite.id)).toBe(invite.secret);
    expect(p.agents.sessionByKey((p.db.query("SELECT id FROM computers").get() as { id: string }).id, SESSION_KEY)).not.toBeNull();

    // What the agent replaces or removes later goes the same way: the freed bytes are zeroed, encrypted or not.
    const before = stored(p).wake!.key;
    expect((await callAs(p, grok, "PUT", "/api/agent/wake", { url: HOOK, key: "k_second" })).status).toBe(200);
    const second = stored(p).wake!.key;
    expect((await callAs(p, grok, "DELETE", "/api/agent/wake")).status).toBe(204);
    p.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(found(dir, { ...old, before, second, wakeKey2: "k_second" })).toEqual([]);
    shut(p);
    expect(found(dir, { ...old, before, second })).toEqual([]);

    // The next start has nothing to replace and rewrites nothing.
    lines.length = 0;
    const again = await restart(dir);
    expect(lines.some((line) => line.includes("database_scrubbed"))).toBe(false);
    shut(again.p);
  });

  test("a database an earlier start already encrypted, leaving the old bytes behind, is rewritten once", async () => {
    const { dir, old } = await oldFolder();
    // That start's pass, as it was: the rows replaced, the freed bytes left in the pages, nothing rewritten.
    const raw = new Database(join(dir, "portico.db"), { strict: true });
    raw.run("PRAGMA secure_delete = OFF");
    const secrets = Secrets.from(TEST_SECRETS_KEY);
    const agentId = (raw.query("SELECT agent_id FROM wake_urls").get() as { agent_id: string }).agent_id;
    raw.query("UPDATE wake_urls SET key = $key").run({ key: await secrets.seal(WakeUrls.place(agentId), WAKE_KEY) });
    leaveBehind(raw, old.wakeKey);
    raw.run("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    expect(found(dir, { wakeKey: old.wakeKey })).toEqual(["wakeKey"]);

    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    const { p } = await restart(dir);
    expect(lines.some((line) => line.includes("database_scrubbed"))).toBe(true);
    expect(found(dir, old)).toEqual([]);
    shut(p);
    expect(found(dir, old)).toEqual([]);
  });

  test("a rewrite that didn't happen is tried again at the next start", async () => {
    const { dir, old } = await oldFolder();
    // The passes ran and the server stopped before the rewrite: the note they left is still there.
    const raw = new Database(join(dir, "portico.db"), { strict: true });
    raw.run("PRAGMA secure_delete = OFF");
    raw.query("UPDATE wake_urls SET key = 'enc:v1:00000000:AAAA:AAAA'").run();
    raw.query("UPDATE event_subscriptions SET secret = 'enc:v1:00000000:AAAA:AAAA', previous_secret = NULL").run();
    raw.query("UPDATE agent_runs SET session_key = 'h:' || session_key").run();
    raw.query("UPDATE invites SET secret_box = NULL").run();
    raw.query("DELETE FROM shares").run();
    leaveBehind(raw, old.wakeKey);
    raw.run("INSERT INTO settings (key, value) VALUES ('scrub_pending', '1'), ('scrubbed_at', '2026-01-01T00:00:00.000Z')");
    raw.run("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    expect(found(dir, old)).toContain("wakeKey");
    const { p } = await restart(dir);
    expect(found(dir, { wakeKey: old.wakeKey, eventSecret: old.eventSecret, inviteBox: old.inviteBox, shareBox: old.shareBox })).toEqual([]);
    expect(p.db.query("SELECT 1 FROM settings WHERE key = 'scrub_pending'").get()).toBeNull();
    shut(p);
  });
});

describe("session keys", () => {
  test("a session key is stored only as a hash, and one stored as it was is hashed at start", async () => {
    const dir = folder();
    const first = makePortico({ dataDir: dir });
    const chris = await addOwner(first);
    const { computer, token } = addComputer(first, chris);
    const session = addSession(first, computer, { key: "session-key-kept-secret-1" });
    const row = () => (first.db.query("SELECT session_key FROM agent_runs").get() as { session_key: string }).session_key;
    expect(row()).toMatch(/^h:[0-9a-f]{64}$/);
    expect((await callAs(first, { token, key: session.key }, "GET", "/api/agent/agents")).status).toBe(200);
    expect((await callAs(first, { token, key: row() }, "GET", "/api/agent/agents")).status).toBe(401);
    // As an earlier Portico left the row.
    first.db.query("UPDATE agent_runs SET session_key = $key").run({ key: session.key });
    shut(first);
    const second = makePortico({ dataDir: dir });
    expect((second.db.query("SELECT session_key FROM agent_runs").get() as { session_key: string }).session_key).toMatch(/^h:[0-9a-f]{64}$/);
    expect((await callAs(second, { token, key: session.key }, "GET", "/api/agent/agents")).status).toBe(200);
    // The same key reconnecting keeps its run.
    expect(second.agents.registerSession(computer, { key: session.key, repo: "api", folderId: "1".padStart(64, "0"), client: "claude-code" }).created).toBe(false);
    shut(second);
  });
});
