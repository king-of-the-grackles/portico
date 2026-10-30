#!/usr/bin/env bun
// Writes plugin-claude-code/bun.lock from the root bun.lock. Claude Code copies only the plugin folder, and the plugin's
// start script installs from this lock with --frozen-lockfile, so hosts get the reviewed versions, never the registry's
// newest in-range ones. Every package entry is copied from the root lock as it stands: nothing is resolved again.
// Usage: bun scripts/plugin-lock.ts   (run after any change to the root bun.lock; the manifest test fails until then)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE = "plugin-claude-code";

type Meta = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalPeers?: string[];
};
type Lock = {
  lockfileVersion: number;
  configVersion: number;
  workspaces: Record<string, { name: string; version?: string } & Record<string, unknown>>;
  packages: Record<string, [string, string?, Meta?, string?]>;
};

/** Parses a bun.lock, which is JSON with trailing commas. */
export const parseLock = (text: string): Lock => JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));

/** The key a package sits under, minus its own name: "express/content-type" → "express", "@a/b/c" → "@a/b". */
function parentKey(key: string): string {
  const parts = key.split("/");
  return parts.slice(0, parts.length >= 2 && parts.at(-2)!.startsWith("@") ? -2 : -1).join("/");
}

/** The package `name` resolves to from `from`, as bun finds it: the nearest nested copy, else the hoisted one. */
function resolveKey(packages: Lock["packages"], from: string, name: string): string | undefined {
  for (let parent = from; parent; parent = parentKey(parent)) {
    if (packages[`${parent}/${name}`]) return `${parent}/${name}`;
  }
  return packages[name] ? name : undefined;
}

/** The plugin's own bun.lock text: its workspace as the only one, and its install closure from the root lock. */
export function pluginLock(rootText: string): string {
  const root = parseLock(rootText);
  const { version: _, ...workspace } = root.workspaces[WORKSPACE]!;
  const keys = new Set<string>();
  const visit = (from: string, required: Record<string, string> = {}, optional: string[] = []) => {
    for (const name of [...Object.keys(required), ...optional]) {
      const key = resolveKey(root.packages, from, name);
      if (key === undefined) {
        if (name in required) throw new Error(`${name}, needed by ${from}, is not in the root bun.lock`);
        continue;
      }
      // A copy nested under the workspace would sit at a different key in the plugin's own lock.
      if (key.startsWith(`${workspace.name}/`)) throw new Error(`${key} is nested under the plugin in the root bun.lock`);
      if (keys.has(key)) continue;
      keys.add(key);
      const meta = root.packages[key]![2] ?? {};
      const peers = Object.keys(meta.peerDependencies ?? {}).filter((peer) => !meta.optionalPeers?.includes(peer));
      visit(key, meta.dependencies, [...Object.keys(meta.optionalDependencies ?? {}), ...peers]);
    }
  };
  visit(workspace.name, workspace.dependencies as Record<string, string>);

  // Entries are copied line for line, in the root lock's order, which is the order bun writes them in.
  const lines = rootText.split("\n").filter((line) => keys.has(/^ {4}"([^"]+)": \[/.exec(line)?.[1] ?? ""));
  if (lines.length !== keys.size) throw new Error("the root bun.lock has an entry that isn't on a line of its own");
  const object = (value: object, indent: string): string =>
    `{\n${Object.entries(value)
      .map(([key, item]) => `${indent}  ${JSON.stringify(key)}: ${typeof item === "object" ? object(item, `${indent}  `) : JSON.stringify(item)},\n`)
      .join("")}${indent}}`;
  return [
    "{",
    `  "lockfileVersion": ${root.lockfileVersion},`,
    `  "configVersion": ${root.configVersion},`,
    `  "workspaces": ${object({ "": workspace }, "  ")},`,
    `  "packages": {`,
    lines.join("\n\n"),
    "  }",
    "}",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  writeFileSync(join(root, WORKSPACE, "bun.lock"), pluginLock(readFileSync(join(root, "bun.lock"), "utf8")));
  console.log(`Wrote ${WORKSPACE}/bun.lock`);
}
