import type { Store } from "../db";
import type { Directory } from "./directory";
import { BridgeError } from "./errors";
import { LOOP_LIMIT, LOOP_WINDOW_MS, loopGuardRetryAt } from "./guards";
import type { Presence } from "./presence";
import { resolveRule } from "./rules";
import { renderTemplate } from "./templates";
import { isFinal } from "./types";
import type {
  ApprovalInfo,
  BridgeConfig,
  BridgeEvent,
  DeliveryTier,
  DirectoryEntry,
  Message,
  Notice,
  Task,
  TaskStatus,
} from "./types";

export interface ServiceDeps {
  store: Store;
  config: BridgeConfig;
  /** Recipients and rule refs: bridge.yaml agents, hub-page assistants and sessions. */
  directory: Directory;
  /** Where check-ins are recorded. */
  presence: Presence;
  now?: () => Date;
  newId?: () => string;
  notify?: (notice: Notice) => void;
  log?: (msg: string, fields: Record<string, unknown>) => void;
  /** Where and how the owner can approve a waiting task (the approval desk). */
  approvalInfo?: (task: Task) => ApprovalInfo | null;
}

/** The most of each kind one deliveries list holds, and one ack may name, so a single ack always covers a list. */
export const DELIVERY_BATCH_MAX = 500;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const EVENT_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const EXPIRY_REASON: Record<"waiting_approval" | "queued" | "working", string> = {
  waiting_approval: "expired: not approved in time",
  queued: "expired: never picked up",
  working: "expired: not finished in time",
};

