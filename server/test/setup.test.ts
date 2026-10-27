import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCommand } from "../src/commands/setup";
import { localSetupLink } from "../src/commands/serve";
import type { CliIo } from "../src/commands/io";
import { hostUrl, platformUrl } from "../src/config";
import { openDb } from "../src/db";
import { createPortico } from "../src/portico";
import { addOwner, copyProblems, HOUR, makePortico, PASSWORD, PUBLIC_URL, signIn, testConfig, visibleCopy } from "./helpers";

const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T;

async function postSetup(p: ReturnType<typeof makePortico>, body: unknown, headers: Record<string, string> = {}) {
  return await p.app.request(`${PUBLIC_URL}/api/setup`, {
    method: "POST",
    headers: { host: "portico.example.com", origin: PUBLIC_URL, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function cookieFrom(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("portico_session="));
  if (!set) throw new Error("no session cookie");
  return set.split(";")[0]!;
}

describe("POST /api/setup", () => {
  test("creates the owner, signs in and opens Home; then Portico is open and the link is spent", async () => {
    const p = makePortico({ setup: false });
    const { token } = p.accounts.createSetupLink();
    const res = await postSetup(p, { token, name: "Chris", password: PASSWORD, publicUrl: PUBLIC_URL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: "/" });
    const cookie = cookieFrom(res);
    expect(await json(p.app.request(`${PUBLIC_URL}/api/me`, { headers: { cookie } }))).toMatchObject({
      person: { name: "Chris", role: "owner", status: "active" },
      publicUrl: PUBLIC_URL,
    });
    const again = await postSetup(p, { token, name: "Someone", password: PASSWORD, publicUrl: PUBLIC_URL });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "wrong_status" });
  });

  test("errors are plain and set nothing", async () => {
    const p = makePortico({ setup: false });
    const { token } = p.accounts.createSetupLink();
    for (const [body, status] of [
      [{ token: "nope", name: "Chris", password: PASSWORD, publicUrl: PUBLIC_URL }, 404],
      [{ token, name: "Chris", password: "short", publicUrl: PUBLIC_URL }, 400],
      [{ token, name: "Chris", password: PASSWORD, publicUrl: "ftp://portico.example.com" }, 400],
      [{ token, name: "", password: PASSWORD, publicUrl: PUBLIC_URL }, 400],
    ] as const) {
      const res = await postSetup(p, body);
      expect(res.status).toBe(status);
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(copyProblems(String((await json(res)).message))).toEqual([]);
    }
    p.clock.advance(HOUR);
    const expired = await postSetup(p, { token, name: "Chris", password: PASSWORD, publicUrl: PUBLIC_URL });
    expect(expired.status).toBe(409);
    expect(String((await json(expired)).message)).toContain("expired");
    expect(p.settings.setupDone()).toBe(false);
  });

  test("a changed request from another site is refused", async () => {
    const p = makePortico({ setup: false });
    const { token } = p.accounts.createSetupLink();
    const res = await postSetup(p, { token, name: "Chris", password: PASSWORD, publicUrl: PUBLIC_URL }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  test("after setup, a reset link sets a new owner password, signs the owner out elsewhere and signs this browser in", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const old = signIn(p, chris);
    const { token } = p.accounts.createSetupLink({ reset: true });
    const res = await postSetup(p, { token, password: "a-new-owner-password" });
    expect(res.status).toBe(200);
    expect((await p.app.request(`${PUBLIC_URL}/api/me`, { headers: { cookie: old } })).status).toBe(401);
    expect((await p.app.request(`${PUBLIC_URL}/api/me`, { headers: { cookie: cookieFrom(res) } })).status).toBe(200);
    expect((await p.accounts.signIn({ name: "Chris", password: "a-new-owner-password", ip: "local" })).id).toBe(chris.id);
  });
});

describe("the setup gate", () => {
  test("before setup the API answers setup_required, pages say so, and /setup and /api/setup stay open", async () => {
    const p = makePortico({ setup: false });
    for (const path of ["/api/me", "/api/agents", "/api/session"]) {
      const res = await p.app.request(`${PUBLIC_URL}${path}`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "setup_required" });
    }
    for (const path of ["/", "/sign-in", "/settings"]) {
      const res = await p.app.request(path);
      expect(res.status).toBe(503);
      const page = await res.text();
      expect(page).toContain("Portico isn't set up yet");
      expect(copyProblems(visibleCopy(page))).toEqual([]);
    }
    expect((await p.app.request("/setup")).status).toBe(200);
  });
});

describe("/setup", () => {
  test("before setup the page matches A1, with the public URL from the request's address", async () => {
    const p = makePortico({ setup: false, config: { publicUrl: null } });
    const res = await p.app.request("https://portico.example.com/setup", { headers: { host: "portico.example.com" } });
    expect(res.status).toBe(200);
    const page = await res.text();
    for (const copy of [
      "<h1>Set up Portico</h1>",
      "Create the owner account. The owner adds agents, invites people and approves sign in requests.",
      "Shown to invited people.",
      "12 characters or more.",
      "Create owner account",
      "This setup link works once. Passkeys can be added later in Settings.",
      'data-api="POST /api/setup"',
      'name="token" data-fragment',
      'autocomplete="new-password"',
      'minlength="12"',
      'name="publicUrl"',
      'value="https://portico.example.com"',
    ]) {
      expect(page).toContain(copy);
    }
    expect(copyProblems(visibleCopy(page))).toEqual([]);
  });

  test("behind a proxy the URL comes from the forwarded host and protocol; PORTICO_PUBLIC_URL wins", async () => {
    const p = makePortico({ setup: false, config: { publicUrl: null } });
    const page = await (
      await p.app.request("http://10.0.0.5:8790/setup", {
        headers: { host: "10.0.0.5:8790", "x-forwarded-host": "portico.example.org", "x-forwarded-proto": "https" },
      })
    ).text();
    expect(page).toContain('value="https://portico.example.org"');
    const configured = makePortico({ setup: false });
    expect(await (await configured.app.request("http://10.0.0.5:8790/setup")).text()).toContain(`value="${PUBLIC_URL}"`);
  });

  test("after setup the page sets a new owner password", async () => {
    const p = makePortico();
    await addOwner(p);
    const page = await (await p.app.request("/setup")).text();
    expect(page).toContain("<h1>Reset the owner password</h1>");
    expect(page).toContain('data-api="POST /api/setup"');
    expect(page).not.toContain('name="publicUrl"');
    expect(page).not.toContain('name="name"');
    expect(copyProblems(visibleCopy(page))).toEqual([]);
  });
});

function testIo(env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env, cwd: "/", out: (line) => out.push(line), err: (line) => err.push(line) };
  return { io, out, err };
}

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "portico-setup-"));
}

