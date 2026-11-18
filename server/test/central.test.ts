import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceCommand } from "../src/commands/workspace";
import { type HostedConfig, hostedEnv } from "../src/config";
import { PorticoError } from "../src/core/errors";
import { Descope } from "../src/hosted/descope";
import { Hosted } from "../src/hosted/router";
import { addAppAgent, addMember, addOwner, copyProblems, HOUR, MINUTE, PASSWORD, testClock, visibleCopy } from "./helpers";

const dirs: string[] = [];
const running: Hosted[] = [];

afterEach(() => {
  for (const hosted of running.splice(0)) hosted.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BASE = "portico.test";
const PROJECT = "P3testproject0000000000000000";

function hostedConfig(): HostedConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "portico-central-"));
  dirs.push(dataDir);
  return {
    domain: BASE,
    baseUrl: `https://${BASE}`,
    dataDir,
    port: 8790,
    pluginSource: null,
    webhooksAllowPrivate: false,
    files: null,
    mail: null,
    descopeProjectId: PROJECT,
  };
}

/** One browser: keeps each host's cookies apart, as a real one does, and never follows a redirect by itself. */
function browser(hosted: Hosted) {
  const jars = new Map<string, Map<string, string>>();
  const call = async (url: string, init: { method?: string; body?: unknown; origin?: string } = {}) => {
    const { host } = new URL(url);
    const jar = jars.get(host) ?? new Map<string, string>();
    jars.set(host, jar);
    const headers = new Headers();
    if (jar.size > 0) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (init.origin) headers.set("origin", init.origin);
    const res = await hosted.fetch(
      new Request(url, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
    );
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const [name, ...value] = pair!.split("=");
      const gone = attrs.some((a) => /^\s*max-age=0$/i.test(a)) || value.join("=") === "";
      if (gone) jar.delete(name!.trim());
      else jar.set(name!.trim(), value.join("="));
    }
    return res;
  };
  /** Follows redirects across hosts until a page or an answer comes back. */
  const go = async (url: string) => {
    let res = await call(url);
    let at = url;
    for (let hops = 0; hops < 8 && res.status === 303; hops++) {
      at = new URL(res.headers.get("location")!, at).toString();
      res = await call(at);
    }
    return { res, at };
  };
  const signIn = async (account: string) => {
    const res = await call(`https://${BASE}/api/session`, { method: "POST", body: { token: `acct:${account}` } });
    expect(res.status).toBe(200);
  };
  return { call, go, signIn, cookies: (host: string) => jars.get(host) ?? new Map<string, string>() };
}

function start() {
  const clock = testClock();
  const hosted = new Hosted(hostedConfig(), {
    now: clock.now,
    idleMs: 10 * MINUTE,
    accountCheck: {
      accountFor: async (token) => {
        if (typeof token !== "string" || !token.startsWith("acct:")) throw new PorticoError("unauthorized", "The sign-in didn't check out. Sign in again.");
        return token.slice(5);
      },
    },
  });
  running.push(hosted);
  return { hosted, clock };
}

/** A signed-in account with a workspace of its own. */
async function withWorkspace(hosted: Hosted, account: string, slug: string, name = "Chris") {
  const b = browser(hosted);
  await b.signIn(account);
  const res = await b.call(`https://${BASE}/api/workspaces`, { method: "POST", body: { slug, name } });
  expect(res.status).toBe(201);
  return { b, ws: hosted.control.bySlug(slug)!, next: ((await res.json()) as { next: string }).next };
}

