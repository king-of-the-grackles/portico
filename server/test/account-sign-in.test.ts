import { describe, expect, test } from "bun:test";
import { addAppAgent, callPerson, fakeAccounts, makePortico, PUBLIC_URL, together } from "./helpers";

/** A Portico where people sign in with an outside account, as hosted Portico does with Descope. */
function start() {
  const p = makePortico({ accountCheck: fakeAccounts, setup: false });
  /** Signs an account in: the Cookie header to send afterwards, and where the browser goes. */
  const signIn = async (token: string, extra: Record<string, unknown> = {}) => {
    const res = await callPerson(p, null, "POST", "/api/session", { token, ...extra });
    const set = res.headers.get("set-cookie") ?? "";
    return { res, set, cookie: set.split(";")[0]!, next: res.ok ? ((await res.json()) as { next: string }).next : null };
  };
  const page = (path: string, cookie: string | null = null) => callPerson(p, cookie, "GET", path);
  return { p, signIn, page };
}

describe("signing in with an account", () => {
  test("setup counts as done: no setup link, and the first sign-in makes the first person", async () => {
    const { p, signIn, page } = start();
    expect(p.settings.setupDone()).toBe(true);
    expect(p.people.list()).toHaveLength(0);
    expect((await page("/")).headers.get("location")).toBe("/sign-in");
    const signInPage = await page("/sign-in");
    expect(signInPage.status).toBe(200);
    expect(await signInPage.text()).toContain("<descope-wc");
    await signIn("account:first::Ada");
    expect(p.people.list().map((x) => [x.name, x.role, x.status])).toEqual([["Ada", "member", "active"]]);
  });

  test("a new person picks a name and handle before anything else opens, then has a personal workspace", async () => {
    const { p, signIn, page } = start();
    const { res, set, cookie, next } = await signIn("account:acct-chris:chris@example.com:Chris");
    expect(res.status).toBe(200);
    expect(set).toContain("HttpOnly");
    // One address, so the cookie is for this host only.
    expect(set).not.toContain("Domain=");
    expect(next).toBe("/welcome");
    const chris = p.people.byExternalId("acct-chris")!;
    expect(chris).toMatchObject({ name: "Chris", email: "chris@example.com", handle: null });

    // Until the handle is picked nothing else opens.
    expect((await page("/", cookie)).headers.get("location")).toBe("/welcome");
    expect((await page("/settings", cookie)).headers.get("location")).toBe("/welcome?next=%2Fsettings");
    expect((await page("/api/agents", cookie)).status).toBe(403);
    expect((await page("/welcome", cookie)).status).toBe(200);

    const check = async (handle: string) => (await (await page(`/api/handles/check?handle=${handle}`, cookie)).json()) as { free: boolean };
    expect((await check("chris")).free).toBe(true);
    expect((await check("admin")).free).toBe(false);
    expect((await check("x")).free).toBe(false);
    expect((await callPerson(p, cookie, "POST", "/api/welcome", { name: "Chris", handle: "admin" })).status).toBe(409);
    const done = await callPerson(p, cookie, "POST", "/api/welcome", { name: "Chris I", handle: "Chris", next: "/settings" });
    expect(((await done.json()) as { next: string }).next).toBe("/settings");
    expect(p.people.get(chris.id)).toMatchObject({ handle: "chris", name: "Chris I" });
    expect(p.workspaces.forPerson(chris.id).map((w) => w.kind)).toEqual(["personal", "shared"]);
    expect((await page("/", cookie)).status).toBe(200);
    expect((await page("/welcome", cookie)).headers.get("location")).toBe("/");
  });

  test("where to go afterwards stays on this Portico: next is kept through the welcome page, and nothing outside is followed", async () => {
    const { p, signIn } = start();
    const first = await signIn("account:acct-chris::Chris", { next: "/settings" });
    expect(first.next).toBe("/welcome?next=%2Fsettings");
    await callPerson(p, first.cookie, "POST", "/api/welcome", { name: "Chris", handle: "chris" });
    expect((await signIn("account:acct-chris::Chris", { next: "/settings" })).next).toBe("/settings");
    // An address that isn't a path here, and the retired `at`, go nowhere but the first page.
    expect((await signIn("account:acct-chris::Chris", { next: "https://evil.test/settings" })).next).toBe("/");
    expect((await signIn("account:acct-chris::Chris", { next: "//evil.test" })).next).toBe("/");
    expect((await signIn("account:acct-chris::Chris", { at: "https://evil.test" })).next).toBe("/");
  });

  test("a second account is a second person who sees nothing of anyone else's, and two people can share a name", async () => {
    const { p, signIn, page } = start();
    const first = await signIn("account:acct-chris:chris@example.com:Chris");
    await callPerson(p, first.cookie, "POST", "/api/welcome", { name: "Chris", handle: "chris" });
    const chris = p.people.byExternalId("acct-chris")!;
    addAppAgent(p, chris, "grok", { kind: "grok-bot" });

    const { cookie, next } = await signIn("account:acct-maya:maya@example.com:");
    expect(next).toBe("/welcome");
    const maya = p.people.byExternalId("acct-maya")!;
    expect(maya).toMatchObject({ name: "New person", role: "member", status: "active", email: "maya@example.com", handle: null });
    // The handle tells apart two people with one name, and a taken handle is refused.
    expect((await callPerson(p, cookie, "POST", "/api/welcome", { name: "Chris", handle: "chris" })).status).toBe(409);
    await callPerson(p, cookie, "POST", "/api/welcome", { name: "Chris", handle: "maya" });
    expect(p.people.get(maya.id)).toMatchObject({ name: "Chris", handle: "maya" });
    expect(((await (await page("/api/agents", cookie)).json()) as { agents: unknown[] }).agents).toEqual([]);
    const people = async () => ((await (await page("/api/people", cookie)).json()) as { people: { handle: string }[]; invites: unknown[] }).people.map((x) => x.handle);
    expect(await people()).toEqual(["maya"]);
    // Sharing a workspace is what lets one person see another.
    together(p, addAppAgent(p, chris, "muse").agent, addAppAgent(p, p.people.get(maya.id)!, "scout").agent);
    expect((await people()).sort()).toEqual(["chris", "maya"]);
    expect(((await (await page("/api/agents", cookie)).json()) as { agents: { display: string }[] }).agents.map((a) => a.display).sort()).toEqual(["chris/muse", "scout"]);
    // Signing in again finds the same person, and takes up a changed address.
    await signIn("account:acct-maya:maya@new.example:");
    expect(p.people.list()).toHaveLength(2);
    expect(p.people.get(maya.id)!.email).toBe("maya@new.example");
    await signIn("account:acct-maya::");
    expect(p.people.get(maya.id)!.email).toBeNull();
  });

  test("a token that doesn't check out, another site's request, and the local ways in are all refused", async () => {
    const { p, signIn, page } = start();
    expect((await signIn("nope")).res.status).toBe(401);
    const cross = await p.app.request(`${PUBLIC_URL}/api/session`, {
      method: "POST",
      headers: { host: "portico.example.com", origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ token: "account:a::" }),
    });
    expect(cross.status).toBe(403);
    expect(p.people.list()).toHaveLength(0);
    expect((await callPerson(p, null, "POST", "/api/session", { name: "Chris", password: "correct-horse-battery" })).status).toBe(401);
    for (const path of ["/api/setup", "/api/passkeys", "/api/session/passkey/options", "/api/me/password", "/api/invites", "/api/invites/check", "/api/invites/claim"]) {
      expect((await callPerson(p, null, "POST", path, {})).status).toBe(404);
    }
    expect((await page("/setup")).status).toBe(404);
    expect((await page("/invite")).status).toBe(404);
  });

  test("Settings offers no password, passkeys or invites, and signing out ends the session", async () => {
    const { p, signIn, page } = start();
    const { cookie } = await signIn("account:acct-chris:chris@example.com:Chris");
    await callPerson(p, cookie, "POST", "/api/welcome", { name: "Chris", handle: "chris" });
    const html = await (await page("/settings", cookie)).text();
    const data = JSON.parse(html.match(/<script type="application\/json" id="first-data">([\s\S]*?)<\/script>/)![1]!) as Record<string, unknown>;
    expect(data).toMatchObject({ passwords: false, passkeys: null, canInvite: false });
    expect((await callPerson(p, cookie, "DELETE", "/api/session")).status).toBe(204);
    expect((await page("/api/me", cookie)).status).toBe(401);
  });
});

