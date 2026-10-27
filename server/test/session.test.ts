import { describe, expect, test } from "bun:test";
import {
  addMember,
  addOwner,
  callPerson,
  copyProblems,
  makePortico,
  PASSWORD,
  PUBLIC_URL,
  signIn,
  visibleCopy,
} from "./helpers";

const json = async <T = Record<string, unknown>>(res: Response | Promise<Response>) => (await (await res).json()) as T;

/** The session cookie a response set, as a Cookie header value. */
function cookieFrom(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("portico_session="));
  if (!set) throw new Error("no session cookie");
  return set.split(";")[0]!;
}

async function postSession(p: ReturnType<typeof makePortico>, body: unknown, headers: Record<string, string> = {}) {
  return await p.app.request(`${PUBLIC_URL}/api/session`, {
    method: "POST",
    headers: { host: "portico.example.com", origin: PUBLIC_URL, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/session", () => {
  test("a name and password sign in with an HttpOnly, SameSite=Lax, Secure cookie", async () => {
    const p = makePortico();
    await addOwner(p);
    const res = await postSession(p, { name: "chris", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ person: { name: "Chris", role: "owner", isMe: true }, next: "/" });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("portico_session="))!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Secure");
    expect(set).toContain("Path=/");
    const me = await json(callPerson(p, cookieFrom(res), "GET", "/api/me"));
    expect(me).toMatchObject({ person: { name: "Chris" } });
  });

  test("next stays on Portico", async () => {
    const p = makePortico();
    await addOwner(p);
    expect(await json(postSession(p, { name: "Chris", password: PASSWORD, next: "/c/thread-1" }))).toMatchObject({ next: "/c/thread-1" });
    expect(await json(postSession(p, { name: "Chris", password: PASSWORD, next: "//evil.example" }))).toMatchObject({ next: "/" });
  });

  test("a claim waiting for approval signs in to the waiting page", async () => {
    const p = makePortico();
    await addOwner(p);
    await addMember(p, "Priya", "pending");
    expect(await json(postSession(p, { name: "Priya", password: PASSWORD, next: "/settings" }))).toMatchObject({
      person: { name: "Priya", status: "pending" },
      next: "/invite",
    });
  });

  test("a wrong name or password is 401 with the same message, and sets no cookie", async () => {
    const p = makePortico();
    await addOwner(p);
    const wrongPassword = await postSession(p, { name: "Chris", password: "not-the-password" });
    const wrongName = await postSession(p, { name: "Nobody", password: PASSWORD });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.headers.getSetCookie()).toEqual([]);
    const a = await json(wrongPassword);
    expect(a).toEqual(await json(wrongName));
    expect(copyProblems(String(a.message))).toEqual([]);
  });

  test("the limiter counts per address (the proxy's X-Forwarded-For entry, not one the client sent) and name", async () => {
    const p = makePortico();
    await addOwner(p);
    let n = 0;
    // The client makes up the first entry on every try; the proxy's own entry, last, is what counts.
    const from = (ip: string) => ({ "x-forwarded-for": `9.9.9.${++n}, ${ip}` });
    for (let i = 0; i < 10; i++) expect((await postSession(p, { name: "Chris", password: "wrong-password" }, from("1.2.3.4"))).status).toBe(401);
    const limited = await postSession(p, { name: "Chris", password: PASSWORD }, from("1.2.3.4"));
    expect(limited.status).toBe(429);
    const body = await json(limited);
    expect(body.error).toBe("rate_limited");
    expect(copyProblems(String(body.message))).toEqual([]);
    expect((await postSession(p, { name: "Chris", password: PASSWORD }, from("5.6.7.8"))).status).toBe(200);
    expect((await postSession(p, { name: "Chris", password: PASSWORD })).status).toBe(200);
    // Off Fly, a Fly-Client-IP header is just something the client sent.
    expect((await postSession(p, { name: "Chris", password: PASSWORD }, { "fly-client-ip": "1.2.3.4" })).status).toBe(200);
  });

  test("a name gets at most 30 failures in 15 minutes from all addresses together", async () => {
    const p = makePortico();
    await addOwner(p);
    for (let i = 0; i < 30; i++) {
      expect((await postSession(p, { name: "Chris", password: "wrong-password" }, { "x-forwarded-for": `10.0.${i}.1` })).status).toBe(401);
    }
    expect((await postSession(p, { name: "Chris", password: PASSWORD }, { "x-forwarded-for": "10.9.9.9" })).status).toBe(429);
  });

  test("parallel guesses can't slip past the limit while the password check runs", async () => {
    const p = makePortico();
    await addOwner(p);
    const answers = await Promise.all(
      Array.from({ length: 25 }, () => postSession(p, { name: "Chris", password: "wrong-password" }, { "x-forwarded-for": "6.6.6.6" })),
    );
    const statuses = answers.map((res) => res.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
  });

  test("signing in again ends the browser's earlier session", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const earlier = signIn(p, chris);
    const res = await postSession(p, { name: "Chris", password: PASSWORD }, { cookie: earlier });
    expect(res.status).toBe(200);
    expect((await callPerson(p, earlier, "GET", "/api/me")).status).toBe(401);
    expect((await callPerson(p, cookieFrom(res), "GET", "/api/me")).status).toBe(200);
  });

  test("before setup, sign in answers setup_required", async () => {
    const p = makePortico({ setup: false });
    expect((await postSession(p, { name: "Chris", password: PASSWORD })).status).toBe(503);
  });
});

