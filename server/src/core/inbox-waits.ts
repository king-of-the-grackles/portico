import { PorticoError } from "./errors";
import { LIMITS } from "./limits";

/**
 * check_inbox calls waiting for something to pick up, in memory, by agent ID. Portico wakes an agent's calls wherever it
 * would nudge a session's stream: a message for it, a decision on one, an outcome of one it sent, or its removal.
 */
export class InboxWaits {
  private readonly waiting = new Map<string, Set<() => void>>();

  /** Resolves when the agent is woken, after `ms`, or when the signal aborts, whichever comes first. */
  sleep(agentId: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0 || signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        const calls = this.waiting.get(agentId);
        calls?.delete(done);
        if (calls?.size === 0) this.waiting.delete(agentId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      let calls = this.waiting.get(agentId);
      if (!calls) this.waiting.set(agentId, (calls = new Set()));
      calls.add(done);
    });
  }

  /** Wakes every call waiting for these agents. */
  wake(...agentIds: string[]): void {
    for (const agentId of agentIds) {
      for (const done of [...(this.waiting.get(agentId) ?? [])]) done();
    }
  }

  /** How many calls are waiting for the agent. */
  count(agentId: string): number {
    return this.waiting.get(agentId)?.size ?? 0;
  }
}

/** check_inbox's `wait`, in milliseconds: seconds as a number or a numeric string, capped at the limit. Absent is 0. */
export function inboxWaitMs(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const seconds = typeof value === "string" ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    throw new PorticoError("bad_request", `wait must be a number of seconds, from 0 to ${LIMITS.maxInboxWaitSeconds}.`);
  }
  return Math.round(Math.min(seconds, LIMITS.maxInboxWaitSeconds) * 1000);
}
