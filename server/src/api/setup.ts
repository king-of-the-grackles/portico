import { Hono } from "hono";
import type { Core } from "../core/core";
import { log } from "../log";
import type { PersonEnv } from "./context";
import { jsonObject, startBrowserSession } from "./session";

/**
 * POST /api/setup `{ token, name, password, publicUrl }`: the one-time setup link's form, the only route open before
 * setup. It creates the owner, confirms the public URL, signs this browser in and opens Home. After setup, a link from
 * `portico setup --reset` takes `{ token, password }` and sets a new owner password instead.
 */
export function setupRoutes(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.post("/", async (c) => {
    const body = await jsonObject(c);
    const { person, recovered } = await core.accounts.setUp(core.settings, body);
    log("info", recovered ? "owner_password_reset" : "setup_done", { person_id: person.id });
    startBrowserSession(c, core, person.id);
    return c.json({ next: "/" });
  });
  return route;
}
