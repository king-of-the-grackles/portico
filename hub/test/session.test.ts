import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { hasSession, newSessionToken, SESSION_COOKIE } from "../src/page/session";
import { T0, testConfig } from "./helpers";

const config = testConfig();

/** A token in the format every hub has signed since v1: base64url JSON claims, a dot, and an HMAC over "<purpose>:<payload>". */
function token(purpose: string, claims: object): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", config.signingSecret).update(`${purpose}:${payload}`).digest("base64url");
  return `${payload}.${mac}`;
}

async function signedIn(cookie: string | null, now = T0): Promise<boolean> {
  const app = new Hono();
  app.get("/", (c) => c.text(String(hasSession(c, config, now))));
  const res = await app.request("/", cookie === null ? {} : { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
  return (await res.text()) === "true";
}

describe("hub page sessions", () => {
  test("a session token signed before the upgrade still signs in", async () => {
    expect(await signedIn(token("session", { expiresAt: "2026-10-27T12:00:00.000Z" }))).toBe(true);
  });

  test("a new session token works for seven days", async () => {
    const fresh = newSessionToken(config, T0);
    expect(await signedIn(fresh)).toBe(true);
    expect(await signedIn(fresh, new Date(T0.getTime() + 7 * 86_400_000 + 1))).toBe(false);
  });

  test("an old approval link token, a tampered token and garbage are no session", async () => {
    expect(await signedIn(token("link", { subject: "task", id: "t1", action: "approve", expiresAt: "2026-10-27T12:00:00.000Z" }))).toBe(false);
    const [payload] = newSessionToken(config, T0).split(".");
    expect(await signedIn(`${payload}.AAAA`)).toBe(false);
    for (const bad of ["", "abc", "a.b.c"]) expect(await signedIn(bad)).toBe(false);
    expect(await signedIn(null)).toBe(false);
  });
});
