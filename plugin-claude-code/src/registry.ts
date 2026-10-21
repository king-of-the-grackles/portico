import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** This session's record in Claude Code's session registry, `~/.claude/sessions/<pid>.json`. */
export interface OwnSession {
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  name: string | null;
  messagingSocketPath: string | null;
}

export interface RegistryDeps {
  /** The registry folder, `<claude home>/sessions`. */
  sessionsDir: string;
  /** The parent of a process, or null when it has none or can't be read. Default: `ps`. */
  parentOf?: (pid: number) => number | null;
  /** Where the walk starts. Default: this process's parent. */
  startPid?: number;
  /** How many parents up the walk goes. Default 6. */
  maxDepth?: number;
  /** The clock, in milliseconds, for SessionLocator's retries. Default: `Date.now`. */
  now?: () => number;
}

// While no registry file is found: a walk every 5 s for the first minute, then every 30 s. Each walk spawns up to
// seven `ps` processes synchronously.
const RETRY_MS = 5_000;
const SLOW_RETRY_MS = 30_000;
const FAST_RETRY_FOR_MS = 60_000;

/** Reads one registry file. Null for a missing, unreadable or invalid file. */
export function readSessionFile(path: string): OwnSession | null {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || typeof record.cwd !== "string") return null;
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  return {
    pid: typeof record.pid === "number" ? record.pid : Number.parseInt(basename(path), 10),
    sessionId: record.sessionId,
    cwd: record.cwd,
    status: text(record.status) ?? "unknown",
    name: text(record.name),
    messagingSocketPath: text(record.messagingSocketPath),
  };
}

function psParent(pid: number): number | null {
  const out = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  const parent = Number.parseInt(out.stdout?.trim() ?? "", 10);
  return Number.isInteger(parent) && parent > 0 ? parent : null;
}

/** Walks up from the start pid to the nearest process that has a registry file: the Claude Code session. */
function locate(deps: RegistryDeps): { pid: number; session: OwnSession } | null {
  const parentOf = deps.parentOf ?? psParent;
  const maxDepth = deps.maxDepth ?? 6;
  let pid: number | null = deps.startPid ?? process.ppid;
  for (let step = 0; pid !== null && pid > 1 && step <= maxDepth; step++) {
    const session = readSessionFile(join(deps.sessionsDir, `${pid}.json`));
    if (session) return { pid, session };
    pid = parentOf(pid);
  }
  return null;
}

/** The nearest ancestor process with `<sessionsDir>/<pid>.json`, read. */
export function findOwnSession(deps: RegistryDeps): OwnSession | null {
  return locate(deps)?.session ?? null;
}

/**
 * Finds the session's pid once, then re-reads that file on every call, so status and socket path stay current.
 * While nothing is found, it walks again at most every 5 s for the first minute after the first walk, then at most
 * every 30 s.
 */
export class SessionLocator {
  private pid: number | null = null;
  private firstWalk: number | null = null;
  private lastWalk = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: RegistryDeps) {}

  current(): OwnSession | null {
    if (this.pid !== null) return readSessionFile(join(this.deps.sessionsDir, `${this.pid}.json`));
    const now = (this.deps.now ?? Date.now)();
    this.firstWalk ??= now;
    const gap = now - this.firstWalk < FAST_RETRY_FOR_MS ? RETRY_MS : SLOW_RETRY_MS;
    if (now - this.lastWalk < gap) return null;
    this.lastWalk = now;
    const found = locate(this.deps);
    if (!found) return null;
    this.pid = found.pid;
    return found.session;
  }
}
