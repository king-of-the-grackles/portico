import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** What the status line takes from a session's transcript, and nothing else. */
export interface TranscriptState {
  /** The latest `ai-title`. */
  title: string | null;
  /** The to-do in progress: its activeForm, else its content or subject. */
  task: string | null;
  /** The in-progress task's ID, from TaskCreate or TaskUpdate, so its completion can clear it. */
  taskId: string | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** How many task names, and TaskCreate calls waiting for their IDs, are remembered. */
const MAX_REMEMBERED = 200;

function remember(map: Map<string, string>, key: string, value: string): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value!);
}

/**
 * Task names remembered between transcript lines. Claude Code's TaskUpdate carries only `{ status, taskId }`, and a
 * TaskCreate gets its ID only in the next user entry (`toolUseResult.task`, linked by `tool_use_id`), so the name a
 * TaskCreate gave is kept until its ID arrives, then by ID.
 */
export class TaskNames {
  /** activeForm ?? subject, by the TaskCreate's tool_use id. */
  private readonly pending = new Map<string, string>();
  private readonly byId = new Map<string, string>();

  created(toolUseId: string, name: string): void {
    remember(this.pending, toolUseId, name);
  }

  /** A TaskCreate's result: its task ID, named by the TaskCreate when it was seen, else by the result's subject. */
  identified(toolUseIds: string[], taskId: string, subject: string | null): void {
    const useId = toolUseIds.find((id) => this.pending.has(id));
    const name = (useId !== undefined ? this.pending.get(useId) : undefined) ?? subject;
    if (useId !== undefined) this.pending.delete(useId);
    if (name) remember(this.byId, taskId, name);
  }

  name(taskId: string): string | null {
    return this.byId.get(taskId) ?? null;
  }
}

function applyToolUse(use: Record<string, unknown>, state: TranscriptState, names: TaskNames): void {
  const { name } = use;
  const input = use.input as Record<string, unknown>;
  if (name === "TodoWrite") {
    if (!Array.isArray(input.todos)) return;
    const current = input.todos.find(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object" && (item as Record<string, unknown>).status === "in_progress",
    );
    state.task = current ? (text(current.activeForm) ?? text(current.content)) : null;
    state.taskId = null;
    return;
  }
  if (name !== "TaskCreate" && name !== "TaskUpdate") return;
  const taskId = text(input.taskId);
  // A name sent with the call itself; for a TaskUpdate it overrides the remembered one.
  const given = text(input.activeForm) ?? text(input.subject);
  const useId = text(use.id);
  if (name === "TaskCreate" && given && useId) names.created(useId, given);
  if (input.status === "in_progress") {
    state.task = given ?? (name === "TaskUpdate" && taskId !== null ? names.name(taskId) : null);
    state.taskId = taskId;
  } else if (name === "TaskUpdate" && input.status === "completed" && taskId !== null && taskId === state.taskId) {
    state.task = null;
    state.taskId = null;
  }
}

/** A user entry carrying a TaskCreate's result: `toolUseResult.task = { id, subject }`. */
function applyTaskResult(record: Record<string, unknown>, names: TaskNames): void {
  const result = record.toolUseResult as { task?: unknown } | undefined;
  const task = result?.task as { id?: unknown; subject?: unknown } | null | undefined;
  if (!task || typeof task !== "object") return;
  const taskId = text(task.id);
  if (!taskId) return;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  const toolUseIds = Array.isArray(content)
    ? content
        .map((part) => (part !== null && typeof part === "object" ? text((part as Record<string, unknown>).tool_use_id) : null))
        .filter((id): id is string => id !== null)
    : [];
  names.identified(toolUseIds, taskId, text(task.subject));
}

/**
 * Updates the state from one transcript line: an `ai-title` entry, an assistant message's to-do tool calls, or the
 * user entry that gives a created task its ID. `names` carries task names from line to line; pass the same one for
 * every line of a transcript.
 */
export function applyTranscriptLine(line: string, state: TranscriptState, names: TaskNames = new TaskNames()): void {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (entry === null || typeof entry !== "object") return;
  const record = entry as Record<string, unknown>;
  if (record.type === "ai-title") {
    const title = text(record.aiTitle);
    if (title) state.title = title;
    return;
  }
  if (record.type === "user") {
    applyTaskResult(record, names);
    return;
  }
  if (record.type !== "assistant") return;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const use = part as Record<string, unknown>;
    if (use.type !== "tool_use" || use.input === null || typeof use.input !== "object") continue;
    applyToolUse(use, state, names);
  }
}

const DEFAULT_FIRST_READ_BYTES = 256 * 1024;
/** A line longer than this is a tool result or an image, never a title or a to-do, so it isn't kept. */
const MAX_LINE_CHARS = 1024 * 1024;

/**
 * Follows one transcript file from its tail (spec §5.3). The first read covers at most the last `firstReadBytes`;
 * later reads take only what was appended, in chunks of the same size. Starts over when the file shrinks or the
 * path changes.
 */
export class TranscriptTail {
  private readonly firstReadBytes: number;
  private path: string | null = null;
  private offset = 0;
  private partial = "";
  private skipFirst = false;
  private decoder = new TextDecoder();
  private state: TranscriptState = { title: null, task: null, taskId: null };
  private names = new TaskNames();

  constructor(opts: { firstReadBytes?: number } = {}) {
    this.firstReadBytes = opts.firstReadBytes ?? DEFAULT_FIRST_READ_BYTES;
  }

  read(path: string): TranscriptState {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return { ...this.state };
    }
    if (path !== this.path || size < this.offset) {
      this.path = path;
      this.state = { title: null, task: null, taskId: null };
      this.names = new TaskNames();
      this.offset = Math.max(0, size - this.firstReadBytes);
      this.partial = "";
      this.decoder = new TextDecoder();
      // Starting mid-file means starting mid-line: that first line is dropped, not parsed.
      this.skipFirst = this.offset > 0;
    }
    if (size > this.offset) {
      let fd: number;
      try {
        fd = openSync(path, "r");
      } catch {
        return { ...this.state };
      }
      try {
        const buf = Buffer.alloc(Math.min(this.firstReadBytes, size - this.offset));
        while (this.offset < size) {
          const n = readSync(fd, buf, 0, Math.min(buf.length, size - this.offset), this.offset);
          if (n <= 0) break;
          this.offset += n;
          this.consume(this.decoder.decode(buf.subarray(0, n), { stream: true }));
        }
      } finally {
        closeSync(fd);
      }
    }
    return { ...this.state };
  }

  private consume(chunk: string): void {
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    if (this.skipFirst && lines.length > 0) {
      lines.shift();
      this.skipFirst = false;
    }
    for (const line of lines) if (line.trim()) applyTranscriptLine(line, this.state, this.names);
    if (this.partial.length > MAX_LINE_CHARS) {
      this.partial = "";
      this.skipFirst = true; // drop the rest of it too
    }
  }
}

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** `<projectsDir>/<project>/<sessionId>.jsonl`, or null when there's none. */
export function findTranscript(projectsDir: string, sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  let projects: string[];
  try {
    projects = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const project of projects) {
    const path = join(projectsDir, project, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}
