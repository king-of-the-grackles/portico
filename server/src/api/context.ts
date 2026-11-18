import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../core/accounts";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import type { Person } from "../core/types";

/** What a signed-in person without a handle may still open: the handle page and its calls, sign-in and sign-out. */
const OPEN_WITHOUT_HANDLE = /^\/(welcome|sign-in|assets\/.*|api\/(session|welcome|handles\/check|me))\/?$/;

/** Every person-API route sees who is signed in, or null. */
export type PersonEnv = { Variables: { person: Person | null } };

/** The person signed in with the request's cookie, or null. Set on every /api route and every page. */
export function loadPerson(core: Core): MiddlewareHandler<PersonEnv> {
  return async (c, next) => {
    const person = core.accounts.personForSession(getCookie(c, sessionCookieName(core)));
    c.set("person", person);
    // With handles, a person without one can only pick one: nothing else opens, on any surface a person reaches.
    if (core.accountSignIn && person && person.handle === null && !OPEN_WITHOUT_HANDLE.test(c.req.path)) {
      if (c.req.path.startsWith("/api/")) return c.json({ error: "not_allowed", message: "Pick a handle first, at /welcome." }, 403);
      if (c.req.method !== "GET") return c.json({ error: "not_allowed", message: "Pick a handle first, at /welcome." }, 403);
      const url = new URL(c.req.url);
      const back = url.pathname + url.search;
      return c.redirect(`${core.accountSignIn.homeUrl}/welcome${back === "/" ? "" : `?next=${encodeURIComponent(back)}`}`, 303);
    }
    await next();
  };
}

/**
 * The signed-in, approved person, or a 401. A claimed invite still waiting for the owner's approval gets 403, except on
 * routes that pass `{ pending: true }` (the waiting page's own reads and Sign out).
 */
export function currentPerson(c: Context<PersonEnv>, opts: { pending?: boolean } = {}): Person {
  const person = c.get("person");
  if (!person) throw new PorticoError("unauthorized", "Sign in to Portico first.");
  if (person.status === "pending" && !opts.pending) {
    throw new PorticoError("not_allowed", "Waiting for the owner to approve this account.");
  }
  return person;
}

/** The signed-in owner, or 403 for a member. */
export function currentOwner(c: Context<PersonEnv>): Person {
  const person = currentPerson(c);
  if (person.role !== "owner") throw new PorticoError("not_allowed", "Only the owner can do this.");
  return person;
}

/**
 * The sign-in cookie's name. Where every address of a hosted Portico shares one sign-in, the cookie has a name of its
 * own, so a cookie an address set for itself before can't stand in front of it.
 */
export function sessionCookieName(core: Pick<Core, "accountSignIn">): string {
  return core.accountSignIn ? "portico_account_session" : SESSION_COOKIE;
}

/** The sign-in cookie's options for this Portico. */
export function sessionCookie(core: Core, expiresAt: string) {
  const domain = core.accountSignIn?.cookieDomain ?? null;
  return { ...sessionCookieOptions(core.settings.publicUrl(), expiresAt), ...(domain ? { domain } : {}) };
}

/** What deleting the sign-in cookie needs to name: the same path and domain the cookie was set with. */
export function sessionCookieGone(core: Core) {
  const domain = core.accountSignIn?.cookieDomain ?? null;
  return { path: "/", secure: core.settings.publicUrl().startsWith("https:"), ...(domain ? { domain } : {}) };
}

/** The cookie a sign-in sets: HttpOnly, SameSite=Lax (connector consent pages arrive from other sites), Secure on https. */
export function sessionCookieOptions(publicUrl: string, expiresAt: string) {
  return {
    httpOnly: true,
    secure: publicUrl.startsWith("https:"),
    sameSite: "Lax" as const,
    path: "/",
    expires: new Date(expiresAt),
  };
}
