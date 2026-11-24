// Turns what a flow recorded (steps.json and the raw video) into smoke.mp4 and steps.md, in the same folder.
//
//   bun smoke/render.ts <output folder>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Recording, captions, problem, stepsMarkdown, videoFilter } from "./lib/captions";

const out = process.argv[2];
if (!out) throw new Error("usage: bun smoke/render.ts <output folder>");

const rec: Recording & { video: string } = JSON.parse(fs.readFileSync(path.join(out, "steps.json"), "utf8"));
const wrong = problem(rec);
if (wrong) {
  console.error(`smoke: ${wrong}`);
  process.exit(1);
}

// Any sans-serif font the computer has: the caption bar is drawn here, not in the browser.
const font = execFileSync("fc-match", ["-f", "%{file}", "sans"], { encoding: "utf8" }).trim();
if (!font || !fs.existsSync(font)) throw new Error("fc-match found no font for the caption bar.");

const caps = captions(rec.steps, rec.total);
const capDir = fs.mkdtempSync(path.join(out, "captions-"));
try {
  caps.forEach((cap, i) => fs.writeFileSync(path.join(capDir, `${i}.txt`), cap.lines.join("\n")));
  // H.264 High with yuv420p and the index up front: what an iPhone plays, in a chat or from Files.
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", rec.video, "-vf", videoFilter(caps, capDir, font), "-c:v", "libx264", "-profile:v", "high", "-level", "4.2", "-pix_fmt", "yuv420p", "-r", "30", "-crf", "23", "-movflags", "+faststart", "-an", path.join(out, "smoke.mp4")],
    { stdio: "inherit" },
  );
} finally {
  fs.rmSync(capDir, { recursive: true, force: true });
}

const { video: _raw, ...shown } = rec;
fs.writeFileSync(path.join(out, "steps.md"), stepsMarkdown(shown));
// The raw recording and the working file go: the folder holds what is handed over and nothing else.
fs.rmSync(path.join(out, "raw"), { recursive: true, force: true });
fs.rmSync(path.join(out, "steps.json"), { force: true });

const size = fs.statSync(path.join(out, "smoke.mp4")).size;
console.log(`smoke: ${rec.flow}: smoke.mp4 (${Math.round(rec.total)} s, ${(size / 1e6).toFixed(1)} MB), ${rec.steps.filter((s) => s.shot).length} screenshots and steps.md in ${out}`);
