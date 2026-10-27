import { PorticoError } from "../core/errors";
import { MINUTE_MS } from "../core/limits";

/**
 * Counts events in a sliding window: failed join-line redemptions, or registrations. Once `max` land within the
 * window, the route is closed until the oldest falls out. In memory: a restart clears it.
 */
export class WindowLimiter {
  private events: number[] = [];

  constructor(
    private readonly now: () => Date,
    private readonly max = 10,
    private readonly windowMs = 15 * MINUTE_MS,
  ) {}

  blocked(): boolean {
    const cutoff = this.now().getTime() - this.windowMs;
    this.events = this.events.filter((at) => at > cutoff);
    return this.events.length >= this.max;
  }

  record(): void {
    this.events.push(this.now().getTime());
  }
}

/**
 * Runs a join-line redemption under the limiter: refused while blocked, and a secret that matches no line counts as a
 * failure. Nothing awaits between the check and the count (bun:sqlite is synchronous), so a burst of requests can't
 * all pass the check first.
 */
export function limitedRedeem<T>(limiter: WindowLimiter, fn: () => T): T {
  if (limiter.blocked()) throw new PorticoError("rate_limited", "Too many failed join attempts. Try again in 15 minutes.");
  try {
    return fn();
  } catch (err) {
    if (err instanceof PorticoError && err.code === "not_found") limiter.record();
    throw err;
  }
}
