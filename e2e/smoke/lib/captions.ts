// What turns a recorded flow's steps into the caption bar under the video and into steps.md. No browser, no ffmpeg:
// plain functions, so they are unit-tested (server/test/smoke.test.ts).

/** One step of a flow, as the recorder wrote it. */
export interface Step {
  /** Seconds into the video when the step's screen was ready. */
  at: number;
  /** The screenshot's file name, or null for a step only the video shows. */
  shot: string | null;
  /** One sentence: what the viewer should see. */
  says: string;
  /** How long the recorder held the screen after it, in seconds. */
  hold: number;
}

export interface Recording {
  flow: string;
  title: string;
  target: string;
  commit: string;
  recordedAt: string;
  /** The video's length in seconds. */
  total: number;
  /** What the flow does not show, one sentence each. */
  notShown: string[];
  steps: Step[];
}

export interface Caption {
  from: number;
  to: number;
  lines: string[];
}

/** The phone the flows are recorded at, in CSS pixels. The video is twice that, with the caption bar under it. */
export const PHONE = { width: 390, height: 844 };
export const VIDEO = { width: PHONE.width * 2, height: PHONE.height * 2, bar: 240 };
export const CAPTION_LINE_CHARS = 46;
export const CAPTION_MAX_LINES = 3;
/** Each screenshot is sent as a file of its own, in one message a person can take in: five at most. */
export const MAX_SHOTS = 5;
export const MIN_SHOTS = 3;

/** Breaks a sentence into lines of at most `width` characters, at spaces. A longer word gets a line of its own. */
export function wrap(text: string, width = CAPTION_LINE_CHARS): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * When each step's caption shows. A caption starts once the step before has been held (never later than its own
 * screen is ready), so it covers the clicks and typing that lead to its screen, and the last one stays to the end.
 */
export function captions(steps: Step[], total: number): Caption[] {
  return steps.map((step, i) => {
    const before = steps[i - 1];
    const from = before ? Math.min(before.at + before.hold, step.at) : 0;
    const next = steps[i + 1];
    const to = next ? Math.min(step.at + step.hold, next.at) : Math.max(total, step.at);
    return { from: round(from), to: round(to), lines: [`${i + 1} of ${steps.length}`, ...wrap(step.says)] };
  });
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A problem with the steps that would make a bad recording, or null. */
export function problem(rec: Pick<Recording, "steps" | "total">): string | null {
  if (rec.steps.length === 0) return "The flow recorded no steps.";
  const shots = rec.steps.filter((s) => s.shot).length;
  if (shots < MIN_SHOTS || shots > MAX_SHOTS) return `The flow saved ${shots} screenshots: ${MIN_SHOTS} to ${MAX_SHOTS} are wanted.`;
  if (rec.total < 30 || rec.total > 90) return `The video is ${Math.round(rec.total)} seconds long: 30 to 90 are wanted.`;
  const long = rec.steps.find((s) => wrap(s.says).length > CAPTION_MAX_LINES);
  if (long) return `This caption does not fit the bar (${CAPTION_MAX_LINES} lines of ${CAPTION_LINE_CHARS} characters): "${long.says}"`;
  return null;
}

/**
 * ffmpeg's -vf for the phone video: doubled, with a bar under it, and one drawtext per caption reading its text from
 * `<captionDir>/<n>.txt` (a file, so no caption text has to be escaped into the filter).
 */
export function videoFilter(caps: Caption[], captionDir: string, font: string): string {
  const parts = [`scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos`, `pad=${VIDEO.width}:${VIDEO.height + VIDEO.bar}:0:0:color=0x12302a`];
  caps.forEach((cap, i) => {
    parts.push(
      `drawtext=fontfile=${filterPath(font)}:textfile=${filterPath(`${captionDir}/${i}.txt`)}:fontsize=30:fontcolor=white:line_spacing=10:x=32:y=${VIDEO.height + 28}:enable='between(t,${cap.from},${cap.to})'`,
    );
  });
  return parts.join(",");
}

/** A path inside a filter: the characters the filter syntax reads are escaped. */
const filterPath = (p: string) => p.replace(/([\\:',\[\];])/g, "\\$1");

/** steps.md: one line per step, for someone who reads no code. */
export function stepsMarkdown(rec: Recording): string {
  const caps = captions(rec.steps, rec.total);
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");
  return [
    `# ${rec.title}`,
    "",
    `Recorded on ${rec.target} at commit \`${rec.commit}\`, ${rec.recordedAt}, at phone size (${PHONE.width} x ${PHONE.height}). The video is ${Math.round(rec.total)} seconds long and shows a caption under each step.`,
    "",
    "| Step | From (seconds) | Screenshot | What the viewer should see |",
    "| --- | --- | --- | --- |",
    ...rec.steps.map((s, i) => `| ${i + 1} | ${Math.round(caps[i]!.from)} | ${s.shot ?? "video only"} | ${cell(s.says)} |`),
    "",
    ...(rec.notShown.length > 0 ? ["Not shown:", "", ...rec.notShown.map((n) => `- ${n}`), ""] : []),
  ].join("\n");
}