export class BridgeService {
  private readonly store: Store;
  private readonly config: BridgeConfig;
  private readonly directory: Directory;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly notify: (notice: Notice) => void;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  private readonly presence: Presence;
  private readonly approvalInfo: ((task: Task) => ApprovalInfo | null) | undefined;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.directory = deps.directory;
    this.presence = deps.presence;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.notify = deps.notify ?? (() => {});
    this.log = deps.log ?? (() => {});
    this.approvalInfo = deps.approvalInfo;
  }

  /** The live directory: every member but the caller, connected members first. */
  listAgents(caller: string): DirectoryEntry[] {
    return this.directory.entries(caller);
  }

  lastCheckIn(agent: string): string | null {
    return this.presence.lastCheckIn(agent);
  }

  hasWaiting(agent: string): boolean {
    return this.store.hasWaitingFor(agent, this.iso());
  }

  /** Queued tasks, unseen results and pending messages: what the caller's next check_inbox would pick up. */
  unreadCount(caller: string): number {
    return this.store.countWaitingFor(caller, this.iso());
  }

  /** How a queued task will reach its receiver; null for a task in any other state. */
  deliveryFor(task: Task): DeliveryTier | null {
    return task.status === "queued" ? this.directory.tier(task.toAgent) : null;
  }

  /** Where and how the owner can approve a waiting task; null for any other status. */
  approvalFor(task: Task): ApprovalInfo | null {
    return task.status === "waiting_approval" ? (this.approvalInfo?.(task) ?? null) : null;
  }

  sendTask(caller: string, input: { to: string; instructions: string; idempotencyKey?: string }): Task {
    this.requireText("instructions", input.instructions);
    const key = this.optionalIdempotencyKey(input.idempotencyKey);
    if (key !== null) {
      const existing = this.store.findByIdempotencyKey(caller, key);
      if (existing) {
        if (!this.isSameReceiver(existing.toAgent, input.to, caller) || existing.instructions !== input.instructions) {
          throw new BridgeError(
            "bad_request",
            "idempotency_key was already used for a different task. Use a new key for a new task.",
          );
        }
        return existing; // a retry: no new task, and it doesn't count against the rate limit
      }
    }
    const to = this.requireReceiver(caller, input.to);
    this.requireTaskBudget(caller, 1);
    return this.createTask(caller, to, input.instructions, {
      eventId: null,
      triggerName: null,
      idempotencyKey: key,
    });
  }

  /**
   * A message between the owner's agents. Rules, approvals and the chain check don't apply (spec §7.2); the guards do:
   * no broadcasts, the size limit, the per-sender hourly limit and the loop guard.
   */
  sendMessage(
    caller: string,
    input: { to?: string; text: string; replyTo?: string },
  ): { message: Message; delivery: DeliveryTier } {
    this.requireMessageText(input.text);
    let to = typeof input.to === "string" && input.to.trim() !== "" ? input.to : undefined;
    let replyTo: string | null = null;
    if (input.replyTo !== undefined && input.replyTo !== null && input.replyTo !== "") {
      const original = typeof input.replyTo === "string" ? this.store.getMessage(input.replyTo) : null;
      if (!original || (original.toAgent !== caller && original.fromAgent !== caller)) {
        throw new BridgeError("bad_request", "reply_to must be the ID of a message sent to or by this agent.");
      }
      replyTo = original.id;
      to ??= original.toAgent === caller ? original.fromAgent : original.toAgent;
    }
    if (!to) throw new BridgeError("bad_request", "to is required unless reply_to is given.");
    const receiver = this.directory.resolve(to, caller); // refuses broadcasts and unknown names
    if (receiver.address === caller) throw new BridgeError("bad_request", "An agent can't send a message to itself.");
    const limit = this.config.limits.messagesPerHourPerAgent;
    if (this.store.countMessagesFromSince(caller, this.iso(-HOUR_MS)) >= limit) {
      throw new BridgeError("rate_limited", `${caller} has reached the limit of ${limit} messages per hour.`);
    }
    const retryAt = loopGuardRetryAt(this.store.messageTimesBetween(caller, receiver.address, this.iso(-LOOP_WINDOW_MS)));
    if (retryAt) {
      // Rounded up to the minute, so a retry at the time named is never refused again.
      const retryMinute = new Date(Math.ceil(Date.parse(retryAt) / MINUTE_MS) * MINUTE_MS).toISOString();
      throw new BridgeError(
        "rate_limited",
        `Loop guard: ${LOOP_LIMIT} messages between ${caller} and ${receiver.address} in 10 minutes. ` +
          `Try again after ${retryMinute.slice(0, 16).replace("T", " ")} UTC.`,
      );
    }
    const message: Message = {
      id: this.newId(),
      fromAgent: caller,
      toAgent: receiver.address,
      text: input.text,
      replyTo,
      createdAt: this.iso(),
      expiresAt: this.iso(this.config.limits.messageExpiryHours * HOUR_MS),
      deliveredAt: null,
    };
    this.store.insertMessage(message);
    const delivery = this.directory.tier(receiver.address);
    this.log("message_sent", { message_id: message.id, from: caller, to: receiver.address, delivery });
    this.notify({ kind: "message_queued", message });
    return { message, delivery };
  }

  /**
   * Claims the caller's queued tasks, marks its results seen and marks its pending messages delivered. With
   * `messages: false`, messages are left out and stay pending, for a caller that would drop them.
   */
  checkInbox(caller: string, opts: { messages?: boolean } = {}): { tasks: Task[]; results: Task[]; messages: Message[] } {
    const at = this.iso();
    const outcome = this.store.transaction(() => {
      const tasks = this.store
        .listQueuedFor(caller)
        .map((task) => this.store.updateTask(task.id, { status: "working", updatedAt: at }));
      const results = this.store
        .listUnseenResultsFor(caller)
        .map((task) => this.store.updateTask(task.id, { senderNotifiedAt: at }));
      const pending = opts.messages === false ? [] : this.store.listPendingMessagesFor(caller, at);
      this.store.markMessagesDelivered(caller, pending.map((message) => message.id), at);
      const messages = pending.map((message) => ({ ...message, deliveredAt: at }));
      return { tasks, results, messages };
    });
    this.presence.checkedIn(caller, at);
    for (const task of outcome.tasks) this.log("task_status", { task_id: task.id, status: "working" });
    return outcome;
  }

  /**
   * What a push agent's plugin has to deliver, oldest first, at most DELIVERY_BATCH_MAX of each kind. Peeking changes
   * nothing but the check-in time; ackDeliveries claims.
   */
  pendingDeliveries(caller: string): { tasks: Task[]; results: Task[]; messages: Message[] } {
    const at = this.iso();
    const pending = {
      tasks: this.store.listQueuedFor(caller, DELIVERY_BATCH_MAX),
      results: this.store.listUnseenResultsFor(caller, DELIVERY_BATCH_MAX),
      messages: this.store.listPendingMessagesFor(caller, at, DELIVERY_BATCH_MAX),
    };
    this.presence.checkedIn(caller, at);
    return pending;
  }

  /**
   * Claims delivered tasks, marks delivered results seen and marks delivered messages delivered: only the caller's own,
   * and only those still in that state.
   */
  ackDeliveries(
    caller: string,
    ack: { tasks: string[]; results: string[]; messages: string[] },
  ): { tasks: number; results: number; messages: number } {
    const at = this.iso();
    const { claimed, seen, delivered } = this.store.transaction(() => ({
      claimed: this.store.claimQueued(caller, [...new Set(ack.tasks)], at),
      seen: this.store.markResultsSeen(caller, [...new Set(ack.results)], at),
      delivered: this.store.markMessagesDelivered(caller, [...new Set(ack.messages)], at),
    }));
    for (const task of claimed) this.log("task_status", { task_id: task.id, status: "working" });
    return { tasks: claimed.length, results: seen, messages: delivered };
  }

  finishTask(caller: string, input: { taskId: string; result?: string; failedReason?: string }): Task {
    const hasResult = typeof input.result === "string" && input.result.trim() !== "";
    const hasReason = typeof input.failedReason === "string" && input.failedReason.trim() !== "";
    if (hasResult === hasReason) {
      throw new BridgeError("bad_request", "Provide exactly one of result or failed_reason.");
    }
    const text = hasResult ? input.result! : input.failedReason!;
    this.requireSize(hasResult ? "result" : "failed_reason", text);
    const task = this.requireTask(input.taskId);
    if (task.toAgent !== caller) throw new BridgeError("not_allowed", "Only the receiving agent can finish a task.");
    if (isFinal(task.status)) return task;
    if (task.status !== "working") {
      throw new BridgeError(
        "wrong_status",
        `Task ${task.id} is ${task.status}; only a working task can be finished. Call check_inbox to pick it up first.`,
      );
    }
    const at = this.iso();
    const updated = this.store.updateTask(
      task.id,
      hasResult ? { status: "done", result: text, updatedAt: at } : { status: "failed", reason: text, updatedAt: at },
    );
    this.log("task_status", { task_id: task.id, status: updated.status });
    this.notify({ kind: "result_ready", task: updated });
    return updated;
  }

  getTask(caller: string, taskId: string, opts?: { expectedReceiver?: string }): Task {
    const task = this.requireTask(taskId);
    if (opts?.expectedReceiver !== undefined && task.toAgent !== opts.expectedReceiver) {
      throw new BridgeError("not_found", `No task ${taskId}.`);
    }
    if (task.fromAgent !== caller && task.toAgent !== caller) {
      throw new BridgeError("not_allowed", "Only the sender or receiver can read this task.");
    }
    if (task.fromAgent === caller && isFinal(task.status) && task.senderNotifiedAt === null) {
      return this.store.updateTask(task.id, { senderNotifiedAt: this.iso() });
    }
    return task;
  }

  reportEvent(caller: string, input: { name: string; details: string }): { event: BridgeEvent; tasks: Task[] } {
    if (typeof input.name !== "string" || !EVENT_NAME.test(input.name)) {
      throw new BridgeError("bad_request", "name must be 1–100 characters: letters, digits, _ . -");
    }
    const details = input.details ?? "";
    if (typeof details !== "string") throw new BridgeError("bad_request", "details must be a string.");
    this.requireSize("details", details);

    const eventLimit = this.config.limits.eventsPerHourPerAgent;
    if (this.store.countEventsFromSince(caller, this.iso(-HOUR_MS)) >= eventLimit) {
      throw new BridgeError("rate_limited", `${caller} has reached the limit of ${eventLimit} events per hour.`);
    }

    const event: BridgeEvent = { id: this.newId(), agent: caller, name: input.name, details, createdAt: this.iso() };
    const planned = this.config.triggers
      .filter((trigger) => trigger.when.agent === caller && trigger.when.event === input.name)
      .map((trigger) => ({ trigger, instructions: renderTemplate(trigger.send.instructions, event) }));
    for (const { trigger, instructions } of planned) {
      this.requireSize(`instructions for trigger ${trigger.name}`, instructions);
    }
    // Triggered tasks count against the reporting agent's budget; check them all before creating anything.
    if (planned.length > 0) this.requireTaskBudget(caller, planned.length);

    return this.store.transaction(() => {
      this.store.insertEvent(event);
      this.log("event_reported", { event_id: event.id, agent: caller, name: event.name, triggers: planned.length });
      const tasks = planned.map(({ trigger, instructions }) =>
        this.createTask(caller, trigger.send.to, instructions, { eventId: event.id, triggerName: trigger.name, idempotencyKey: null }),
      );
      return { event, tasks };
    });
  }

  approveTask(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.status !== "waiting_approval") {
      throw new BridgeError("wrong_status", `Task ${task.id} is already ${task.status}.`);
    }
    const updated = this.store.updateTask(task.id, { status: "queued", updatedAt: this.iso() });
    this.log("task_status", { task_id: task.id, status: "queued", by: "approval" });
    this.notify({ kind: "queued", task: updated });
    this.notify({ kind: "approval_decided", task: updated, outcome: "approved" });
    return updated;
  }

  denyTask(taskId: string, note?: string): Task {
    const task = this.requireTask(taskId);
    if (task.status !== "waiting_approval") {
      throw new BridgeError("wrong_status", `Task ${task.id} is already ${task.status}.`);
    }
    const reason = note?.trim() ? note.trim() : "denied by the user";
    this.requireSize("note", reason);
    const updated = this.store.updateTask(task.id, { status: "denied", reason, updatedAt: this.iso() });
    this.log("task_status", { task_id: task.id, status: "denied", by: "approval" });
    this.notify({ kind: "result_ready", task: updated });
    this.notify({ kind: "approval_decided", task: updated, outcome: "denied" });
    return updated;
  }

  expireDue(): Task[] {
    const at = this.iso();
    return this.store.transaction(() =>
      this.store.listExpirable(at).map((task) => {
        const reason = EXPIRY_REASON[task.status as keyof typeof EXPIRY_REASON];
        const updated = this.store.updateTask(task.id, { status: "expired", reason, updatedAt: at });
        this.log("task_status", { task_id: task.id, status: "expired", was: task.status });
        this.notify({ kind: "result_ready", task: updated });
        if (task.status === "waiting_approval") this.notify({ kind: "approval_decided", task: updated, outcome: "expired" });
        return updated;
      }),
    );
  }

  // Deletes finished tasks even if the sender never read the result: history_days bounds what the hub keeps.
  deleteOldHistory(): { tasks: number; events: number; messages: number } {
    const cutoff = this.iso(-this.config.limits.historyDays * DAY_MS);
    return {
      tasks: this.store.deleteFinishedBefore(cutoff),
      events: this.store.deleteEventsBefore(cutoff),
      messages: this.store.deleteMessagesBefore(cutoff),
    };
  }

  // ---- reads for the owner's own views (approval pages, the hub page): no caller check, no side effects ----

  findTask(taskId: string): Task | null {
    return this.store.getTask(taskId);
  }

  listTasks(filter: { agent?: string; status?: TaskStatus; limit: number; oldestFirst?: boolean }): Task[] {
    return this.store.listTasks(filter);
  }

  listEvents(filter: { agent?: string; limit: number }): BridgeEvent[] {
    return this.store.listEvents(filter);
  }

  /** The tasks that led to this one, oldest first: each was being worked on when the next was sent. */
  chainOf(task: Task): Task[] {
    const chain: Task[] = [];
    let parentId = task.parentTaskId;
    while (parentId && chain.length < 20) {
      const parent = this.store.getTask(parentId);
      if (!parent) break;
      chain.unshift(parent);
      parentId = parent.parentTaskId;
    }
    return chain;
  }

  // ---- helpers ----

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  private requireText(field: string, value: unknown): asserts value is string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new BridgeError("bad_request", `${field} must be a non-empty string.`);
    }
    this.requireSize(field, value);
  }

  private optionalIdempotencyKey(value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new BridgeError("bad_request", "idempotency_key must be a string of up to 100 printable characters.");
    }
    return value;
  }

  private requireSize(field: string, value: string, maxKb = this.config.limits.maxTextKb): void {
    if (new TextEncoder().encode(value).length > maxKb * 1024) {
      throw new BridgeError("too_large", `${field} is larger than ${maxKb} KB.`);
    }
  }

  /** A message's text: non-empty, and within max_message_kb rather than max_text_kb. */
  private requireMessageText(value: unknown): asserts value is string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new BridgeError("bad_request", "text must be a non-empty string.");
    }
    this.requireSize("text", value, this.config.limits.maxMessageKb);
  }

  /** The receiver's full address. A short session name resolves when it's unique. */
  private requireReceiver(caller: string, to: unknown): string {
    const receiver = this.directory.resolve(to, caller);
    if (receiver.address === caller) throw new BridgeError("bad_request", "An agent can't send a task to itself.");
    return receiver.address;
  }

  /**
   * Whether a retry's `to` names the stored receiver: the same text, the stored session's short name (even once that
   * name is ambiguous or the session is gone), or a name that still resolves to it.
   */
  private isSameReceiver(stored: string, to: unknown, caller: string): boolean {
    if (to === stored) return true;
    if (typeof to === "string" && !to.includes("@") && stored.startsWith(`${to}@`)) return true;
    try {
      return this.directory.resolve(to, caller).address === stored;
    } catch (err) {
      if (err instanceof BridgeError) return false;
      throw err;
    }
  }

  private requireTaskBudget(caller: string, needed: number): void {
    const limit = this.config.limits.tasksPerHourPerAgent;
    const used = this.store.countTasksFromSince(caller, this.iso(-HOUR_MS));
    if (used + needed > limit) {
      throw new BridgeError("rate_limited", `${caller} has reached the limit of ${limit} tasks per hour.`);
    }
  }

  private requireTask(id: unknown): Task {
    if (typeof id !== "string" || id === "") throw new BridgeError("bad_request", "task_id is required.");
    const task = this.store.getTask(id);
    if (!task) throw new BridgeError("not_found", `No task ${id}.`);
    return task;
  }

  private createTask(
    from: string,
    to: string,
    instructions: string,
    origin: { eventId: string | null; triggerName: string | null; idempotencyKey: string | null },
  ): Task {
    const at = this.iso();
    const parent = this.store.latestWorkingFor(from);
    const chainLength = parent ? parent.chainLength + 1 : 1;
    const maxChain = this.config.limits.maxChainLength;

    let status: TaskStatus;
    let reason: string | null = null;
    if (parent && chainLength > maxChain) {
      status = "denied";
      reason =
        maxChain === 1
          ? `chained tasks are off; finish task ${parent.id} first`
          : `chain too long (limit ${maxChain}); finish task ${parent.id} first`;
    } else {
      const { action, rule } = resolveRule(this.config.rules, this.directory.ref(from), this.directory.ref(to));
      // A chained task never passes straight through: "allow" becomes "ask".
      const effective = parent && action === "allow" ? "ask" : action;
      if (effective === "block") {
        status = "denied";
        reason = rule ? "blocked by rule" : `no rule allows ${from} → ${to}`;
      } else {
        status = effective === "allow" ? "queued" : "waiting_approval";
      }
    }

    const task: Task = {
      id: this.newId(),
      fromAgent: from,
      toAgent: to,
      instructions,
      status,
      result: null,
      reason,
      parentTaskId: parent?.id ?? null,
      chainLength,
      eventId: origin.eventId,
      triggerName: origin.triggerName,
      // A task denied at creation is reported in the response itself, so it's already "seen".
      senderNotifiedAt: status === "denied" ? at : null,
      createdAt: at,
      updatedAt: at,
      expiresAt: this.iso(this.config.limits.taskExpiryHours * HOUR_MS),
      idempotencyKey: origin.idempotencyKey,
    };
    this.store.insertTask(task);
    this.log("task_created", {
      task_id: task.id,
      from,
      to,
      status,
      chain_length: chainLength,
      trigger: origin.triggerName,
    });
    if (status === "queued") this.notify({ kind: "queued", task });
    if (status === "waiting_approval") this.notify({ kind: "approval_needed", task });
    return task;
  }
}
