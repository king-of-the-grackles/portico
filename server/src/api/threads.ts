import { Hono } from "hono";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import { type PersonEnv, currentPerson } from "./context";
import { canSeeThread, personViews } from "./views";

/**
 * /api/threads: transcripts. The owner sees every thread; a member, only threads with the member's agents. A thread comes
 * a page at a time, newest first; `before` asks for the page ending just before that message, and `limit` (at most
 * 2000) for a longer page.
 */
export function threadRoutes(core: Core): Hono<PersonEnv> {
  const { agents, messages } = core;
  const route = new Hono<PersonEnv>();

  route.get("/", (c) => {
    const me = currentPerson(c);
    const agentId = c.req.query("agent") || undefined;
    const involving = me.role === "owner" ? undefined : agents.ownedBy(me.id).map((a) => a.id);
    const views = personViews(core, me);
    return c.json({ threads: messages.threads({ involving, agentId }).map(views.thread) });
  });

  route.get("/:id", (c) => {
    const me = currentPerson(c);
    const thread = messages.thread(c.req.param("id"));
    // A thread the person can't see answers the same as one that doesn't exist.
    if (!thread || !canSeeThread(agents, me, thread)) throw new PorticoError("not_found", "No such thread.");
    const limit = Number(c.req.query("limit"));
    return c.json(
      personViews(core, me).threadData(thread, {
        before: c.req.query("before") || undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      }),
    );
  });

  return route;
}
