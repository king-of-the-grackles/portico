import { randomBytes, timingSafeEqual } from "node:crypto";
import { defang } from "../core/framing";
import type { ApprovalInfo, ApprovalOutcome, Task } from "../core/types";
import { listOf } from "../core/words";
import type { StreamChange, AgentStreams } from "../ways-in/stream";

/** The most of a task's instructions a pop-up shows, in code points. */
export const PANEL_TEXT_MAX = 500;
const HOUR_MS = 3_600_000;

/** Sent on the elected session's stream. camelCase, unlike the REST views. */
export interface ApprovalRequestEvent {
  taskId: string;
  /** Random per task and session; the answer must carry it. Never logged. */
  nonce: string;
  from: string;
  to: string;
  /** Defanged and clipped to PANEL_TEXT_MAX. */
  instructions: string;
  expiresAt: string;
}

/** Sent to every connected session that was sent the request, once the task is decided. */
export interface ApprovalClosedEvent {
  taskId: string;
  outcome: ApprovalOutcome;
}

interface OpenRequest {
  view: Omit<ApprovalRequestEvent, "nonce">;
  /** Every session ever sent this request, with the nonce it got. */
  nonces: Map<string, string>;
  /** Machine name → the session elected there. */
  holders: Map<string, string>;
  closed: ApprovalOutcome | null;
}

/** The task's instructions as a pop-up shows them: defanged, trimmed, and clipped to 500 code points with "…". */
export function panelInstructions(text: string): string {
  const chars = Array.from(defang(text).trim());
  return chars.length > PANEL_TEXT_MAX ? `${chars.slice(0, PANEL_TEXT_MAX).join("")}…` : chars.join("");
}

/** The sentence send_task's result carries for a waiting task. */
export function approvalNote(url: string, popups: string[]): string {
  if (popups.length === 0) return `Waiting for the owner's approval at ${url}. No joined machine is online to show a pop-up.`;
  return `Waiting for the owner's approval. A pop-up is up on ${listOf(popups)}; the owner can also approve at ${url}.`;
}

export interface ApprovalDeskDeps {
  streams: Pick<AgentStreams, "send" | "isConnected" | "popupSessions" | "popupMachines">;
  publicUrl: string;
  now?: () => Date;
  /** Default: 24 random bytes as base64url, 32 characters. */
  newNonce?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Open approval requests, in memory. Each request goes to one pop-up session per machine: the one whose stream
 * connected first. When that stream closes, the next session there is elected. A decision closes the request
 * everywhere it was sent.
 */
export class ApprovalDesk {
  private readonly requests = new Map<string, OpenRequest>();
  private readonly streams: ApprovalDeskDeps["streams"];
  private readonly publicUrl: string;
  private readonly now: () => Date;
  private readonly newNonce: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: ApprovalDeskDeps) {
    this.streams = deps.streams;
    this.publicUrl = deps.publicUrl;
    this.now = deps.now ?? (() => new Date());
    this.newNonce = deps.newNonce ?? (() => randomBytes(24).toString("base64url"));
    this.log = deps.log ?? (() => {});
  }

  /** Opens a request for a waiting task and sends it to each machine's oldest pop-up session. */
  open(task: Task): void {
    if (task.status !== "waiting_approval" || this.requests.has(task.id)) return;
    const request: OpenRequest = {
      view: {
        taskId: task.id,
        from: task.fromAgent,
        to: task.toAgent,
        instructions: panelInstructions(task.instructions),
        expiresAt: task.expiresAt,
      },
      nonces: new Map(),
      holders: new Map(),
      closed: null,
    };
    this.requests.set(task.id, request);
    for (const machine of this.streams.popupMachines()) {
      const oldest = this.streams.popupSessions(machine)[0];
      if (oldest) this.send(request, machine, oldest);
    }
  }

