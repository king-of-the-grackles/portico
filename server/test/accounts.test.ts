import { describe, expect, test } from "bun:test";
import { checkNewPassword, verifyPassword } from "../src/core/accounts";
import { PorticoError } from "../src/core/errors";
import { addMember, addOwner, copyProblems, errorCode, HOUR, makePortico, MINUTE, PASSWORD, PUBLIC_URL } from "./helpers";

async function rejects(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PorticoError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected a PorticoError");
}

const NEW_PASSWORD = "a-brand-new-password";

describe("setup links", () => {
  test("a link is a one-time secret stored only as a hash, valid for 1 hour", () => {
    const p = makePortico({ setup: false });
    const { token, expiresAt } = p.accounts.createSetupLink();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt).toBe(new Date(p.clock.now().getTime() + HOUR).toISOString());
    const rows = p.db.query("SELECT token_hash FROM setup_links").all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toContain(token);
  });

  test("setup creates the owner, confirms the public URL and closes the link", async () => {
    const p = makePortico({ setup: false });
    const { token } = p.accounts.createSetupLink();
    const { person, recovered } = await p.accounts.setUp(p.settings, {
      token,
      name: "  Chris ",
      password: PASSWORD,
      publicUrl: "https://portico.example.com/",
    });
    expect(recovered).toBe(false);
    expect(person).toMatchObject({ name: "Chris", role: "owner", status: "active" });
    expect(p.settings.setupDone()).toBe(true);
    expect(p.settings.get("public_url")).toBe("https://portico.example.com");
    expect(await verifyPassword(PASSWORD, p.people.passwordHash(person.id)!)).toBe(true);
    const again = await rejects(p.accounts.setUp(p.settings, { token, name: "Chris", password: PASSWORD, publicUrl: PUBLIC_URL }));
    expect(again.code).toBe("wrong_status");
    expect(again.message).toContain("already used");
  });

  test("an expired, unknown or missing link is refused with a next step", async () => {
    const p = makePortico({ setup: false });
    const { token } = p.accounts.createSetupLink();
    p.clock.advance(HOUR);
    const input = { name: "Chris", password: PASSWORD, publicUrl: PUBLIC_URL };
    const expired = await rejects(p.accounts.setUp(p.settings, { ...input, token }));
    expect(expired).toMatchObject({ code: "wrong_status" });
    expect(expired.message).toContain("expired");
    expect(expired.message).toContain("portico setup");
    expect((await rejects(p.accounts.setUp(p.settings, { ...input, token: "x".repeat(22) }))).code).toBe("not_found");
    expect((await rejects(p.accounts.setUp(p.settings, { ...input, token: "" }))).code).toBe("not_found");
    expect(p.settings.setupDone()).toBe(false);
    expect(p.people.owner()).toBeNull();
  });

  test("the name, password and public URL are checked before the link is used", async () => {
    const p = makePortico({ setup: false });
    const { token } = p.accounts.createSetupLink();
    const base = { token, name: "Chris", password: PASSWORD, publicUrl: PUBLIC_URL };
    expect((await rejects(p.accounts.setUp(p.settings, { ...base, name: "  " }))).code).toBe("bad_request");
    const short = await rejects(p.accounts.setUp(p.settings, { ...base, password: "short" }));
    expect(short).toEqual({ code: "bad_request", message: "A password needs 12 characters or more." });
    const url = await rejects(p.accounts.setUp(p.settings, { ...base, publicUrl: "http://portico.example.com" }));
    expect(url.code).toBe("bad_request");
    expect(url.message).toContain("https://");
    const done = await p.accounts.setUp(p.settings, base);
    expect(done.person.name).toBe("Chris");
  });

  test("reset closes unused links; before setup the new link sets up Portico", async () => {
    const p = makePortico({ setup: false });
    const first = p.accounts.createSetupLink();
    const second = p.accounts.createSetupLink({ reset: true });
    const input = { name: "Chris", password: PASSWORD, publicUrl: PUBLIC_URL };
    expect((await rejects(p.accounts.setUp(p.settings, { ...input, token: first.token }))).code).toBe("not_found");
    await p.accounts.setUp(p.settings, { ...input, token: second.token });
    expect(p.settings.setupDone()).toBe(true);
  });

  test("after setup, a reset link sets a new owner password and signs the owner out everywhere", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const maya = await addMember(p);
    const ownerSession = p.accounts.startSession(chris.id).token;
    const memberSession = p.accounts.startSession(maya.id).token;
    const { token } = p.accounts.createSetupLink({ reset: true });
    const { person, recovered } = await p.accounts.setUp(p.settings, { token, password: NEW_PASSWORD });
    expect(recovered).toBe(true);
    expect(person.id).toBe(chris.id);
    expect(await verifyPassword(NEW_PASSWORD, p.people.passwordHash(chris.id)!)).toBe(true);
    expect(p.accounts.personForSession(ownerSession)).toBeNull();
    expect(p.accounts.personForSession(memberSession)?.id).toBe(maya.id);
    expect(p.people.owner()?.name).toBe("Chris");
  });

  test("the daily sweep deletes expired links", () => {
    const p = makePortico({ setup: false });
    p.accounts.createSetupLink();
    p.clock.advance(30 * MINUTE);
    p.accounts.createSetupLink();
    p.clock.advance(31 * MINUTE);
    expect(p.accounts.sweep()).toBe(1);
    expect(p.db.query("SELECT COUNT(*) AS n FROM setup_links").get()).toEqual({ n: 1 });
  });
});

