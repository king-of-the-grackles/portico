import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Accounts } from "../core/accounts";
import { SESSION_COOKIE } from "../core/accounts";
import { PorticoError } from "../core/errors";
import type { Person } from "../core/types";

/** Every person-API route sees who is signed in, or null. */
export type PersonEnv = { Variables: { person: Person | null } };

/** The person signed in with the request's cookie, or null. Set on every /api route and every page. */
export function loadPerson(accounts: Accounts): MiddlewareHandler<PersonEnv> {
  return async (c, next) => {
    c.set("person", accounts.personForSession(getCookie(c, SESSION_COOKIE)));
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
