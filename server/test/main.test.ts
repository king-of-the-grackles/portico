import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceCommand } from "../src/commands/workspace";
import type { HostedConfig } from "../src/config";
import type { Account } from "../src/core/types";
import { MainHosted, createMain, migrateToMain, previewMigration, readMain } from "../src/hosted/main";
import { Hosted } from "../src/hosted/router";
import { startHold } from "../src/server";
import { addAppAgent, addMember, addOwner, errorCode, testClock } from "./helpers";

const dirs: string[] = [];
const running: { stop(): void }[] = [];

afterEach(() => {
  for (const hosted of running.splice(0)) hosted.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hostedConfig(): HostedConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "portico-main-"));
  dirs.push(dataDir);
  return { domain: "portico.test", baseUrl: "https://portico.test", dataDir, port: 8790, pluginSource: null, webhooksAllowPrivate: false, files: null, mail: null, descopeProjectId: null };
}

/** Sign-in tokens are `account:<id>:<email>:<name>` here. */
const accountCheck = {
  accountFor: async (token: unknown) => (await accountCheck.account(token)).id,
  account: async (token: unknown): Promise<Account> => {
    const [kind, id, email, name] = String(token).split(":");
    if (kind !== "account" || !id) throw new (await import("../src/core/errors")).PorticoError("unauthorized", "The sign-in didn't check out. Sign in again.");
    return { id, email: email || null, name: name || null };
  },
};

/** The old layout: a workspace `super` with an owner, a member, agents on both sides and a conversation between them. */
async function oldSuper(config: HostedConfig) {
  const hosted = new Hosted(config);
  const ws = hosted.create("super");
  const p = hosted.portico(ws);
  p.settings.set("setup_done_at", new Date().toISOString());
  const chris = await addOwner(p, "Chris");
  p.people.setExternalId(chris.id, "acct-chris");
  const robert = await addMember(p, "Robert");
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  const muse = addAppAgent(p, chris, "muse");
  const dots = addAppAgent(p, robert, "dots");
  p.messages.send(grok.agent, { to: "muse", subject: "Mine", text: "Between the owner's own agents." });
  p.messages.send(grok.agent, { to: "dots", subject: "Theirs", text: "To the other person's agent." });
  p.accounts.startSession(chris.id);
  hosted.stop();
  return { ws, chris, robert, grok, muse, dots };
}

