import type { Store } from "../db";
import { BridgeError } from "./errors";
import { resolveRule } from "./rules";
import { isFinal } from "./types";
import type { AgentConfig, BridgeConfig, Notice, Task, TaskStatus } from "./types";

export interface ServiceDeps {
  store: Store;
  config: BridgeConfig;
  now?: () => Date;
  newId?: () => string;
  notify?: (notice: Notice) => void;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

const HOUR_MS = 3_600_000;

export class BridgeService {
  private readonly store: Store;
  private readonly config: BridgeConfig;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly notify: (notice: Notice) => void;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  private readonly lastCheckIns = new Map<string, string>();

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.notify = deps.notify ?? (() => {});
    this.log = deps.log ?? (() => {});
  }

  listAgents(caller: string): AgentConfig[] {
    return this.config.agents.filter((agent) => agent.name !== caller);
  }

  lastCheckIn(agent: string): string | null {
    return this.lastCheckIns.get(agent) ?? null;
  }

  sendTask(caller: string, input: { to: string; instructions: string }): Task {
    this.requireText("instructions", input.instructions);
    this.requireReceiver(caller, input.to);
    this.requireTaskBudget(caller, 1);
    return this.createTask(caller, input.to, input.instructions, { eventId: null, triggerName: null });
  }

  checkInbox(caller: string): { tasks: Task[]; results: Task[] } {
    const at = this.iso();
    this.lastCheckIns.set(caller, at);
    return this.store.transaction(() => {
      const tasks = this.store.listQueuedFor(caller).map((task) => {
        this.log("task_status", { task_id: task.id, status: "working" });
        return this.store.updateTask(task.id, { status: "working", updatedAt: at });
      });
      const results = this.store
        .listUnseenResultsFor(caller)
        .map((task) => this.store.updateTask(task.id, { senderNotifiedAt: at }));
      return { tasks, results };
    });
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

  getTask(caller: string, taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.fromAgent !== caller && task.toAgent !== caller) {
      throw new BridgeError("not_allowed", "Only the sender or receiver can read this task.");
    }
    if (task.fromAgent === caller && isFinal(task.status) && task.senderNotifiedAt === null) {
      return this.store.updateTask(task.id, { senderNotifiedAt: this.iso() });
    }
    return task;
  }

  // ---- helpers (also used by the event, approval and expiry methods in Task 5) ----

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  private requireText(field: string, value: unknown): asserts value is string {
    if (typeof value !== "string" || value.trim() === "") {
      throw new BridgeError("bad_request", `${field} must be a non-empty string.`);
    }
    this.requireSize(field, value);
  }

  private requireSize(field: string, value: string): void {
    const maxKb = this.config.limits.maxTextKb;
    if (new TextEncoder().encode(value).length > maxKb * 1024) {
      throw new BridgeError("too_large", `${field} is larger than ${maxKb} KB.`);
    }
  }

  private requireReceiver(caller: string, to: unknown): void {
    if (typeof to !== "string" || to.trim() === "") throw new BridgeError("bad_request", "to must be an agent name.");
    if (to === caller) throw new BridgeError("bad_request", "An agent can't send a task to itself.");
    if (!this.config.agents.some((agent) => agent.name === to)) {
      const valid = this.listAgents(caller)
        .map((agent) => agent.name)
        .join(", ");
      throw new BridgeError("unknown_agent", `No agent named "${to}". Valid agents: ${valid}.`);
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
    origin: { eventId: string | null; triggerName: string | null },
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
      const { action, rule } = resolveRule(this.config.rules, from, to);
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