  /** Tells every connected session that was sent the request. The request is kept, closed, so a late answer gets 409. */
  close(taskId: string, outcome: ApprovalOutcome): void {
    const request = this.requests.get(taskId);
    if (!request || request.closed) return;
    request.closed = outcome;
    request.holders.clear();
    const event: ApprovalClosedEvent = { taskId, outcome };
    for (const address of request.nonces.keys()) {
      if (this.streams.isConnected(address)) this.streams.send(address, "approval_closed", { ...event });
    }
  }

  /** For AgentStreams.onChange. */
  streamChanged(change: StreamChange): void {
    if (change.kind === "opened") this.streamOpened(change.address, change.machine, change.popup);
    else this.streamClosed(change.address, change.machine);
  }

  streamOpened(address: string, machine: string | null, popup: boolean): void {
    if (machine === null) return;
    if (!popup) {
      // A holder that reopened without pop-ups (its panel failed to show) can't show the request: the next session takes it.
      this.release(address, machine);
      return;
    }
    for (const request of this.requests.values()) {
      if (request.closed) continue;
      const holder = request.holders.get(machine);
      // No holder there yet, or the holder itself reconnecting: send it (again, with the same nonce).
      if (holder === undefined || holder === address) this.send(request, machine, address);
    }
  }

  streamClosed(address: string, machine: string | null): void {
    if (machine !== null) this.release(address, machine);
  }

  /** "open" only for the nonce this session was sent. Unknown task, wrong nonce and another session's nonce look alike. */
  check(taskId: string, address: string, nonce: string): "open" | "closed" | "unknown" {
    const request = this.requests.get(taskId);
    const sent = request?.nonces.get(address);
    if (!request || sent === undefined || !sameSecret(sent, nonce)) return "unknown";
    return request.closed ? "closed" : "open";
  }

  info(task: Task): ApprovalInfo | null {
    if (task.status !== "waiting_approval") return null;
    const url = `${this.publicUrl}/hub/tasks/${encodeURIComponent(task.id)}`;
    const request = this.requests.get(task.id);
    // Before the request opens (the notice runs after send_task's answer is built), the machines that will get it.
    const popups = request && !request.closed ? [...request.holders.keys()].sort() : this.streams.popupMachines();
    return { url, popups, note: approvalNote(url, popups) };
  }

  /** Forgets closed requests whose task has expired, and open ones an hour past expiry (a missed close). */
  sweep(): number {
    const now = this.now().getTime();
    let removed = 0;
    for (const [taskId, request] of this.requests) {
      const expiry = Date.parse(request.view.expiresAt);
      // An open request is kept an hour past expiry: the expiry sweep's close arrives in a microtask after this runs.
      if ((request.closed && expiry <= now) || expiry + HOUR_MS <= now) {
        this.requests.delete(taskId);
        removed++;
      }
    }
    return removed;
  }

  /** The address holds nothing on the machine now: each request it held goes to the next session there. */
  private release(address: string, machine: string): void {
    for (const request of this.requests.values()) {
      if (request.closed || request.holders.get(machine) !== address) continue;
      request.holders.delete(machine);
      this.electNext(request, machine, address);
    }
  }

  private electNext(request: OpenRequest, machine: string, except: string): void {
    const next = this.streams.popupSessions(machine).find((candidate) => candidate !== except);
    if (next) this.send(request, machine, next);
  }

  /**
   * Elects the address on the machine and sends it the request. The holder is set before sending: a failed send drops
   * the stream, AgentStreams reports the close synchronously, and streamClosed elects the next session.
   */
  private send(request: OpenRequest, machine: string, address: string): void {
    const nonce = request.nonces.get(address) ?? this.newNonce();
    request.nonces.set(address, nonce);
    request.holders.set(machine, address);
    if (this.streams.send(address, "approval_request", { ...request.view, nonce })) {
      this.log("approval_request_sent", { task_id: request.view.taskId, agent: address });
      return;
    }
    // A stream already gone (dropped earlier in the same round) reports no close, so nothing else moves the request on.
    if (request.holders.get(machine) === address && !this.streams.isConnected(address)) {
      request.holders.delete(machine);
      this.electNext(request, machine, address);
    }
  }
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
