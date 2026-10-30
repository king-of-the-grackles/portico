import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign as signBytes } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { addMember, addOwner, copyProblems, makePortico, MINUTE, PASSWORD, PUBLIC_URL, signIn } from "./helpers";

const RP_ID = "portico.example.com";

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/**
 * A software authenticator: a real P-256 key pair answering WebAuthn ceremonies the way a browser and a platform
 * authenticator would, with "none" attestation and user verification.
 */
function softAuthenticator(opts: { origin?: string; rpId?: string } = {}) {
  const origin = opts.origin ?? PUBLIC_URL;
  const rpIdHash = createHash("sha256").update(opts.rpId ?? RP_ID).digest();
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const rawId = randomBytes(16);
  const id = rawId.toString("base64url");
  let counter = 0;
  let userHandle = "";
  const clientData = (type: string, challenge: string) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString("base64url");

  return {
    id,
    register(options: { challenge: string; user: { id: string } }) {
      userHandle = options.user.id;
      const coseKey = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))],
          [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))],
        ]),
      );
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(rawId.length);
      // Flags: user present, user verified, attested credential data.
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), u32(counter), Buffer.alloc(16), idLength, rawId, Buffer.from(coseKey)]);
      const attestationObject = isoCBOR.encode(
        new Map<string, string | Map<string, never> | Uint8Array>([
          ["fmt", "none"],
          ["attStmt", new Map<string, never>()],
          ["authData", new Uint8Array(authData)],
        ]),
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData("webauthn.create", options.challenge),
          attestationObject: Buffer.from(attestationObject).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    assert(options: { challenge: string }) {
      counter += 1;
      const clientDataJSON = clientData("webauthn.get", options.challenge);
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), u32(counter)]);
      const signed = Buffer.concat([authData, createHash("sha256").update(Buffer.from(clientDataJSON, "base64url")).digest()]);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON,
          authenticatorData: authData.toString("base64url"),
          signature: signBytes("sha256", signed, privateKey).toString("base64url"),
          userHandle,
        },
      };
    },
  };
}

type Options = { challenge: string; user: { id: string; name: string }; rp: Record<string, string>; [key: string]: unknown };

