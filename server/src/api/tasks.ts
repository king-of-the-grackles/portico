import { Hono } from "hono";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import { type Task, TASK_OUTCOMES, type TaskOutcome } from "../core/tasks";
import type { Person } from "../core/types";
import { type PersonEnv, currentPerson } from "./context";
import { pendingSignIns } from "./sign-ins";
import {
  type ActivityView,
  type AgentView,
  agentsInOrder,
  type HeldCard,
  personViews,
  type SignInView,
  type TaskView,
} from "./views";

/** The agents whose tasks and activity the person sees: everyone's for the owner (null), a member's own otherwise. */
export function visibleAgents(core: Core, me: Person): string[] | null {
  return me.role === "owner" ? null : core.agents.ownedBy(me.id).map((a) => a.id);
}

function sees(visible: string[] | null, task: Task): boolean {
  return visible === null || visible.includes(task.fromId) || visible.includes(task.toId);
}

/** An ISO time from a query string, or null when it's missing or not a time. */
function timeParam(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The session folders on Portico, sorted: the Project filter's choices. */
function projects(core: Core, visible: string[] | null): string[] {
  const folders = core.agents
    .all()
    .filter((a) => a.type === "session" && a.folder && (visible === null || visible.includes(a.id)))
    .map((a) => a.folder!);
  return [...new Set(folders)].sort((a, b) => a.localeCompare(b));
}

/** What GET /api/today answers. */
export interface TodayData {
  since: string;
  counts: { decide: number; inProgress: number; done: number; failed: number };
  decisions: { held: HeldCard[]; signIns: SignInView[]; waiting: AgentView[] };
  inProgress: TaskView[];
  done: TaskView[];
  failed: TaskView[];
}

/** The start of the server's day: Today's default when the page doesn't send its own. */
export function serverMidnight(now: Date): string {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

/** Today: what needs the person's decision, what's in progress, and what ended since `since`. */
export function todayData(core: Core, me: Person, since: string): TodayData {
  const views = personViews(core, me);
  const tasks = core.tasks.all({ visible: visibleAgents(core, me) });
  const held = core.approvals.heldFor(me.id).map(views.held);
  const signIns = pendingSignIns(core, me);
  const waiting = agentsInOrder(core.agents, me)
    .filter((a) => a.ownerId === me.id && core.agents.entry(a).status === "waiting")
    .map(views.agent);
  const inProgress = tasks.filter((t) => t.outcome === "in_progress");
  const ended = (outcome: TaskOutcome) => tasks.filter((t) => t.outcome === outcome && t.endedAt !== null && t.endedAt >= since);
  const done = ended("done");
  const failed = ended("failed");
  return {
    since,
    counts: { decide: held.length + signIns.length + waiting.length, inProgress: inProgress.length, done: done.length, failed: failed.length },
    decisions: { held, signIns, waiting },
    inProgress: inProgress.slice(0, 20).map(views.task),
    done: done.slice(0, 20).map(views.task),
    failed: failed.slice(0, 20).map(views.task),
  };
}

/** What GET /api/tasks answers. */
export interface TaskListData {
  tasks: TaskView[];
  counts: Record<TaskOutcome, number>;
  more: boolean;
  projects: string[];
}

export interface TaskQuery {
  agent?: string | null;
  project?: string | null;
  outcome?: string | null;
  before?: string | null;
  limit?: number;
}

/** A page of tasks for the person, filtered by agent, project and outcome, with every outcome's count. */
export function taskListData(core: Core, me: Person, query: TaskQuery): TaskListData {
  const views = personViews(core, me);
  const visible = visibleAgents(core, me);
  if (query.outcome && !TASK_OUTCOMES.includes(query.outcome as TaskOutcome)) {
    throw new PorticoError("bad_request", `outcome must be one of: ${TASK_OUTCOMES.join(", ")}.`);
  }
  const anyOf = query.project
    ? core.agents
        .all()
        .filter((a) => a.type === "session" && a.folder === query.project)
        .map((a) => a.id)
    : undefined;
  const page = core.tasks.list({
    visible,
    agentId: query.agent || undefined,
    anyOf,
    outcome: (query.outcome as TaskOutcome | null) || undefined,
    before: timeParam(query.before ?? undefined) ?? undefined,
    limit: query.limit !== undefined && Number.isFinite(query.limit) ? query.limit : 50,
  });
  return { tasks: page.tasks.map(views.task), counts: page.counts, more: page.more, projects: projects(core, visible) };
}

/**
 * The control plane's reads: /api/today (what needs a decision, what's in progress, what got done), /api/tasks (every
 * task, filtered), /api/tasks/:id (one task's steps and messages) and /api/activity (joins, sessions, decisions and
 * settings changes). Tasks are conversations between agents, worked out from the stored messages.
 */
export function taskRoutes(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  route.get("/today", (c) => {
    const me = currentPerson(c);
    // The page sends the start of its own day; without it, the server's.
    return c.json(todayData(core, me, timeParam(c.req.query("since")) ?? serverMidnight(core.now())));
  });

  route.get("/tasks", (c) => {
    const me = currentPerson(c);
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(
      taskListData(core, me, {
        agent: c.req.query("agent"),
        project: c.req.query("project"),
        outcome: c.req.query("outcome"),
        before: c.req.query("before"),
        limit,
      }),
    );
  });

  route.get("/tasks/:id", (c) => {
    const me = currentPerson(c);
    const views = personViews(core, me);
    const found = core.tasks.get(c.req.param("id"));
    if (!found || !sees(visibleAgents(core, me), found.task)) throw new PorticoError("not_found", "No such task.");
    const messages = found.messageIds.map((id) => core.messages.get(id)).filter((m) => m !== null);
    return c.json({ task: views.task(found.task), messages: messages.map(views.message) });
  });

  route.get("/activity", (c) => {
    const me = currentPerson(c);
    const views = personViews(core, me);
    const visible = visibleAgents(core, me);
    const agent = c.req.query("agent") || undefined;
    const agentIds = agent ? [agent] : visible;
    if (agent && visible !== null && !visible.includes(agent)) return c.json({ entries: [] });
    const before = timeParam(c.req.query("before")) ?? undefined;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 300);
    const record = core.activity
      .list({ agentIds: agentIds ?? undefined, withUnattached: !agent && visible === null, before, limit })
      .map(views.activity);
    const sessions: ActivityView[] = core.agents.recentRuns(agentIds, { before, limit }).flatMap((run) => {
      const view = views.run(run);
      const started: ActivityView = {
        id: `${run.id}-started`,
        at: run.startedAt,
        kind: "session_started",
        agent: view.agent,
        other: null,
        person: null,
        detail: { client: run.client },
      };
      if (run.endedAt === null || (before && run.endedAt >= before)) return [started];
      return [{ ...started, id: `${run.id}-ended`, at: run.endedAt, kind: "session_ended" as const }, started];
    });
    const entries = [...record, ...sessions].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id)).slice(0, limit);
    return c.json({ entries });
  });

  return route;
}
