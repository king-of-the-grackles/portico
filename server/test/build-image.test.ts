// scripts/deploy/build-image.sh: the build that the Deploy workflow runs before a release, with a flyctl that is a
// stand-in. No test here reaches Fly.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const script = join(root, "scripts", "deploy", "build-image.sh");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/**
 * Runs the script with a `flyctl` that writes down each call and then does what `behaviour` says, per call: a shell
 * line run with the call's number in $n.
 */
function run(behaviour: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "portico-build-image-"));
  const calls = join(dir, "calls");
  const output = join(dir, "output");
  writeFileSync(join(dir, "flyctl"), `#!/usr/bin/env bash\necho "$*" >>"${calls}"\nn="$(wc -l <"${calls}")"\n${behaviour}\n`);
  chmodSync(join(dir, "flyctl"), 0o755);
  const result = Bun.spawnSync(["bash", script, "fly.hosted.toml", "portico-chat", COMMIT], {
    env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "2", ...env },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    output: existsSync(output) ? readFileSync(output, "utf8") : "",
  };
}

describe("scripts/deploy/build-image.sh", () => {
  test("a build that works is one call: build only, pushed, labelled for this commit, run and try", () => {
    const { code, calls, output, out } = run("exit 0");
    expect(code).toBe(0);
    expect(calls).toEqual([`deploy -c fly.hosted.toml -a portico-chat --build-only --push --image-label commit-0123456789ab-77-2-1 --build-arg PORTICO_COMMIT=${COMMIT}`]);
    expect(output).toBe("image=registry.fly.io/portico-chat:commit-0123456789ab-77-2-1\n");
    expect(out.trim().split("\n").at(-1)).toBe("image=registry.fly.io/portico-chat:commit-0123456789ab-77-2-1");
  });

  test("a build that fails is tried once more, on Fly's own builder, under a label of its own", () => {
    const { code, calls, output, out } = run('[ "$n" = 1 ] && exit 1; exit 0');
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(`deploy -c fly.hosted.toml -a portico-chat --build-only --push --image-label commit-0123456789ab-77-2-2 --build-arg PORTICO_COMMIT=${COMMIT} --depot=false`);
    expect(output).toBe("image=registry.fly.io/portico-chat:commit-0123456789ab-77-2-2\n");
    expect(out).toContain("::warning title=Image build tried again::The first build of portico-chat failed (exit 1).");
  });

  test("a build that hangs is cut off and tried once more", () => {
    const { code, calls, output, out } = run('[ "$n" = 1 ] && sleep 30; exit 0', { BUILD_TIMEOUT: "1" });
    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--depot=false");
    expect(out).toContain("was cut off after 1s without finishing");
    expect(output).toBe("image=registry.fly.io/portico-chat:commit-0123456789ab-77-2-2\n");
  });

  test("two builds that don't finish fail the step and name no image: there is no third try", () => {
    const { code, calls, output, err } = run("exit 3");
    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
    expect(output).toBe("");
    expect(err).toContain("Nothing was deployed.");
  });

  test("no call the script makes is a release: every one is --build-only", () => {
    for (const behaviour of ["exit 0", "exit 1"]) for (const call of run(behaviour).calls) expect(call).toContain("--build-only");
  });
});