/** A browser: keeps its cookies (the session, the passkey challenge) between calls, as same-origin fetches do. */
function browser(p: ReturnType<typeof makePortico>, cookie: string | null = null) {
  const jar = new Map<string, string>();
  if (cookie) {
    const [name, value] = cookie.split("=") as [string, string];
    jar.set(name, value);
  }
  return {
    jar,
    async call(method: string, path: string, body?: unknown): Promise<Response> {
      const headers: Record<string, string> = { host: "portico.example.com", origin: PUBLIC_URL };
      if (jar.size > 0) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await p.app.request(`${PUBLIC_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const set of res.headers.getSetCookie()) {
        const [pair] = set.split(";");
        const [name, value] = pair!.split("=") as [string, string];
        if (value === "" || /Max-Age=0/.test(set)) jar.delete(name);
        else jar.set(name, value);
      }
      return res;
    },
  };
}

async function withPasskey() {
  const p = makePortico();
  const chris = await addOwner(p);
  const owner = browser(p, signIn(p, chris));
  const key = softAuthenticator();
  const { options } = (await (await owner.call("POST", "/api/passkeys/options", { current: PASSWORD })).json()) as { options: Options };
  const added = await owner.call("POST", "/api/passkeys", { credential: key.register(options), name: "MacBook Touch ID" });
  expect(added.status).toBe(201);
  const { passkey } = (await added.json()) as { passkey: { id: string } };
  return { p, chris, owner, key, passkeyId: passkey.id };
}

describe("adding a passkey", () => {
  test("options name Portico's host, the person, and ask for a discoverable, verified passkey", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const res = await browser(p, signIn(p, chris)).call("POST", "/api/passkeys/options", { current: PASSWORD });
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().find((c) => c.startsWith("portico_passkey="))!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Path=/api");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Max-Age=300");
    const { options } = (await res.json()) as { options: Options };
    expect(options.rp).toEqual({ name: "Portico", id: RP_ID });
    expect(options.user.name).toBe("Chris");
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(options.attestation).toBe("none");
  });

  test("options need the current password; a wrong one counts toward the limit on changing the password", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const owner = browser(p, signIn(p, chris));
    expect((await owner.call("POST", "/api/passkeys/options")).status).toBe(400);
    const none = await owner.call("POST", "/api/passkeys/options", {});
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ error: "bad_request", message: "The current password is wrong." });
    const wrong = await owner.call("POST", "/api/passkeys/options", { current: "not-the-password" });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "bad_request", message: "The current password is wrong." });
    // No challenge was issued, so there is nothing to answer.
    expect(owner.jar.has("portico_passkey")).toBe(false);

    // The empty answer and the wrong one each counted: 8 more make 10.
    for (let i = 0; i < 8; i++) expect((await owner.call("POST", "/api/passkeys/options", { current: "guess-guess-guess" })).status).toBe(400);
    const limited = await owner.call("POST", "/api/passkeys/options", { current: PASSWORD });
    expect(limited.status).toBe(429);
    expect(owner.jar.has("portico_passkey")).toBe(false);
    expect((await owner.call("POST", "/api/me/password", { current: PASSWORD, next: "a-brand-new-password" })).status).toBe(429);
    p.clock.advance(15 * MINUTE);
    expect((await owner.call("POST", "/api/passkeys/options", { current: PASSWORD })).status).toBe(200);
    expect(p.accounts.passkeys.list(chris.id)).toEqual([]);
  });

  test("the browser's answer stores the passkey; the list shows it; it's excluded next time", async () => {
    const { owner, key } = await withPasskey();
    const { passkeys } = (await (await owner.call("GET", "/api/passkeys")).json()) as { passkeys: unknown[] };
    expect(passkeys).toEqual([{ id: expect.any(String), name: "MacBook Touch ID", createdAt: "2026-10-27T12:00:00.000Z", lastUsedAt: null }]);
    const { options } = (await (await owner.call("POST", "/api/passkeys/options", { current: PASSWORD })).json()) as { options: { excludeCredentials: { id: string }[] } };
    expect(options.excludeCredentials.map((c) => c.id)).toEqual([key.id]);
  });

  test("the same passkey twice is 409; an answer without its options, or for another origin, is refused", async () => {
    const { p, chris, owner, key } = await withPasskey();
    const { options } = (await (await owner.call("POST", "/api/passkeys/options", { current: PASSWORD })).json()) as { options: Options };
    const again = await owner.call("POST", "/api/passkeys", { credential: key.register(options), name: "Again" });
    expect(again.status).toBe(409);
    // The challenge cookie went with that answer.
    expect((await owner.call("POST", "/api/passkeys", { credential: key.register(options), name: "Again" })).status).toBe(400);

    const other = softAuthenticator({ origin: "https://evil.example" });
    const fresh = (await (await owner.call("POST", "/api/passkeys/options", { current: PASSWORD })).json()) as { options: Options };
    const res = await owner.call("POST", "/api/passkeys", { credential: other.register(fresh.options), name: "Evil" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("The passkey couldn't be added. Try again.");
    expect(p.accounts.passkeys.list(chris.id).map((k) => k.name)).toEqual(["MacBook Touch ID"]);
  });

  test("another person's challenge cookie, an expired one, or a pending person is refused", async () => {
    const { p, owner } = await withPasskey();
    const { options } = (await (await owner.call("POST", "/api/passkeys/options", { current: PASSWORD })).json()) as { options: Options };
    const maya = browser(p, signIn(p, await addMember(p)));
    maya.jar.set("portico_passkey", owner.jar.get("portico_passkey")!);
    expect((await maya.call("POST", "/api/passkeys", { credential: softAuthenticator().register(options), name: "X" })).status).toBe(400);

    const late = (await (await owner.call("POST", "/api/passkeys/options", { current: PASSWORD })).json()) as { options: Options };
    p.clock.advance(5 * MINUTE);
    const expired = await owner.call("POST", "/api/passkeys", { credential: softAuthenticator().register(late.options), name: "X" });
    expect(await expired.json()).toEqual({ error: "bad_request", message: "The passkey request expired. Try again." });

    const pending = browser(p, signIn(p, await addMember(p, "Priya", "pending")));
    expect((await pending.call("POST", "/api/passkeys/options", { current: PASSWORD })).status).toBe(403);
    expect((await pending.call("GET", "/api/passkeys")).status).toBe(403);
  });

  test("removing: only one's own passkey; then it no longer signs in", async () => {
    const { p, owner, key, passkeyId } = await withPasskey();
    const maya = browser(p, signIn(p, await addMember(p)));
    expect((await maya.call("DELETE", `/api/passkeys/${passkeyId}`)).status).toBe(404);
    expect((await owner.call("DELETE", `/api/passkeys/${passkeyId}`)).status).toBe(204);
    const visitor = browser(p);
    const { options } = (await (await visitor.call("POST", "/api/session/passkey/options")).json()) as { options: Options };
    const res = await visitor.call("POST", "/api/session/passkey", { credential: key.assert(options) });
    expect(res.status).toBe(401);
  });
});

describe("changing the password", () => {
  test("removes every passkey: one added before the change no longer signs in", async () => {
    const { p, chris, owner, key } = await withPasskey();
    const changed = await owner.call("POST", "/api/me/password", { current: PASSWORD, next: "a-brand-new-password" });
    expect(changed.status).toBe(204);
    expect(p.accounts.passkeys.list(chris.id)).toEqual([]);
    expect(await (await owner.call("GET", "/api/passkeys")).json()).toEqual({ passkeys: [] });
    const visitor = browser(p);
    const { options } = (await (await visitor.call("POST", "/api/session/passkey/options")).json()) as { options: Options };
    const res = await visitor.call("POST", "/api/session/passkey", { credential: key.assert(options) });
    expect(res.status).toBe(401);
    expect(visitor.jar.has("portico_session")).toBe(false);
  });

  test("ends every session, this browser's too, and signs this browser back in with a new cookie", async () => {
    const { p, chris, owner } = await withPasskey();
    const elsewhere = browser(p, signIn(p, chris));
    const before = owner.jar.get("portico_session")!;
    const changed = await owner.call("POST", "/api/me/password", { current: PASSWORD, next: "a-brand-new-password" });
    expect(changed.status).toBe(204);
    const set = changed.headers.getSetCookie().find((c) => c.startsWith("portico_session="))!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Secure");
    const after = owner.jar.get("portico_session")!;
    expect(after).not.toBe(before);
    expect((await browser(p, `portico_session=${before}`).call("GET", "/api/me")).status).toBe(401);
    expect((await elsewhere.call("GET", "/api/me")).status).toBe(401);
    expect((await owner.call("GET", "/api/me")).status).toBe(200);
  });
});

describe("signing in with a passkey", () => {
  test("a verified answer signs the browser in and goes to next; last used is recorded", async () => {
    const { p, key } = await withPasskey();
    p.clock.advance(MINUTE);
    const visitor = browser(p);
    const optionsRes = await visitor.call("POST", "/api/session/passkey/options");
    const { options } = (await optionsRes.json()) as { options: Options & { rpId: string; allowCredentials: unknown[] } };
    expect(options.rpId).toBe(RP_ID);
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe("required");
    const res = await visitor.call("POST", "/api/session/passkey", { credential: key.assert(options), next: "/settings" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ person: { name: "Chris" }, next: "/settings" });
    expect(visitor.jar.has("portico_session")).toBe(true);
    expect(visitor.jar.has("portico_passkey")).toBe(false);
    expect((await visitor.call("GET", "/api/me")).status).toBe(200);
    const [stored] = p.accounts.passkeys.list((await p.people.byName("Chris"))!.id);
    expect(stored!.lastUsedAt).toBe("2026-10-27T12:01:00.000Z");
  });

  test("a replayed answer, a forged signature, an unknown passkey and a missing challenge are refused", async () => {
    const { p, key } = await withPasskey();
    const visitor = browser(p);
    const { options } = (await (await visitor.call("POST", "/api/session/passkey/options")).json()) as { options: Options };
    const challengeCookie = visitor.jar.get("portico_passkey")!;
    const answer = key.assert(options);
    expect((await visitor.call("POST", "/api/session/passkey", { credential: answer })).status).toBe(200);
    // The same answer with the same challenge cookie, sent again.
    const replay = browser(p);
    replay.jar.set("portico_passkey", challengeCookie);
    expect((await replay.call("POST", "/api/session/passkey", { credential: answer })).status).toBe(400);

    const forged = browser(p);
    const fresh = (await (await forged.call("POST", "/api/session/passkey/options")).json()) as { options: Options };
    const signedByAnother = { ...key.assert(fresh.options) };
    signedByAnother.response = { ...signedByAnother.response, signature: softAuthenticator().assert(fresh.options).response.signature };
    const res = await forged.call("POST", "/api/session/passkey", { credential: signedByAnother });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", message: "The passkey couldn't be checked. Try again." });
    expect(forged.jar.has("portico_session")).toBe(false);

    const stranger = browser(p);
    const strangerOptions = (await (await stranger.call("POST", "/api/session/passkey/options")).json()) as { options: Options };
    const unknown = await stranger.call("POST", "/api/session/passkey", { credential: softAuthenticator().assert(strangerOptions.options) });
    expect(unknown.status).toBe(401);
    const messages = [String(((await unknown.json()) as { message: string }).message)];

    const noChallenge = await browser(p).call("POST", "/api/session/passkey", { credential: key.assert(options) });
    expect(noChallenge.status).toBe(400);
    messages.push(String(((await noChallenge.json()) as { message: string }).message));
    expect(copyProblems(messages.join(" "))).toEqual([]);
  });

  test("a claim still waiting signs in to the waiting page", async () => {
    const p = makePortico();
    await addOwner(p);
    const priya = await addMember(p, "Priya", "pending");
    const key = softAuthenticator();
    const options = await p.accounts.passkeys.registrationOptions(priya, { id: RP_ID, origin: PUBLIC_URL });
    await p.accounts.passkeys.add(priya, { id: RP_ID, origin: PUBLIC_URL }, {
      challenge: options.challenge,
      credential: key.register(options as unknown as Options),
      name: "",
    });
    expect(p.accounts.passkeys.list(priya.id)[0]!.name).toBe("Passkey");
    const visitor = browser(p);
    const { options: signInOptions } = (await (await visitor.call("POST", "/api/session/passkey/options")).json()) as { options: Options };
    const res = await visitor.call("POST", "/api/session/passkey", { credential: key.assert(signInOptions), next: "/settings" });
    expect(await res.json()).toMatchObject({ person: { name: "Priya", status: "pending" }, next: "/invite" });
  });
});
