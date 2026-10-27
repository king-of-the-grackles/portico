import { Hono } from "hono";
import type { Core } from "../core/core";
import { type PersonEnv, currentPerson } from "./context";
import { personViews } from "./views";

/** GET /api/me: who is signed in, and Portico's public URL. A claimed invite still waiting may read it too. */
export function meRoutes(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.get("/", (c) => {
    const me = currentPerson(c, { pending: true });
    return c.json({ person: personViews(core, me).person(me), publicUrl: core.settings.publicUrl() });
  });
  return route;
}
