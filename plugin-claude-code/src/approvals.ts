import { errorName, type Logger } from "./log";
import { type DialogRunner, type PanelOutcome, panelSubject, panelText, type RunningPanel } from "./popup";
import { ApiError, type Decision, type PorticoClient } from "./portico-client";

/** The most panels open at once. Later requests wait, in order, for one to close. */
export const MAX_OPEN_PANELS = 5;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
/** setTimeout's longest delay. */
const MAX_TIMER_MS = 2_147_483_647;

/** An `approval_request` stream event: a held message for a person on this computer to decide. */
export interface ApprovalRequest {
  messageId: string;
  nonce: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  expiresAt: string;
}

export function parseApprovalRequest(data: unknown): ApprovalRequest | null {
  if (!data || typeof data !== "object") return null;
  const { messageId, nonce, from, to, subject, text, expiresAt } = data as Record<string, unknown>;
  const named = (value: unknown): value is string => typeof value === "string" && value !== "";
  if (!named(messageId) || !named(from) || !named(to) || !named(subject)) return null;
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return null;
  if (typeof text !== "string") return null;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  return { messageId, nonce, from, to, subject, text, expiresAt };
}

export interface ApprovalPanelsDeps {
  client: Pick<PorticoClient, "answerApproval">;
  /** Null when this session can't show pop-ups. */
  runner: DialogRunner | null;
  log: Logger;
  /** The pauses before retrying an answer Portico couldn't take. Default [1000, 2000]. */
  retryMs?: number[];
  now?: () => number;
  /**
   * Called once, when a panel fails to show. Pop-ups are then off for the rest of the process: the plugin reconnects
   * its stream without declaring them, so Portico moves the request to another session on the computer.
   */
  onUnavailable?: () => void;
}

interface OpenPanel {
  /** The newest nonce Portico sent for the message. Never logged. */
  nonce: string;
  panel: RunningPanel;
  timer: ReturnType<typeof setTimeout>;
  /** Each open panel's offset, so none hides another. */
  slot: number;
}

/**
 * One panel per open approval request, keyed by message, and at most MAX_OPEN_PANELS at once. The answer goes back
 * with the request's nonce.
 */
export class ApprovalPanels {
  private readonly panels = new Map<string, OpenPanel>();
  /** Requests waiting for a free panel, oldest first. */
  private readonly queue = new Map<string, ApprovalRequest>();
  /** Messages whose answer is being sent or retried: a request Portico sends again meanwhile opens no second panel. */
  private readonly answering = new Set<string>();
  /** The latest request Portico sent again while its message was being answered: shown if that answer fails. */
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
    const open = this.panels.get(request.messageId) ?? this.queue.get(request.messageId);
    if (open) {
      open.nonce = request.nonce;
      return;
    }
    if (this.answering.has(request.messageId)) {
      // Answered here already, and Portico's approval_closed follows. Kept in case that answer fails: say Portico
      // restarted and sent a new nonce, so the old one gets 403.
      this.resent.set(request.messageId, request);
      return;
    }
    if (!this.available) {
      if (!this.ignoredLogged) {
        this.deps.log("warn", "approval_request_ignored", { message_id: request.messageId, reason: "no_popup" });
      }
      this.ignoredLogged = true;
      return;
    }
    if (this.panels.size >= MAX_OPEN_PANELS) {
      this.queue.set(request.messageId, request);
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
      messageId: request.messageId,
      from: request.from,
      to: request.to,
      subject: panelSubject(request.subject),
      text: panelText(request.text),
      expiresAt: request.expiresAt,
      slot,
    });
    const timer = setTimeout(() => this.dismiss(request.messageId), Math.min(remaining, MAX_TIMER_MS));
    timer.unref?.(); // an open panel never keeps the process alive by itself
    const entry: OpenPanel = { nonce: request.nonce, panel, timer, slot };
    this.panels.set(request.messageId, entry);
    this.deps.log("info", "approval_popup_shown", { message_id: request.messageId });
    void panel.result.then((outcome) => this.settled(request.messageId, entry, outcome));
  }

  /** An `approval_closed` event: the message was decided, here or elsewhere, or expired. */
  closed(data: unknown): void {
    const messageId = (data as { messageId?: unknown } | null)?.messageId;
    if (typeof messageId !== "string") return;
    this.queue.delete(messageId);
    this.resent.delete(messageId);
    this.dismiss(messageId);
  }

  /** The stream dropped, or the plugin stops. Portico sends open requests again on reconnect. */
  closeAll(): void {
    this.queue.clear(); // first, so closing the panels opens none of the waiting requests
    this.resent.clear(); // Portico sends open requests again on reconnect
    for (const messageId of [...this.panels.keys()]) this.dismiss(messageId);
  }

  private dismiss(messageId: string): void {
    const entry = this.panels.get(messageId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.panels.delete(messageId); // forgotten first, so the kill's "dismissed" outcome sends nothing
    entry.panel.kill();
    this.openQueued();
  }

  /** Opens waiting requests, oldest first, while a panel is free. Without pop-ups they're dropped: none can show. */
  private openQueued(): void {
    for (const [messageId, request] of this.queue) {
      if (this.panels.size >= MAX_OPEN_PANELS) return;
      this.queue.delete(messageId);
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
  private async settled(messageId: string, entry: OpenPanel, outcome: PanelOutcome): Promise<void> {
    if (this.panels.get(messageId) !== entry) return; // closed, expired or dropped first
    clearTimeout(entry.timer);
    this.panels.delete(messageId);
    if (outcome.kind === "failed") {
      this.deps.log("warn", "approval_popup_failed", { message_id: messageId, code: outcome.code });
      this.turnOff();
    }
    if (outcome.kind === "answered") this.answering.add(messageId);
    this.openQueued();
    if (outcome.kind !== "answered") return;
    let answered = false;
    try {
      answered = await this.answer(messageId, { nonce: entry.nonce, decision: outcome.decision });
    } finally {
      this.answering.delete(messageId);
      const again = this.resent.get(messageId);
      this.resent.delete(messageId);
      // The answer didn't land, but Portico asked again meanwhile: show that request, with its nonce.
      if (!answered && again) this.request(again);
    }
  }

  /** Retries when Portico can't be reached or answers 5xx. Any 4xx is final. True once Portico took the answer. */
  private async answer(messageId: string, body: { nonce: string; decision: Decision }): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.deps.client.answerApproval(messageId, body);
        this.deps.log("info", "approval_answered", { message_id: messageId, decision: body.decision });
        return true;
      } catch (err) {
        const status = err instanceof ApiError ? err.status : null;
        const retry = status !== null && (status === 0 || status >= 500) ? this.retryMs[attempt] : undefined;
        if (retry === undefined) {
          this.deps.log(
            "warn",
            "approval_answer_failed",
            status === null ? { message_id: messageId, error: errorName(err) } : { message_id: messageId, status },
          );
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
