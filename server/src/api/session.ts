import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { readJson } from "../agent-api/rest";
import { PASSKEY_CHALLENGE_MS, passkeyRp, SESSION_COOKIE } from "../core/accounts";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import { sign, verifySigned } from "../core/tokens";
import type { Person } from "../core/types";
import { clientIp } from "../client-ip";
import { safeNext } from "../web/layout";
import { type PersonEnv, sessionCookieOptions } from "./context";
import { personViews } from "./views";

/** A JSON object body, or 400. */
export async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  const body = await readJson(c);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PorticoError("bad_request", "The body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/** Signs this browser in as the person: ends the browser's earlier session, if any, and sets the cookie. */
export function startBrowserSession(c: Context, core: Core, personId: string): void {
  core.accounts.endSession(getCookie(c, SESSION_COOKIE));
  const { token, expiresAt } = core.accounts.startSession(personId);
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(core.settings.publicUrl(), expiresAt));
}

/** Where a person goes after signing in: a claim still waiting for approval goes to the waiting page. */
export function afterSignIn(person: Person, next: unknown): string {
  return person.status === "pending" ? "/invite" : safeNext(next);
}

/** Holds a passkey request's challenge between the options call and the answer: signed, short-lived, /api only. */
const CHALLENGE_COOKIE = "portico_passkey";

type Ceremony = "add" | "sign-in";

interface ChallengePayload {
  challenge: string;
  /** Adding: the person who asked for the options. */
  personId: string | null;
  expiresAt: number;
}

export function setPasskeyChallenge(c: Context, core: Core, ceremony: Ceremony, challenge: string, personId: string | null): void {
  const payload: ChallengePayload = { challenge, personId, expiresAt: core.now().getTime() + PASSKEY_CHALLENGE_MS };
  setCookie(c, CHALLENGE_COOKIE, sign(core.config.signingKey, `passkey-${ceremony}`, payload), {
    httpOnly: true,
    secure: core.settings.publicUrl().startsWith("https:"),
    sameSite: "Strict",
    path: "/api",
    maxAge: PASSKEY_CHALLENGE_MS / 1000,
  });
}

/** The challenge this browser was given for the ceremony, once; then the cookie is cleared. */
export function takePasskeyChallenge(c: Context, core: Core, ceremony: Ceremony, personId: string | null): string {
  const value = getCookie(c, CHALLENGE_COOKIE);
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/api", secure: core.settings.publicUrl().startsWith("https:") });
  const payload = value ? verifySigned<ChallengePayload>(core.config.signingKey, `passkey-${ceremony}`, value) : null;
  if (!payload || payload.expiresAt <= core.now().getTime() || payload.personId !== personId || typeof payload.challenge !== "string") {
    throw new PorticoError("bad_request", "The passkey request expired. Try again.");
  }
  return payload.challenge;
}

/**
 * /api/session: sign in with a name and password, or with a passkey, and sign out. Sign in answers `{ person, next }`,
 * where next is the page to open.
 */
export function sessionRoutes(core: Core): Hono<PersonEnv> {
  const { accounts } = core;
  const route = new Hono<PersonEnv>();
  const signedIn = (c: Context<PersonEnv>, person: Person, next: unknown) => {
    startBrowserSession(c, core, person.id);
    return c.json({ person: personViews(core, person).person(person), next: afterSignIn(person, next) });
  };

  route.post("/", async (c) => {
    const body = await jsonObject(c);
    const person = await accounts.signIn({ name: body.name, password: body.password, ip: clientIp(c) });
    return signedIn(c, person, body.next);
  });

  // Signing out works for anyone, signed in or not, including a claim still waiting for approval.
  route.delete("/", (c) => {
    accounts.endSession(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: core.settings.publicUrl().startsWith("https:") });
    return c.body(null, 204);
  });

  route.post("/passkey/options", async (c) => {
    const options = await accounts.passkeys.signInOptions(passkeyRp(core.settings.publicUrl()));
    setPasskeyChallenge(c, core, "sign-in", options.challenge, null);
    return c.json({ options });
  });

  route.post("/passkey", async (c) => {
    const body = await jsonObject(c);
    const challenge = takePasskeyChallenge(c, core, "sign-in", null);
    const person = await accounts.passkeys.signIn(passkeyRp(core.settings.publicUrl()), { challenge, credential: body.credential });
    return signedIn(c, person, body.next);
  });

  return route;
}
