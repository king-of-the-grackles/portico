import { Hono } from "hono";
import type { Core } from "../core/core";
import { readJson } from "../agent-api/rest";
import { PorticoError } from "../core/errors";
import { type PersonEnv, currentPerson } from "./context";
import { agentsInOrder, personViews } from "./views";

/**
 * /api/agents: every agent on Portico, and what the person who manages an agent can change: name, description,
 * Approval required, the folder switch, the Always allow list, and removal.
 */
export function agentRoutes(core: Core): Hono<PersonEnv> {
  const { agents, approvals } = core;
  const route = new Hono<PersonEnv>();

  route.get("/", (c) => {
    const me = currentPerson(c);
    const views = personViews(core, me);
    return c.json({ agents: agentsInOrder(agents, me).map(views.agent) });
  });

  route.get("/:id", (c) => {
    const me = currentPerson(c);
    const agent = agents.require(c.req.param("id"));
    const views = personViews(core, me);
    const allowList = agent.ownerId === me.id ? approvals.allowListFor(me.id, agent.id).map(views.allowEntry) : null;
    return c.json({ agent: views.agent(agent), allowList });
  });

  route.patch("/:id", async (c) => {
    const me = currentPerson(c);
    const body = (await readJson(c)) as Record<string, unknown> | null;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new PorticoError("bad_request", "The body must be a JSON object.");
    }
    const agent = agents.update(me.id, c.req.param("id"), {
      name: body.name,
      description: body.description,
      approvalRequired: body.approvalRequired,
      joinFromFolder: body.joinFromFolder,
    });
    return c.json({ agent: personViews(core, me).agent(agent) });
  });

  route.delete("/:id", (c) => {
    const me = currentPerson(c);
    agents.remove(me.id, c.req.param("id"));
    return c.body(null, 204);
  });

  route.delete("/:id/allow/:senderId", (c) => {
    const me = currentPerson(c);
    approvals.removeAllowed(me.id, c.req.param("id"), c.req.param("senderId"));
    return c.body(null, 204);
  });

  return route;
}
