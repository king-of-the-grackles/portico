import { PorticoError } from "./errors";
import { defang } from "./framing";
import type { SessionStatus, StatusReport } from "./types";

const STATUSES = new Set(["busy", "idle", "waiting"]);

/** Defanged, on one line, trimmed and clipped to `max` code points; null when nothing is left or it isn't a string. */
function oneLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = defang(value).replace(/\s+/g, " ").trim();
  return text ? Array.from(text).slice(0, max).join("") : null;
}

/** A status report from a push member's body. Only `status` is required. */
export function parseStatusReport(body: unknown): StatusReport {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.status !== "string" || !STATUSES.has(b.status)) {
    throw new PorticoError("bad_request", "status must be busy, idle or waiting.");
  }
  const repo = oneLine(b.repo, 100);
  return {
    status: b.status as SessionStatus,
    doing: oneLine(b.doing, 120),
    // A basename only, even if a client sends a path.
    repo: repo?.split(/[\\/]/).filter(Boolean).pop() ?? null,
    branch: oneLine(b.branch, 100),
  };
}

/**
 * Live state, in memory only: each push member's last status report, and each member's last check-in. After a
 * restart, sessions report again within seconds of their plugins reconnecting.
 */
export class Presence {
  private readonly reports = new Map<string, StatusReport & { at: string }>();
  private readonly checkIns = new Map<string, string>();

  report(address: string, report: StatusReport, at: string): void {
    this.reports.set(address, { ...report, at });
  }

  get(address: string): (StatusReport & { at: string }) | null {
    return this.reports.get(address) ?? null;
  }

  checkedIn(address: string, at: string): void {
    this.checkIns.set(address, at);
  }

  lastCheckIn(address: string): string | null {
    return this.checkIns.get(address) ?? null;
  }

  /** Drops everything known about the address, e.g. once its assistant is removed. */
  forget(address: string): void {
    this.reports.delete(address);
    this.checkIns.delete(address);
  }
}
