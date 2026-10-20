import { type HubClient, HubError, type PermissionPrompt } from "./hub-client";
import { errorName, type Logger } from "./log";

/** Matches the hub: a relayed prompt is forgotten after an hour. */
export const PERMISSION_TTL_MS = 3_600_000;

export type PermissionBehavior = "allow" | "deny";

export interface PermissionRelayDeps {
  client: HubClient;
  /** Sends notifications/claude/channel/permission to Claude Code. */
  sendVerdict: (requestId: string, behavior: PermissionBehavior) => Promise<void>;
  log: Logger;
  /** Pauses between relay attempts when the hub can't be reached or fails. Default 1 s, then 2 s. */
  retryMs?: number[];
  now?: () => number;
}

/**
 * Relays Claude Code's permission prompts to the hub, and forwards the answers back (spec §9.5). The hub re-sends
 * every answer from the last hour on each reconnect, so an answer is forwarded only for a prompt this session
 * relayed and is still waiting on, and only once.
 *
 * A prompt counts as waiting only once the hub has accepted it; answers that arrive while the relay is still in
 * flight are dropped. Claude Code can reuse a request_id: if one is relayed again while still waiting or in flight,
 * the plugin forgets it and relays nothing, so no answer applies to either prompt and both stay answerable in the
 * terminal. The hub merges an unanswered repeat into the earlier prompt, so a prompt is armed only when the hub's
 * response echoes exactly the content sent (tool, description, preview) with no answer; otherwise it stays
 * terminal-only and `permission_id_reused` is logged.
 */
export class PermissionRelayClient {
  /** request_id → when to forget it (ms since the epoch). */
  private readonly waiting = new Map<string, number>();
  /** request_id → token of the relay in flight. Replaced or removed when the ID is reused, which cancels it. */
  private readonly inflight = new Map<string, object>();
  private readonly now: () => number;
  private readonly retryMs: number[];

  constructor(private readonly deps: PermissionRelayDeps) {
    this.now = deps.now ?? Date.now;
    this.retryMs = deps.retryMs ?? [1_000, 2_000];
  }

  /** How many relayed prompts are still waiting for an answer. */
  get pending(): number {
    this.sweep();
    return this.waiting.size;
  }

  async relay(prompt: PermissionPrompt): Promise<void> {
    this.sweep();
    const id = prompt.request_id;
    if (this.waiting.has(id) || this.inflight.has(id)) {
      this.waiting.delete(id);
      this.inflight.delete(id);
      this.deps.log("warn", "permission_id_reused", { request_id: id });
      return;
    }
    const token = {};
    this.inflight.set(id, token);
    for (let attempt = 0; ; attempt++) {
      try {
        const response: unknown = await this.deps.client.relayPermission(prompt);
        if (this.inflight.get(id) !== token) return; // the ID was reused meanwhile; stay out of the way
        this.inflight.delete(id);
        if (!confirms(response, prompt)) {
          this.deps.log("warn", "permission_id_reused", { request_id: id });
          return;
        }
        this.waiting.set(id, this.now() + PERMISSION_TTL_MS);
        this.deps.log("info", "permission_relayed", { request_id: prompt.request_id, tool: prompt.tool_name.slice(0, 60) });
        return;
      } catch (err) {
        const status = err instanceof HubError ? err.status : -1;
        // Retry only when the hub couldn't be reached or failed. A 4xx won't change on retry.
        const retryable = status === 0 || status >= 500;
        const pause = this.retryMs[attempt];
        if (!retryable || pause === undefined) {
          if (this.inflight.get(id) === token) this.inflight.delete(id);
          this.deps.log("warn", "permission_relay_failed", {
            request_id: prompt.request_id,
            status,
            error: errorName(err),
          });
          return;
        }
        await Bun.sleep(pause);
        if (this.inflight.get(id) !== token) return;
      }
    }
  }

  /** Handles a `permission` stream event. */
  answer(data: unknown): void {
    const { request_id: requestId, behavior } = (data ?? {}) as { request_id?: unknown; behavior?: unknown };
    if (typeof requestId !== "string" || (behavior !== "allow" && behavior !== "deny")) return;
    this.sweep();
    if (!this.waiting.delete(requestId)) return;
    this.deps.log("info", "permission_answered", { request_id: requestId, behavior });
    this.deps
      .sendVerdict(requestId, behavior)
      .catch((err) => this.deps.log("warn", "permission_verdict_failed", { request_id: requestId, error: errorName(err) }));
  }

  private sweep(): void {
    const now = this.now();
    for (const [requestId, forgetAt] of this.waiting) if (forgetAt <= now) this.waiting.delete(requestId);
  }
}

/** True when the hub's response is this very prompt, unanswered. Checked at runtime: the body is not trusted. */
function confirms(response: unknown, prompt: PermissionPrompt): boolean {
  const request = (response as { request?: unknown } | null)?.request as Record<string, unknown> | null | undefined;
  if (typeof request !== "object" || request === null) return false;
  return (
    request.tool_name === prompt.tool_name &&
    request.description === prompt.description &&
    request.input_preview === prompt.input_preview &&
    request.answer === null
  );
}
