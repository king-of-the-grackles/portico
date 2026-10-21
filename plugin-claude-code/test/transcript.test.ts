import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyTranscriptLine, findTranscript, type TranscriptState, TranscriptTail } from "../src/transcript";
import { tempDir } from "./helpers";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const todo = (todos: unknown[]) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos } }] } });
const tool = (name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { content: [{ type: "text", text: "Working on it" }, { type: "tool_use", name, input }] },
});
const title = (aiTitle: string) => ({ type: "ai-title", aiTitle, sessionId: "s-1" });
const empty = (): TranscriptState => ({ title: null, task: null, taskId: null });

describe("applyTranscriptLine", () => {
  test("takes the latest ai-title", () => {
    const state = empty();
    applyTranscriptLine(line(title("Fix login")), state);
    expect(state.title).toBe("Fix login");
    applyTranscriptLine(line({ type: "user", message: { content: "Fix it" } }), state);
    applyTranscriptLine(line(title("Fix login and signup")), state);
    expect(state.title).toBe("Fix login and signup");
  });

  test("takes the in-progress TodoWrite item's activeForm, and clears it when none is in progress", () => {
    const state = empty();
    applyTranscriptLine(line(todo([{ content: "Add tests", activeForm: "Adding tests", status: "in_progress" }])), state);
    expect(state.task).toBe("Adding tests");
    applyTranscriptLine(line(todo([{ content: "Add tests", activeForm: "Adding tests", status: "completed" }])), state);
    expect(state.task).toBeNull();
    // Without an activeForm, the item's content.
    applyTranscriptLine(line(todo([{ content: "Ship it", status: "pending" }, { content: "Write docs", status: "in_progress" }])), state);
    expect(state.task).toBe("Write docs");
  });

  test("tracks TaskUpdate in_progress, and clears it when the same task completes", () => {
    const state = empty();
    applyTranscriptLine(line(tool("TaskCreate", { subject: "Add tests", activeForm: "Adding tests" })), state);
    expect(state.task).toBeNull(); // created, not started
    applyTranscriptLine(line(tool("TaskUpdate", { taskId: "3", status: "in_progress", activeForm: "Adding tests" })), state);
    expect(state).toMatchObject({ task: "Adding tests", taskId: "3" });
    // Another task finishing leaves the current one alone.
    applyTranscriptLine(line(tool("TaskUpdate", { taskId: "2", status: "completed" })), state);
    expect(state.task).toBe("Adding tests");
    applyTranscriptLine(line(tool("TaskUpdate", { taskId: "3", status: "completed" })), state);
    expect(state.task).toBeNull();
    // A task created in progress counts too, by its subject when there's no activeForm.
    applyTranscriptLine(line(tool("TaskCreate", { subject: "Write docs", status: "in_progress" })), state);
    expect(state.task).toBe("Write docs");
  });

  test("ignores lines that aren't JSON or aren't entries it knows", () => {
    const state = empty();
    applyTranscriptLine("not json at all", state);
    applyTranscriptLine("null", state);
    applyTranscriptLine(line({ type: "assistant", message: { content: "just text" } }), state);
    applyTranscriptLine(line({ type: "ai-title", aiTitle: 42 }), state);
    applyTranscriptLine(line(todo("not a list" as unknown as unknown[])), state);
    expect(state).toEqual(empty());
  });
});