describe("sign in", () => {
  test("a name in any letter case and the password sign in; a wrong name or password get the same message", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    expect((await p.accounts.signIn({ name: " chris ", password: PASSWORD, ip: "local" })).id).toBe(chris.id);
    const wrongPassword = await rejects(p.accounts.signIn({ name: "Chris", password: "nope-nope-nope", ip: "local" }));
    const wrongName = await rejects(p.accounts.signIn({ name: "Nobody", password: PASSWORD, ip: "local" }));
    expect(wrongPassword).toEqual(wrongName);
    expect(wrongName.code).toBe("unauthorized");
    expect((await rejects(p.accounts.signIn({ name: "", password: "", ip: "local" }))).code).toBe("bad_request");
  });

  test("10 failures in 15 minutes per address and name stop sign in, even with the right password", async () => {
    const p = makePortico();
    await addOwner(p);
    for (let i = 0; i < 10; i++) {
      expect((await rejects(p.accounts.signIn({ name: "Chris", password: "wrong-password", ip: "1.2.3.4" }))).code).toBe(
        "unauthorized",
      );
      p.clock.advance(MINUTE);
    }
    const limited = await rejects(p.accounts.signIn({ name: "Chris", password: PASSWORD, ip: "1.2.3.4" }));
    expect(limited.code).toBe("rate_limited");
    expect(limited.message).toBe("Too many failed sign in attempts. Try again in 5 minutes.");
    // Another address, or another name from the same address, is counted apart.
    expect((await p.accounts.signIn({ name: "Chris", password: PASSWORD, ip: "5.6.7.8" })).name).toBe("Chris");
    expect((await rejects(p.accounts.signIn({ name: "Maya", password: PASSWORD, ip: "1.2.3.4" }))).code).toBe("unauthorized");
    // The oldest failure leaves the window after 15 minutes.
    p.clock.advance(5 * MINUTE);
    expect((await p.accounts.signIn({ name: "chris", password: PASSWORD, ip: "1.2.3.4" })).name).toBe("Chris");
  });

  test("a success clears the failures", async () => {
    const p = makePortico();
    await addOwner(p);
    for (let i = 0; i < 9; i++) await rejects(p.accounts.signIn({ name: "Chris", password: "wrong-password", ip: "local" }));
    await p.accounts.signIn({ name: "Chris", password: PASSWORD, ip: "local" });
    for (let i = 0; i < 9; i++) await rejects(p.accounts.signIn({ name: "Chris", password: "wrong-password", ip: "local" }));
    expect((await p.accounts.signIn({ name: "Chris", password: PASSWORD, ip: "local" })).name).toBe("Chris");
  });
});

