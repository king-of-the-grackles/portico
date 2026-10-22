import { type HubClient, HubError } from "./hub-client";
import { errorName, type Logger } from "./log";
import { type DialogRunner, type PanelOutcome, panelText, type RunningPanel } from "./popup";

/** The longest note sent with Deny, in code points. */
export const NOTE_MAX = 2_000;
/** The most panels open at once. Later requests wait, in order, for one to close. */
export const MAX_OPEN_PANELS = 5;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
/** setTimeout's longest delay. */
const MAX_TIMER_MS = 2_147_483_647;

/** An `approval_request` stream event. */
export interface ApprovalRequest {
  taskId: string;
  nonce: string;
  from: string;
  to: string;
  instructions: string;
  expiresAt: string;
}

export function parseApprovalRequest(data: unknown): ApprovalRequest | null {
  if (!data || typeof data !== "object") return null;
  const { taskId, nonce, from, to, instructions, expiresAt } = data as Record<string, unknown>;
  const named = (value: unknown): value is string => typeof value === "string" && value !== "";
  if (!named(taskId) || !named(from) || !named(to)) return null;
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return null;
  if (typeof instructions !== "string") return null;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  return { taskId, nonce, from, to, instructions, expiresAt };
}

export interface ApprovalPanelsDeps {
  client: Pick<HubClient, "answerApproval">;
  /** Null when this session can't show pop-ups. */
  runner: DialogRunner | null;
  log: Logger;
  /** The pauses before retrying an answer the hub couldn't take. Default [1000, 2000]. */
  retryMs?: number[];
  now?: () => number;
  /**
   * Called once, when a panel fails to show. Pop-ups are then off for the rest of the process: the plugin reconnects
   * its stream without declaring them, so the hub moves the request to another session on the machine.
   */
  onUnavailable?: () => void;
}

interface OpenPanel {
  /** The newest nonce the hub sent for the task. Never logged. */
  nonce: string;
  panel: RunningPanel;
  timer: ReturnType<typeof setTimeout>;
  /** Each open panel's offset, so none hides another. */
  slot: number;
}

/**
 * One panel per open approval request, keyed by task, and at most MAX_OPEN_PANELS at once. The answer goes back with
 * the request's nonce.
 */
export class ApprovalPanels {
  private readonly panels = new Map<string, OpenPanel>();
  /** Requests waiting for a free panel, oldest first. */
  private readonly queue = new Map<string, ApprovalRequest>();
  /** Tasks whose answer is being sent or retried: a request the hub sends again meanwhile opens no second panel. */
  private readonly answering = new Set<string>();
  /** The latest request the hub sent again while its task was being answered: shown if that answer fails. */
  private readonly resent = new Map<string, ApprovalRequest>();
  private readonly now: () => number;
  private readonly retryMs: number[];
  private ignoredLogged = false;
  private failed = false;

  constructor(private readonly deps: ApprovalPanelsDeps) {
    this.now = deps.now ?? Date.now;
    this.retryMs = deps.retryMs ?? [1_000, 2_000];
  }

  /** Whether this session declares pop-ups: it has a runner, and no panel has failed to show. */
  get available(): boolean {
    return this.deps.runner !== null && !this.failed;
  }

  get openCount(): number {
    return this.panels.size;
  }

  /** An `approval_request` event. */
  request(data: unknown): void {
    const request = parseApprovalRequest(data);
    if (!request) return void this.deps.log("warn", "approval_request_invalid", {});
    // The same request again, say after a reconnect: keep the panel or the queued request, and take the newest nonce.
    const open = this.panels.get(request.taskId) ?? this.queue.get(request.taskId);
    if (open) {
      open.nonce = request.nonce;
      return;
    }
    if (this.answering.has(request.taskId)) {
      // Answered here already, and the hub's approval_closed follows. Kept in case that answer fails: say the hub
      // restarted and sent a new nonce, so the old one gets 403.
      this.resent.set(request.taskId, request);
      return;
    }
    if (!this.available) {
      if (!this.ignoredLogged) this.deps.log("warn", "approval_request_ignored", { task_id: request.taskId, reason: "no_popup" });
      this.ignoredLogged = true;
      return;
    }
    if (this.panels.size >= MAX_OPEN_PANELS) {
      this.queue.set(request.taskId, request);
      return;
    }
    this.show(request);
  }

