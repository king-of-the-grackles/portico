#!/usr/bin/env bun
// Builds the single-file `portico` executables into dist/.
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

const run = (cmd: string[]) => Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" }).exitCode ?? 1;

// Browser modules go into the binary as a generated module; the stub is put back afterwards.
if (run(["bun", "server/scripts/bundle-client.ts"]) !== 0) process.exit(1);
let failed = 0;
try {
  for (const target of targets) {
    const outfile = `dist/portico-${target.replace(/^bun-/, "")}`;
    failed = run([
      "bun", "build", "server/src/cli.ts", "--compile", `--target=${target}`, "--no-compile-autoload-bunfig", `--outfile=${outfile}`,
    ]);
    if (failed !== 0) break;
    console.log(`Built ${outfile}`);
  }
} finally {
  run(["bun", "server/scripts/bundle-client.ts", "--restore"]);
}
process.exit(failed);