/** Every key the sign-in limiters hold. They're private, so this reads them the way a heap dump would. */
function limiterKeys(p: ReturnType<typeof makePortico>): string[] {
  type Limiter = { failures: Map<string, number[]> } | undefined;
  const limiters = p.accounts as unknown as Record<"addressAttempts" | "signInFailures" | "nameFailures", Limiter>;
  return [limiters.addressAttempts, limiters.signInFailures, limiters.nameFailures].flatMap((limiter) => [...(limiter?.failures.keys() ?? [])]);
}

describe("sign in limits that don't depend on the name", () => {
  test("30 attempts in 15 minutes from one address, whatever the names, stop sign in; a success counts too", async () => {
    const p = makePortico();
    await addOwner(p);
    expect((await p.accounts.signIn({ name: "Chris", password: PASSWORD, ip: "1.2.3.4" })).name).toBe("Chris");
    // In batches of 10, all the password checks take at once, so both places that run them are kept busy.
    for (let first = 1; first < 30; first += 10) {
      const names = Array.from({ length: Math.min(10, 30 - first) }, (_, i) => `Nobody ${first + i}`);
      const answers = await Promise.all(names.map((name) => rejects(p.accounts.signIn({ name, password: "wrong-password", ip: "1.2.3.4" }))));
      for (const answer of answers) expect(answer.code).toBe("unauthorized");
    }
    const limited = await rejects(p.accounts.signIn({ name: "Nobody 30", password: "wrong-password", ip: "1.2.3.4" }));
    expect(limited.code).toBe("rate_limited");
    expect(copyProblems(limited.message)).toEqual([]);
    expect((await rejects(p.accounts.signIn({ name: "Chris", password: PASSWORD, ip: "1.2.3.4" }))).code).toBe("rate_limited");
    expect((await p.accounts.signIn({ name: "Chris", password: PASSWORD, ip: "5.6.7.8" })).name).toBe("Chris");
    p.clock.advance(15 * MINUTE);
    expect((await p.accounts.signIn({ name: "Chris", password: PASSWORD, ip: "1.2.3.4" })).name).toBe("Chris");
  });

  test("\"local\" (no proxy reported an address) has no per-address cap, so one client can't lock out everyone", async () => {
    const p = makePortico();
    await addOwner(p);
    for (let first = 0; first < 40; first += 10) {
      const names = Array.from({ length: 10 }, (_, i) => `Nobody ${first + i}`);
      const answers = await Promise.all(names.map((name) => rejects(p.accounts.signIn({ name, password: "wrong-password", ip: "local" }))));
      for (const answer of answers) expect(answer.code).toBe("unauthorized");
    }
    expect((await p.accounts.signIn({ name: "Chris", password: PASSWORD, ip: "local" })).name).toBe("Chris");
  });

  test("a name over 60 characters or a password over 1,000 gets the usual 401, uncounted and unchecked", async () => {
    const p = makePortico();
    await addOwner(p);
    const usual = { code: "unauthorized", message: "Wrong name or password." };
    expect(await rejects(p.accounts.signIn({ name: "x".repeat(61), password: "wrong-password", ip: "1.2.3.4" }))).toEqual(usual);
    expect(await rejects(p.accounts.signIn({ name: "Chris", password: "x".repeat(1001), ip: "1.2.3.4" }))).toEqual(usual);
    expect(limiterKeys(p)).toEqual([]);
    // Refused before any password check: the decoy hash a check against an unknown name needs was never made.
    expect((p.accounts as unknown as { decoyHash: unknown }).decoyHash).toBeNull();
    // 60 characters is still a name.
    expect(await rejects(p.accounts.signIn({ name: "x".repeat(60), password: "wrong-password", ip: "1.2.3.4" }))).toEqual(usual);
    expect(limiterKeys(p)).toHaveLength(3);
  });

  test("2 password checks run and 8 wait; while they do, more attempts get 429 at once and aren't counted", async () => {
    const p = makePortico();
    await addOwner(p);
    let settled = 0;
    const waiting = Array.from({ length: 10 }, (_, i) =>
      rejects(p.accounts.signIn({ name: `Nobody ${i}`, password: "wrong-password", ip: `10.0.0.${i}` })).finally(() => settled++),
    );
    const keys = limiterKeys(p);
    const refused = await rejects(p.accounts.signIn({ name: "Chris", password: PASSWORD, ip: "10.0.1.1" }));
    expect(refused.code).toBe("rate_limited");
    expect(copyProblems(refused.message)).toEqual([]);
    expect(settled).toBe(0);
    expect(limiterKeys(p)).toEqual(keys);
    for (const answer of await Promise.all(waiting)) expect(answer.code).toBe("unauthorized");
    expect((await p.accounts.signIn({ name: "Chris", password: PASSWORD, ip: "10.0.1.1" })).name).toBe("Chris");
  });

  test("an address the client makes up is cut to 64 characters in limiter keys", async () => {
    const p = makePortico();
    await addOwner(p);
    const res = await p.app.request(`${PUBLIC_URL}/api/session`, {
      method: "POST",
      headers: { host: "portico.example.com", "content-type": "application/json", "x-forwarded-for": "7".repeat(10_000) },
      body: JSON.stringify({ name: "Chris", password: "wrong-password" }),
    });
    expect(res.status).toBe(401);
    const keys = limiterKeys(p);
    for (const key of keys) expect(key).not.toContain("7".repeat(65));
    expect(keys.filter((key) => key.includes("7".repeat(64)))).toHaveLength(2);
  });

  test("the minute sweep forgets sign-in keys with nothing left in the window", async () => {
    const p = makePortico();
    await addOwner(p);
    await rejects(p.accounts.signIn({ name: "Nobody", password: "wrong-password", ip: "1.2.3.4" }));
    p.clock.advance(14 * MINUTE);
    await rejects(p.accounts.signIn({ name: "Somebody", password: "wrong-password", ip: "5.6.7.8" }));
    p.clock.advance(2 * MINUTE);
    p.sweepMinute();
    expect(limiterKeys(p).sort()).toEqual(["sign-in-address\n5.6.7.8", "sign-in\n5.6.7.8\nsomebody", "sign-in\nsomebody"].sort());
  });
});

