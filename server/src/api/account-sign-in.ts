import { type Context, Hono } from "hono";
import type { Core } from "../core/core";
import { NO_PASSWORD } from "../core/accounts";
import { PorticoError } from "../core/errors";
import { checkHandle, cleanPersonName } from "../core/people";
import type { Account, AccountSignIn, Person } from "../core/types";
import { log } from "../log";
import { safeNext } from "../web/layout";
import { type PersonEnv, currentPerson } from "./context";
import { jsonObject, startBrowserSession } from "./session";

/** Pages that ask a new person for the handle themselves: the consent page and a connector's consent page. */
const ASKS_FOR_HANDLE = /^\/(c\/[^/?]+|oauth\/authorize)\/?(\?|$)/;

/**
 * Where a browser goes after signing in: the page asked for, or first the welcome page for a person with no handle
 * yet, unless the page asked for takes the handle itself.
 */
export function afterAccountSignIn(person: Person, next: unknown): string {
  const path = safeNext(next);
  if (person.handle !== null || ASKS_FOR_HANDLE.test(path)) return path;
  return path === "/" ? "/welcome" : `/welcome?next=${encodeURIComponent(path)}`;
}

/**
 * A name for a person just made from an account: the account's own (Google's, say), else a plain one that stands until
 * the person types theirs at sign-up. Never the first half of the address: that is no name to show other people.
 */
function firstName(account: Account): string {
  for (const candidate of [account.name]) {
    if (!candidate) continue;
    try {
      return cleanPersonName(candidate);
    } catch {
      // Not usable as a name: the next one.
    }
  }
  return "New person";
}

/**
 * Signing in with an outside account (Descope). The first sign-in makes the person; the welcome page then asks for the
 * name and handle before anything else opens.
 *
 *   POST /api/session `{ token, next? }` → `{ next }`
 *   GET  /api/handles/check?handle=… → `{ handle, free, message }`
 *   POST /api/welcome `{ name, handle, next? }` → `{ next }`
 */
export function accountSignInRoutes(core: Core, signIn: AccountSignIn): Hono<PersonEnv> {
  const { people, workspaces } = core;
  const route = new Hono<PersonEnv>();

  route.post("/session", async (c) => {
    const body = await jsonObject(c);
    const account = await signIn.account(body.token);
    let person = people.byExternalId(account.id);
    if (!person) {
      person = people.create({ name: firstName(account), role: "member", status: "active", passwordHash: NO_PASSWORD, externalId: account.id });
      log("info", "account_person_created", { person_id: person.id });
    }
    // The stored address is what the sign-in service vouches for now: a change is taken up, and an address no longer
    // verified is dropped, so an old address can't keep claiming links sent to it.
    const email = account.email?.toLowerCase() ?? null;
    if (email !== person.email) {
      try {
        person = email === null ? people.clearEmail(person.id) : people.setEmail(person.id, email);
      } catch {
        person = people.clearEmail(person.id);
      }
    }
    startBrowserSession(c, core, person.id);
    log("info", "account_sign_in", { person_id: person.id });
    return c.json({ next: afterAccountSignIn(person, body.next) });
  });

  /** Whether the signed-in person could take the handle, and why not. Never says whose a taken handle is. */
  const check = (c: Context<PersonEnv>, raw: unknown) => {
    const me = currentPerson(c);
    try {
      const handle = checkHandle(typeof raw === "string" ? raw.trim().toLowerCase() : raw);
      if (!people.handleFree(handle, me.id)) return { handle, free: false, message: `The handle ${handle} is taken or too close to one in use.` };
      return { handle, free: true, message: `${handle} is free.` };
    } catch (err) {
      if (!(err instanceof PorticoError)) throw err;
      return { handle: null, free: false, message: err.message };
    }
  };

  route.get("/handles/check", (c) => c.json(check(c, c.req.query("handle"))));

  // A free handle near the name the person is typing, for the handle field to offer. Empty when nothing usable was typed.
  route.get("/handles/suggest", (c) => {
    const me = currentPerson(c);
    const name = (c.req.query("name") ?? "").trim().slice(0, 60);
    if (!/[a-z0-9]/i.test(name)) return c.json({ handle: "" });
    try {
      return c.json({ handle: people.suggestHandle(name, me.id) });
    } catch {
      return c.json({ handle: "" });
    }
  });

  route.post("/welcome", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    const handle = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : body.handle;
    const person = core.db.transaction(() => {
      people.rename(me.id, body.name as string);
      const named = people.setHandle(me.id, handle);
      workspaces.personal(me.id);
      return named;
    })();
    log("info", "handle_set", { person_id: person.id });
    return c.json({ next: afterAccountSignIn(person, body.next) });
  });

  return route;
}
