import { Hono } from "hono";
import type { Core } from "../core/core";
import { readJson } from "../agent-api/rest";
import { type PersonEnv, currentPerson } from "./context";
import { pendingSignIns, signInRoutes } from "./sign-ins";
import { personViews } from "./views";

/**
 * /api/approvals: what waits for the signed-in person. Held messages to agents the person manages, and app agents'
 * sign-in requests from join lines the person made.
 */
export function approvalRoutes(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  route.get("/", (c) => {
    const me = currentPerson(c);
    const views = personViews(core, me);
    return c.json({ held: core.approvals.heldFor(me.id).map(views.held), signIns: pendingSignIns(core, me) });
  });

  route.post("/held/:messageId", async (c) => {
    const me = currentPerson(c);
    const body = (await readJson(c)) as { decision?: unknown } | null;
    const message = core.approvals.decide(me.id, c.req.param("messageId"), body?.decision);
    return c.json({ message: personViews(core, me).message(message) });
  });

  route.route("/sign-ins", signInRoutes(core));
  return route;
}
