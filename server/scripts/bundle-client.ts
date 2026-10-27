#!/usr/bin/env bun
// Writes every browser module, transpiled, into src/web/client-bundle.gen.ts, so a single-file build serves them without
// source files. Run just before `bun build --compile`; `--restore` puts the stub back afterwards.
// Usage: bun server/scripts/bundle-client.ts [--restore] [--out <file>]
import { join } from "node:path";
import { CLIENT_DIR, listClientModules, transpileClient } from "../src/web/client-modules";

const HEADER = `// Replaced by \`bun server/scripts/bundle-client.ts\` just before a single-file build, which holds no source files to read.
// Running from source, it stays null and browser modules are read from server/src/web/client/ instead.
`;
export const STUB = `${HEADER}export const CLIENT_BUNDLE: Record<string, string> | null = null;\n`;

/** The generated module: every browser module's JavaScript by served path. */
export async function bundleSource(dir: string = CLIENT_DIR): Promise<string> {
  const entries: [string, string][] = [];
  for (const path of listClientModules(dir)) {
    entries.push([path, transpileClient(await Bun.file(join(dir, path.replace(/\.js$/, ".ts"))).text())]);
  }
  return `${HEADER}export const CLIENT_BUNDLE: Record<string, string> | null = ${JSON.stringify(Object.fromEntries(entries), null, 0)};\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1]! : join(import.meta.dir, "..", "src", "web", "client-bundle.gen.ts");
  if (args.includes("--restore")) {
    await Bun.write(out, STUB);
    console.log(`Restored ${out}`);
  } else {
    await Bun.write(out, await bundleSource());
    console.log(`Wrote ${listClientModules().length} browser modules to ${out}`);
  }
}
