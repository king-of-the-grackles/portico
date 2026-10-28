import { randomBytes } from "node:crypto";
import { defang } from "./core/framing";
import { sameSecret } from "./core/tokens";

/** The most of a message's text a pop-up shows, in code points. */
export const PANEL_TEXT_MAX = 500;
const HOUR_MS = 3_600_000;

/** Sent on the elected run's stream. */
export interface ApprovalRequestEvent {
  messageId: string;
  /** Random per message and run; the answer must carry it. Never logged. */
  nonce: string;
  /** The sender's and recipient's display names. */
  from: string;
  to: string;
  subject: string;
  /** Defanged and clipped to PANEL_TEXT_MAX. */
  text: string;
  expiresAt: string;
}

/** Sent to every connected run that was sent the request, once the message is decided or expires. */
export interface ApprovalClosedEvent {
  messageId: string;
  outcome: "allowed" | "declined" | "expired";
}

/** What the desk needs to open a request: the held message, and who decides it. */
export interface HeldRequest {
  messageId: string;
  /** The person who manages the recipient: only that person's computers show the pop-up. */
  ownerId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  expiresAt: string;
}

interface OpenRequest {
  ownerId: string;
  view: Omit<ApprovalRequestEvent, "nonce">;
  /** Every run ever sent this request, with the nonce it got. */
  nonces: Map<string, string>;
  /** Computer ID → the run elected there. */
  holders: Map<string, string>;
  closed: ApprovalClosedEvent["outcome"] | null;
}

/** `opened` for every connection, reconnects included; `closed` only when the run loses its stream. */
export interface StreamChange {
  kind: "opened" | "closed";
  agentId: string;
  runId: string;
  computerId: string | null;
  ownerId: string | null;
  popup: boolean;
}

/** The desk talks to runs: each terminal or Codex conversation that can show pop-ups. */
export interface DeskStreams {
  sendRun(runId: string, event: "approval_request" | "approval_closed", data: Record<string, unknown>): boolean;
  isRunConnected(runId: string): boolean;
  /** The computer's pop-up runs, oldest connection first. */
  popupSessions(computerId: string): string[];
  /** The person's computers with at least one pop-up run. */
  popupComputers(ownerId: string): string[];
}

/** The message's text as a pop-up shows it: defanged, trimmed, and clipped to 500 code points with "…". */
export function panelText(text: string): string {
  const chars = Array.from(defang(text).trim());
  return chars.length > PANEL_TEXT_MAX ? `${chars.slice(0, PANEL_TEXT_MAX).join("")}…` : chars.join("");
}

export interface DeskDeps {
  streams: DeskStreams;
  now?: () => Date;
  /** Default: 24 random bytes as base64url, 32 characters. */
  newNonce?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Open pop-up requests for held messages, in memory. Each request goes to one pop-up run on each computer of the
 * person who decides: the one whose stream connected first. When that stream closes, the next run there is elected.
 * A decision closes the request everywhere it was sent.
 */
export class Desk {
  private readonly requests = new Map<string, OpenRequest>();
  private readonly streams: DeskStreams;
  private readonly now: () => Date;
  private readonly newNonce: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: DeskDeps) {
    this.streams = deps.streams;
    this.now = deps.now ?? (() => new Date());
    this.newNonce = deps.newNonce ?? (() => randomBytes(24).toString("base64url"));
    this.log = deps.log ?? (() => {});
  }

  /** Opens a request for a held message and sends it to the oldest pop-up run on each of the owner's computers. */
  open(held: HeldRequest): void {
    if (this.requests.has(held.messageId)) return;
    const request: OpenRequest = {
      ownerId: held.ownerId,
      view: {
        messageId: held.messageId,
        from: held.from,
        to: held.to,
        subject: defang(held.subject),
        text: panelText(held.text),
        expiresAt: held.expiresAt,
      },
      nonces: new Map(),
      holders: new Map(),
      closed: null,
    };
    this.requests.set(held.messageId, request);
    for (const computerId of this.streams.popupComputers(held.ownerId)) {
      const oldest = this.streams.popupSessions(computerId)[0];
      if (oldest) this.send(request, computerId, oldest);
    }
  }

