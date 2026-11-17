import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceCommand } from "../src/commands/workspace";
import { ConfigError, ensureSigningKey, type HostedConfig, hostedEnv } from "../src/config";
import { cleanPublicUrl } from "../src/core/settings";
import { checkSlug } from "../src/hosted/control";
import { Hosted } from "../src/hosted/router";
import { openDb } from "../src/db";
import { createPortico } from "../src/portico";
import { addAppAgent, addOwner, errorCode, fakeConnection, HOUR, MINUTE, PASSWORD, signIn, testClock, testConfig } from "./helpers";

const dirs: string[] = [];
const running: Hosted[] = [];

afterEach(() => {
  for (const hosted of running.splice(0)) hosted.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function hostedConfig(overrides: Partial<HostedConfig> = {}): HostedConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "portico-hosted-"));
  dirs.push(dataDir);
  return {
    domain: "portico.test",
    baseUrl: "https://portico.test",
    dataDir,
    port: 8790,
    pluginSource: null,
    webhooksAllowPrivate: false,
    files: null,
    descopeProjectId: null,
    ...overrides,
  };
}

function start(config = hostedConfig()) {
  const clock = testClock();
  const hosted = new Hosted(config, { now: clock.now, idleMs: 10 * MINUTE });
  running.push(hosted);
  const call = (host: string, path: string, init: RequestInit & { token?: string; cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    if (init.cookie) headers.set("cookie", init.cookie);
    if (typeof init.body === "string") headers.set("content-type", "application/json");
    return hosted.fetch(new Request(`https://${host}${path}`, { ...init, headers }));
  };
  return { hosted, clock, call };
}

/** A workspace that is set up, with an owner and two app agents. */
async function workspace(hosted: Hosted, slug: string) {
  const ws = hosted.create(slug);
  const p = hosted.portico(ws);
  p.settings.set("setup_done_at", new Date().toISOString());
  const owner = await addOwner(p, `${slug} owner`);
  const grok = addAppAgent(p, owner, "grok", { kind: "grok-bot" });
  const muse = addAppAgent(p, owner, "muse");
  return { ws, p, owner, grok, muse, host: `${slug}.portico.test` };
}

describe("health check", () => {
  test("answers at any address, since a platform's check names no domain", async () => {
    const { call } = start();
    expect((await call("10.0.0.7:8790", "/healthz")).status).toBe(200);
    expect((await call("10.0.0.7:8790", "/")).status).toBe(404);
  });
});

describe("hosted settings", () => {
  test("hosted mode is on only with a domain, and a workspace's address comes from the domain", () => {
    expect(hostedEnv({})).toBeNull();
    const config = hostedEnv({ PORTICO_HOSTED_DOMAIN: "Portico.Example", PORTICO_HOSTED_DATA: "/srv/portico", PORT: "9000" })!;
    expect(config).toMatchObject({ domain: "portico.example", baseUrl: "https://portico.example", dataDir: "/srv/portico", port: 9000 });
    expect(hostedEnv({ PORTICO_HOSTED_DOMAIN: "localhost:8790" })!.baseUrl).toBe("http://localhost:8790");
    expect(() => hostedEnv({ PORTICO_HOSTED_DOMAIN: "https://portico.example/x" })).toThrow(ConfigError);
  });

  test("a name under localhost counts as this computer, so a workspace sets up on a developer's computer", () => {
    expect(cleanPublicUrl("http://acme.localhost:8790")).toBe("http://acme.localhost:8790");
    expect(cleanPublicUrl("http://acme.localhost.example.com")).toBeNull();
  });

  test("a workspace name is a plain, unreserved, unused address label", () => {
    expect(checkSlug(" Acme-Team ")).toBe("acme-team");
    expect(errorCode(() => checkSlug("ab"))).toBe("bad_request");
    expect(errorCode(() => checkSlug("acme.team"))).toBe("bad_request");
    expect(errorCode(() => checkSlug("-acme"))).toBe("bad_request");
    expect(errorCode(() => checkSlug("www"))).toBe("conflict");
    const { hosted } = start();
    hosted.create("acme");
    expect(errorCode(() => hosted.create("acme"))).toBe("conflict");
  });
});

describe("routing by host", () => {
  test("each address reaches its own workspace, and the workspace knows its own address", async () => {
    const { hosted, call } = start();
    const acme = await workspace(hosted, "acme");
    const zeta = await workspace(hosted, "zeta");
    addAppAgent(zeta.p, zeta.owner, "only-in-zeta");

    const names = async (host: string, token: string) =>
      ((await (await call(host, "/api/agent/agents", { token })).json()) as { agents: { name: string }[] }).agents.map((a) => a.name);
    expect(await names(acme.host, acme.grok.token)).toEqual(["muse"]);
    expect(await names(zeta.host, zeta.grok.token)).toEqual(["muse", "only-in-zeta"]);

    const api = (await (await call(acme.host, "/api/agent/openapi.json")).json()) as { servers: { url: string }[] };
    expect(api.servers[0]!.url).toBe("https://acme.portico.test");
    expect(acme.p.settings.publicUrl()).toBe("https://acme.portico.test");
  });

  test("the base domain, an unknown name and a deeper name each get their own answer", async () => {
    const { hosted, call } = start();
    await workspace(hosted, "acme");
    const base = await call("portico.test", "/");
    expect(base.status).toBe(200);
    expect(await base.text()).toContain("Each workspace has an address");
    expect((await call("portico.test", "/healthz")).status).toBe(200);
    expect((await call("portico.test", "/api/agent/agents")).status).toBe(404);

    const unknown = await call("nobody.portico.test", "/");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("No workspace at this address");
    expect((await call("nobody.portico.test", "/api/agent/agents")).status).toBe(404);
    expect((await call("a.acme.portico.test", "/")).status).toBe(404);
    expect((await call("acme.portico.test.evil.example", "/")).status).toBe(404);
    expect((await call("acme.portico.test", "/healthz")).status).toBe(200);
  });
});

describe("one workspace never reaches another", () => {
  test("an agent token works only at its own workspace's address", async () => {
    const { hosted, call } = start();
    const acme = await workspace(hosted, "acme");
    const zeta = await workspace(hosted, "zeta");
    expect((await call(acme.host, "/api/agent/agents", { token: acme.grok.token })).status).toBe(200);
    expect((await call(zeta.host, "/api/agent/agents", { token: acme.grok.token })).status).toBe(401);
    expect((await call(zeta.host, "/mcp", { method: "POST", token: acme.grok.token, body: "{}" })).status).toBe(401);
  });

  test("a sign-in cookie works only at its own workspace's address", async () => {
    const { hosted, call } = start();
    const acme = await workspace(hosted, "acme");
    const zeta = await workspace(hosted, "zeta");
    const cookie = signIn(acme.p, acme.owner);
    expect((await call(acme.host, "/api/me", { cookie })).status).toBe(200);
    expect((await call(zeta.host, "/api/me", { cookie })).status).toBe(401);
  });

  test("messages and files stay in the workspace that holds them", async () => {
    const { hosted, call } = start();
    const acme = await workspace(hosted, "acme");
    const zeta = await workspace(hosted, "zeta");
    const made = (await (
      await call(acme.host, "/api/agent/files", { method: "POST", token: acme.grok.token, body: JSON.stringify({ name: "plan.txt", text: "acme only" }) })
    ).json()) as { file: { id: string } };
    const sent = (await (
      await call(acme.host, "/api/agent/messages", {
        method: "POST",
        token: acme.grok.token,
        body: JSON.stringify({ to: "muse", subject: "Plan", text: "See file.", attachments: [made.file.id] }),
      })
    ).json()) as { message: { id: string } };

    // The same IDs mean nothing in the other workspace.
    expect((await call(zeta.host, `/api/agent/tasks/${sent.message.id}`, { token: zeta.muse.token })).status).toBe(404);
    expect((await call(zeta.host, `/api/agent/files/${made.file.id}`, { token: zeta.muse.token })).status).toBe(404);

    // A download address Portico signed for acme fails at zeta's address: each workspace signs with its own key.
    const task = (await (await call(acme.host, `/api/agent/tasks/${sent.message.id}`, { token: acme.muse.token })).json()) as {
      messages: { attachments: { download_url: string }[] }[];
    };
    const link = new URL(task.messages[0]!.attachments[0]!.download_url);
    expect(link.host).toBe(acme.host);
    expect(await (await call(acme.host, link.pathname + link.search)).text()).toBe("acme only");
    expect((await call(zeta.host, link.pathname + link.search)).status).toBe(404);

    // And the bytes sit in the workspace's own folder.
    expect(existsSync(join(hosted.config.dataDir, "w", acme.ws.id, "files", made.file.id))).toBe(true);
    expect(existsSync(join(hosted.config.dataDir, "w", zeta.ws.id, "files", made.file.id))).toBe(false);
  });
});

describe("opening and closing", () => {
  test("an unused workspace closes, and opens again with everything in place", async () => {
    const { hosted, clock, call } = start();
    const acme = await workspace(hosted, "acme");
    hosted.sweepMinute();
    expect(hosted.isOpen(acme.ws.id)).toBe(true);
    clock.advance(11 * MINUTE);
    hosted.sweepMinute();
    expect(hosted.isOpen(acme.ws.id)).toBe(false);
    expect((await call(acme.host, "/api/agent/agents", { token: acme.grok.token })).status).toBe(200);
    expect(hosted.isOpen(acme.ws.id)).toBe(true);
  });

  test("a live stream keeps a workspace open", async () => {
    const { hosted, clock } = start();
    const acme = await workspace(hosted, "acme");
    const done = acme.p.agentStreams.connect(acme.grok.agent.id, "run-1", fakeConnection().conn);
    clock.advance(HOUR);
    hosted.sweepMinute();
    expect(hosted.isOpen(acme.ws.id)).toBe(true);
    done();
    hosted.sweepMinute();
    expect(hosted.isOpen(acme.ws.id)).toBe(false);
  });

  test("a closed workspace's messages still expire", async () => {
    const { hosted, clock, call } = start();
    const acme = await workspace(hosted, "acme");
    const sent = (await (
      await call(acme.host, "/api/agent/messages", { method: "POST", token: acme.grok.token, body: JSON.stringify({ to: "muse", subject: "Hi", text: "Hi" }) })
    ).json()) as { message: { id: string } };
    clock.advance(11 * MINUTE);
    hosted.sweepMinute();
    expect(hosted.isOpen(acme.ws.id)).toBe(false);

    clock.advance(73 * HOUR);
    await hosted.sweepAll();
    expect(hosted.isOpen(acme.ws.id)).toBe(false);
    expect(hosted.portico(acme.ws).messages.get(sent.message.id)!.status).toBe("expired");
  });

  test("removing a workspace takes its record and its folder", async () => {
    const { hosted, call } = start();
    const acme = await workspace(hosted, "acme");
    hosted.remove(acme.ws);
    expect(existsSync(join(hosted.config.dataDir, "w", acme.ws.id))).toBe(false);
    expect((await call(acme.host, "/")).status).toBe(404);
  });
});

describe("portico workspace", () => {
  test("import brings a single Portico over: its people sign in and its agents' tokens work at the new address", async () => {
    // A single Portico on disk, with an owner, two agents and a message between them.
    const folder = mkdtempSync(join(tmpdir(), "portico-single-"));
    dirs.push(folder);
    const single = createPortico(testConfig({ dbPath: join(folder, "portico.db"), dataDir: folder, signingKey: ensureSigningKey(folder) }), {
      db: openDb(join(folder, "portico.db")),
    });
    single.settings.set("setup_done_at", new Date().toISOString());
    const owner = await addOwner(single, "Chris");
    const grok = addAppAgent(single, owner, "grok", { kind: "grok-bot" });
    const muse = addAppAgent(single, owner, "muse");
    const sent = await single.app.request("/api/agent/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${grok.token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "muse", subject: "Before the move", text: "hello" }),
    });
    expect(sent.status).toBe(201);
    // Left open on purpose: the copy has to be whole while the source still runs.
    const key = readFileSync(join(folder, "signing.key"), "utf8");

    const config = hostedConfig();
    const env = { PORTICO_HOSTED_DOMAIN: config.domain, PORTICO_HOSTED_DATA: config.dataDir };
    const out: string[] = [];
    const io = { env, cwd: config.dataDir, out: (line: string) => out.push(line), err: (line: string) => out.push(`ERR ${line}`) };
    expect(await workspaceCommand(["import", "moved", folder], io)).toBe(0);
    expect(out[0]).toBe("Made https://moved.portico.test with 1 person and 2 agents.");
    single.db.close();
    // The source is only read.
    expect(readFileSync(join(folder, "signing.key"), "utf8")).toBe(key);
    expect(existsSync(join(folder, "portico.db"))).toBe(true);

    const { hosted, call } = start(config);
    const ws = hosted.control.bySlug("moved")!;
    expect(ws.createdBy).toBeNull();
    expect(readFileSync(join(config.dataDir, "w", ws.id, "signing.key"), "utf8")).toBe(key);
    // The agents' tokens work, and the message came along.
    const inbox = await call("moved.portico.test", "/api/agent/inbox", { token: muse.token });
    expect(inbox.status).toBe(200);
    expect(JSON.stringify(await inbox.json())).toContain("Before the move");
    // The owner signs in with the old password, and links name the new address.
    const signedIn = await call("moved.portico.test", "/api/session", {
      method: "POST",
      headers: { origin: "https://moved.portico.test" },
      body: JSON.stringify({ name: "Chris", password: PASSWORD }),
    });
    expect(signedIn.status).toBe(200);
    expect(hosted.portico(ws).settings.publicUrl()).toBe("https://moved.portico.test");

    // What can't be brought over says why, and leaves nothing behind.
    expect(await workspaceCommand(["import", "moved", folder], io)).toBe(1);
    expect(out.at(-1)).toContain("taken");
    const empty = mkdtempSync(join(tmpdir(), "portico-single-"));
    dirs.push(empty);
    expect(await workspaceCommand(["import", "other", empty], io)).toBe(1);
    expect(out.at(-1)).toContain("portico.db and signing.key");
    writeFileSync(join(empty, "portico.db"), "not a database");
    writeFileSync(join(empty, "signing.key"), key);
    expect(await workspaceCommand(["import", "other", empty], io)).toBe(1);
    expect(await workspaceCommand(["import", "other"], io)).toBe(1);
    expect(hosted.control.bySlug("other")).toBeNull();
  });

  test("create prints the workspace's setup link, and list shows the workspaces", async () => {
    const config = hostedConfig();
    const env = { PORTICO_HOSTED_DOMAIN: config.domain, PORTICO_HOSTED_DATA: config.dataDir };
    const out: string[] = [];
    const io = { env, cwd: config.dataDir, out: (line: string) => out.push(line), err: (line: string) => out.push(`ERR ${line}`) };
    expect(await workspaceCommand(["create", "acme"], io)).toBe(0);
    expect(out[1]).toMatch(/^ {2}https:\/\/acme\.portico\.test\/setup#\S+$/);
    expect(await workspaceCommand(["create", "acme"], io)).toBe(1);
    expect(out.at(-1)).toContain("taken");
    expect(await workspaceCommand(["list"], io)).toBe(0);
    expect(out.at(-1)).toStartWith("https://acme.portico.test");
    expect(await workspaceCommand(["create"], io)).toBe(1);
    expect(await workspaceCommand(["list"], { ...io, env: {} })).toBe(1);

    // The link opens the workspace's own setup page.
    const { hosted, call } = start(config);
    expect((await call("acme.portico.test", "/setup")).status).toBe(200);
    expect(hosted.control.all()).toHaveLength(1);
  });
});
