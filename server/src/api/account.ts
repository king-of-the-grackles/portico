import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { SESSION_COOKIE } from "../core/accounts";
import type { Core } from "../core/core";
import { tellAccountName } from "./account-sign-in";
import { type PersonEnv, currentPerson, sessionCookie } from "./context";
import { jsonObject } from "./session";
import { personViews } from "./views";

/**
 * /api/me changes: the name (409 when another person has it) and the password (needs the current one, removes the
 * person's passkeys and signs out every browser, then signs this one back in with a new session).
 */
export function accountRoutes(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  route.patch("/", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    // The name, the handle, or both. A new handle holds the old one back from everyone else.
    const person = core.db.transaction(() => {
      let changed = body.name === undefined ? me : core.people.rename(me.id, body.name as string);
      if (body.handle !== undefined) {
        changed = core.people.setHandle(me.id, typeof body.handle === "string" ? body.handle.trim().toLowerCase() : body.handle);
        core.changes.about({ people: [me.id] }, "agents", "people", "me");
      }
      return changed;
    })();
    if (person.name !== me.name) await tellAccountName(core, person);
    return c.json({ person: personViews(core, person).person(person) });
  });

  route.post("/password", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    const { token, expiresAt } = await core.accounts.changePassword(me.id, { current: body.current, next: body.next });
    setCookie(c, SESSION_COOKIE, token, sessionCookie(core, expiresAt));
    core.changes.about({ people: [me.id] }, "me");
    return c.body(null, 204);
  });

  return route;
}
