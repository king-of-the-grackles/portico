import { randomBytes } from "node:crypto";
import { defang } from "./core/framing";
import { sameSecret } from "./core/tokens";

/** The most of a message's text a pop-up shows, in code points. */
export const PANEL_TEXT_MAX = 500;
const HOUR_MS = 3_600_000;

/** Sent on the elected session's stream. */
export interface ApprovalRequestEvent {
  messageId: string;
  /** Random per message and session; the answer must carry it. Never logged. */
  nonce: string;
  /** The sender's and recipient's display names. */
  from: string;
  to: string;
  subject: string;
  /** Defanged and clipped to PANEL_TEXT_MAX. */
  text: string;
  expiresAt: string;
}

/** Sent to every connected session that was sent the request, once the message is decided or expires. */
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
  /** Every session ever sent this request, with the nonce it got. */
  nonces: Map<string, string>;
  /** Computer ID → the session elected there. */
  holders: Map<string, string>;
  closed: ApprovalClosedEvent["outcome"] | null;
}

/** `opened` for every connection, reconnects included; `closed` only when the agent loses its stream. */
export interface StreamChange {
  kind: "opened" | "closed";
  agentId: string;
  computerId: string | null;
  ownerId: string | null;
  popup: boolean;
}

export interface DeskStreams {
  send(agentId: string, event: "approval_request" | "approval_closed", data: Record<string, unknown>): boolean;
  isConnected(agentId: string): boolean;
  /** The computer's pop-up sessions, oldest connection first. */
  popupSessions(computerId: string): string[];
  /** The person's computers with at least one pop-up session. */
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
 * Open pop-up requests for held messages, in memory. Each request goes to one pop-up session on each computer of the
 * person who decides: the one whose stream connected first. When that stream closes, the next session there is
 * elected. A decision closes the request everywhere it was sent.
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

  /** Opens a request for a held message and sends it to the oldest pop-up session on each of the owner's computers. */
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

  /** Tells every connected session that was sent the request. The request is kept, closed, so a late answer gets 409. */
  close(messageId: string, outcome: ApprovalClosedEvent["outcome"]): void {
    const request = this.requests.get(messageId);
    if (!request || request.closed) return;
    request.closed = outcome;
    request.holders.clear();
    const event: ApprovalClosedEvent = { messageId, outcome };
    for (const agentId of request.nonces.keys()) {
      if (this.streams.isConnected(agentId)) this.streams.send(agentId, "approval_closed", { ...event });
    }
  }

  /** For the agent streams' change listener. */
  streamChanged(change: StreamChange): void {
    if (change.computerId === null || change.ownerId === null) return;
    if (change.kind === "closed") {
      this.release(change.agentId, change.computerId);
      return;
    }
    if (!change.popup) {
      // A holder that reopened without pop-ups (its panel failed to show) can't show the request: the next session takes it.
      this.release(change.agentId, change.computerId);
      return;
    }
    for (const request of this.requests.values()) {
      if (request.closed || request.ownerId !== change.ownerId) continue;
      const holder = request.holders.get(change.computerId);
      // No holder there yet, or the holder itself reconnecting: send it (again, with the same nonce).
      if (holder === undefined || holder === change.agentId) this.send(request, change.computerId, change.agentId);
    }
  }

  /** "open" only for the nonce this session was sent. Unknown message, wrong nonce and another session's nonce look alike. */
  check(messageId: string, agentId: string, nonce: string): "open" | "closed" | "unknown" {
    const request = this.requests.get(messageId);
    const sent = request?.nonces.get(agentId);
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

  /** The session holds nothing on the computer now: each request it held goes to the next session there. */
  private release(agentId: string, computerId: string): void {
    for (const request of this.requests.values()) {
      if (request.closed || request.holders.get(computerId) !== agentId) continue;
      request.holders.delete(computerId);
      this.electNext(request, computerId, agentId);
    }
  }

  private electNext(request: OpenRequest, computerId: string, except: string): void {
    const next = this.streams.popupSessions(computerId).find((candidate) => candidate !== except);
    if (next) this.send(request, computerId, next);
  }

  /**
   * Elects the session on the computer and sends it the request. The holder is set before sending: a failed send drops
   * the stream, the streams report the close synchronously, and streamChanged elects the next session.
   */
  private send(request: OpenRequest, computerId: string, agentId: string): void {
    const nonce = request.nonces.get(agentId) ?? this.newNonce();
    request.nonces.set(agentId, nonce);
    request.holders.set(computerId, agentId);
    if (this.streams.send(agentId, "approval_request", { ...request.view, nonce })) {
      this.log("approval_request_sent", { message_id: request.view.messageId, agent_id: agentId });
      return;
    }
    // A stream already gone (dropped earlier in the same round) reports no close, so nothing else moves the request on.
    if (request.holders.get(computerId) === agentId && !this.streams.isConnected(agentId)) {
      request.holders.delete(computerId);
      this.electNext(request, computerId, agentId);
    }
  }
}
