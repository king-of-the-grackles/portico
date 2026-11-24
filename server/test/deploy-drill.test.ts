// The Deploy workflow's rollback drill (README, "Rollback drill"): a manual run that fails one dev deploy on purpose.
// These tests hold the drill to the dev job, and the production jobs out of it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const workflow = readFileSync(join(root, ".github", "workflows", "deploy.yml"), "utf8");

/** The workflow cut at its top-level and job headings: `on`, `env`, and each job by name. */
function sections(): Record<string, string> {
  const jobsAt = workflow.indexOf("\njobs:\n");
  const out: Record<string, string> = { top: workflow.slice(0, jobsAt) };
  const jobs = workflow.slice(jobsAt + "\njobs:\n".length);
  const heads = [...jobs.matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gm)];
  heads.forEach((head, i) => {
    out[head[1]!] = jobs.slice(head.index!, heads[i + 1]?.index ?? jobs.length);
  });
  return out;
}

const NOT_A_DRILL = "if: ${{ !(github.event_name == 'workflow_dispatch' && inputs.drill == true) }}";

describe("the rollback drill", () => {
  const parts = sections();

  test("the workflow has the jobs this test knows", () => {
    for (const name of ["top", "deploy-dev", "e2e-dev", "plan-production", "deploy-production"]) expect(parts[name]?.length ?? 0, name).toBeGreaterThan(100);
  });

  test("it is a box on the manual run, off unless ticked, and never on for a run that follows CI", () => {
    expect(parts.top).toMatch(/workflow_dispatch:\n {4}inputs:\n(?: {6}#.*\n)* {6}drill:\n(?: {8}.*\n)*? {8}type: boolean\n {8}default: false\n/);
    expect(parts.top).toContain("DRILL: ${{ github.event_name == 'workflow_dispatch' && inputs.drill == true }}");
  });

  test("only the dev job acts on it", () => {
    for (const [name, text] of Object.entries(parts)) {
      if (name === "top" || name === "deploy-dev") continue;
      // Everything a later job says about a drill is its own guard: one comment and one condition.
      const mentions = text.split("\n").filter((line) => /drill/i.test(line)).map((line) => line.trim());
      const allowed = name === "plan-production" || name === "deploy-production" ? ["# Never in a drill, whatever the jobs before it did.", NOT_A_DRILL] : [];
      expect(mentions, name).toEqual(allowed);
    }
  });

  test("the plan and production jobs are skipped in a drill by their own condition, and still need the job before them", () => {
    expect(parts["plan-production"]).toContain(`needs: e2e-dev\n    # Never in a drill, whatever the jobs before it did.\n    ${NOT_A_DRILL}\n`);
    expect(parts["deploy-production"]).toContain(NOT_A_DRILL);
    expect(parts["deploy-production"]).toMatch(/needs: (plan-production|\[plan-production, watch-dev\])\n/);
    // No status function in the guard, so GitHub still requires the jobs before it to have succeeded.
    for (const fn of ["always()", "!cancelled()", "failure()"]) expect(NOT_A_DRILL).not.toContain(fn);
  });

  test("production is always built under the commit's own ID", () => {
    expect(parts["deploy-production"]).toContain('flyctl deploy -c fly.hosted.toml -a "$PRODUCTION_APP" --ha=false --build-arg "PORTICO_COMMIT=$DEPLOY_SHA"');
    expect(parts["deploy-production"]).not.toContain("BUILD_COMMIT");
  });

  test("in a drill dev is built under another name, waits a short time for the real commit, and refuses to start without an image to go back to", () => {
    const dev = parts["deploy-dev"]!;
    expect(dev).toContain("BUILD_COMMIT: ${{ env.DRILL == 'true' && format('drill-{0}', github.run_number) || env.DEPLOY_SHA }}");
    expect(dev).toContain('--build-arg "PORTICO_COMMIT=$BUILD_COMMIT"');
    expect(dev).toContain("WAIT_SECONDS: ${{ env.DRILL == 'true' && '60' || '300' }}");
    expect(dev).toContain('scripts/deploy/wait-healthz.sh "$DEV_URL" "$DEPLOY_SHA" "$WAIT_SECONDS"');
  });

  test("a drill starts only when dev already runs the commit it builds, so no new code or migration reaches dev's data", () => {
    const dev = parts["deploy-dev"]!;
    const start = dev.indexOf('- name: "Drill: stop unless dev already runs this commit and its image was recorded"');
    const deploy = dev.indexOf("- name: Deploy\n");
    expect(start).toBeGreaterThan(-1);
    // Before anything is deployed, and after the running image was recorded.
    expect(start).toBeLessThan(deploy);
    expect(start).toBeGreaterThan(dev.indexOf("- name: Record the image running now"));
    const guard = dev.slice(start, deploy);
    expect(guard).toContain("if: env.DRILL == 'true'\n");
    expect(guard).not.toContain("continue-on-error");
    // No image to go back to: stop.
    expect(guard).toMatch(/if \[ -z "\$PREVIOUS_IMAGE" \]; then\n.*\n\s+exit 1/);
    // Dev's own answer, read with one GET, must be exactly the commit being built: anything else stops the drill.
    expect(guard).toContain('curl -fsS --max-time 15 --retry 2 --retry-delay 5 "$DEV_URL/healthz"');
    expect(guard).toMatch(/if \[ "\$running" != "\$DEPLOY_SHA" \]; then\n.*\n\s+exit 1/);
    expect(guard).not.toContain("flyctl");
    // The step runs for real in a shell: dev on another commit, dev silent, and dev on this commit.
    const script = guard.slice(guard.indexOf("run: |\n") + "run: |\n".length).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
    const run = (healthz: string | null, image = "registry.fly.io/portico-dev:deployment-1") => {
      const curl = healthz === null ? "return 22" : `printf '%s' '${healthz}'`;
      return Bun.spawnSync(["bash", "-euo", "pipefail", "-c", `curl() { ${curl}; }\n${script}`], {
        env: { PATH: process.env.PATH!, DEV_APP: "portico-dev", DEV_URL: "https://dev.example", DEPLOY_SHA: "a".repeat(40), PREVIOUS_IMAGE: image },
      });
    };
    expect(run(`{"ok":true,"commit":"${"a".repeat(40)}"}`).exitCode).toBe(0);
    const behind = run(`{"ok":true,"commit":"${"b".repeat(40)}"}`);
    expect(behind.exitCode).toBe(1);
    expect(behind.stderr.toString()).toContain("not deploying");
    expect(run(null).exitCode).toBe(1);
    expect(run("not json").exitCode).toBe(1);
    expect(run(`{"ok":true,"commit":"drill-7"}`).exitCode).toBe(1);
    expect(run(`{"ok":true,"commit":"${"a".repeat(40)}"}`, "").exitCode).toBe(1);
  });

  test("the rollback step itself knows nothing of drills: the drill runs the real one", () => {
    const dev = parts["deploy-dev"]!;
    const start = dev.indexOf("- name: Roll back to the previous image");
    const step = dev.slice(start, dev.indexOf("- name: Summary", start));
    expect(step.length).toBeGreaterThan(200);
    expect(step).not.toMatch(/drill/i);
    expect(step).toContain("steps.deploy.outcome == 'failure' || steps.healthz.outcome == 'failure'");
  });
});