describe("TranscriptTail", () => {
  test("reads only the appended bytes on later calls", () => {
    const path = join(tempDir(), "s-1.jsonl");
    writeFileSync(path, line(title("Fix login")));
    const tail = new TranscriptTail();
    expect(tail.read(path)).toEqual({ title: "Fix login", task: null, taskId: null });
    // Rewriting the first line in place (same size) proves the second read doesn't start over.
    writeFileSync(path, line(title("Fix lagin")));
    appendFileSync(path, line(todo([{ content: "Add tests", activeForm: "Adding tests", status: "in_progress" }])));
    expect(tail.read(path)).toEqual({ title: "Fix login", task: "Adding tests", taskId: null });
    expect(tail.read(path)).toEqual({ title: "Fix login", task: "Adding tests", taskId: null });
  });

  test("the first read starts within the last firstReadBytes, skipping the partial first line", () => {
    const path = join(tempDir(), "s-1.jsonl");
    const early = line(title("Old title"));
    const filler = line({ type: "user", message: { content: "x".repeat(300) } });
    const recent = line(title("New title"));
    writeFileSync(path, early + filler + recent);
    // The window starts inside the filler line, which must be skipped rather than parsed.
    const tail = new TranscriptTail({ firstReadBytes: recent.length + 50 });
    expect(tail.read(path)).toEqual({ title: "New title", task: null, taskId: null });

    // A window that cuts into the early title skips it, so the title stays unknown.
    const other = join(tempDir(), "s-2.jsonl");
    writeFileSync(other, early + filler);
    expect(new TranscriptTail({ firstReadBytes: filler.length + 5 }).read(other).title).toBeNull();
  });

  test("starts over when the file shrinks or the path changes", () => {
    const dir = tempDir();
    const path = join(dir, "s-1.jsonl");
    writeFileSync(path, line(title("First")) + line(todo([{ content: "a", activeForm: "Doing a", status: "in_progress" }])));
    const tail = new TranscriptTail();
    expect(tail.read(path)).toEqual({ title: "First", task: "Doing a", taskId: null });
    truncateSync(path, 0);
    writeFileSync(path, line(title("Second")));
    expect(tail.read(path)).toEqual({ title: "Second", task: null, taskId: null });

    const other = join(dir, "s-2.jsonl");
    writeFileSync(other, line(todo([{ content: "b", activeForm: "Doing b", status: "in_progress" }])));
    expect(tail.read(other)).toEqual({ title: null, task: "Doing b", taskId: null });
    // A missing file changes nothing.
    expect(tail.read(join(dir, "missing.jsonl"))).toEqual({ title: null, task: "Doing b", taskId: null });
  });

  test("ignores lines that aren't JSON, and keeps a trailing partial line for the next read", () => {
    const path = join(tempDir(), "s-1.jsonl");
    const full = line(title("Fix login"));
    writeFileSync(path, `garbage line\n${full.slice(0, 10)}`);
    const tail = new TranscriptTail();
    expect(tail.read(path)).toEqual({ title: null, task: null, taskId: null });
    appendFileSync(path, full.slice(10));
    expect(tail.read(path)).toEqual({ title: "Fix login", task: null, taskId: null });
  });

  test("skips a line too long to be a title or a to-do, without losing the lines after it", () => {
    const path = join(tempDir(), "s-1.jsonl");
    // Even an ai-title entry is dropped once it's past the limit, which shows the line wasn't kept.
    const huge = line(title("x".repeat(1_200_000)));
    writeFileSync(path, huge.slice(0, 1_100_000));
    const tail = new TranscriptTail({ firstReadBytes: 2_000_000 });
    expect(tail.read(path).title).toBeNull();
    appendFileSync(path, huge.slice(1_100_000));
    expect(tail.read(path).title).toBeNull();
    appendFileSync(path, line(title("After the big one")));
    expect(tail.read(path).title).toBe("After the big one");
  });

  test("keeps multi-byte characters whole across reads", () => {
    const path = join(tempDir(), "s-1.jsonl");
    const full = Buffer.from(line(title("Café ☕ crème")));
    const cut = full.indexOf(Buffer.from("☕")) + 1; // inside the 3-byte character
    writeFileSync(path, full.subarray(0, cut));
    const tail = new TranscriptTail();
    tail.read(path);
    appendFileSync(path, full.subarray(cut));
    expect(tail.read(path).title).toBe("Café ☕ crème");
  });
});

describe("findTranscript", () => {
  test("findTranscript looks for <sessionId>.jsonl one folder down", () => {
    const projects = tempDir();
    mkdirSync(join(projects, "-w-api"));
    mkdirSync(join(projects, "-w-dialog"));
    writeFileSync(join(projects, "-w-dialog", "s-1.jsonl"), "");
    expect(findTranscript(projects, "s-1")).toBe(join(projects, "-w-dialog", "s-1.jsonl"));
    expect(findTranscript(projects, "s-2")).toBeNull();
    expect(findTranscript(join(projects, "missing"), "s-1")).toBeNull();
    // A session ID that isn't a plain name is never used as a path.
    expect(findTranscript(projects, "../-w-dialog/s-1")).toBeNull();
  });
});
