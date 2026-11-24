import type { Content, ContentDb, Scope } from "./content";
import { HOUR_MS, LIMITS } from "./limits";
import { finalFacts } from "./types";
import type { Decision, HeldFor, Message, MessageStatus } from "./types";

/**
 * Where a task stands: the four outcomes the pages show (Needs a decision, In progress, Done, Didn't go through) and
 * agents read from list_tasks. A task is one conversation between two agents: a message that isn't a reply, and every
 * reply in its chain. Worked out from the messages, never stored.
 */
export type TaskOutcome = "needs_approval" | "in_progress" | "done" | "failed";
export const TASK_OUTCOMES: readonly TaskOutcome[] = ["needs_approval", "in_progress", "done", "failed"];

/**
 * Why a task didn't go through: a person didn't allow it, it expired unread or undecided, no answer came, or it was
 * withdrawn (its Portico was paused, or one of the two agents left the Portico or was revoked, before pickup).
 */
export type TaskReason = "not_allowed" | "expired" | "no_answer" | "withdrawn";

/** A task where nothing happens for this long after pickup, or after the latest update, didn't go through. */
export const NO_ANSWER_AFTER_MS = LIMITS.messageExpiryHours * HOUR_MS;

export type TaskStepKind = "asked" | "allowed" | "denied" | "picked_up" | "answered" | "expired" | "withdrawn";

export interface TaskStep {
  kind: TaskStepKind;
  at: string;
  /** The person who decided, for allowed and denied. */
  personId: string | null;
  /** For allowed: once or always. */
  decision: Decision | null;
}

export interface Task {
  /** The first message's ID. */
  id: string;
  /** The workspace the conversation runs through: every message of a task is in that one workspace. */
  workspaceId: string;
  subject: string;
  /** Who asked, and who was asked. Every message in a task is between these two. */
  fromId: string;
  toId: string;
  outcome: TaskOutcome;
  /** For failed: why. */
  reason: TaskReason | null;
  startedAt: string;
  /** The latest thing that happened: a message, a decision, a pickup. */
  updatedAt: string;
  /** When the outcome was reached: answered, denied, expired or given up on. Null while it's open. */
  endedAt: string | null;
  /** When the first message was held for a person's decision; it stays set after the decision. */
  heldAt: string | null;
  /** When the agent asked picked the first message up. */
  pickedUpAt: string | null;
  /** The latest answer from the agent that was asked. Not final when that agent said more is coming. */
  answer: { id: string; subject: string; summary: string | null; final: boolean; createdAt: string } | null;
  /**
   * The first message said no reply is needed: the task is done once that message is picked up, unless the agent
   * asked answers anyway. A flag on a later message changes nothing here.
   */
  noReplyNeeded: boolean;
  /** A held message in the task, for the decision buttons. */
  heldMessageId: string | null;
  /**
   * The first message never left its sender's side (`neverSent`): only the sender's side may see the task.
   */
  outboundHeld: boolean;
  messageCount: number;
  steps: TaskStep[];
}

/** A message as a task needs it: everything but the text and the key. */
type TaskMessage = Omit<Message, "text" | "sendKey">;

/**
 * Whether a message's receiver may read the message: it was never held, or a person allowed it. Until then the message
 * is the person's to decide on, not the receiver's to see.
 */
export function letThrough(m: Pick<Message, "heldAt" | "decision">): boolean {
  return m.heldAt === null || m.decision === "allow_once" || m.decision === "always_allow";
}

/**
 * Whether a message never left its sender's side: held on its way out for the sender's own person, and still waiting
 * there, turned down there, or ended there. The receiving side, person and agent, must not see its subject or text,
 * nor that it exists. Once the sender's person lets it go it is an ordinary message.
 */
export function neverSent(m: Pick<Message, "status" | "heldFor">): boolean {
  return m.heldFor === "outbound" && m.status !== "pending" && m.status !== "delivered";
}

