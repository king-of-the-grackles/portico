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

/** A status report from a session's body. Only `status` is required. */
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

/** Check-ins kept per agent, for the usual interval between them. */
const CHECK_INS_KEPT = 5;

/**
 * Live state, in memory only, by agent ID: each session's last status report, and each agent's recent check-ins.
 * After a restart, sessions report again within seconds of their plugins reconnecting.
 */
export class Presence {
  private readonly reports = new Map<string, StatusReport & { at: string }>();
  private readonly checkIns = new Map<string, string[]>();

  report(agentId: string, report: StatusReport, at: string): void {
    this.reports.set(agentId, { ...report, at });
  }

  get(agentId: string): (StatusReport & { at: string }) | null {
    return this.reports.get(agentId) ?? null;
  }

  checkedIn(agentId: string, at: string): void {
    const times = this.checkIns.get(agentId) ?? [];
    times.push(at);
    if (times.length > CHECK_INS_KEPT) times.shift();
    this.checkIns.set(agentId, times);
  }

  lastCheckIn(agentId: string): string | null {
    return this.checkIns.get(agentId)?.at(-1) ?? null;
  }

  /**
   * The usual minutes between check-ins: the median gap, rounded, once there are two. Gaps under a minute (a burst of
   * calls in one turn) don't count.
   */
  checkInMinutes(agentId: string): number | null {
    const times = (this.checkIns.get(agentId) ?? []).map((at) => Date.parse(at));
    const gaps = times
      .slice(1)
      .map((at, i) => (at - times[i]!) / 60_000)
      .filter((gap) => gap >= 1)
      .sort((a, b) => a - b);
    if (gaps.length === 0) return null;
    return Math.round(gaps[Math.floor((gaps.length - 1) / 2)]!);
  }

  /** Drops everything known about the agent, e.g. once it's removed. */
  forget(agentId: string): void {
    this.reports.delete(agentId);
    this.checkIns.delete(agentId);
  }
}
