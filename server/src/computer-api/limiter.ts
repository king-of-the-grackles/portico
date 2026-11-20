import { MINUTE_MS } from "../core/limits";

/**
 * Counts events per key (a client address) in a sliding window: requests to join, or registrations. Once
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
