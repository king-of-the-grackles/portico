import { Hono } from "hono";
import type { Core } from "../core/core";
import { readJson } from "../agent-api/rest";
import { PorticoError } from "../core/errors";
import type { EventsView } from "../core/events";
import type { WakeUrlView } from "../core/wake-urls";
import { type PersonEnv, currentPerson } from "./context";
import type { TaskOutcome } from "../core/tasks";
import { visibleAgents } from "./tasks";
import type { Person } from "../core/types";
import { type AgentRef, type AgentView, type AllowEntry, agentsInOrder, personViews, type RunView } from "./views";

/** What GET /api/agents/:id answers: the agent page's data. */
export interface AgentPageData {
  agent: AgentView;
  allowList: AllowEntry[] | null;
  taskCounts: Record<TaskOutcome, number>;
  worksWith: { agent: AgentRef; tasks: number; lastAt: string }[];
  runs: RunView[];
  runCount: number;
  /** Whether Portico wakes the agent when a message arrives: a wake URL or event subscription whose last try didn't fail. */
  woken: boolean;
  /** The wake URL and event subscriptions, for the agent's manager only. */
  wake: WakeUrlView | null;
  events: EventsView | null;
}

/**
 * One agent's page: the agent, its Always allow list (for its manager), its tasks' counts, who it works with (by task
 * count), and its recent sessions. Throws not_found for an agent that doesn't exist.
 */
export function agentPageData(core: Core, me: Person, id: string): AgentPageData {
  const { agents, approvals } = core;
  const agent = agents.require(id);
  const views = personViews(core, me);
  const mine = agent.ownerId === me.id;
  const allowList = mine ? approvals.allowListFor(me.id, agent.id).map(views.allowEntry) : null;
  const wake = core.wakeUrls.view(agent.id);
  const events = core.events.view(agent.id);
  const visible = visibleAgents(core, me);
  const tasks = core.tasks.all({ visible, agentId: agent.id });
  const counts: Record<TaskOutcome, number> = { needs_approval: 0, in_progress: 0, done: 0, failed: 0 };
  const partners = new Map<string, { tasks: number; lastAt: string }>();
  for (const task of tasks) {
    counts[task.outcome]++;
    const other = task.fromId === agent.id ? task.toId : task.fromId;
    const seen = partners.get(other);
    partners.set(other, { tasks: (seen?.tasks ?? 0) + 1, lastAt: seen && seen.lastAt > task.updatedAt ? seen.lastAt : task.updatedAt });
  }
  const worksWith = [...partners]
    .sort(([, a], [, b]) => b.tasks - a.tasks || b.lastAt.localeCompare(a.lastAt))
    .map(([partner, p]) => ({ agent: views.agentRef(partner), tasks: p.tasks, lastAt: p.lastAt }));
  return {
    agent: views.agent(agent),
    allowList,
    taskCounts: counts,
    worksWith,
    // Sessions, like tasks and activity, only for the person's own agents (everyone's for the owner).
    runs: visible === null || visible.includes(agent.id) ? agents.runs(agent.id, 10).map(views.run) : [],
    runCount: visible === null || visible.includes(agent.id) ? agents.runCount(agent.id) : 0,
    woken: [wake, events].some((v) => v !== null && (v.lastStatus === null || v.lastStatus === "ok")),
    wake: mine ? wake : null,
    events: mine ? events : null,
  };
}

/**
 * /api/agents: every agent on Portico, and what the person who manages an agent can change: name, description,
 * Approval required, the folder switch, the Always allow list, the wake URL, and removal.
 */
export function agentRoutes(core: Core): Hono<PersonEnv> {
  const { agents, approvals } = core;
  const route = new Hono<PersonEnv>();

  route.get("/", (c) => {
    const me = currentPerson(c);
    const views = personViews(core, me);
    return c.json({ agents: agentsInOrder(agents, me).map(views.agent) });
  });

  route.get("/:id", (c) => c.json(agentPageData(core, currentPerson(c), c.req.param("id"))));

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

  // The key goes in once and never comes back out: the answer shows only the host and how the last wake went.
  route.put("/:id/wake", async (c) => {
    const me = currentPerson(c);
    const body = (await readJson(c)) as Record<string, unknown> | null;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new PorticoError("bad_request", "The body must be a JSON object.");
    }
    const agent = agents.requireManaged(me.id, c.req.param("id"));
    return c.json({ wake: core.wakeUrls.set(agent, me.id, { url: body.url, key: body.key }) });
  });

  route.delete("/:id/wake", (c) => {
    const me = currentPerson(c);
    core.wakeUrls.clear(agents.requireManaged(me.id, c.req.param("id")), me.id);
    return c.body(null, 204);
  });

  route.delete("/:id/allow/:senderId", (c) => {
    const me = currentPerson(c);
    approvals.removeAllowed(me.id, c.req.param("id"), c.req.param("senderId"));
    return c.body(null, 204);
  });

  return route;
}
