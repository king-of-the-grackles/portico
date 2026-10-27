import { PorticoError } from "../core/errors";
import { MINUTE_MS } from "../core/limits";

/**
 * Counts events per key (a client address) in a sliding window: failed join-line redemptions, or registrations. Once
 * `max` land within the window, that key is refused until the oldest falls out; other clients are unaffected. In
 * memory: a restart clears it.
 */
export class WindowLimiter {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly now: () => Date,
    private readonly max = 10,
    private readonly windowMs = 15 * MINUTE_MS,
  ) {}

  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  record(key: string): void {
    this.events.set(key, [...this.recent(key), this.now().getTime()]);
  }

  private recent(key: string): number[] {
    const cutoff = this.now().getTime() - this.windowMs;
    const recent = (this.events.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length === 0) this.events.delete(key);
    else this.events.set(key, recent);
    return recent;
  }
}

/**
 * Runs a join-line redemption under the limiter for this client: refused while blocked, and a secret that matches no
 * line counts as a failure. Nothing awaits between the check and the count (bun:sqlite is synchronous), so a burst of
 * requests can't all pass the check first.
 */
export function limitedRedeem<T>(limiter: WindowLimiter, key: string, fn: () => T): T {
  if (limiter.blocked(key)) throw new PorticoError("rate_limited", "Too many failed join attempts. Try again in 15 minutes.");
  try {
    return fn();
  } catch (err) {
    if (err instanceof PorticoError && err.code === "not_found") limiter.record(key);
    throw err;
  }
}