/**
 * Whether a reader with these agents may count a message at all: everything but a message that never left someone
 * else's side. `mine` null reads everything (the sweeps).
 */
function readable(m: Pick<Message, "status" | "heldFor" | "fromId">, mine: string[] | null): boolean {
  return mine === null || !neverSent(m) || mine.includes(m.fromId);
}

function latest(...times: (string | null)[]): string {
  return times.filter((t): t is string => t !== null).sort().at(-1)!;
}

/**
 * The task one conversation's messages make, oldest first, under its first message's ID. The first message is the root,
 * or the oldest left when an earlier Portico pruned the root alone.
 *
 * Done means the agent asked gave a final answer: its latest answer that went through (not held, declined or expired)
 * isn't an update with more to come. The task ended with the first of the final answers after the last update.
 *
 * Done also means a first message that said no reply is needed was picked up, with no answer from the agent asked:
 * the task ended at pickup, and no wait for an answer ever starts. An answer sent anyway counts as on any other task.
 */
export function taskOf(rootId: string, chain: TaskMessage[], now: Date): Task {
  const root = chain.find((m) => m.id === rootId) ?? chain[0]!;
  const answers = chain.filter((m) => m.fromId === root.toId && (m.status === "pending" || m.status === "delivered"));
  const lastAnswer = answers.at(-1) ?? null;
  const held = chain.find((m) => m.status === "held") ?? null;
  // Only the conversation's own first message: once that one is pruned, the oldest reply left closes nothing.
  const noReplyNeeded = root.id === rootId && root.noReplyNeeded;

  let outcome: TaskOutcome;
  let reason: TaskReason | null = null;
  let endedAt: string | null = null;
  if (held) outcome = "needs_approval";
  else if (lastAnswer?.final) {
    outcome = "done";
    let first = answers.length - 1;
    while (first > 0 && answers[first - 1]!.final) first--;
    endedAt = answers[first]!.createdAt;
  } else if (root.status === "declined") {
    outcome = "failed";
    reason = "not_allowed";
    endedAt = root.decidedAt;
  } else if (root.status === "expired") {
    outcome = "failed";
    reason = "expired";
    endedAt = root.expiresAt;
  } else if (root.status === "withdrawn") {
    outcome = "failed";
    reason = "withdrawn";
    endedAt = root.withdrawnAt ?? root.createdAt;
  } else if (root.status === "pending") outcome = "in_progress";
  else if (noReplyNeeded && lastAnswer === null) {
    outcome = "done";
    endedAt = root.deliveredAt ?? root.createdAt;
  } else {
    // Picked up: the clock runs from pickup, and starts again with each update.
    const givenUp = Date.parse(latest(root.deliveredAt ?? root.createdAt, lastAnswer?.createdAt ?? null)) + NO_ANSWER_AFTER_MS;
    if (givenUp <= now.getTime()) {
      outcome = "failed";
      reason = "no_answer";
      endedAt = new Date(givenUp).toISOString();
    } else outcome = "in_progress";
  }

  const steps: TaskStep[] = [{ kind: "asked", at: root.createdAt, personId: null, decision: null }];
  if (root.decision && root.decidedAt) {
    steps.push({
      kind: root.decision === "deny" ? "denied" : "allowed",
      at: root.decidedAt,
      personId: root.decidedBy,
      decision: root.decision,
    });
  }
  if (root.deliveredAt) steps.push({ kind: "picked_up", at: root.deliveredAt, personId: null, decision: null });
  if (root.status === "expired") steps.push({ kind: "expired", at: root.expiresAt, personId: null, decision: null });
  if (root.status === "withdrawn") steps.push({ kind: "withdrawn", at: root.withdrawnAt ?? root.createdAt, personId: null, decision: null });
  if (outcome === "done" && lastAnswer) steps.push({ kind: "answered", at: endedAt!, personId: null, decision: null });

  return {
    id: rootId,
    workspaceId: root.workspaceId,
    subject: root.subject,
    fromId: root.fromId,
    toId: root.toId,
    outcome,
    reason,
    startedAt: root.createdAt,
    updatedAt: latest(...chain.flatMap((m) => [m.createdAt, m.decidedAt, m.deliveredAt, m.withdrawnAt]), endedAt),
    endedAt,
    heldAt: root.heldAt,
    pickedUpAt: root.deliveredAt,
    answer: lastAnswer
      ? {
          id: lastAnswer.id,
          subject: lastAnswer.subject,
          summary: lastAnswer.summary,
          final: lastAnswer.final,
          createdAt: lastAnswer.createdAt,
        }
      : null,
    noReplyNeeded,
    heldMessageId: held?.id ?? null,
    outboundHeld: neverSent(root),
    messageCount: chain.length,
    steps,
  };
}

