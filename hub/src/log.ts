export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test") return;
  // Callers pass IDs, names and statuses only, never instructions, results, reasons, details or tokens.
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
}

/** Returns value truncated to max characters, or null when it isn't a string. For logging caller-controlled text. */
export function clip(value: unknown, max = 100): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}
