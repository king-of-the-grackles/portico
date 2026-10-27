// Runs before the plugin's dependencies are installed (the leave command, and the server's `portico leave`), so it
// imports only node:* and the files beside it.
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { removeLine, removePorticoAllowRule } from "./claude-settings";
import { type ComputerFile, ComputerFileError, readComputerFile, removeComputerFile } from "./computer";
import { callPortico, CommandError, refusal } from "./computer-api";

/** What uninstalls the plugin, as the person would type it. */
export const UNINSTALL_COMMAND = "claude plugin uninstall portico@portico";
const UNINSTALL_ARGS = ["plugin", "uninstall", "portico@portico"];

export interface LeaveDeps {
  configPath: string;
  /** Claude Code's user settings, where the join added the allow rule. */
  settingsPath: string;
  fetch?: typeof fetch;
  /** The `claude` executable, or null when it isn't on the PATH. Default: a look through process.env.PATH. */
  findClaude?: () => string | null;
  /** Runs `claude plugin uninstall portico@portico` and returns its exit status (null when it didn't exit). */
  uninstall?: (claude: string) => number | null;
}

/**
 * Undoes a join: tells Portico to remove this computer and its sessions, removes computer.json, takes the allow rule
 * out of Claude Code's settings and uninstalls the plugin. Every step runs even when an earlier one couldn't: a
 * Portico that can't be reached gets a note, not a failure. Returns the lines to print.
 */
export async function leaveComputer(deps: LeaveDeps): Promise<string[]> {
  const lines: string[] = [];
  let file: ComputerFile | null = null;
  try {
    file = readComputerFile(deps.configPath);
  } catch (err) {
    if (!(err instanceof ComputerFileError)) throw err;
    lines.push(`${err.message} Portico wasn't told; remove the computer in Settings › Computers.`);
  }
  if (file) lines.push(await tellPortico(file, deps.fetch));
  else if (lines.length === 0) lines.push(`No computer file at ${deps.configPath}, so there was nothing to tell Portico.`);

  if (removeComputerFile(deps.configPath)) lines.push(`Removed ${deps.configPath}.`);
  const rule = removeLine(removePorticoAllowRule(deps.settingsPath));
  if (rule) lines.push(rule);

  const claude = (deps.findClaude ?? (() => findOnPath("claude", process.env.PATH)))();
  if (!claude) {
    lines.push(`To remove the plugin too, run: ${UNINSTALL_COMMAND}`);
  } else {
    const status = (deps.uninstall ?? runUninstall)(claude);
    lines.push(
      status === 0
        ? "Uninstalled the Portico plugin (portico@portico)."
        : `The plugin uninstall didn't finish (claude exited with ${status ?? "a signal"}). To remove the plugin, run: ${UNINSTALL_COMMAND}`,
    );
  }
  lines.push("This computer has left Portico.");
  return lines;
}

async function tellPortico(file: ComputerFile, doFetch?: typeof fetch): Promise<string> {
  const where = `Remove computer "${file.computer}" in Settings › Computers.`;
  try {
    const answer = await callPortico(file.url, "DELETE", "/api/computer", { token: file.token, fetch: doFetch });
    if (answer.ok) return `Portico removed computer "${file.computer}" along with every session there.`;
    if (answer.status === 401) return `Computer "${file.computer}" was already gone from Portico.`;
    return `Portico refused to remove computer "${file.computer}": ${refusal(file.url, answer)} ${where}`;
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    return `Portico at ${file.url} could not be reached, so computer "${file.computer}" stays listed there. ${where}`;
  }
}

/** An executable file named `name` in one of the PATH's folders, or null. */
export function findOnPath(name: string, path: string | undefined): string | null {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function runUninstall(claude: string): number | null {
  const result = spawnSync(claude, UNINSTALL_ARGS, { stdio: "ignore", timeout: 120_000 });
  return result.error ? null : result.status;
}
