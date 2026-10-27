// One implementation of leaving: the plugin's, as for joining.
import { type CliDeps, runCli } from "../../../plugin-claude-code/src/cli-run";
import type { CliIo } from "./io";

/**
 * `portico leave`: takes this computer off Portico and undoes the join: removes the computer on Portico, then
 * ~/.portico/computer.json, the settings rule and the plugin.
 */
export async function leaveCommand(args: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  return runCli(["leave", ...args], io, deps);
}
