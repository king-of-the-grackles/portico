// The 'visible change' lane: the script that decides whether a deploy waits for a person (scripts/deploy/visible.sh),
// the Deploy workflow's wiring of that wait, and the captions of the recording made on dev (e2e/smoke/).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Step, CAPTION_LINE_CHARS, VIDEO, captions, problem, stepsMarkdown, videoFilter, wrap } from "../../e2e/smoke/lib/captions";

const root = join(import.meta.dir, "..", "..");
const script = join(root, "scripts", "deploy", "visible.sh");

describe("scripts/deploy/visible.sh", () => {
  let repo: string;
  let commits: string[];
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
    return run.stdout.toString().trim();
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "portico-visible-"));
    git("init", "-q", "-b", "main");
    commits = ["live", "one", "two"].map((name) => {
      writeFileSync(join(repo, "file"), name);
      git("add", "file");
      git("commit", "-q", "-m", name);
      return git("rev-parse", "HEAD");
    });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const pull = (number: number, labels: string[], body = "", merged = true) => ({ number, merged_at: merged ? "2026-11-24T00:00:00Z" : null, labels: labels.map((name) => ({ name })), body });
  const reviewed = { protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }] };

  /** Runs the script for live..two with GitHub's answers read from files. `pulls` is per commit: [one, two]. */
  function run(pulls: (unknown[] | null)[], opts: { live?: string; environment?: unknown } = {}) {
    const api = mkdtempSync(join(tmpdir(), "portico-visible-api-"));
    const out = join(api, "output");
    const summary = join(api, "summary");
    pulls.forEach((answer, i) => {
      if (answer !== null) writeFileSync(join(api, `commits_${commits[i + 1]}_pulls.json`), JSON.stringify(answer));
    });
    if (opts.environment !== undefined) writeFileSync(join(api, "environments_visible-change.json"), JSON.stringify(opts.environment));
    const done = Bun.spawnSync(["bash", script, commits[2]!, opts.live ?? commits[0]!], {
      cwd: repo,
      env: { PATH: process.env.PATH!, VISIBLE_API_DIR: api, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    });
    const read = (file: string) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return "";
      }
    };
    const outputs = Object.fromEntries(read(out).split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const result = { code: done.exitCode, stderr: done.stderr.toString(), outputs, summary: read(summary) };
    rmSync(api, { recursive: true, force: true });
    return result;
  }

  test("without the label nothing waits, and the environment is not even looked at", () => {
    const r = run([[pull(21, ["bug"])], [pull(22, [])]]);
    expect(r.code).toBe(0);
    expect(r.outputs.visible).toBe("false");
    expect(r.outputs.visible_prs).toBe("");
    expect(r.summary).toContain("visible=false");
    expect(r.summary).not.toContain("smoke.sh");
  });

  test("a merged pull request with the label makes the deploy wait, and names the flows that exist", () => {
    const body = "What changed\n\n- Smoke flows: `join`, no-such-flow\n";
    const r = run([[pull(21, ["visible"], body)], [pull(22, [])]], { environment: reviewed });
    expect(r.code).toBe(0);
    expect(r.outputs.visible).toBe("true");
    expect(r.outputs.visible_prs).toBe("#21");
    expect(r.outputs.smoke_flows).toBe("join");
    expect(r.summary).toContain(`e2e/smoke.sh --commit ${commits[2]!.slice(0, 12)} join`);
    expect(r.summary).toContain("Named but not in `e2e/smoke/flows/`: no-such-flow");
  });

  test("a labelled pull request that was never merged doesn't count", () => {
    expect(run([[pull(21, ["visible"], "", false)], []]).outputs.visible).toBe("false");
  });

  test("what a pull request writes is never run: only plain flow names get through", () => {
    const body = "Smoke flows: $(touch pwned) `id`; join && ../../etc/passwd JOIN";
    const r = run([[pull(21, ["visible"], body)], []], { environment: reviewed });
    expect(r.code).toBe(0);
    expect(r.outputs.smoke_flows).toBe("join");
    expect(Bun.spawnSync(["ls", repo]).stdout.toString()).not.toContain("pwned");
  });

  test("a visible change is refused when the environment is missing or has no reviewer", () => {
    for (const environment of [undefined, { protection_rules: [] }, { protection_rules: [{ type: "branch_policy" }] }, { protection_rules: [{ type: "required_reviewers", reviewers: [] }] }]) {
      const r = run([[pull(21, ["visible"])], []], { environment });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not deploying");
      expect(r.outputs.visible).toBeUndefined();
    }
  });

  test("when it can't be worked out, the deploy waits rather than guesses", () => {
    // GitHub gives no answer for a commit.
    expect(run([[pull(21, [])], null], { environment: reviewed }).outputs.visible).toBe("true");
    // The live commit is unknown, unreadable, or not in the history.
    for (const live of ["missing", "unreadable", "0123456789abcdef0123456789abcdef01234567", "; rm -rf /"]) {
      const r = run([[], []], { live, environment: reviewed });
      expect(r.code).toBe(0);
      expect(r.outputs.visible).toBe("true");
    }
    // And with no reviewed environment, that is a stop too.
    expect(run([[], []], { live: "missing" }).code).toBe(1);
  });

  test("a deploy of the commit already live is not a visible change", () => {
    const r = run([], { live: commits[2] });
    expect(r.code).toBe(0);
    expect(r.outputs.visible).toBe("false");
  });
});

