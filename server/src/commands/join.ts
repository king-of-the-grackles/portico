// One implementation of joining: the plugin's. cli-run.ts imports only node built-ins and the files beside it, and has
// no side effects, so Portico's single-file build bundles it safely.
import { type CliDeps, runCli } from "../../../plugin-claude-code/src/cli-run";
import type { CliIo } from "./io";

/**
 * `portico join <address> [--name <computer>] [--replace] [--no-allow]`: asks to join this computer to the Portico
 * server at the address and prints the link a person allows the join with. The page then shows that person a 4-digit
 * code: typed at this command's prompt in a terminal, or handed in with `portico join --code <4 digits>`. Then writes
 * ~/.portico/computer.json and allows the Portico tools in Claude Code's settings.
 */
export async function joinCommand(args: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  return runCli(["join", ...args], io, { command: "portico", ...deps });
}
