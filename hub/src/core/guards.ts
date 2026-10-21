/** A `to` that names a pattern rather than one agent. Tasks (and messages) go to one agent at a time. */
export function isBroadcast(to: string): boolean {
  return to.includes("*") || to.includes("?") || to.startsWith("kind:");
}