  /** Tells every connected run that was sent the request. The request is kept, closed, so a late answer gets 409. */
  close(messageId: string, outcome: ApprovalClosedEvent["outcome"]): void {
    const request = this.requests.get(messageId);
    if (!request || request.closed) return;
    request.closed = outcome;
    request.holders.clear();
    const event: ApprovalClosedEvent = { messageId, outcome };
    for (const runId of request.nonces.keys()) {
      if (this.streams.isRunConnected(runId)) this.streams.sendRun(runId, "approval_closed", { ...event });
    }
  }

  /** For the agent streams' change listener. */
  streamChanged(change: StreamChange): void {
    if (change.computerId === null || change.ownerId === null) return;
    if (change.kind === "closed") {
      this.release(change.runId, change.computerId);
      return;
    }
    if (!change.popup) {
      // A holder that reopened without pop-ups (its panel failed to show) can't show the request: the next run takes it.
      this.release(change.runId, change.computerId);
      return;
    }
    for (const request of this.requests.values()) {
      if (request.closed || request.ownerId !== change.ownerId) continue;
      const holder = request.holders.get(change.computerId);
      // No holder there yet, or the holder itself reconnecting: send it (again, with the same nonce).
      if (holder === undefined || holder === change.runId) this.send(request, change.computerId, change.runId);
    }
  }

  /** "open" only for the nonce this run was sent. Unknown message, wrong nonce and another run's nonce look alike. */
  check(messageId: string, runId: string, nonce: string): "open" | "closed" | "unknown" {
    const request = this.requests.get(messageId);
    const sent = request?.nonces.get(runId);
    if (!request || sent === undefined || !sameSecret(sent, nonce)) return "unknown";
    return request.closed ? "closed" : "open";
  }

  /** Forgets closed requests whose message has expired, and open ones an hour past expiry (a missed close). */
  sweep(): number {
    const now = this.now().getTime();
    let removed = 0;
    for (const [messageId, request] of this.requests) {
      const expiry = Date.parse(request.view.expiresAt);
      if ((request.closed && expiry <= now) || expiry + HOUR_MS <= now) {
        this.requests.delete(messageId);
        removed++;
      }
    }
    return removed;
  }

  /** The run holds nothing on the computer now: each request it held goes to the next run there. */
  private release(runId: string, computerId: string): void {
    for (const request of this.requests.values()) {
      if (request.closed || request.holders.get(computerId) !== runId) continue;
      request.holders.delete(computerId);
      this.electNext(request, computerId, runId);
    }
  }

  private electNext(request: OpenRequest, computerId: string, except: string): void {
    const next = this.streams.popupSessions(computerId).find((candidate) => candidate !== except);
    if (next) this.send(request, computerId, next);
  }

  /**
   * Elects the run on the computer and sends it the request. The holder is set before sending: a failed send drops
   * the stream, the streams report the close synchronously, and streamChanged elects the next run.
   */
  private send(request: OpenRequest, computerId: string, runId: string): void {
    const nonce = request.nonces.get(runId) ?? this.newNonce();
    request.nonces.set(runId, nonce);
    request.holders.set(computerId, runId);
    if (this.streams.sendRun(runId, "approval_request", { ...request.view, nonce })) {
      this.log("approval_request_sent", { message_id: request.view.messageId, run_id: runId });
      return;
    }
    // A stream already gone (dropped earlier in the same round) reports no close, so nothing else moves the request on.
    if (request.holders.get(computerId) === runId && !this.streams.isRunConnected(runId)) {
      request.holders.delete(computerId);
      this.electNext(request, computerId, runId);
    }
  }
}