describe("DELETE /api/session", () => {
  test("ends this browser's session only, and clears the cookie", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const here = signIn(p, chris);
    const there = signIn(p, chris);
    const res = await callPerson(p, here, "DELETE", "/api/session");
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie().join()).toMatch(/portico_session=;.*Max-Age=0/);
    expect((await callPerson(p, here, "GET", "/api/me")).status).toBe(401);
    expect((await callPerson(p, there, "GET", "/api/me")).status).toBe(200);
  });

  test("a pending person can sign out, and signing out twice is fine", async () => {
    const p = makePortico();
    await addOwner(p);
    const cookie = signIn(p, await addMember(p, "Priya", "pending"));
    expect((await callPerson(p, cookie, "DELETE", "/api/session")).status).toBe(204);
    expect((await callPerson(p, cookie, "DELETE", "/api/session")).status).toBe(204);
    expect((await callPerson(p, null, "DELETE", "/api/session")).status).toBe(204);
  });
});

describe("account", () => {
  test("PATCH /api/me renames; a name in use is 409; signed out is 401", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    await addMember(p, "Maya");
    const cookie = signIn(p, chris);
    const renamed = await callPerson(p, cookie, "PATCH", "/api/me", { name: "Chris Ivester" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ person: { name: "Chris Ivester", isMe: true } });
    const taken = await callPerson(p, cookie, "PATCH", "/api/me", { name: "maya" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "conflict" });
    expect((await callPerson(p, cookie, "PATCH", "/api/me", { name: "" })).status).toBe(400);
    expect((await callPerson(p, null, "PATCH", "/api/me", { name: "X" })).status).toBe(401);
  });

  test("a pending person can't rename or change the password", async () => {
    const p = makePortico();
    await addOwner(p);
    const cookie = signIn(p, await addMember(p, "Priya", "pending"));
    expect((await callPerson(p, cookie, "PATCH", "/api/me", { name: "P" })).status).toBe(403);
    expect((await callPerson(p, cookie, "POST", "/api/me/password", { current: PASSWORD, next: "another-password" })).status).toBe(403);
  });

  test("POST /api/me/password needs the current password and signs out other sessions", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const here = signIn(p, chris);
    const there = signIn(p, chris);
    const wrong = await callPerson(p, here, "POST", "/api/me/password", { current: "not-the-password", next: "another-password" });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "bad_request", message: "The current password is wrong." });
    const short = await callPerson(p, here, "POST", "/api/me/password", { current: PASSWORD, next: "short" });
    expect(await short.json()).toEqual({ error: "bad_request", message: "A password needs 12 characters or more." });
    const ok = await callPerson(p, here, "POST", "/api/me/password", { current: PASSWORD, next: "another-password" });
    expect(ok.status).toBe(204);
    expect((await callPerson(p, here, "GET", "/api/me")).status).toBe(200);
    expect((await callPerson(p, there, "GET", "/api/me")).status).toBe(401);
    expect((await postSession(p, { name: "Chris", password: "another-password" })).status).toBe(200);
  });
});

describe("/sign-in", () => {
  test("the page matches K2: name, password, the passkey button and the invite note", async () => {
    const p = makePortico();
    const res = await p.app.request("/sign-in?next=%2Fsettings");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<h1>Sign in to Portico</h1>");
    expect(page).toContain('data-api="POST /api/session"');
    expect(page).toContain('autocomplete="username"');
    expect(page).toContain('autocomplete="current-password"');
    expect(page).toContain('name="next" value="/settings"');
    expect(page).toContain("Sign in with a passkey");
    expect(page).toContain("No account yet? Ask the person who runs this Portico for an invite link.");
    expect(page).toContain('src="/assets/forms.js"');
    expect(page).toContain('src="/assets/passkey.js"');
    expect(copyProblems(visibleCopy(page))).toEqual([]);
  });

  test("a crafted next falls back to Home", async () => {
    const p = makePortico();
    const page = await (await p.app.request("/sign-in?next=https%3A%2F%2Fevil.example")).text();
    expect(page).toContain('name="next" value="/"');
  });

  test("a signed-in visit goes on to next; a pending person goes to the waiting page", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const res = await p.app.request("/sign-in?next=%2Fa%2Fagent-1", { headers: { cookie: signIn(p, chris) } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/a/agent-1");
    const pending = signIn(p, await addMember(p, "Priya", "pending"));
    const waiting = await p.app.request("/sign-in", { headers: { cookie: pending } });
    expect(waiting.headers.get("location")).toBe("/invite");
  });

  test("before setup, the sign-in page says Portico isn't set up", async () => {
    const p = makePortico({ setup: false });
    const res = await p.app.request("/sign-in");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Portico isn't set up yet");
  });
});
