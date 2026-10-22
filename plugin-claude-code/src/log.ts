export type Logger = (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

/**
 * One JSON object per line on stderr: stdout carries the MCP protocol. Callers pass IDs, names and statuses only,
 * never task text, results, reasons, approval nonces or deny notes, or tokens.
 */
export const stderrLog: Logger = (level, msg, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`);
};

/** The error's class name, for logs. Never the message, which can carry caller text. */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