interface TaskRow {
  id: string;
  thread_id: string;
  from_id: string;
  to_id: string;
  subject: string;
  reply_to: string | null;
  root_id: string;
  summary: string | null;
  final: number;
  status: string;
  held_at: string | null;
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  expires_at: string;
  delivered_at: string | null;
  withdrawn_at: string | null;
  held_for: string | null;
  sender_notified_at: string | null;
}

const COLUMNS = `id, thread_id, from_id, to_id, subject, reply_to, root_id, summary, final, status, held_at, held_for, decision,
  decided_by, decided_at, created_at, expires_at, delivered_at, withdrawn_at, sender_notified_at`;

function toTaskMessage(row: TaskRow, workspaceId: string): TaskMessage {
  return {
    id: row.id,
    workspaceId,
    threadId: row.thread_id,
    fromId: row.from_id,
    toId: row.to_id,
    subject: row.subject,
    replyTo: row.reply_to,
    rootId: row.root_id,
    summary: row.summary,
    // The `final` column holds two facts: see FINAL in types.ts.
    ...finalFacts(row.final),
    status: row.status as MessageStatus,
    heldAt: row.held_at,
    heldFor: row.held_for as HeldFor | null,
    decision: row.decision as Decision | null,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deliveredAt: row.delivered_at,
    withdrawnAt: row.withdrawn_at,
    senderNotifiedAt: row.sender_notified_at,
  };
}

export interface TaskFilter {
  /** Only tasks with one of these agents: what a member may see. Null for everything (the owner). */
  visible: string[] | null;
  /** Only tasks this agent is in. */
  agentId?: string;
  /** Only tasks with one of these agents: a project's agents. */
  anyOf?: string[];
  /** Only tasks in conversations that run through this workspace. */
  workspaceId?: string;
  /** Only tasks with this outcome, or one of these. */
  outcome?: TaskOutcome | readonly TaskOutcome[];
  /** Only tasks started before this time: the next page. */
  before?: string;
  /** Only tasks with something new since this time. */
  since?: string;
  limit?: number;
}

export interface TasksDeps {
  content: Content;
  now?: () => Date;
}

type BuildFilter = Omit<TaskFilter, "outcome" | "before" | "since" | "limit">;

/**
 * Tasks, worked out from the stored messages, which are kept for 30 days. Every read names whose content to look in:
 * an agent's, or a person's. A task's messages are all in one workspace, so tasks from several workspaces merge into
 * one list without splitting any.
 */
export class Tasks {
  private readonly content: Content;
  private readonly now: () => Date;

