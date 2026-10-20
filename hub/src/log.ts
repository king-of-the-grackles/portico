let sink: ((line: string) => void) | null = null;

/** Tests capture log lines with this. Pass null to go back to normal logging. */
export function captureLogs(fn: ((line: string) => void) | null): void {
  sink = fn;
}

export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  // Callers pass IDs, names and statuses only, never instructions, results, reasons, details or tokens.
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (sink) {
    sink(line);
    return;
  }
  if (process.env.NODE_ENV === "test") return;
  console.log(line);
}

/** Returns value truncated to max characters, or null when it isn't a string. For logging caller-controlled text. */
export function clip(value: unknown, max = 100): string | null {
  return typeof value === "string" ? value.slice(0, max) : null;
}

/** The error's class name, for logs. Never the message, which can carry caller text. */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