describe("checking a Descope token", () => {
  const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

  async function keyPair(kid: string) {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, use: "sig", alg: "RS256" };
    const token = async (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid, typ: "JWT" }) => {
      const signed = `${b64(header)}.${b64(claims)}`;
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, Buffer.from(signed));
      return `${signed}.${Buffer.from(signature).toString("base64url")}`;
    };
    return { jwk, token };
  }

  const refused = async (run: Promise<unknown>) => {
    try {
      await run;
    } catch (err) {
      return err instanceof PorticoError ? err.code : "other";
    }
    return null;
  };

  test("a session token signed by the project's key names the account; anything else is refused", async () => {
    const clock = testClock();
    const key = await keyPair("k1");
    const other = await keyPair("k1");
    const descope = new Descope(PROJECT, { now: clock.now, fetchKeys: async () => [key.jwk] });
    const exp = clock.now().getTime() / 1000 + 600;
    const good = { iss: `https://api.descope.com/${PROJECT}`, sub: "U2abc", exp, drn: "DS" };

    expect(await descope.accountFor(await key.token(good))).toBe("U2abc");
    // Older tokens name the project alone.
    expect(await descope.accountFor(await key.token({ ...good, iss: PROJECT }))).toBe("U2abc");

    expect(await refused(descope.accountFor(await other.token(good)))).toBe("unauthorized");
    expect(await refused(descope.accountFor(await key.token({ ...good, iss: "https://api.descope.com/P3other" })))).toBe("unauthorized");
    expect(await refused(descope.accountFor(await key.token({ ...good, exp: exp - 601 })))).toBe("unauthorized");
    expect(await refused(descope.accountFor(await key.token({ ...good, drn: "DSR" })))).toBe("unauthorized");
    expect(await refused(descope.accountFor(await key.token({ ...good, sub: "" })))).toBe("unauthorized");
    expect(await refused(descope.accountFor(await key.token(good, { alg: "none", kid: "k1" })))).toBe("unauthorized");
    expect(await refused(descope.accountFor(await key.token(good, { alg: "HS256", kid: "k1" })))).toBe("unauthorized");
    const [head, body] = (await key.token(good)).split(".");
    expect(await refused(descope.accountFor(`${head}.${body}.`))).toBe("unauthorized");
    expect(await refused(descope.accountFor(`${head}.${b64({ ...good, sub: "U2other" })}.${(await key.token(good)).split(".")[2]}`))).toBe("unauthorized");
    for (const junk of [undefined, 7, "", "a.b", "a.b.c", "x".repeat(9000)]) {
      expect(await refused(descope.accountFor(junk))).toBe("unauthorized");
    }
  });

  test("the email address counts only when the token says the address was verified", async () => {
    const clock = testClock();
    const key = await keyPair("k1");
    const descope = new Descope(PROJECT, { now: clock.now, fetchKeys: async () => [key.jwk] });
    const base = { iss: `https://api.descope.com/${PROJECT}`, sub: "U2abc", exp: clock.now().getTime() / 1000 + 600, drn: "DS" };
    expect(await descope.account(await key.token(base))).toEqual({ id: "U2abc", email: null, name: null });
    expect(await descope.account(await key.token({ ...base, email: "ada@example.com", name: "Ada" }))).toEqual({ id: "U2abc", email: null, name: "Ada" });
    expect(await descope.account(await key.token({ ...base, email: "ada@example.com", email_verified: false }))).toMatchObject({ email: null });
    expect(await descope.account(await key.token({ ...base, email: "ada@example.com", email_verified: true }))).toMatchObject({ email: "ada@example.com" });
    expect(await descope.account(await key.token({ ...base, email: "ada@example.com", verifiedEmail: "true" }))).toMatchObject({ email: "ada@example.com" });
    expect(await descope.account(await key.token({ ...base, email: 7, email_verified: true }))).toMatchObject({ email: null });
  });

  test("a new key is picked up, and unknown keys don't make Portico fetch more than once a minute", async () => {
    const clock = testClock();
    const first = await keyPair("k1");
    const second = await keyPair("k2");
    let keys = [first.jwk];
    let fetches = 0;
    const descope = new Descope(PROJECT, {
      now: clock.now,
      fetchKeys: async () => {
        fetches++;
        return keys;
      },
    });
    const claims = () => ({ iss: PROJECT, sub: "U2abc", exp: clock.now().getTime() / 1000 + 600, drn: "DS" });
    expect(await descope.accountFor(await first.token(claims()))).toBe("U2abc");
    expect(fetches).toBe(1);

    keys = [first.jwk, second.jwk];
    expect(await refused(descope.accountFor(await second.token(claims())))).toBe("unauthorized");
    expect(await refused(descope.accountFor(await second.token(claims())))).toBe("unauthorized");
    expect(fetches).toBe(1);
    clock.advance(MINUTE);
    expect(await descope.accountFor(await second.token(claims()))).toBe("U2abc");
    expect(fetches).toBe(2);

    // A key Descope withdrew stops working within the hour, and a fetch that fails counts against the limit too.
    keys = [second.jwk];
    clock.advance(61 * MINUTE);
    expect(await refused(descope.accountFor(await first.token(claims())))).toBe("unauthorized");
    expect(fetches).toBe(3);
    const down = new Descope(PROJECT, {
      now: clock.now,
      fetchKeys: async () => {
        fetches++;
        throw new Error("down");
      },
    });
    expect(await refused(down.accountFor(await first.token(claims())))).toBe("other");
    expect(await refused(down.accountFor(await first.token(claims())))).toBe("unauthorized");
    expect(fetches).toBe(4);
  });
});

