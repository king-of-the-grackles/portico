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
    const guard = dev.indexOf("if: env.DRILL == 'true' && steps.previous.outputs.image == ''");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(dev.indexOf("- name: Deploy\n"));
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
