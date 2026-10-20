import { BridgeError } from "./errors";

export type PermissionBehavior = "allow" | "deny";

export interface PermissionRequest {
  agent: string;
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
  createdAt: string;
  expiresAt: string;
  answer: PermissionBehavior | null;
  answeredAt: string | null;
  /** True once the answer reached the agent's live stream. */
  delivered: boolean;
}

export interface PermissionRelayDeps {
  maxTextKb: number;
  /** Sends an answer down the agent's live stream. Returns false if the agent isn't connected. */
  deliver: (agent: string, requestId: string, behavior: PermissionBehavior) => boolean;
  now?: () => Date;
}

export const PERMISSION_TTL_MS = 3_600_000;
export const MAX_PENDING_PER_AGENT = 50;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOL_NAME = 200;

function key(agent: string, requestId: string): string {
  // Neither agent names nor request IDs can contain "/", so the key is unambiguous.
  return `${agent}/${requestId}`;
}

/**
 * Claude Code permission prompts relayed by push agents (spec §9.5). Kept in memory only: after an hour or
 * a restart a prompt is gone, and only the terminal can answer it.
 */
export class PermissionRelay {
  private readonly requests = new Map<string, PermissionRequest>();
  private readonly now: () => Date;

  constructor(private readonly deps: PermissionRelayDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  add(
    agent: string,
    input: { requestId: unknown; toolName: unknown; description?: unknown; inputPreview?: unknown },
  ): { request: PermissionRequest; created: boolean } {
    this.sweep();
    const { requestId, toolName } = input;
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) {
      throw new BridgeError("bad_request", "request_id must be 1–64 letters, digits, _ or -.");
    }
    if (typeof toolName !== "string" || toolName.trim() === "" || toolName.length > MAX_TOOL_NAME) {
      throw new BridgeError("bad_request", `tool_name must be a non-empty string of up to ${MAX_TOOL_NAME} characters.`);
    }
    const description = this.optionalText("description", input.description);
    const inputPreview = this.optionalText("input_preview", input.inputPreview);

    const existing = this.requests.get(key(agent, requestId));
    // An unanswered repeat is the same prompt. An answered one is treated as a new prompt: answers are re-sent on
    // every reconnect (see redeliver), so an old answer must never apply to a new prompt that reuses a short
    // request ID. At worst the owner is asked twice.
    if (existing && existing.answer === null) return { request: { ...existing }, created: false };
    if (this.unansweredFor(agent) >= MAX_PENDING_PER_AGENT) {
      throw new BridgeError("rate_limited", `${agent} already has ${MAX_PENDING_PER_AGENT} permission prompts waiting.`);
    }
    const at = this.now();
    const request: PermissionRequest = {
      agent,
      requestId,
      toolName,
      description,
      inputPreview,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + PERMISSION_TTL_MS).toISOString(),
      answer: null,
      answeredAt: null,
      delivered: false,
    };
    this.requests.set(key(agent, requestId), request);
    return { request: { ...request }, created: true };
  }

  answer(agent: string, requestId: string, behavior: PermissionBehavior): PermissionRequest {
    this.sweep();
    const request = this.requests.get(key(agent, requestId));
    if (!request) throw new BridgeError("not_found", "That permission prompt is no longer pending.");
    if (request.answer) {
      throw new BridgeError("wrong_status", `That permission prompt was already answered: ${request.answer}.`);
    }
    request.answer = behavior;
    request.answeredAt = this.now().toISOString();
    request.delivered = this.deps.deliver(agent, requestId, behavior);
    return { ...request };
  }

  /**
   * Re-sends every answered, unexpired prompt for the agent, whether or not it was marked delivered. A write to
   * a stalled stream (e.g. a half-open connection) looks like success, so "delivered" can't be trusted. The
   * plugin ignores answers for requests it isn't waiting on, so duplicates are harmless. Returns how many went out.
   */
  redeliver(agent: string): number {
    this.sweep();
    let sent = 0;
    for (const request of this.requests.values()) {
      if (request.agent !== agent || request.answer === null) continue;
      request.delivered = this.deps.deliver(agent, request.requestId, request.answer);
      if (request.delivered) sent++;
    }
    return sent;
  }

  get(agent: string, requestId: string): PermissionRequest | null {
    this.sweep();
    const request = this.requests.get(key(agent, requestId));
    return request ? { ...request } : null;
  }

  /** Unanswered prompts, oldest first. */
  pending(): PermissionRequest[] {
    this.sweep();
    return [...this.requests.values()]
      .filter((request) => request.answer === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((request) => ({ ...request }));
  }

  /** Forgets expired prompts. Returns how many. */
  sweep(): number {
    const now = this.now().getTime();
    let removed = 0;
    for (const [k, request] of this.requests) {
      if (Date.parse(request.expiresAt) <= now) {
        this.requests.delete(k);
        removed++;
      }
    }
    return removed;
  }

  private unansweredFor(agent: string): number {
    let count = 0;
    for (const request of this.requests.values()) if (request.agent === agent && request.answer === null) count++;
    return count;
  }

  private optionalText(field: string, value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string") throw new BridgeError("bad_request", `${field} must be a string.`);
    if (new TextEncoder().encode(value).length > this.deps.maxTextKb * 1024) {
      throw new BridgeError("too_large", `${field} is larger than ${this.deps.maxTextKb} KB.`);
    }
    return value;
  }
}