describe("portico setup", () => {
  test("prints a one-time link that sets up the Portico serve uses", async () => {
    const dir = dataDir();
    const dbPath = join(dir, "portico.db");
    openDb(dbPath).close();
    const { io, out, err } = testIo({ PORTICO_DB_PATH: dbPath, PORTICO_PUBLIC_URL: PUBLIC_URL, PORT: "8802" });
    expect(await setupCommand([], io)).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toBe("Open this link in a browser to set up Portico. The link works once and expires in 1 hour.");
    const link = out.find((line) => line.includes("/setup#"))!.trim();
    expect(link).toMatch(/^https:\/\/portico\.example\.com\/setup#[A-Za-z0-9_-]{22}$/);
    expect(copyProblems(out.join("\n").replace(link, ""))).toEqual([]);

    const p = createPortico(testConfig({ dbPath }), { db: openDb(dbPath) });
    const res = await p.app.request(`${PUBLIC_URL}/api/setup`, {
      method: "POST",
      headers: { origin: PUBLIC_URL, "content-type": "application/json" },
      body: JSON.stringify({ token: link.split("#")[1], name: "Chris", password: PASSWORD, publicUrl: PUBLIC_URL }),
    });
    expect(res.status).toBe(200);
    p.db.close();

    const after = testIo({ PORTICO_DB_PATH: dbPath, PORTICO_PUBLIC_URL: PUBLIC_URL });
    expect(await setupCommand([], after.io)).toBe(1);
    expect(after.err.join("\n")).toBe("Portico is already set up. To set a new owner password, run portico setup --reset.");
    expect(after.out).toEqual([]);
  });

  test("--reset closes unused links and prints a new one; after setup it resets the owner password", async () => {
    const dir = dataDir();
    const dbPath = join(dir, "portico.db");
    openDb(dbPath).close();
    const env = { PORTICO_DB_PATH: dbPath, PORTICO_PUBLIC_URL: PUBLIC_URL };
    const first = testIo(env);
    await setupCommand([], first.io);
    const second = testIo(env);
    expect(await setupCommand(["--reset"], second.io)).toBe(0);
    const token = (lines: string[]) => lines.find((l) => l.includes("/setup#"))!.trim().split("#")[1];

    const p = createPortico(testConfig({ dbPath }), { db: openDb(dbPath) });
    const post = (body: unknown) =>
      p.app.request(`${PUBLIC_URL}/api/setup`, {
        method: "POST",
        headers: { origin: PUBLIC_URL, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ token: token(first.out), name: "Chris", password: PASSWORD, publicUrl: PUBLIC_URL })).status).toBe(404);
    expect((await post({ token: token(second.out), name: "Chris", password: PASSWORD, publicUrl: PUBLIC_URL })).status).toBe(200);

    const reset = testIo(env);
    expect(await setupCommand(["--reset"], reset.io)).toBe(0);
    expect(reset.out[0]).toBe(
      "Open this link in a browser to set a new owner password. Every browser signed in as the owner is signed out. The link works once and expires in 1 hour.",
    );
    expect((await post({ token: token(reset.out), password: "a-new-owner-password" })).status).toBe(200);
    p.db.close();
  });

  test("refuses without a database, and with an unknown option", async () => {
    const dir = dataDir();
    const dbPath = join(dir, "portico.db");
    const missing = testIo({ PORTICO_DB_PATH: dbPath });
    expect(await setupCommand([], missing.io)).toBe(1);
    expect(missing.err.join("\n")).toBe(
      `No Portico database at ${dbPath}. Start Portico with portico serve first, or set PORTICO_DB_PATH to the database Portico uses.`,
    );
    expect(existsSync(dbPath)).toBe(false);
    const unknown = testIo({ PORTICO_DB_PATH: dbPath });
    expect(await setupCommand(["--force"], unknown.io)).toBe(1);
    expect(unknown.err.join("\n")).toBe("Unknown option: --force. Usage: portico setup [--reset]");
    expect(copyProblems([...missing.err, ...unknown.err].join("\n"))).toEqual([]);
  });

  test("without a configured URL, the link uses the saved URL, then the platform's, then localhost with a note", async () => {
    const dir = dataDir();
    const dbPath = join(dir, "portico.db");
    openDb(dbPath).close();
    const local = testIo({ PORTICO_DB_PATH: dbPath, PORT: "8802" });
    expect(await setupCommand([], local.io)).toBe(0);
    expect(local.out.find((l) => l.includes("/setup#"))).toMatch(/^ {2}http:\/\/localhost:8802\/setup#/);
    expect(local.out.at(-1)).toBe("If a browser reaches Portico at another address, use that address in place of http://localhost:8802.");
    expect(copyProblems(local.out.filter((l) => !l.includes("/setup#")).join("\n"))).toEqual([]);

    const render = testIo({ PORTICO_DB_PATH: dbPath, RENDER_EXTERNAL_URL: "https://portico-x1.onrender.com" });
    await setupCommand([], render.io);
    expect(render.out.find((l) => l.includes("/setup#"))).toContain("https://portico-x1.onrender.com/setup#");
    expect(render.out.join("\n")).not.toContain("in place of");
  });

  test("hostUrl and platformUrl", () => {
    const config = testConfig({ publicUrl: null, port: 8802 });
    expect(platformUrl({})).toBeNull();
    expect(platformUrl({ RENDER_EXTERNAL_URL: "https://a.onrender.com/" })).toBe("https://a.onrender.com");
    expect(platformUrl({ FLY_APP_NAME: "portico-chris" })).toBe("https://portico-chris.fly.dev");
    expect(platformUrl({ FLY_APP_NAME: "bad name!" })).toBeNull();
    expect(hostUrl(config, {}, null)).toBe("http://localhost:8802");
    expect(hostUrl(config, { FLY_APP_NAME: "portico-chris" }, null)).toBe("https://portico-chris.fly.dev");
    expect(hostUrl(config, { FLY_APP_NAME: "portico-chris" }, "https://portico.example.org")).toBe("https://portico.example.org");
    expect(hostUrl(testConfig(), { FLY_APP_NAME: "portico-chris" }, "https://portico.example.org")).toBe(PUBLIC_URL);
  });
});

describe("portico serve", () => {
  test("running locally before setup, the first start makes a setup link", async () => {
    const p = makePortico({ setup: false, config: { publicUrl: null, port: 8802 } });
    const link = localSetupLink(p, {});
    expect(link).toMatch(/^http:\/\/localhost:8802\/setup#[A-Za-z0-9_-]{22}$/);
    const res = await p.app.request("http://localhost:8802/api/setup", {
      method: "POST",
      headers: { origin: "http://localhost:8802", "content-type": "application/json" },
      body: JSON.stringify({ token: link!.split("#")[1], name: "Chris", password: PASSWORD, publicUrl: "http://localhost:8802" }),
    });
    expect(res.status).toBe(200);
    expect(localSetupLink(p, {})).toBeNull();
  });

  test("a public URL elsewhere, or a cloud platform, prints no link", () => {
    expect(localSetupLink(makePortico({ setup: false }), {})).toBeNull();
    expect(localSetupLink(makePortico({ setup: false, config: { publicUrl: null } }), { RENDER_EXTERNAL_URL: "https://a.onrender.com" })).toBeNull();
    expect(localSetupLink(makePortico({ setup: false, config: { publicUrl: "http://127.0.0.1:8802" } }), {})).toContain(
      "http://127.0.0.1:8802/setup#",
    );
  });
});