describe("signing in on the base domain", () => {
  test("a checked token sets the base domain's cookie; a bad one and another site's request are refused", async () => {
    const { hosted } = start();
    const b = browser(hosted);
    expect((await b.call(`https://${BASE}/api/session`, { method: "POST", body: { token: "nope" } })).status).toBe(401);
    expect(
      (await b.call(`https://${BASE}/api/session`, { method: "POST", body: { token: "acct:u1" }, origin: "https://evil.example" })).status,
    ).toBe(403);
    expect(b.cookies(BASE).size).toBe(0);

    const signedOut = await b.call(`https://${BASE}/`);
    expect(signedOut.headers.get("location")).toBe("/sign-in");
    const page = await b.call(`https://${BASE}/sign-in`);
    const text = await page.text();
    expect(text).toContain(`<descope-wc project-id="${PROJECT}"`);
    expect(page.headers.get("content-security-policy")).toContain("https://descopecdn.com");

    await b.signIn("u1");
    expect([...b.cookies(BASE).keys()]).toEqual(["portico_base"]);
    expect((await b.call(`https://${BASE}/sign-in?next=%2Fgo%2Facme`)).headers.get("location")).toBe("/go/acme");
    expect(await (await b.call(`https://${BASE}/`)).text()).toContain("Create a workspace");

    expect((await b.call(`https://${BASE}/api/session`, { method: "DELETE" })).status).toBe(204);
    expect(await (await b.call(`https://${BASE}/`)).text()).not.toContain("Create a workspace");
  });

  test("the base domain's sign-in ends after 30 days", async () => {
    const { hosted, clock } = start();
    const b = browser(hosted);
    await b.signIn("u1");
    clock.advance(31 * 24 * 60 * MINUTE);
    expect(await (await b.call(`https://${BASE}/`)).text()).not.toContain("Create a workspace");
    expect(hosted.control.sweep()).toBe(1);
  });

  test("only a page's own copy rules apply: no pronouns on the base domain's pages", async () => {
    const { hosted } = start();
    const { b } = await withWorkspace(hosted, "u1", "acme");
    const signedOut = browser(hosted);
    for (const res of [
      await signedOut.call(`https://${BASE}/sign-in`),
      await b.call(`https://${BASE}/`),
      await signedOut.call(`https://acme.${BASE}/sign-in?out`),
      await signedOut.call(`https://acme.${BASE}/invite`),
      await signedOut.call(`https://acme.${BASE}/hand-off?pass=x`),
    ]) {
      expect(copyProblems(visibleCopy(await res.text()))).toEqual([]);
    }
  });
});

describe("making a workspace", () => {
  test("a signed-in account makes a workspace and is its owner, with no setup link and no password", async () => {
    const { hosted } = start();
    const { b, ws, next } = await withWorkspace(hosted, "u1", "acme", "Chris");
    expect(next).toBe(`https://acme.${BASE}/sign-in/start`);
    const p = hosted.portico(ws);
    expect(p.settings.setupDone()).toBe(true);
    expect(p.people.owner()).toMatchObject({ name: "Chris", role: "owner", status: "active" });
    expect(p.people.byExternalId("u1")?.id).toBe(p.people.owner()!.id);

    // Straight from the form's answer into the workspace, signed in.
    const { res, at } = await b.go(next);
    expect(at).toBe(`https://acme.${BASE}/`);
    expect(res.status).toBe(200);
    const me = (await (await b.call(`https://acme.${BASE}/api/me`)).json()) as { person: { name: string } };
    expect(me.person.name).toBe("Chris");

    const list = await (await b.call(`https://${BASE}/`)).text();
    expect(list).toContain(`acme.${BASE}`);
    expect(list).toContain("Owner, as Chris");
  });

  test("signed out, a bad name, a taken address and a fourth workspace are all refused, and leave nothing behind", async () => {
    const { hosted } = start();
    const out = browser(hosted);
    expect((await out.call(`https://${BASE}/api/workspaces`, { method: "POST", body: { slug: "acme", name: "Chris" } })).status).toBe(401);

    const { b } = await withWorkspace(hosted, "u1", "acme");
    const make = (slug: string, name = "Chris") => b.call(`https://${BASE}/api/workspaces`, { method: "POST", body: { slug, name } });
    expect((await make("acme")).status).toBe(409);
    expect((await make("zeta", "")).status).toBe(400);
    expect((await make("www")).status).toBe(409);
    expect(hosted.control.all().map((w) => w.slug)).toEqual(["acme"]);

    expect((await make("beta")).status).toBe(201);
    expect((await make("gamma")).status).toBe(201);
    const fourth = await make("delta");
    expect(fourth.status).toBe(429);
    expect(hosted.control.bySlug("delta")).toBeNull();
    expect(await (await b.call(`https://${BASE}/`)).text()).toContain("One account can make 3 workspaces");

    // Another account has a count of its own.
    const other = browser(hosted);
    await other.signIn("u2");
    expect((await other.call(`https://${BASE}/api/workspaces`, { method: "POST", body: { slug: "delta", name: "Maya" } })).status).toBe(201);
  });
});

