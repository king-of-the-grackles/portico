/** A `to` that names a pattern rather than one agent. Tasks (and messages) go to one agent at a time. */
export function isBroadcast(to: string): boolean {
  return to.includes("*") || to.includes("?") || to.startsWith("kind:");
}

/** At most this many messages between two agents, both directions together, in any LOOP_WINDOW_MS. */
export const LOOP_LIMIT = 12;
export const LOOP_WINDOW_MS = 600_000;

/**
 * Given when each message between a pair was sent within the window (oldest first), null while another fits, else when
 * the window frees up: the moment the oldest of the last LOOP_LIMIT leaves it.
 */
export function loopGuardRetryAt(times: string[]): string | null {
  if (times.length < LOOP_LIMIT) return null;
  return new Date(Date.parse(times[times.length - LOOP_LIMIT]!) + LOOP_WINDOW_MS).toISOString();
}