describe("the Deploy workflow's wait for a visible change", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "deploy.yml"), "utf8");
  const job = (name: string) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    expect(start).toBeGreaterThan(-1);
    const rest = workflow.slice(start + 1);
    const next = rest.slice(3).search(/\n  [a-z-]+:\n/);
    return next === -1 ? rest : rest.slice(0, next + 3);
  };

  test("the waiting job runs only for a visible change, in its own environment, and holds no secret", () => {
    const wait = job("watch-dev");
    expect(wait).toContain("needs: plan-production");
    expect(wait).toContain("if: needs.plan-production.outputs.visible == 'true'");
    expect(wait).toContain("environment: visible-change");
    expect(wait).not.toContain("secrets.");
    expect(wait).not.toContain("flyctl");
  });

  test("production needs the plan, and the wait either approved or not needed", () => {
    const production = job("deploy-production");
    expect(production).toContain("needs: [plan-production, watch-dev]");
    expect(production).toContain("needs.plan-production.result == 'success'");
    expect(production).toContain("needs.watch-dev.result == 'success'");
    expect(production).toContain("(needs.watch-dev.result == 'skipped' && needs.plan-production.outputs.visible == 'false')");
    // The job's own condition (the first `if:`) never says always(): a failed plan or suite must stop it.
    expect(production.slice(0, production.indexOf("runs-on:"))).not.toContain("always()");
    // A migration still waits in its own environment: one approval never covers both.
    expect(production).toContain("needs.plan-production.outputs.migration == 'true' && 'production-migration' || 'production'");
  });

  test("the script, the workflow and CONTRIBUTING.md name the same environment and label", () => {
    const sh = readFileSync(script, "utf8");
    expect(sh).toContain("ENVIRONMENT=visible-change");
    expect(sh).toContain("LABEL=visible");
    const contributing = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
    expect(contributing).toContain("Environment `visible-change`");
  });
});

describe("the recording's captions (e2e/smoke/lib/captions.ts)", () => {
  const step = (at: number, says: string, hold = 4.7, shot: string | null = "01-x.png"): Step => ({ at, says, hold, shot });

  test("a sentence wraps at spaces to the bar's width", () => {
    const lines = wrap("An agent called research-helper asks to join. The person opens its link and is asked to allow it.");
    expect(lines.length).toBe(3);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(CAPTION_LINE_CHARS);
    expect(lines.join(" ")).toBe("An agent called research-helper asks to join. The person opens its link and is asked to allow it.");
    expect(wrap("  ")).toEqual([]);
  });

  test("each caption starts when the step before has been held, never overlaps the next, and the last stays to the end", () => {
    const caps = captions([step(3, "One."), step(11, "Two.", 3.7), step(15, "Three.")], 25);
    expect(caps.map((c) => [c.from, c.to])).toEqual([
      [0, 7.7],
      [7.7, 14.7],
      [14.7, 25],
    ]);
    expect(caps[1]!.lines).toEqual(["2 of 3", "Two."]);
    for (let i = 1; i < caps.length; i++) expect(caps[i]!.from).toBeGreaterThanOrEqual(caps[i - 1]!.to);
  });

  test("a recording outside what is wanted is refused with the reason", () => {
    const five = Array.from({ length: 5 }, (_, i) => step(i * 8, `Step ${i}.`));
    expect(problem({ steps: five, total: 50 })).toBeNull();
    // Steps only the video shows don't count as screenshots.
    expect(problem({ steps: [...five, step(40, "Video only.", 4.7, null)], total: 50 })).toBeNull();
    expect(problem({ steps: [], total: 50 })).toContain("no steps");
    expect(problem({ steps: five.slice(0, 2), total: 50 })).toContain("2 screenshots");
    // Every screenshot is a file of its own, and five is what one message should hold.
    expect(problem({ steps: [...five, step(40, "A sixth.")], total: 50 })).toContain("6 screenshots: 3 to 5");
    expect(problem({ steps: five, total: 12 })).toContain("12 seconds");
    expect(problem({ steps: five, total: 140 })).toContain("140 seconds");
    expect(problem({ steps: [...five.slice(0, 4), step(40, "word ".repeat(60))], total: 50 })).toContain("does not fit");
  });

  test("the video filter doubles the phone, adds the bar, and reads caption text from files", () => {
    const filter = videoFilter(captions([step(1, "It's 5:00, isn't it?")], 30), "/tmp/out dir/captions-ab", "/usr/share/fonts/a:b.ttf");
    expect(filter).toStartWith(`scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos,pad=${VIDEO.width}:${VIDEO.height + VIDEO.bar}:0:0`);
    expect(filter).toContain("textfile=/tmp/out dir/captions-ab/0.txt");
    expect(filter).toContain("fontfile=/usr/share/fonts/a\\:b.ttf");
    expect(filter).toContain("enable='between(t,0,30)'");
    expect(filter).not.toContain("5:00");
  });

  test("steps.md has one line per step and says what is not shown", () => {
    const md = stepsMarkdown({
      flow: "join",
      title: "A person signs in",
      target: "https://dev.portico.chat",
      commit: "a4dcb2a",
      recordedAt: "2026-11-24T17:50:32Z",
      total: 52.4,
      notShown: ["Typing into the sign-in screen."],
      steps: [step(3, "The sign-in page."), step(11, "A | in the text.", 4.7, null)],
    });
    expect(md).toContain("# A person signs in");
    expect(md).toContain("Recorded on https://dev.portico.chat at commit `a4dcb2a`");
    expect(md).toContain("| 1 | 0 | 01-x.png | The sign-in page. |");
    expect(md).toContain("| 2 | 8 | video only | A \\| in the text. |");
    expect(md).toContain("- Typing into the sign-in screen.");
  });
});
