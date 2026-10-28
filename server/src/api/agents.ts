import { Hono } from "hono";
import type { Core } from "../core/core";
import { readJson } from "../agent-api/rest";
import { PorticoError } from "../core/errors";
import { type PersonEnv, currentPerson } from "./context";
import type { TaskOutcome } from "../core/tasks";
import { visibleAgents } from "./tasks";
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

  /**
   * One agent's page: the agent, its Always allow list (for its manager), its tasks' counts, who it works with (by
   * task count), and its recent sessions.
   */
  route.get("/:id", (c) => {
    const me = currentPerson(c);
    const agent = agents.require(c.req.param("id"));
    const views = personViews(core, me);
    const allowList = agent.ownerId === me.id ? approvals.allowListFor(me.id, agent.id).map(views.allowEntry) : null;
    const visible = visibleAgents(core, me);
    const tasks = core.tasks.all({ visible, agentId: agent.id });
    const counts: Record<TaskOutcome, number> = { decide: 0, in_progress: 0, done: 0, failed: 0 };
    const partners = new Map<string, { tasks: number; lastAt: string }>();
    for (const task of tasks) {
      counts[task.outcome]++;
      const other = task.fromId === agent.id ? task.toId : task.fromId;
      const seen = partners.get(other);
      partners.set(other, { tasks: (seen?.tasks ?? 0) + 1, lastAt: seen && seen.lastAt > task.updatedAt ? seen.lastAt : task.updatedAt });
    }
    const worksWith = [...partners]
      .sort(([, a], [, b]) => b.tasks - a.tasks || b.lastAt.localeCompare(a.lastAt))
      .map(([id, p]) => ({ agent: views.agentRef(id), tasks: p.tasks, lastAt: p.lastAt }));
    return c.json({
      agent: views.agent(agent),
      allowList,
      taskCounts: counts,
      worksWith,
      // Sessions, like tasks and activity, only for the person's own agents (everyone's for the owner).
      runs: visible === null || visible.includes(agent.id) ? agents.runs(agent.id, 10).map(views.run) : [],
      runCount: visible === null || visible.includes(agent.id) ? agents.runCount(agent.id) : 0,
    });
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
