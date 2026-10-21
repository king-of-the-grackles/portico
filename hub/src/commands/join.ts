// One implementation of joining: the plugin's. cli-run.ts imports only node built-ins and has no side effects, so the
// hub's single-file build bundles it safely.
import { runCli } from "../../../plugin-claude-code/src/cli-run";
import type { CliIo } from "./io";

/** `bridge join <line> [--name <machine>] [--replace]`: joins this machine to a hub and writes machine.json. */
export async function joinCommand(
  args: string[],
  io: CliIo,
  deps: { fetch?: typeof fetch; hostname?: () => string } = {},
): Promise<number> {
  return runCli(["join", ...args], io, deps);
}
