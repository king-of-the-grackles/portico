// The test object every recorded flow imports: `rec` is a phone-sized browser with video on, and `world` is the
// browser suite's own (the same test people, the same cleanup). A flow calls rec.step() at each screen worth seeing.
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { BASE_URL } from "../../lib/env";
import { test as base, expect } from "../../lib/fixtures";
import { PHONE, type Recording, type Step } from "./captions";

export { expect };

export interface StepOptions {
  /** How long to stay on the screen, in milliseconds. Default 4000. */
  hold?: number;
  /** False: the video shows the step and no screenshot is saved. Default true. */
  shot?: boolean;
}

export class Recorder {
  private readonly started = Date.now();
  private readonly steps: Step[] = [];
  private readonly notShown: string[] = [];
  private shots = 0;

  constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly out: string,
  ) {}

  /** A screen worth seeing: `says` is the one sentence under the video and in steps.md, `slug` names the screenshot. */
  async step(slug: string, says: string, opts: StepOptions = {}): Promise<void> {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`A step's name is lower-case words joined by hyphens, not "${slug}".`);
    const hold = opts.hold ?? 4000;
    const shot = opts.shot === false ? null : `${String(++this.shots).padStart(2, "0")}-${slug}.png`;
    this.steps.push({ at: (Date.now() - this.started) / 1000, shot, says, hold: (hold + SETTLE_MS) / 1000 });
    await this.page.waitForTimeout(SETTLE_MS);
    if (shot) await this.page.screenshot({ path: path.join(this.out, shot) });
    await this.page.waitForTimeout(hold);
  }

  /** Types into a labelled box a key at a time, so the eye can follow. */
  async type(label: string, value: string): Promise<void> {
    const box = this.page.getByLabel(label);
    await box.fill("");
    await box.pressSequentially(value, { delay: 90 });
  }

  /** A pause with nothing to say: after a page opens, before a click. */
  pause(ms = 1500): Promise<void> {
    return this.page.waitForTimeout(ms);
  }

  /** Something the flow cannot show, said in steps.md so the viewer knows. */
  cannotShow(sentence: string): void {
    this.notShown.push(sentence);
  }

  /** Called by the fixture once the browser is closed and the video file is whole. */
  write(meta: { flow: string; title: string; video: string }): void {
    const rec: Recording & { video: string } = {
      flow: meta.flow,
      title: meta.title,
      target: BASE_URL,
      commit: process.env.SMOKE_COMMIT ?? "unknown",
      recordedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      total: (Date.now() - this.started) / 1000,
      notShown: this.notShown,
      steps: this.steps,
      video: meta.video,
    };
    fs.writeFileSync(path.join(this.out, "steps.json"), JSON.stringify(rec, null, 2));
  }
}

const SETTLE_MS = 700;

export const test = base.extend<{ rec: Recorder }>({
  rec: async ({ browser }, use, info) => {
    const out = process.env.SMOKE_OUT_DIR;
    if (!out) throw new Error("SMOKE_OUT_DIR is not set: flows are run by e2e/smoke.sh.");
    fs.mkdirSync(out, { recursive: true });
    const context = await browser.newContext({
      baseURL: BASE_URL,
      viewport: PHONE,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      recordVideo: { dir: path.join(out, "raw"), size: PHONE },
    });
    const page = await context.newPage();
    const rec = new Recorder(context, page, out);
    await use(rec);
    await context.close();
    const video = await page.video()?.path();
    // Only a flow that ran to its end is turned into a video: a failed one leaves no steps.json.
    if (info.status === "passed" && video) rec.write({ flow: path.basename(info.file).replace(/\.flow\.ts$/, ""), title: info.title, video });
  },
});
