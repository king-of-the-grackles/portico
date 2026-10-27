// One implementation of joining: the plugin's. cli-run.ts imports only node built-ins and the files beside it, and has
// no side effects, so Portico's single-file build bundles it safely.
import { type CliDeps, runCli } from "../../../plugin-claude-code/src/cli-run";
import type { CliIo } from "./io";

/**
 * `portico join '<line>' [--name <computer>] [--replace] [--no-allow]`: joins this computer to Portico with a join
 * line, writes ~/.portico/computer.json, and allows the Portico tools in Claude Code's settings.
 */
export async function joinCommand(args: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  return runCli(["join", ...args], io, deps);
}
