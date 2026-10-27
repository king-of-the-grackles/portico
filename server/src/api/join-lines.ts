import { Hono } from "hono";
import { readJson } from "../agent-api/rest";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import { type PersonEnv, currentPerson } from "./context";
import { signInView } from "./sign-ins";
import { personViews } from "./views";

/**
 * /api/join-lines: make a join line, and watch for the agent that joins with it. The line's secret is shown once, in
 * the answer to POST; GET shows only what the Add agent sheet waits for.
 */
export function joinLineRoutes(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  route.post("/", async (c) => {
    const me = currentPerson(c);
    const body = (await readJson(c)) as { kind?: unknown } | null;
    const { joinLine, secret } = core.computers.createJoinLine(me.id, body?.kind);
    const line = `Join Portico: ${core.settings.publicUrl()}/join#${secret}`;
    return c.json({ joinLine: { id: joinLine.id, kind: joinLine.kind, line, expiresAt: joinLine.expiresAt } }, 201);
  });

  // Only the person who made the line sees it. The agent is the first that joined through it: the first session on a
  // computer line's computer, or the app agent approved from its sign-in request.
  route.get("/:id", (c) => {
    const me = currentPerson(c);
    let joinLine = core.computers.joinLine(c.req.param("id"));
    if (!joinLine || joinLine.createdBy !== me.id) throw new PorticoError("not_found", "No such join line.");
    if (joinLine.computerId && !joinLine.agentId && core.computers.linkFirstSessions() > 0) {
      joinLine = core.computers.joinLine(joinLine.id) ?? joinLine;
    }
    const agent = joinLine.agentId ? core.agents.get(joinLine.agentId) : null;
    const signIn = core.computers.signInForLine(joinLine.id);
    return c.json({
      joinLine: {
        id: joinLine.id,
        kind: joinLine.kind,
        expiresAt: joinLine.expiresAt,
        usedAt: joinLine.usedAt,
        agent: agent ? personViews(core, me).agent(agent) : null,
        signIn: signIn ? signInView(signIn) : null,
      },
    });
  });

  return route;
}