describe("the name on the handle page", () => {
  test("the handle page starts the name with what the sign-in gave, and empty when the sign-in gave only an address", async () => {
    const { p, signIn, page } = start();
    const field = async (cookie: string) => /id="wl-name"[^>]*value="([^"]*)"/.exec(await (await page("/welcome", cookie)).text())?.[1];
    // Google gives a name: the field starts with it.
    expect(await field((await signIn("account:acct-g:gia@example.com:Gia Rossi")).cookie)).toBe("Gia Rossi");
    // An email sign-up gives none: the name is left to the person, and nothing is taken from the address, not even a
    // handle to offer. The handle is offered from the name as the person types it.
    const byEmail = await signIn("account:acct-e:emil.k@example.com:");
    expect(p.people.byExternalId("acct-e")!.name).toBe("New person");
    expect(await field(byEmail.cookie)).toBe("");
    const welcome = await (await page("/welcome", byEmail.cookie)).text();
    expect(/id="wl-handle"[^>]*value="([^"]*)"/.exec(welcome)?.[1]).toBe("");
    const offer = async (name: string) => ((await (await callPerson(p, byEmail.cookie, "GET", `/api/handles/suggest?name=${encodeURIComponent(name)}`)).json()) as { handle: string }).handle;
    expect(await offer("Emil Koch")).toBe("emil-koch");
    expect(await offer("  ")).toBe("");
  });

  test("the name a person gives is kept in Portico only: no server source reads a management key or calls Descope's management API", async () => {
    const { p, signIn, page } = start();
    const { cookie } = await signIn("account:acct-maya:maya@example.com:");
    expect((await callPerson(p, cookie, "POST", "/api/welcome", { name: "Maya Lin", handle: "maya" })).status).toBe(200);
    const me = (await (await page("/api/me", cookie)).json()) as { person: { name: string } };
    expect(me.person.name).toBe("Maya Lin");
    const glob = new Bun.Glob("**/*.ts");
    for await (const file of glob.scan({ cwd: `${import.meta.dir}/../src`, absolute: true })) {
      const text = await Bun.file(file).text();
      expect({ file, hit: /MANAGEMENT_KEY|\/mgmt\//.test(text) }).toEqual({ file, hit: false });
    }
  });
});
