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

function applyToolUse(name: unknown, input: Record<string, unknown>, state: TranscriptState): void {
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
  if (input.status === "in_progress") {
    state.task = text(input.activeForm) ?? text(input.subject);
    state.taskId = taskId;
  } else if (name === "TaskUpdate" && input.status === "completed" && taskId !== null && taskId === state.taskId) {
    state.task = null;
    state.taskId = null;
  }
}

/** Updates the state from one transcript line: an `ai-title` entry, or an assistant message's to-do tool calls. */
export function applyTranscriptLine(line: string, state: TranscriptState): void {
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
  if (record.type !== "assistant") return;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    const use = part as Record<string, unknown>;
    if (use.type !== "tool_use" || use.input === null || typeof use.input !== "object") continue;
    applyToolUse(use.name, use.input as Record<string, unknown>, state);
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
    for (const line of lines) if (line.trim()) applyTranscriptLine(line, this.state);
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
