import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { copyProblems } from "./helpers";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_ENV: "test" } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

describe("cli", () => {
  test("help lists the commands, in the copy rules", async () => {
    const { code, out } = await run(["help"]);
    expect(code).toBe(0);
    for (const command of ["serve", "setup", "doctor", "join", "leave"]) expect(out).toContain(`  ${command}`);
    expect(out).not.toContain("init");
    expect(out).not.toContain("invite");
    expect(copyProblems(out)).toEqual([]);
  });

  test("an unknown command fails with the usage", async () => {
    const { code, err } = await run(["frobnicate"]);
    expect(code).toBe(1);
    expect(err).toContain("Unknown command: frobnicate");
  });
});
