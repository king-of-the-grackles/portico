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

/** Which run's report an agent shows when several are open: the busiest, then the latest. */
const RANK: Record<SessionStatus, number> = { busy: 0, waiting: 1, idle: 2 };

type Report = StatusReport & { at: string };

/** Ended runs remembered, so a report that races the stream's close is ignored. */
const ENDED_KEPT = 1000;

/**
 * Live state, in memory only, by agent ID: each open run's last status report, the agent's last report from any run,
 * and each agent's recent check-ins. After a restart, sessions report again within seconds of their plugins
 * reconnecting.
 */
export class Presence {
  private readonly runs = new Map<string, Map<string, Report>>();
  private readonly last = new Map<string, Report>();
  private readonly ended = new Set<string>();
  private readonly checkIns = new Map<string, string[]>();

  /** A run's report. `runId` is the agent's own ID for an agent without runs. A run that already ended is ignored. */
  report(agentId: string, runId: string, report: StatusReport, at: string): void {
    if (this.ended.has(runId)) return;
    const runs = this.runs.get(agentId) ?? new Map<string, Report>();
    runs.set(runId, { ...report, at });
    this.runs.set(agentId, runs);
    this.last.set(agentId, { ...report, at });
  }

  /** The busiest open run's report (then the latest), or with none open, the last report from any run. */
  get(agentId: string): Report | null {
    const open = [...(this.runs.get(agentId)?.values() ?? [])];
    if (open.length === 0) return this.last.get(agentId) ?? null;
    return open.sort((a, b) => RANK[a.status] - RANK[b.status] || b.at.localeCompare(a.at))[0]!;
  }

  /**
   * The run's stream closed: its report no longer counts toward the agent's status, and a report that arrives after
   * the close (a process's last heartbeat) is ignored until the run reconnects.
   */
  endRun(agentId: string, runId: string): void {
    const runs = this.runs.get(agentId);
    runs?.delete(runId);
    if (runs?.size === 0) this.runs.delete(agentId);
    this.ended.add(runId);
    // Kept short: only a report racing the close needs it.
    if (this.ended.size > ENDED_KEPT) this.ended.delete(this.ended.values().next().value!);
  }

  /** The run's stream opened (again): its reports count. */
  startRun(runId: string): void {
    this.ended.delete(runId);
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
    this.runs.delete(agentId);
    this.last.delete(agentId);
    this.checkIns.delete(agentId);
  }
}
