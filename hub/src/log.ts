export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === "test") return;
  // Callers pass IDs, names and statuses only, never instructions, results, reasons, details or tokens.
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
}