function start(config: HostedConfig) {
  const clock = testClock();
  const hosted = new MainHosted(config, { now: clock.now, accountCheck });
  running.push(hosted);
  const call = (host: string, path: string, init: RequestInit & { token?: string; cookie?: string; json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    if (init.cookie) headers.set("cookie", init.cookie);
    const body = init.json === undefined ? init.body : JSON.stringify(init.json);
    if (typeof body === "string") headers.set("content-type", "application/json");
    return hosted.fetch(new Request(`https://${host}${path}`, { ...init, body, headers }));
  };
  /** Signs an account in at the base domain: the Cookie header to send afterwards, and where the browser goes. */
  const signIn = async (token: string, extra: Record<string, unknown> = {}) => {
    const res = await call("portico.test", "/api/session", { method: "POST", json: { token, ...extra } });
    const set = res.headers.get("set-cookie") ?? "";
    return { res, set, cookie: set.split(";")[0]!, next: res.ok ? ((await res.json()) as { next: string }).next : null };
  };
  return { hosted, clock, call, signIn, p: hosted.portico };
}

describe("moving a workspace into one database", () => {
  test("the preview changes nothing and says what removing a person takes along", async () => {
    const config = hostedConfig();
    await oldSuper(config);
    const preview = previewMigration(config, "super", ["Robert"]);
    expect(preview).toMatchObject({ people: 2, agents: 3, threads: 2, messages: 2 });
    expect(preview.removed).toEqual([{ person: "Robert", agents: 1, threads: 1, messages: 1 }]);
    expect(readMain(config)).toBeNull();
    expect(errorCode(() => previewMigration(config, "super", ["Nobody"]))).toBe("not_found");
    expect(errorCode(() => previewMigration(config, "other"))).toBe("not_found");
  });

  test("the copy keeps every agent, gives each person a personal workspace and stamps each conversation", async () => {
    const config = hostedConfig();
    const old = await oldSuper(config);
    const result = migrateToMain(config, "super");
    expect(result).toMatchObject({ people: 2, agents: 3, threads: 2, messages: 2, removed: [] });
    expect(readMain(config)).toEqual({ aliases: ["super"], filesPrefix: "main/files/" });
    const { p } = start(config);
    const mine = p.workspaces.personal(old.chris.id);
    expect(p.workspaces.agentsIn(mine.id).sort()).toEqual([old.grok.agent.id, old.muse.agent.id].sort());
    expect(p.workspaces.agentsIn(p.workspaces.personal(old.robert.id).id)).toEqual([old.dots.agent.id]);
    const stamps = p.db.query("SELECT a_id, b_id, workspace_id FROM threads").all() as { a_id: string; b_id: string; workspace_id: string | null }[];
    const between = (a: string, b: string) => stamps.find((t) => [t.a_id, t.b_id].sort().join() === [a, b].sort().join())!;
    expect(between(old.grok.agent.id, old.muse.agent.id).workspace_id).toBe(mine.id);
    // The two people share no workspace yet, so their conversation runs through none and can't be added to.
    expect(between(old.grok.agent.id, old.dots.agent.id).workspace_id).toBeNull();
    expect(errorCode(() => p.messages.send(p.agents.get(old.grok.agent.id)!, { to: "dots", subject: "More", text: "x" }))).toBe("unknown_agent");
    // Everyone signs in again.
    expect((p.db.query("SELECT COUNT(*) AS n FROM web_sessions").get() as { n: number }).n).toBe(0);
  });

  test("a removed person goes with their agents and conversations, in the copy only", async () => {
    const config = hostedConfig();
    const old = await oldSuper(config);
    const result = migrateToMain(config, "super", ["Robert"]);
    expect(result).toMatchObject({ people: 1, agents: 2, threads: 1, messages: 1 });
    const { p } = start(config);
    expect(p.people.get(old.robert.id)).toBeNull();
    expect(p.agents.get(old.dots.agent.id)).toBeNull();
    // The workspace's own database still holds everyone: the release before runs on it unchanged.
    const before = new Database(join(config.dataDir, "w", old.ws.id, "portico.db"), { readonly: true });
    expect((before.query("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n).toBe(2);
    before.close();
  });

  test("a second move is refused, and moving the folder aside goes back to a database per workspace", async () => {
    const config = hostedConfig();
    await oldSuper(config);
    migrateToMain(config, "super");
    expect(errorCode(() => migrateToMain(config, "super"))).toBe("conflict");
    expect(errorCode(() => createMain(config))).toBe("conflict");
    renameSync(join(config.dataDir, "main"), join(config.dataDir, "main.aside"));
    expect(readMain(config)).toBeNull();
    const hosted = new Hosted(config);
    running.push(hosted);
    expect(hosted.control.bySlug("super")).not.toBeNull();
    expect(hosted.portico(hosted.control.bySlug("super")!).people.list()).toHaveLength(2);
  });

  test("portico workspace unite previews first and moves only with --confirm", async () => {
    const config = hostedConfig();
    await oldSuper(config);
    const out: string[] = [];
    const err: string[] = [];
    const io = { env: { PORTICO_HOSTED_DOMAIN: "portico.test", PORTICO_HOSTED_DATA: config.dataDir }, cwd: config.dataDir, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    expect(await workspaceCommand(["unite", "super", "--remove", "Robert"], io)).toBe(0);
    expect(out.join("\n")).toContain("super holds 2 people, 3 agents, 2 conversations and 2 messages. Nothing is changed yet.");
    expect(out.join("\n")).toContain("Removing Robert also removes 1 agent, 1 conversation and 1 message.");
    expect(existsSync(join(config.dataDir, "main"))).toBe(false);
    expect(await workspaceCommand(["unite", "super", "--confirm", "other"], io)).toBe(1);
    expect(existsSync(join(config.dataDir, "main"))).toBe(false);
    expect(await workspaceCommand(["unite", "super", "--remove", "Robert", "--confirm", "super"], io)).toBe(0);
    expect(out.join("\n")).toContain("Made the one database from super: 1 person, 2 agents, 1 conversation and 1 message.");
    expect(readMain(config)!.aliases).toEqual(["super"]);
    expect(await workspaceCommand(["unite", "super", "--confirm", "super"], io)).toBe(1);
    expect(await workspaceCommand(["create", "acme"], io)).toBe(1);
    expect(err.join("\n")).toContain("keeps one database");
  });
});

describe("holding the address during the move", () => {
  test("only the health check answers, and everything else is told to come back", async () => {
    const hold = startHold(0);
    running.push(hold);
    const at = `http://localhost:${hold.port}`;
    expect((await fetch(`${at}/healthz`)).status).toBe(200);
    for (const path of ["/", "/mcp", "/api/agent/agents"]) {
      const res = await fetch(`${at}${path}`, { method: path === "/mcp" ? "POST" : "GET" });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("30");
    }
  });
});

describe("one database at several addresses", () => {
  test("an agent's token works at the address joined before and at the base domain, and nowhere else", async () => {
    const config = hostedConfig();
    const old = await oldSuper(config);
    migrateToMain(config, "super");
    const { call } = start(config);
    for (const host of ["super.portico.test", "portico.test"]) {
      const res = await call(host, "/api/agent/agents", { token: old.grok.token });
      expect(res.status).toBe(200);
      const names = ((await res.json()) as { agents: { name: string }[] }).agents.map((a) => a.name);
      expect(names).toContain("muse");
      expect(names).not.toContain("dots");
    }
    expect((await call("other.portico.test", "/api/agent/agents", { token: old.grok.token })).status).toBe(404);
    expect((await call("evil.test", "/api/agent/agents", { token: old.grok.token })).status).toBe(404);
  });

  test("each address names itself in what a connector reads", async () => {
    const config = hostedConfig();
    await oldSuper(config);
    migrateToMain(config, "super");
    const { call } = start(config);
    for (const host of ["super.portico.test", "portico.test"]) {
      const resource = (await (await call(host, "/.well-known/oauth-protected-resource")).json()) as { resource: string; authorization_servers: string[] };
      expect(resource.resource.startsWith(`https://${host}`)).toBe(true);
      expect(resource.authorization_servers).toEqual([`https://${host}`]);
      const unauthorized = await call(host, "/mcp", { method: "POST", json: {} });
      expect(unauthorized.headers.get("www-authenticate")).toContain(`https://${host}/.well-known/oauth-protected-resource`);
    }
  });
});

describe("signing in with an account", () => {
  test("the person brought over signs in, picks a handle, and finds every agent in the personal workspace", async () => {
    const config = hostedConfig();
    const old = await oldSuper(config);
    migrateToMain(config, "super", ["Robert"]);
    const { call, signIn, p } = start(config);
    expect((await call("portico.test", "/")).headers.get("location")).toBe("/sign-in");
    const { res, set, cookie, next } = await signIn("account:acct-chris:chris@example.com:Chris");
    expect(res.status).toBe(200);
    // One sign-in for every address of this Portico.
    expect(set).toContain("Domain=portico.test");
    expect(set).toContain("HttpOnly");
    expect(next).toBe("https://portico.test/welcome");
    expect(p.people.get(old.chris.id)!.email).toBe("chris@example.com");

    // Until the handle is picked nothing else opens, at either address.
    expect((await call("portico.test", "/", { cookie })).headers.get("location")).toBe("https://portico.test/welcome");
    expect((await call("super.portico.test", "/settings", { cookie })).headers.get("location")).toBe("https://portico.test/welcome?next=%2Fsettings");
    expect((await call("portico.test", "/api/agents", { cookie })).status).toBe(403);
    expect((await call("portico.test", "/welcome", { cookie })).status).toBe(200);

    const check = async (handle: string) => (await (await call("portico.test", `/api/handles/check?handle=${handle}`, { cookie })).json()) as { free: boolean };
    expect((await check("chris")).free).toBe(true);
    expect((await check("admin")).free).toBe(false);
    expect((await check("x")).free).toBe(false);
    const bad = await call("portico.test", "/api/welcome", { method: "POST", cookie, json: { name: "Chris", handle: "admin" } });
    expect(bad.status).toBe(409);
    const done = await call("portico.test", "/api/welcome", { method: "POST", cookie, json: { name: "Chris I", handle: "Chris" } });
    expect(((await done.json()) as { next: string }).next).toBe("/");
    expect(p.people.get(old.chris.id)).toMatchObject({ handle: "chris", name: "Chris I" });

    for (const host of ["portico.test", "super.portico.test"]) {
      const agents = (await (await call(host, "/api/agents", { cookie })).json()) as { agents: { name: string }[] };
      expect(agents.agents.map((a) => a.name).sort()).toEqual(["grok", "muse"]);
      expect((await call(host, "/", { cookie })).status).toBe(200);
    }
  });

  test("a new account becomes a new person who sees nothing of anyone else's", async () => {
    const config = hostedConfig();
    await oldSuper(config);
    migrateToMain(config, "super");
    const { call, signIn, p } = start(config);
    const { cookie, next } = await signIn("account:acct-maya:maya@example.com:");
    expect(next).toBe("https://portico.test/welcome");
    const maya = p.people.byExternalId("acct-maya")!;
    expect(maya).toMatchObject({ name: "maya", role: "member", status: "active", email: "maya@example.com", handle: null });
    await call("portico.test", "/api/welcome", { method: "POST", cookie, json: { name: "Chris", handle: "maya" } });
    // Two people can share a name: the handle tells them apart.
    expect(p.people.get(maya.id)).toMatchObject({ name: "Chris", handle: "maya" });
    expect(p.workspaces.forPerson(maya.id).map((w) => w.kind)).toEqual(["personal"]);
    expect(((await (await call("portico.test", "/api/agents", { cookie })).json()) as { agents: unknown[] }).agents).toEqual([]);
    expect(((await (await call("portico.test", "/api/people", { cookie })).json()) as { people: { name: string }[] }).people.map((x) => x.name)).toEqual(["Chris"]);
    // Signing in again finds the same person.
    await signIn("account:acct-maya:maya@example.com:");
    expect(p.people.list()).toHaveLength(3);
  });

  test("a token that doesn't check out, another site's request, and the old ways in are all refused", async () => {
    const config = hostedConfig();
    createMain(config);
    const { call, signIn } = start(config);
    expect((await signIn("nope")).res.status).toBe(401);
    const cross = await call("portico.test", "/api/session", { method: "POST", json: { token: "account:a::" }, headers: { origin: "https://evil.test" } });
    expect(cross.status).toBe(403);
    expect((await call("portico.test", "/api/session", { method: "POST", json: { name: "Chris", password: "correct-horse-battery" } })).status).toBe(401);
    for (const path of ["/api/setup", "/api/passkeys", "/api/session/passkey/options"]) {
      expect((await call("portico.test", path, { method: "POST", json: {} })).status).toBe(404);
    }
    expect((await call("portico.test", "/setup")).status).toBe(404);
  });

  test("a sign-in that starts at another address of this Portico comes back there, and nowhere outside", async () => {
    const config = hostedConfig();
    await oldSuper(config);
    migrateToMain(config, "super", ["Robert"]);
    const { call, signIn } = start(config);
    const away = await call("super.portico.test", "/sign-in?next=%2Fsettings");
    expect(away.headers.get("location")).toBe("https://portico.test/sign-in?at=https%3A%2F%2Fsuper.portico.test&next=%2Fsettings");
    const first = await signIn("account:acct-chris::Chris", { next: "/settings", at: "https://super.portico.test" });
    expect(first.next).toBe("https://portico.test/welcome?next=%2Fsettings&at=https%3A%2F%2Fsuper.portico.test");
    const done = await call("portico.test", "/api/welcome", { method: "POST", cookie: first.cookie, json: { name: "Chris", handle: "chris", next: "/settings", at: "https://super.portico.test" } });
    expect(((await done.json()) as { next: string }).next).toBe("https://super.portico.test/settings");
    const outside = await signIn("account:acct-chris::Chris", { next: "/settings", at: "https://evil.test" });
    expect(outside.next).toBe("/settings");
  });

  test("an empty one database starts with no people, and the first sign-in makes the first", async () => {
    const config = hostedConfig();
    createMain(config);
    const { signIn, p } = start(config);
    expect(p.people.list()).toHaveLength(0);
    await signIn("account:first::Ada");
    expect(p.people.list().map((x) => x.name)).toEqual(["Ada"]);
  });
});