describe("the pass from the base domain to a workspace", () => {
  /** Runs a sign-in up to the pass: the workspace's start, then the base domain's answer. */
  async function untilPass(b: ReturnType<typeof browser>, slug: string, next = "") {
    const started = await b.call(`https://${slug}.${BASE}/sign-in/start${next}`);
    expect(started.status).toBe(303);
    const toBase = started.headers.get("location")!;
    expect(toBase).toStartWith(`https://${BASE}/go/${slug}?state=`);
    const answered = await b.call(toBase);
    expect(answered.status).toBe(303);
    return answered.headers.get("location")!;
  }

  test("a signed-out visit goes through the base domain's sign-in and comes back to the page first asked for", async () => {
    const { hosted } = start();
    await withWorkspace(hosted, "u1", "acme");
    const b = browser(hosted);
    // A visit goes straight on; only a browser that just signed out sees the page with the button.
    expect((await b.call(`https://acme.${BASE}/sign-in?next=%2Fsettings`)).headers.get("location")).toBe("/sign-in/start?next=%2Fsettings");
    const page = await b.call(`https://acme.${BASE}/sign-in?out&next=%2Fsettings`);
    expect(await page.text()).toContain('href="/sign-in/start?next=%2Fsettings"');

    const started = await b.call(`https://acme.${BASE}/sign-in/start?next=%2Fsettings`);
    const asked = await b.call(started.headers.get("location")!);
    // Not signed in on the base domain yet: the sign-in page, which returns to the same hand-off.
    expect(asked.status).toBe(303);
    const signInPage = asked.headers.get("location")!;
    expect(signInPage).toStartWith("/sign-in?next=%2Fgo%2Facme");
    const next = new URL(signInPage, `https://${BASE}`).searchParams.get("next")!;
    const answer = await b.call(`https://${BASE}/api/session`, { method: "POST", body: { token: "acct:u1", next } });
    const { res, at } = await b.go(`https://${BASE}${((await answer.json()) as { next: string }).next}`);
    expect(at).toBe(`https://acme.${BASE}/settings`);
    expect(res.status).toBe(200);
  });

  test("a pass works once", async () => {
    const { hosted } = start();
    const { b } = await withWorkspace(hosted, "u1", "acme");
    const handOff = await untilPass(b, "acme");
    const stateCookie = b.cookies(`acme.${BASE}`).get("portico_handoff")!;
    expect((await b.call(handOff)).status).toBe(303);
    expect(b.cookies(`acme.${BASE}`).has("portico_session")).toBe(true);

    // The same address again, even with the same state, is a used pass.
    const again = browser(hosted);
    again.cookies(`acme.${BASE}`);
    const replay = await hosted.fetch(new Request(handOff, { headers: { cookie: `portico_handoff=${stateCookie}` } }));
    expect(replay.status).toBe(400);
    expect(replay.headers.getSetCookie().some((line) => line.startsWith("portico_session="))).toBe(false);
  });

  test("a pass is for one workspace: at another's address the pass is refused, and used up", async () => {
    const { hosted } = start();
    const { b } = await withWorkspace(hosted, "u1", "acme");
    await b.call(`https://${BASE}/api/workspaces`, { method: "POST", body: { slug: "zeta", name: "Chris" } });
    const handOff = await untilPass(b, "acme");
    const state = b.cookies(`acme.${BASE}`).get("portico_handoff")!;
    const atZeta = handOff.replace(`acme.${BASE}`, `zeta.${BASE}`);
    const wrong = await hosted.fetch(new Request(atZeta, { headers: { cookie: `portico_handoff=${state}` } }));
    expect(wrong.status).toBe(400);
    expect((await b.call(handOff)).status).toBe(400);
  });

  test("a pass is for the browser that asked: another browser can't be signed in with the address", async () => {
    const { hosted } = start();
    const { b: attacker } = await withWorkspace(hosted, "u1", "acme");
    const handOff = await untilPass(attacker, "acme");

    // The victim opens the attacker's address: no state of the victim's own, or a different one.
    const victim = browser(hosted);
    const bare = await victim.call(handOff);
    expect(bare.status).toBe(400);
    expect(bare.headers.get("referrer-policy")).toBe("no-referrer");
    expect(victim.cookies(`acme.${BASE}`).has("portico_session")).toBe(false);
    // Opening the address used the pass up, so the attacker's own browser can't finish with the pass either.
    expect((await attacker.call(handOff)).status).toBe(400);

    const second = await untilPass(attacker, "acme");
    const midway = browser(hosted);
    await midway.call(`https://acme.${BASE}/sign-in/start`);
    expect((await midway.call(second)).status).toBe(400);
    expect(midway.cookies(`acme.${BASE}`).has("portico_session")).toBe(false);
  });

  test("a pass lasts one minute", async () => {
    const { hosted, clock } = start();
    const { b } = await withWorkspace(hosted, "u1", "acme");
    const handOff = await untilPass(b, "acme");
    clock.advance(MINUTE);
    expect((await b.call(handOff)).status).toBe(400);
  });

  test("the base domain gives no pass without a state from the workspace, and none for a workspace that isn't there", async () => {
    const { hosted } = start();
    const { b } = await withWorkspace(hosted, "u1", "acme");
    const bare = await b.call(`https://${BASE}/go/acme`);
    expect(bare.headers.get("location")).toBe(`https://acme.${BASE}/sign-in/start`);
    expect((await b.call(`https://${BASE}/go/nowhere?state=${"a".repeat(22)}`)).status).toBe(404);
  });

  test("an account with no person in the workspace gets no session there", async () => {
    const { hosted } = start();
    await withWorkspace(hosted, "u1", "acme");
    const stranger = browser(hosted);
    await stranger.signIn("u2");
    const { res } = await stranger.go(`https://acme.${BASE}/sign-in/start`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("No account in this workspace");
    expect(stranger.cookies(`acme.${BASE}`).has("portico_session")).toBe(false);
    expect((await stranger.call(`https://acme.${BASE}/api/me`)).status).toBe(401);
  });

  test("one address's cookies mean nothing at another", async () => {
    const { hosted } = start();
    const { b } = await withWorkspace(hosted, "u1", "acme");
    await b.call(`https://${BASE}/api/workspaces`, { method: "POST", body: { slug: "zeta", name: "Chris" } });
    await b.go(`https://acme.${BASE}/sign-in/start`);
    const session = b.cookies(`acme.${BASE}`).get("portico_session")!;
    const base = b.cookies(BASE).get("portico_base")!;
    const send = (url: string, cookie: string) => hosted.fetch(new Request(url, { headers: { cookie } }));

    expect((await send(`https://acme.${BASE}/api/me`, `portico_session=${session}`)).status).toBe(200);
    expect((await send(`https://zeta.${BASE}/api/me`, `portico_session=${session}`)).status).toBe(401);
    // The base domain's cookie, sent to a workspace under either name, signs nobody in.
    expect((await send(`https://acme.${BASE}/api/me`, `portico_base=${base}; portico_session=${base}`)).status).toBe(401);
    // And a workspace's session, sent to the base domain, is no account.
    expect(await (await send(`https://${BASE}/`, `portico_base=${session}`)).text()).not.toContain("Create a workspace");
  });
});

describe("a hosted workspace takes no passwords", () => {
  test("the password, passkey and setup routes are gone; signing out stays", async () => {
    const { hosted } = start();
    const { b, next } = await withWorkspace(hosted, "u1", "acme");
    await b.go(next);
    const at = `https://acme.${BASE}`;
    const post = (path: string, body: unknown = {}) => b.call(`${at}${path}`, { method: "POST", body });
    expect((await post("/api/session", { name: "Chris", password: "!" })).status).toBe(404);
    expect((await post("/api/session", { name: "Chris", password: "" })).status).toBe(404);
    expect((await post("/api/session/passkey/options")).status).toBe(404);
    expect((await post("/api/session/passkey")).status).toBe(404);
    expect((await post("/api/passkeys/options")).status).toBe(404);
    expect((await b.call(`${at}/api/passkeys`)).status).toBe(404);
    expect((await post("/api/me/password", { current: "!", next: "a-long-new-password" })).status).toBe(404);
    expect((await post("/api/setup", { token: "x" })).status).toBe(404);
    expect((await b.call(`${at}/setup`)).status).toBe(404);

    const settings = await (await b.call(`${at}/settings`)).text();
    expect(settings).not.toContain("Change password");
    expect(settings).not.toContain("Passkeys");

    expect((await b.call(`${at}/api/session`, { method: "DELETE" })).status).toBe(204);
    expect((await b.call(`${at}/api/me`)).status).toBe(401);
  });

  test("a workspace made from the command line keeps the setup link and passwords", async () => {
    const config = hostedConfig();
    const env = { PORTICO_HOSTED_DOMAIN: config.domain, PORTICO_HOSTED_DATA: config.dataDir, PORTICO_DESCOPE_PROJECT_ID: PROJECT };
    expect(hostedEnv(env)!.descopeProjectId).toBe(PROJECT);
    expect(() => hostedEnv({ ...env, PORTICO_DESCOPE_PROJECT_ID: "not a project" })).toThrow();
    const out: string[] = [];
    const io = { env, cwd: config.dataDir, out: (line: string) => out.push(line), err: (line: string) => out.push(`ERR ${line}`) };
    expect(await workspaceCommand(["create", "acme"], io)).toBe(0);

    const hosted = new Hosted(config, { accountCheck: { accountFor: async () => "u1" } });
    running.push(hosted);
    const b = browser(hosted);
    expect((await b.call(`https://acme.${BASE}/setup`)).status).toBe(200);
    // Not set up yet, and no base-domain sign-in page either: the setup link is the way in.
    expect((await b.call(`https://acme.${BASE}/sign-in/start`)).status).toBe(503);
    expect(hosted.portico(hosted.control.bySlug("acme")!).central).toBeNull();
  });
});

describe("moving a workspace's people from passwords to the base domain's sign-in", () => {
  /** A workspace as import leaves it: made without an account, set up, with an owner and a member who have passwords. */
  async function passwordWorkspace(hosted: Hosted) {
    const ws = hosted.create("super");
    const p = hosted.portico(ws);
    p.settings.set("setup_done_at", new Date().toISOString());
    const owner = await addOwner(p, "Chris");
    const member = await addMember(p, "Maya");
    const agent = addAppAgent(p, owner, "grok", { kind: "grok-bot" });
    return { ws, owner, member, agent };
  }
  const at = `https://super.${BASE}`;
  const password = (b: ReturnType<typeof browser>, name: string) =>
    b.call(`${at}/api/session`, { method: "POST", origin: at, body: { name, password: PASSWORD } });

  test("the owner's link turns the workspace over to the base domain's sign-in, and the owner's agents stay", async () => {
    const { hosted } = start();
    const { ws, owner, agent } = await passwordWorkspace(hosted);
    expect(hosted.portico(ws).central).toBeNull();
    const { secret } = hosted.linkFor(ws, "Chris");

    // Signed out, the link goes to sign-in first and comes back.
    const b = browser(hosted);
    const first = await b.call(`https://${BASE}/link?t=${secret}`);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(`/sign-in?next=${encodeURIComponent(`/link?t=${secret}`)}`);
    await b.signIn("u1");
    const page = await b.call(`https://${BASE}/link?t=${secret}`);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("Use this sign-in for Chris");
    expect(copyProblems(visibleCopy(text))).toEqual([]);
    // Looking uses nothing up.
    expect(hosted.portico(ws).central).toBeNull();

    const used = await b.call(`https://${BASE}/api/link`, { method: "POST", body: { secret } });
    expect(used.status).toBe(200);
    expect(((await used.json()) as { next: string }).next).toBe(`${at}/sign-in/start`);
    const after = hosted.control.bySlug("super")!;
    expect(after.createdBy).toBe("u1");
    expect(hosted.portico(after).central).not.toBeNull();
    expect(hosted.portico(after).people.byExternalId("u1")!.id).toBe(owner.id);

    // The sign-in opens the workspace as the same person, the password is off, and the agent's token still works.
    const { res, at: landed } = await b.go(`${at}/sign-in/start`);
    expect(res.status).toBe(200);
    expect(landed).toBe(`${at}/`);
    expect((await password(browser(hosted), "Chris")).status).toBe(404);
    const agents = await hosted.fetch(new Request(`${at}/api/agent/agents`, { headers: { authorization: `Bearer ${agent.token}` } }));
    expect(agents.status).toBe(200);
    // The workspace shows in the account's list.
    expect(await (await b.call(`https://${BASE}/`)).text()).toContain(`super.${BASE}`);

    // A link works once.
    const again = await b.call(`https://${BASE}/api/link`, { method: "POST", body: { secret } });
    expect(again.status).toBe(404);
    expect((await b.call(`https://${BASE}/link?t=${secret}`)).status).toBe(404);
  });

  test("a member's link keeps the member's place; an account can't be two people; an old link stops working", async () => {
    const { hosted, clock } = start();
    const { ws, member } = await passwordWorkspace(hosted);
    const owner = browser(hosted);
    await owner.signIn("u1");
    expect((await owner.call(`https://${BASE}/api/link`, { method: "POST", body: { secret: hosted.linkFor(ws, "Chris").secret } })).status).toBe(200);

    // The owner's account can't also become the member.
    const taken = await owner.call(`https://${BASE}/api/link`, {
      method: "POST",
      body: { secret: hosted.linkFor(hosted.control.bySlug("super")!, "Maya").secret },
    });
    expect(taken.status).toBe(409);

    // A newer link replaces an older one, and a link lasts a day.
    const old = hosted.linkFor(hosted.control.bySlug("super")!, "Maya").secret;
    const fresh = hosted.linkFor(hosted.control.bySlug("super")!, "Maya").secret;
    const maya = browser(hosted);
    await maya.signIn("u2");
    expect((await maya.call(`https://${BASE}/api/link`, { method: "POST", body: { secret: old } })).status).toBe(404);
    expect((await maya.call(`https://${BASE}/api/link`, { method: "POST", body: { secret: fresh } })).status).toBe(200);
    expect(hosted.portico(hosted.control.bySlug("super")!).people.byExternalId("u2")!.id).toBe(member.id);
    const { res, at: landed } = await maya.go(`${at}/sign-in/start`);
    expect(res.status).toBe(200);
    expect(landed).toBe(`${at}/`);

    const late = hosted.linkFor(hosted.control.bySlug("super")!, "Maya").secret;
    clock.advance(25 * HOUR);
    expect((await maya.call(`https://${BASE}/api/link`, { method: "POST", body: { secret: late } })).status).toBe(404);
    // Nobody signed in, or nobody by that name, gets nothing.
    expect((await browser(hosted).call(`https://${BASE}/api/link`, { method: "POST", body: { secret: late } })).status).toBe(401);
    expect(() => hosted.linkFor(hosted.control.bySlug("super")!, "Nobody")).toThrow();
  });

  test("portico workspace link prints the link", async () => {
    const config = hostedConfig();
    const env = { PORTICO_HOSTED_DOMAIN: config.domain, PORTICO_HOSTED_DATA: config.dataDir, PORTICO_DESCOPE_PROJECT_ID: PROJECT };
    const out: string[] = [];
    const io = { env, cwd: config.dataDir, out: (line: string) => out.push(line), err: (line: string) => out.push(`ERR ${line}`) };
    {
      const hosted = new Hosted(config);
      const p = hosted.portico(hosted.create("super"));
      p.settings.set("setup_done_at", new Date().toISOString());
      await addOwner(p, "Chris");
      await addMember(p, "Maya");
      hosted.stop();
    }
    expect(await workspaceCommand(["link", "super", "Chris"], io)).toBe(0);
    expect(out[1]).toMatch(new RegExp(`^ {2}https://${BASE.replaceAll(".", "\\.")}/link\\?t=[A-Za-z0-9_-]+$`));
    expect(await workspaceCommand(["link", "super", "Maya"], io)).toBe(0);
    expect(out.at(-1)).toContain("The owner's link comes first");
    expect(await workspaceCommand(["link", "super", "Nobody"], io)).toBe(1);
    expect(await workspaceCommand(["link", "nowhere", "Chris"], io)).toBe(1);
    expect(await workspaceCommand(["link", "super"], io)).toBe(1);
    expect(await workspaceCommand(["link", "super", "Chris"], { ...io, env: { ...env, PORTICO_DESCOPE_PROJECT_ID: undefined } })).toBe(1);
    expect(copyProblems(out.join("\n"))).toEqual([]);
  });
});

describe("joining a hosted workspace by invite", () => {
  test("the invited person signs in on the base domain, picks a name, and waits for the owner", async () => {
    const { hosted } = start();
    const { ws } = await withWorkspace(hosted, "u1", "acme");
    const p = hosted.portico(ws);
    const { secret } = p.people.createInvite(p.people.owner()!.id, "Maya");
    const at = `https://acme.${BASE}`;

    const maya = browser(hosted);
    const claim = (body: unknown) => maya.call(`${at}/api/invites/claim`, { method: "POST", body });
    // The link alone isn't enough: nobody has signed in.
    expect((await claim({ secret, name: "Maya" })).status).toBe(401);
    expect(await (await maya.call(`${at}/invite`)).text()).toContain('"signedIn":false');

    await maya.signIn("u2");
    const { res, at: landed } = await maya.go(`${at}/sign-in/start?next=%2Finvite`);
    expect(landed).toBe(`${at}/invite`);
    expect(await res.text()).toContain('"signedIn":true');
    expect(maya.cookies(`acme.${BASE}`).has("portico_session")).toBe(false);

    const claimed = await claim({ secret, name: "Maya" });
    expect(claimed.status).toBe(201);
    expect(((await claimed.json()) as { next: string }).next).toBe("/invite");
    expect(p.people.byExternalId("u2")).toMatchObject({ name: "Maya", status: "pending", role: "member" });
    expect(maya.cookies(`acme.${BASE}`).has("portico_account")).toBe(false);

    // Waiting: the base domain lists the workspace, and the workspace stays closed until the owner approves.
    expect(await (await maya.call(`https://${BASE}/`)).text()).toContain("Waiting for the owner&#39;s approval");
    expect((await maya.call(`${at}/api/agents`)).status).toBe(403);
    p.people.approveClaim(p.people.owner()!.id, p.people.byExternalId("u2")!.id);
    expect((await maya.call(`${at}/api/agents`)).status).toBe(200);

    // Signing in again later needs no invite.
    const later = browser(hosted);
    await later.signIn("u2");
    expect((await later.go(`${at}/sign-in/start`)).at).toBe(`${at}/`);
  });

  test("one account claims one place: a second link is refused, and so is a claim once the wait is over", async () => {
    const { hosted, clock } = start();
    const { ws } = await withWorkspace(hosted, "u1", "acme");
    const p = hosted.portico(ws);
    const owner = p.people.owner()!;
    const first = p.people.createInvite(owner.id, "Maya").secret;
    const at = `https://acme.${BASE}`;

    // The owner's own account can't take a second place with a link.
    const chris = browser(hosted);
    await chris.signIn("u1");
    await chris.go(`${at}/sign-in/start?next=%2Finvite`);
    expect((await chris.call(`${at}/api/invites/claim`, { method: "POST", body: { secret: first, name: "Second" } })).status).toBe(403);

    const maya = browser(hosted);
    await maya.signIn("u2");
    await maya.go(`${at}/sign-in/start?next=%2Finvite`);
    clock.advance(61 * MINUTE);
    expect((await maya.call(`${at}/api/invites/claim`, { method: "POST", body: { secret: first, name: "Maya" } })).status).toBe(401);
    expect(p.people.list()).toHaveLength(1);
  });

  test("a person removed from a workspace drops off the base domain's list", async () => {
    const { hosted } = start();
    const { ws } = await withWorkspace(hosted, "u1", "acme");
    const p = hosted.portico(ws);
    const owner = p.people.owner()!;
    const { secret } = p.people.createInvite(owner.id, "Maya");
    const maya = browser(hosted);
    await maya.signIn("u2");
    await maya.go(`https://acme.${BASE}/sign-in/start?next=%2Finvite`);
    await maya.call(`https://acme.${BASE}/api/invites/claim`, { method: "POST", body: { secret, name: "Maya" } });
    expect(hosted.workspacesFor("u2")).toHaveLength(1);
    p.people.declineClaim(owner.id, p.people.byExternalId("u2")!.id);
    expect(hosted.workspacesFor("u2")).toHaveLength(0);
    expect(hosted.control.memberOf("u2")).toHaveLength(0);
  });
});
