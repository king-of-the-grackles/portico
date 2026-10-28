import type { Database } from "bun:sqlite";
import { HOUR_MS, LIMITS } from "./limits";
import type { Decision, Message, MessageStatus } from "./types";

/**
 * Where a task stands, in detail. A task is one conversation between two agents: a message that isn't a reply, and
 * every reply in its chain. Worked out from the messages, never stored.
 */
export type TaskState = "needs_approval" | "queued" | "delivered" | "answered" | "no_answer" | "expired" | "denied";

/** The four outcomes the pages show: Needs a decision, In progress, Done, Didn't go through. */
export type TaskOutcome = "decide" | "in_progress" | "done" | "failed";
export const TASK_OUTCOMES: readonly TaskOutcome[] = ["decide", "in_progress", "done", "failed"];

const OUTCOMES: Record<TaskState, TaskOutcome> = {
  needs_approval: "decide",
  queued: "in_progress",
  delivered: "in_progress",
  answered: "done",
  no_answer: "failed",
  expired: "failed",
  denied: "failed",
};

/** A delivered question with no answer for this long didn't go through: the same window a held message gets. */
export const NO_ANSWER_AFTER_MS = LIMITS.messageExpiryHours * HOUR_MS;

export type TaskStepKind = "asked" | "held" | "allowed" | "denied" | "seen" | "expired" | "answered" | "answer_seen";

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
  subject: string;
  /** Who asked, and who was asked. Every message in a task is between these two. */
  fromId: string;
  toId: string;
  state: TaskState;
  outcome: TaskOutcome;
  startedAt: string;
  /** The latest thing that happened: a message, a decision, a delivery. */
  updatedAt: string;
  /** When the outcome was reached: answered, denied, expired or given up on. Null while it's open. */
  endedAt: string | null;
  /** The latest answer from the agent that was asked. */
  answer: { id: string; subject: string; summary: string | null; createdAt: string } | null;
  /** A held message in the task, for the decision buttons. */
  heldMessageId: string | null;
  messageCount: number;
  steps: TaskStep[];
}

/** A message as a task needs it: everything but the text. */
type TaskMessage = Omit<Message, "text">;

function latest(...times: (string | null)[]): string {
  return times.filter((t): t is string => t !== null).sort().at(-1)!;
}

/**
 * The task one conversation's messages make, oldest first, under its first message's ID. The first message is the root,
 * or the oldest left when an earlier Portico pruned the root alone.
 */
export function taskOf(rootId: string, chain: TaskMessage[], now: Date): Task {
  const root = chain.find((m) => m.id === rootId) ?? chain[0]!;
  const answers = chain.filter((m) => m.fromId === root.toId);
  const firstAnswer = answers[0] ?? null;
  const lastAnswer = answers.at(-1) ?? null;
  const held = chain.find((m) => m.status === "held") ?? null;

  let state: TaskState;
  let endedAt: string | null = null;
  if (held) state = "needs_approval";
  else if (lastAnswer) {
    state = "answered";
    endedAt = firstAnswer!.createdAt;
  } else if (root.status === "declined") {
    state = "denied";
    endedAt = root.decidedAt;
  } else if (root.status === "expired") {
    state = "expired";
    endedAt = root.expiresAt;
  } else if (root.status === "pending") state = "queued";
  else {
    const givenUp = Date.parse(root.deliveredAt ?? root.createdAt) + NO_ANSWER_AFTER_MS;
    if (givenUp <= now.getTime()) {
      state = "no_answer";
      endedAt = new Date(givenUp).toISOString();
    } else state = "delivered";
  }

  const steps: TaskStep[] = [{ kind: "asked", at: root.createdAt, personId: null, decision: null }];
  if (root.heldAt) steps.push({ kind: "held", at: root.heldAt, personId: null, decision: null });
  if (root.decision && root.decidedAt) {
    steps.push({
      kind: root.decision === "deny" ? "denied" : "allowed",
      at: root.decidedAt,
      personId: root.decidedBy,
      decision: root.decision,
    });
  }
  if (root.deliveredAt) steps.push({ kind: "seen", at: root.deliveredAt, personId: null, decision: null });
  if (root.status === "expired") steps.push({ kind: "expired", at: root.expiresAt, personId: null, decision: null });
  if (firstAnswer) {
    steps.push({ kind: "answered", at: firstAnswer.createdAt, personId: null, decision: null });
    if (firstAnswer.deliveredAt) steps.push({ kind: "answer_seen", at: firstAnswer.deliveredAt, personId: null, decision: null });
  }

  return {
    id: rootId,
    subject: root.subject,
    fromId: root.fromId,
    toId: root.toId,
    state,
    outcome: OUTCOMES[state],
    startedAt: root.createdAt,
    updatedAt: latest(...chain.flatMap((m) => [m.createdAt, m.decidedAt, m.deliveredAt]), endedAt),
    endedAt,
    answer: lastAnswer
      ? { id: lastAnswer.id, subject: lastAnswer.subject, summary: lastAnswer.summary, createdAt: lastAnswer.createdAt }
      : null,
    heldMessageId: held?.id ?? null,
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
  root_id: string | null;
  summary: string | null;
  status: string;
  held_at: string | null;
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  expires_at: string;
  delivered_at: string | null;
  sender_notified_at: string | null;
}

const COLUMNS = `id, thread_id, from_id, to_id, subject, reply_to, root_id, summary, status, held_at, decision, decided_by,
  decided_at, created_at, expires_at, delivered_at, sender_notified_at`;

function toTaskMessage(row: TaskRow): TaskMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    fromId: row.from_id,
    toId: row.to_id,
    subject: row.subject,
    replyTo: row.reply_to,
    rootId: row.root_id ?? row.id,
    summary: row.summary,
    status: row.status as MessageStatus,
    heldAt: row.held_at,
    decision: row.decision as Decision | null,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deliveredAt: row.delivered_at,
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
  outcome?: TaskOutcome;
  /** Only tasks started before this time: the next page. */
  before?: string;
  limit?: number;
}

