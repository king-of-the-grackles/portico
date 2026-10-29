// Tasks as agents see them, for list_tasks and get_task over MCP and REST: the four outcomes the pages show, and the
// messages, with other agents' text framed as untrusted. An agent sees only the tasks it's in, and nothing a person
// hasn't let through to it yet: a held message stays the person's to decide on, as check_inbox keeps it.
import type { Agents } from "../core/agents";
import { PorticoError } from "../core/errors";
import type { Messages } from "../core/messages";
import { letThrough, TASK_OUTCOMES, type Task, type TaskOutcome, type TaskReason, type Tasks } from "../core/tasks";
import type { Agent } from "../core/types";
import type { AgentViews, MessageOutView } from "./views";

/** What list_tasks filters by: open (needs approval or in progress, the default), all, or one outcome. */
export const TASK_FILTERS = ["open", "all", ...TASK_OUTCOMES] as const;
export type TaskFilterName = (typeof TASK_FILTERS)[number];

const OPEN: readonly TaskOutcome[] = ["needs_approval", "in_progress"];

/** The most tasks one list_tasks answer holds. */
export const AGENT_TASKS_MAX = 100;

export interface AgentTaskView {
  id: string;
  subject: string;
  /** sent: this agent asked. received: this agent was asked. */
  direction: "sent" | "received";
  /** The other agent, by the name to address it. */
  with: string;
  outcome: TaskOutcome;
  /** For failed: not_allowed, expired or no_answer. */
  reason: TaskReason | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  /** When the agent asked picked the first message up. */
  picked_up_at: string | null;
  /** The latest answer. done is false when the agent asked said more is coming. */
  answer: { message_id: string; subject: string; summary: string | null; done: boolean; at: string } | null;
  messages: number;
}

/**
 * A message in get_task: the agent's own text as written, the other agent's framed like a delivery. A message to this
 * agent that a person hasn't let through comes withheld, with no subject or text.
 */
export type AgentTaskMessageView = Omit<MessageOutView, "text" | "subject" | "thread_id" | "expires_at"> & {
  subject?: string;
  done: boolean;
  text?: string;
  framed_message?: string;
  withheld?: true;
};

export interface AgentTaskDeps {
  agents: Agents;
  messages: Messages;
  tasks: Tasks;
  views: AgentViews;
}

export function agentTaskView(views: AgentViews, agent: Agent, t: Task): AgentTaskView {
  const sent = t.fromId === agent.id;
  return {
    id: t.id,
    subject: t.subject,
    direction: sent ? "sent" : "received",
    with: views.nameOf(sent ? t.toId : t.fromId),
    outcome: t.outcome,
    reason: t.reason,
    started_at: t.startedAt,
    updated_at: t.updatedAt,
    ended_at: t.endedAt,
    picked_up_at: t.pickedUpAt,
    answer: t.answer
      ? { message_id: t.answer.id, subject: t.answer.subject, summary: t.answer.summary, done: t.answer.final, at: t.answer.createdAt }
      : null,
    messages: t.messageCount,
  };
}

/** Whether the agent may see the task at all: it asked, or a person let the first message through to it. */
function visibleTo(agent: Agent, t: Task): boolean {
  if (t.fromId === agent.id) return true;
  return t.toId === agent.id && (t.heldAt === null || t.steps.some((s) => s.kind === "allowed"));
}

function checkTime(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) throw new PorticoError("bad_request", `${name} must be a time, such as 2026-10-28T09:00:00Z.`);
  return new Date(at).toISOString();
}

/** The agent's own tasks, newest started first: open ones unless `outcome` says otherwise. */
export function listAgentTasks(
  deps: AgentTaskDeps,
  agent: Agent,
  args: { outcome?: unknown; with?: unknown; since?: unknown; before?: unknown; limit?: unknown },
): { tasks: AgentTaskView[]; more: boolean } {
  const filter = args.outcome === undefined || args.outcome === null || args.outcome === "" ? "open" : args.outcome;
  if (typeof filter !== "string" || !TASK_FILTERS.includes(filter as TaskFilterName)) {
    throw new PorticoError("bad_request", `outcome must be one of: ${TASK_FILTERS.join(", ")}.`);
  }
  const other =
    args.with === undefined || args.with === null || args.with === "" ? undefined : deps.agents.resolve(args.with, agent.id);
  const limit = args.limit === undefined || args.limit === null || args.limit === "" ? 50 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new PorticoError("bad_request", "limit must be a whole number from 1.");
  const outcomes = filter === "all" ? null : filter === "open" ? OPEN : [filter as TaskOutcome];
  const since = checkTime(args.since, "since");
  const before = checkTime(args.before, "before");
  const tasks = deps.tasks
    .all({ visible: null, agentId: agent.id, anyOf: other ? [other.id] : undefined })
    .filter(
      (t) =>
        visibleTo(agent, t) &&
        (!outcomes || outcomes.includes(t.outcome)) &&
        (!since || t.updatedAt >= since) &&
        (!before || t.startedAt < before),
    );
  const shown = tasks.slice(0, Math.min(limit, AGENT_TASKS_MAX));
  deps.agents.checkedIn(agent);
  return { tasks: shown.map((t) => agentTaskView(deps.views, agent, t)), more: tasks.length > shown.length };
}

/** One of the agent's tasks, found by its ID or any of its messages' IDs, with every message. */
export function getAgentTask(
  deps: AgentTaskDeps,
  agent: Agent,
  id: unknown,
): { task: AgentTaskView; messages: AgentTaskMessageView[] } {
  if (typeof id !== "string" || id.trim() === "") throw new PorticoError("bad_request", "task must be a task or message ID.");
  const root = deps.tasks.rootOf(id.trim());
  const found = root ? deps.tasks.get(root) : null;
  if (!found || !visibleTo(agent, found.task)) throw new PorticoError("not_found", "No such task among this agent's tasks.");
  deps.agents.checkedIn(agent);
  const messages = found.messageIds
    .map((messageId) => deps.messages.get(messageId))
    .filter((m) => m !== null)
    .map((m): AgentTaskMessageView => {
      const { text, subject, thread_id: _thread, expires_at: _expires, ...rest } = deps.views.message(m);
      if (m.fromId === agent.id) return { ...rest, subject, done: m.final, text };
      if (!letThrough(m)) return { ...rest, done: m.final, withheld: true };
      return { ...rest, subject, done: m.final, framed_message: deps.views.delivery(m).framed_message };
    });
  return { task: agentTaskView(deps.views, agent, found.task), messages };
}
