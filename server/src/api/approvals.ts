import { Hono } from "hono";
import type { Core } from "../core/core";
import { readJson } from "../agent-api/rest";
import { type PersonEnv, currentPerson } from "./context";
import { consentCards } from "./consents";
import { questionCards } from "./questions";
import { personViews } from "./views";

/**
 * /api/approvals: what waits for the signed-in person. Held messages to agents the person manages, what the
 * person's agents asked that waits on the consent page, and the questions the person's agents asked the person.
 */
export function approvalRoutes(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  route.get("/", (c) => {
    const me = currentPerson(c);
    const views = personViews(core, me);
    return c.json({ held: core.approvals.heldFor(me.id).map(views.held), consents: consentCards(core, me), questions: questionCards(core, me) });
  });

  route.post("/held/:messageId", async (c) => {
    const me = currentPerson(c);
    const body = (await readJson(c)) as { decision?: unknown } | null;
    const message = core.approvals.decide(me.id, c.req.param("messageId"), body?.decision);
    return c.json({ message: personViews(core, me).message(message) });
  });

  return route;
}