describe("passwords", () => {
  test("a new password needs 12 characters or more", () => {
    expect(errorCode(() => checkNewPassword("eleven-char"))).toBe("bad_request");
    expect(errorCode(() => checkNewPassword(12))).toBe("bad_request");
    expect(errorCode(() => checkNewPassword("x".repeat(1001)))).toBe("bad_request");
    expect(checkNewPassword("twelve-chars")).toBe("twelve-chars");
  });

  test("changing the password needs the current one, ends every session and starts a new one", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const here = p.accounts.startSession(chris.id).token;
    const elsewhere = p.accounts.startSession(chris.id).token;
    const wrong = await rejects(p.accounts.changePassword(chris.id, { current: "not-the-password", next: NEW_PASSWORD }));
    expect(wrong).toEqual({ code: "bad_request", message: "The current password is wrong." });
    expect(p.accounts.personForSession(elsewhere)?.id).toBe(chris.id);
    const fresh = await p.accounts.changePassword(chris.id, { current: PASSWORD, next: NEW_PASSWORD });
    expect(p.accounts.personForSession(here)).toBeNull();
    expect(p.accounts.personForSession(elsewhere)).toBeNull();
    expect(p.accounts.personForSession(fresh.token)?.id).toBe(chris.id);
    expect((await p.accounts.signIn({ name: "Chris", password: NEW_PASSWORD, ip: "local" })).id).toBe(chris.id);
  });

  test("guessing the current password is limited too", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    for (let i = 0; i < 10; i++) await rejects(p.accounts.changePassword(chris.id, { current: "guess-guess-guess", next: NEW_PASSWORD }));
    expect((await rejects(p.accounts.changePassword(chris.id, { current: PASSWORD, next: NEW_PASSWORD }))).code).toBe("rate_limited");
  });
});
