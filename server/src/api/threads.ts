import { Hono } from "hono";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import { type PersonEnv, currentPerson } from "./context";
import { canSeeThread, personViews } from "./views";

/** /api/threads: read-only transcripts. The owner sees every thread; a member, only threads with the member's agents. */
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
    const views = personViews(core, me);
    return c.json({ thread: views.thread(thread), messages: messages.inThread(thread.id).map(views.message) });
  });

  return route;
}
