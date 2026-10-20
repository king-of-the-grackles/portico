#!/usr/bin/env bun
// Builds the single-file `bridge` executables (spec §13).
// Usage: bun scripts/build.ts [target ...]   (default: all three; "host" means this machine's platform)
const TARGETS = ["bun-darwin-arm64", "bun-linux-x64", "bun-linux-arm64"] as const;
const host = `bun-${process.platform}-${process.arch}`;

const asked = process.argv.slice(2).map((target) => (target === "host" ? host : target));
const targets = asked.length > 0 ? asked : [...TARGETS];
for (const target of targets) {
  if (!(TARGETS as readonly string[]).includes(target)) {
    console.error(`Unknown target ${target}. Use one of: ${TARGETS.join(", ")}, or host.`);
    process.exit(1);
  }
}

for (const target of targets) {
  const outfile = `dist/bridge-${target.replace(/^bun-/, "")}`;
  const build = Bun.spawnSync(
    ["bun", "build", "hub/src/cli.ts", "--compile", `--target=${target}`, "--no-compile-autoload-bunfig", `--outfile=${outfile}`],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
  console.log(`Built ${outfile}`);
}
