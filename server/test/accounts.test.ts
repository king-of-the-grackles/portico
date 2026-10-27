import { describe, expect, test } from "bun:test";
import { checkNewPassword, verifyPassword } from "../src/core/accounts";
import { PorticoError } from "../src/core/errors";
import { addMember, addOwner, errorCode, HOUR, makePortico, MINUTE, PASSWORD, PUBLIC_URL } from "./helpers";

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

describe("passwords", () => {
  test("a new password needs 12 characters or more", () => {
    expect(errorCode(() => checkNewPassword("eleven-char"))).toBe("bad_request");
    expect(errorCode(() => checkNewPassword(12))).toBe("bad_request");
    expect(errorCode(() => checkNewPassword("x".repeat(1001)))).toBe("bad_request");
    expect(checkNewPassword("twelve-chars")).toBe("twelve-chars");
  });

  test("changing the password needs the current one and signs out every other session", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const here = p.accounts.startSession(chris.id).token;
    const elsewhere = p.accounts.startSession(chris.id).token;
    const wrong = await rejects(p.accounts.changePassword(chris.id, { current: "not-the-password", next: NEW_PASSWORD, keepToken: here }));
    expect(wrong).toEqual({ code: "bad_request", message: "The current password is wrong." });
    expect(p.accounts.personForSession(elsewhere)?.id).toBe(chris.id);
    await p.accounts.changePassword(chris.id, { current: PASSWORD, next: NEW_PASSWORD, keepToken: here });
    expect(p.accounts.personForSession(here)?.id).toBe(chris.id);
    expect(p.accounts.personForSession(elsewhere)).toBeNull();
    expect((await p.accounts.signIn({ name: "Chris", password: NEW_PASSWORD, ip: "local" })).id).toBe(chris.id);
  });

  test("guessing the current password is limited too", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    for (let i = 0; i < 10; i++) await rejects(p.accounts.changePassword(chris.id, { current: "guess-guess-guess", next: NEW_PASSWORD }));
    expect((await rejects(p.accounts.changePassword(chris.id, { current: PASSWORD, next: NEW_PASSWORD }))).code).toBe("rate_limited");
  });
});
