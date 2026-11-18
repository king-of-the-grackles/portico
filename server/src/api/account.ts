import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Core } from "../core/core";
import { type PersonEnv, currentPerson, sessionCookie, sessionCookieName } from "./context";
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
    // The name, the handle (with workspaces), or both. A new handle holds the old one back from everyone else.
    const person = core.db.transaction(() => {
      let changed = body.name === undefined ? me : core.people.rename(me.id, body.name as string);
      if (body.handle !== undefined && core.workspaces.enabled) {
        changed = core.people.setHandle(me.id, typeof body.handle === "string" ? body.handle.trim().toLowerCase() : body.handle);
        core.changes.emit("agents", "people", "me");
      }
      return changed;
    })();
    return c.json({ person: personViews(core, person).person(person) });
  });

  route.post("/password", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    const { token, expiresAt } = await core.accounts.changePassword(me.id, { current: body.current, next: body.next });
    setCookie(c, sessionCookieName(core), token, sessionCookie(core, expiresAt));
    core.changes.emit("me");
    return c.body(null, 204);
  });

  return route;
}