export interface TasksDeps {
  db: Database;
  now?: () => Date;
}

/** Tasks, worked out from the stored messages, which are kept for 30 days. */
export class Tasks {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(deps: TasksDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Matching tasks, newest started first, a page at a time; the counts cover every outcome before the outcome filter,
   * for the status chips.
   */
  list(filter: TaskFilter): { tasks: Task[]; counts: Record<TaskOutcome, number>; more: boolean } {
    const all = this.build(filter);
    const counts: Record<TaskOutcome, number> = { decide: 0, in_progress: 0, done: 0, failed: 0 };
    for (const task of all) counts[task.outcome]++;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const matching = all.filter(
      (task) => (!filter.outcome || task.outcome === filter.outcome) && (!filter.before || task.startedAt < filter.before),
    );
    return { tasks: matching.slice(0, limit), counts, more: matching.length > limit };
  }

  /** Every matching task, newest started first. */
  all(filter: Omit<TaskFilter, "outcome" | "before" | "limit">): Task[] {
    return this.build(filter);
  }

  /** One task and its messages, oldest first. Null when none of its messages are left. */
  get(rootId: string): { task: Task; messageIds: string[] } | null {
    const chain = (
      this.db
        .query(`SELECT ${COLUMNS} FROM messages WHERE root_id = $rootId ORDER BY created_at, rowid`)
        .all({ rootId }) as TaskRow[]
    ).map(toTaskMessage);
    if (chain.length === 0) return null;
    return { task: taskOf(rootId, chain, this.now()), messageIds: chain.map((m) => m.id) };
  }

  /** The task a message belongs to. */
  rootOf(messageId: string): string | null {
    const row = this.db.query("SELECT COALESCE(root_id, id) AS root FROM messages WHERE id = $id").get({ id: messageId }) as {
      root: string;
    } | null;
    return row?.root ?? null;
  }

  private build(filter: Omit<TaskFilter, "outcome" | "before" | "limit">): Task[] {
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
    // Every message of a conversation is between the same two agents, so filtering messages keeps whole tasks.
    const rows = this.db.query(`SELECT ${COLUMNS} FROM messages ${where} ORDER BY created_at, rowid`).all(bindings) as TaskRow[];
    const chains = new Map<string, TaskMessage[]>();
    for (const row of rows) {
      const m = toTaskMessage(row);
      const chain = chains.get(m.rootId) ?? [];
      chain.push(m);
      chains.set(m.rootId, chain);
    }
    const now = this.now();
    return [...chains]
      .map(([rootId, chain]) => taskOf(rootId, chain, now))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  }
}