  constructor(deps: TasksDeps) {
    this.content = deps.content;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Matching tasks, newest started first, a page at a time; the counts cover every outcome before the outcome filter,
   * for the status chips.
   */
  list(scope: Scope, filter: TaskFilter): { tasks: Task[]; counts: Record<TaskOutcome, number>; more: boolean } {
    const all = this.build(scope, filter);
    const counts: Record<TaskOutcome, number> = { needs_approval: 0, in_progress: 0, done: 0, failed: 0 };
    for (const task of all) counts[task.outcome]++;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const outcomes = filter.outcome === undefined ? null : typeof filter.outcome === "string" ? [filter.outcome] : filter.outcome;
    const matching = all.filter(
      (task) =>
        (!outcomes || outcomes.includes(task.outcome)) &&
        (!filter.before || task.startedAt < filter.before) &&
        (!filter.since || task.updatedAt >= filter.since),
    );
    return { tasks: matching.slice(0, limit), counts, more: matching.length > limit };
  }

  /** Every matching task, newest started first. */
  all(scope: Scope, filter: BuildFilter): Task[] {
    return this.build(scope, filter);
  }

  /** One task and its messages, oldest first. Null when none of its messages are left, or none are in the scope. */
  get(scope: Scope, rootId: string, mine: string[] | null = null): { task: Task; messageIds: string[] } | null {
    for (const { db, workspaceId } of this.content.of(scope)) {
      const chain = (db.query(`SELECT ${COLUMNS} FROM messages WHERE root_id = $rootId ORDER BY created_at, rowid`).all({ rootId }) as TaskRow[])
        .map((row) => toTaskMessage(row, workspaceId))
        .filter((m) => readable(m, mine));
      if (chain.length > 0) return { task: taskOf(rootId, chain, this.now()), messageIds: chain.map((m) => m.id) };
    }
    return null;
  }

  /** The task a message belongs to, looked for only in the scope's workspaces. */
  rootOf(scope: Scope, messageId: string): string | null {
    for (const { db } of this.content.of(scope)) {
      const row = db.query("SELECT root_id AS root FROM messages WHERE id = $id").get({ id: messageId }) as { root: string } | null;
      if (row) return row.root;
    }
    return null;
  }

  private build(scope: Scope, filter: BuildFilter): Task[] {
    const clauses: string[] = [];
    const bindings: Record<string, string> = {};
    const among = (ids: string[], prefix: string) => {
      if (ids.length === 0) return "0";
      const names = ids.map((id, i) => {
        bindings[`${prefix}${i}`] = id;
        return `$${prefix}${i}`;
      });
      return `(from_id IN (${names.join(", ")}) OR to_id IN (${names.join(", ")}))`;
    };
    if (filter.visible) clauses.push(among(filter.visible, "v"));
    if (filter.anyOf) clauses.push(among(filter.anyOf, "p"));
    if (filter.agentId) {
      clauses.push("(from_id = $agentId OR to_id = $agentId)");
      bindings.agentId = filter.agentId;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    // Only the one workspace, when the filter names one, and only when the scope covers that workspace.
    const within: Scope = filter.workspaceId === undefined ? scope : { ...scope, workspace: filter.workspaceId };
    const now = this.now();
    const tasks: Task[] = [];
    // The reader's own agents: a message that never left another side isn't part of any task the reader sees.
    const mine = filter.visible ?? (filter.agentId ? [filter.agentId] : null);
    for (const content of this.content.of(within)) tasks.push(...this.tasksIn(content, where, bindings, now, mine));
    // A task still held on its way out is its sender's side's alone: a person sees it only for that person's own agent.
    const own = filter.visible;
    const shown = own ? tasks.filter((task) => !task.outboundHeld || own.includes(task.fromId)) : tasks;
    return shown.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  }

  private tasksIn(content: ContentDb, where: string, bindings: Record<string, string>, now: Date, mine: string[] | null): Task[] {
    // Every message of a conversation is between the same two agents, so filtering messages keeps whole tasks.
    const rows = content.db.query(`SELECT ${COLUMNS} FROM messages ${where} ORDER BY created_at, rowid`).all(bindings) as TaskRow[];
    const chains = new Map<string, TaskMessage[]>();
    for (const row of rows) {
      const m = toTaskMessage(row, content.workspaceId);
      if (!readable(m, mine)) continue;
      const chain = chains.get(m.rootId) ?? [];
      chain.push(m);
      chains.set(m.rootId, chain);
    }
    return [...chains].map(([rootId, chain]) => taskOf(rootId, chain, now));
  }
}