  private show(request: ApprovalRequest): void {
    const runner = this.deps.runner;
    const remaining = Date.parse(request.expiresAt) - this.now();
    if (!runner || !(remaining > 0)) return;
    const slot = this.freeSlot();
    const panel = runner({
      taskId: request.taskId,
      from: request.from,
      to: request.to,
      instructions: panelText(request.instructions),
      expiresAt: request.expiresAt,
      slot,
    });
    const timer = setTimeout(() => this.dismiss(request.taskId), Math.min(remaining, MAX_TIMER_MS));
    timer.unref?.(); // an open panel never keeps the process alive by itself
    const entry: OpenPanel = { nonce: request.nonce, panel, timer, slot };
    this.panels.set(request.taskId, entry);
    this.deps.log("info", "approval_popup_shown", { task_id: request.taskId });
    void panel.result.then((outcome) => this.settled(request.taskId, entry, outcome));
  }

  /** An `approval_closed` event: the task was decided, here or elsewhere. */
  closed(data: unknown): void {
    const taskId = (data as { taskId?: unknown } | null)?.taskId;
    if (typeof taskId !== "string") return;
    this.queue.delete(taskId);
    this.resent.delete(taskId);
    this.dismiss(taskId);
  }

  /** The stream dropped, or the plugin stops. The hub sends open requests again on reconnect. */
  closeAll(): void {
    this.queue.clear(); // first, so closing the panels opens none of the waiting requests
    this.resent.clear(); // the hub sends open requests again on reconnect
    for (const taskId of [...this.panels.keys()]) this.dismiss(taskId);
  }

  private dismiss(taskId: string): void {
    const entry = this.panels.get(taskId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.panels.delete(taskId); // forgotten first, so the kill's "dismissed" outcome sends nothing
    entry.panel.kill();
    this.openQueued();
  }

  /** Opens waiting requests, oldest first, while a panel is free. Without pop-ups they're dropped: none can show. */
  private openQueued(): void {
    for (const [taskId, request] of this.queue) {
      if (this.panels.size >= MAX_OPEN_PANELS) return;
      this.queue.delete(taskId);
      if (this.available) this.show(request);
    }
  }

  /** The lowest offset no open panel holds. */
  private freeSlot(): number {
    const taken = new Set([...this.panels.values()].map((entry) => entry.slot));
    let slot = 0;
    while (taken.has(slot)) slot++;
    return slot;
  }

  /** Never throws. */
  private async settled(taskId: string, entry: OpenPanel, outcome: PanelOutcome): Promise<void> {
    if (this.panels.get(taskId) !== entry) return; // closed, expired or dropped first
    clearTimeout(entry.timer);
    this.panels.delete(taskId);
    if (outcome.kind === "failed") {
      this.deps.log("warn", "approval_popup_failed", { task_id: taskId, code: outcome.code });
      this.turnOff();
    }
    if (outcome.kind === "answered") this.answering.add(taskId);
    this.openQueued();
    if (outcome.kind !== "answered") return;
    const body: { nonce: string; decision: "approve" | "deny"; note?: string } = { nonce: entry.nonce, decision: outcome.decision };
    if (outcome.decision === "deny") {
      // The note is a reason for Deny only, as on the hub page.
      const note = Array.from(outcome.note.trim()).slice(0, NOTE_MAX).join("");
      if (note) body.note = note;
    }
    let answered = false;
    try {
      answered = await this.answer(taskId, body);
    } finally {
      this.answering.delete(taskId);
      const again = this.resent.get(taskId);
      this.resent.delete(taskId);
      // The answer didn't land, but the hub asked again meanwhile: show that request, with its nonce.
      if (!answered && again) this.request(again);
    }
  }

  /** Retries when the hub can't be reached or answers 5xx. Any 4xx is final. True once the hub took the answer. */
  private async answer(taskId: string, body: { nonce: string; decision: "approve" | "deny"; note?: string }): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.deps.client.answerApproval(taskId, body);
        this.deps.log("info", "approval_answered", { task_id: taskId, decision: body.decision });
        return true;
      } catch (err) {
        const status = err instanceof HubError ? err.status : null;
        const retry = status !== null && (status === 0 || status >= 500) ? this.retryMs[attempt] : undefined;
        if (retry === undefined) {
          this.deps.log("warn", "approval_answer_failed", status === null ? { task_id: taskId, error: errorName(err) } : { task_id: taskId, status });
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, retry));
      }
    }
  }

  private turnOff(): void {
    if (this.failed) return;
    this.failed = true;
    this.deps.log("warn", "approval_popup_unavailable", { platform: process.platform, reason: "failed" });
    this.deps.onUnavailable?.();
  }
}
