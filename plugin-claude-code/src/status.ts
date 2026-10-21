import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { basename, resolve } from "node:path";
import type { StatusReport } from "./hub-client";
import { errorName, type Logger } from "./log";
import { realFolder } from "./machine";
import type { OwnSession } from "./registry";
import { TranscriptTail } from "./transcript";

/** Claude Code's registry status as the hub's: `busy` and `shell` are busy, `idle` and `waiting` stay, anything else is idle. */
export function mapStatus(registryStatus: string | null | undefined): StatusReport["status"] {
  if (registryStatus === "busy" || registryStatus === "shell") return "busy";
  if (registryStatus === "waiting") return "waiting";
  return "idle";
}

const MAX_DOING = 120;

/** `<title> · <current to-do>`, either part alone when the other is missing, at most 120 code points. */
export function composeDoing(title: string | null, task: string | null): string | null {
  const parts = [title, task].map((part) => part?.trim() ?? "").filter((part) => part !== "");
  if (parts.length === 0) return null;
  return Array.from(parts.join(" · ")).slice(0, MAX_DOING).join("");
}

/** HMAC-SHA256 of the folder's real path, keyed with the token: the hub tells folders apart without learning either path. */
export function folderId(token: string, folder: string): string {
  return createHmac("sha256", token).update(realFolder(folder)).digest("hex");
}

function runGit(args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile("git", args, { timeout: 5_000, windowsHide: true }, (err, stdout) => done(err ? null : stdout));
  });
}

/**
 * The repo's basename (the git top-level folder's, or the folder's own outside git) and the branch (null outside
 * git or on a detached HEAD). Only basenames leave the machine.
 */
export async function gitInfo(
  cwd: string,
  run: (args: string[]) => Promise<string | null> = runGit,
): Promise<{ repo: string | null; branch: string | null }> {
  const out = await run(["-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"]);
  const [top = "", branch = ""] = (out ?? "").split("\n").map((line) => line.trim());
  if (!top) return { repo: basename(resolve(cwd)) || null, branch: null };
  return { repo: basename(top) || null, branch: branch && branch !== "HEAD" ? branch : null };
}

export interface SessionWatcherDeps {
  /** This session's registry record, re-read on each call. */
  locate: () => OwnSession | null;
  /** The session's working folder. */
  cwd: string;
  /** The session's transcript file, or null when it isn't found. */
  transcriptOf: (sessionId: string) => string | null;
  git: (cwd: string) => Promise<{ repo: string | null; branch: string | null }>;
  report: (r: StatusReport) => Promise<unknown>;
  log: Logger;
  /** How often the registry and transcript are checked. Default 5 s. */
  pollMs?: number;
  /** How often git is asked. Default 30 s. */
  gitMs?: number;
  /** An unchanged status is reported again after this long. Default 60 s. */
  heartbeatMs?: number;
  tail?: TranscriptTail;
}

const POLL_MS = 5_000;
const GIT_MS = 30_000;
const HEARTBEAT_MS = 60_000;
const TRANSCRIPT_RETRY_MS = 30_000;

/**
 * Reports this session's status to the hub (spec §5.3): when it changes, checked every poll, and as a heartbeat.
 * Nothing it reads or reports is logged.
 */
export class SessionWatcher {
  private readonly tail: TranscriptTail;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private ticking = false;
  private forceNext = false;
  private status: StatusReport["status"] = "idle";
  private title: string | null = null;
  private task: string | null = null;
  private repo: string | null = null;
  private branch: string | null = null;
  private lastGitAt = Number.NEGATIVE_INFINITY;
  /** The last transcript lookup: a found path is kept; a miss is retried after TRANSCRIPT_RETRY_MS. */
  private transcript: { sessionId: string; path: string | null; at: number } | null = null;
  private lastSent: string | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private failing = false;
  private readFailing = false;

  constructor(private readonly deps: SessionWatcherDeps) {
    this.tail = deps.tail ?? new TranscriptTail();
  }

  /** Reports at once, then polls. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.tick(false), this.deps.pollMs ?? POLL_MS);
    this.timer.unref?.();
    void this.tick(false);
  }

  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reports the current values now, changed or not: after each hello, the hub may have restarted and forgotten them. */
  resend(): void {
    void this.tick(true);
  }

  current(): StatusReport {
    return { status: this.status, doing: composeDoing(this.title, this.task), repo: this.repo, branch: this.branch };
  }

  private async tick(force: boolean): Promise<void> {
    if (!this.running) return;
    if (this.ticking) {
      if (force) this.forceNext = true;
      return;
    }
    this.ticking = true;
    try {
      try {
        await this.refresh();
        this.readFailing = false;
      } catch (err) {
        // Once per run of failures, as for reports.
        if (!this.readFailing) this.deps.log("warn", "status_read_failed", { error: errorName(err) });
        this.readFailing = true;
      }
      if (!this.running) return;
      const report = this.current();
      const json = JSON.stringify(report);
      const heartbeatMs = this.deps.heartbeatMs ?? HEARTBEAT_MS;
      if (!force && !this.forceNext && json === this.lastSent && Date.now() - this.lastSentAt < heartbeatMs) return;
      this.forceNext = false;
      try {
        await this.deps.report(report);
        this.lastSent = json;
        this.lastSentAt = Date.now();
        this.failing = false;
      } catch (err) {
        // Once per run of failures, not every poll. The next poll tries again.
        if (!this.failing) this.deps.log("warn", "status_report_failed", { error: errorName(err) });
        this.failing = true;
        this.lastSent = null;
      }
    } finally {
      this.ticking = false;
      // A resend asked for while a report was already on its way.
      if (this.forceNext && this.running) void this.tick(true);
    }
  }

  private async refresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastGitAt >= (this.deps.gitMs ?? GIT_MS)) {
      this.lastGitAt = now;
      const info = await this.deps.git(this.deps.cwd);
      this.repo = info.repo;
      this.branch = info.branch;
    }
    const session = this.deps.locate();
    this.status = mapStatus(session?.status);
    const path = session ? this.transcriptPath(session.sessionId, now) : null;
    const state = path ? this.tail.read(path) : null;
    this.title = state?.title ?? null;
    this.task = state?.task ?? null;
  }

  private transcriptPath(sessionId: string, now: number): string | null {
    const last = this.transcript;
    if (last && last.sessionId === sessionId && (last.path !== null || now - last.at < TRANSCRIPT_RETRY_MS)) return last.path;
    const path = this.deps.transcriptOf(sessionId);
    this.transcript = { sessionId, path, at: now };
    return path;
  }
}
