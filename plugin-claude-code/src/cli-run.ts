// Runs before the plugin's dependencies are installed (the join, off, on and leave commands, and the server's
// `portico join` and `portico leave`), so it imports only node:* and the files beside it. No side effects: src/cli.ts
// is the entry that calls runCli.
import { resolve } from "node:path";
import { allowLine, allowPorticoTools, claudeSettingsPath } from "./claude-settings";
import { codexHome } from "./codex-config";
import { ComputerFileError, computerConfigPath, readComputerFile, realFolder } from "./computer";
import { CommandError } from "./computer-api";
import { notJoined, switchFolder } from "./folders";
import { joinComputer, JoinWaiting } from "./join";
import { findOnPath, leaveComputer, type LeaveDeps } from "./leave";

/** What a command needs from the outside world, so tests can run commands without a real process. */
export interface CliIo {
  env: Record<string, string | undefined>;
  /** The folder that relative paths resolve against, and the default folder for off and on. */
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliDeps extends Pick<LeaveDeps, "findClaude" | "uninstall"> {
  fetch?: typeof fetch;
  hostname?: () => string;
  /** For the join's wait: the clock, the pause between polls, and the gap. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

const JOIN_USAGE = "join <address> [--name <computer>] [--replace] [--no-allow] [--wait <seconds>]";
const JOIN_OPTIONS = ["--name", "--replace", "--no-allow", "--wait"];

const USAGE = `Usage: bun src/cli.ts <command>

Commands:
  ${JOIN_USAGE}
                  Ask the Portico server at the address to let this computer join. Prints a link and a 4-digit code:
                  a person opens the link, signs in, types the code and presses Allow. Then writes the computer file
                  and allows the Portico tools in Claude Code. --wait 0 only asks; the same command again keeps waiting.
  off [folder]    Keep new sessions in a folder (default: the current folder) off Portico.
  on [folder]     Let new sessions in a folder join Portico again.
  leave           Take this computer off Portico: remove the computer there, the computer file and the settings rule, and uninstall the plugin.
  status          Show the computer, the Portico address and the folders that are off.
  help            Show this message.`;

/** Runs one command and returns the exit code. CommandError and ComputerFileError messages go to `err`. */
export async function runCli(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "join":
        return await join(args, io, deps);
      case "off":
        return await folderSwitch(args, io, deps, false);
      case "on":
        return await folderSwitch(args, io, deps, true);
      case "leave":
        return await leave(args, io, deps);
      case "status":
        return status(args, io);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      default:
        io.err(`Unknown command: ${command}`);
        io.err(USAGE);
        return 1;
    }
  } catch (err) {
    if (err instanceof CommandError || err instanceof ComputerFileError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
}

function usageError(io: CliIo, problem: string, usage: string): number {
  io.err(`${problem} Usage: ${usage}`);
  return 1;
}

/** What a join that still waits says: nothing is wrong, and the same command picks the request up again. */
export function stillWaiting(expiresAt: string): string {
  return `Still waiting for a person to allow the join. Run the same command again to keep waiting: the link and the code stay the same until ${expiresAt}.`;
}

/**
 * The words that aren't options are joined with spaces into the address: the slash command passes the address as one
 * quoted argument, while a person may type "Join Portico at https://…".
 */
async function join(args: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const words: string[] = [];
  let name: string | undefined;
  let replace = false;
  let noAllow = false;
  let waitSeconds: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--replace") {
      replace = true;
    } else if (arg === "--no-allow") {
      noAllow = true;
    } else if (arg === "--name" || arg === "--wait") {
      const value = args[++i];
      if (value === undefined || JOIN_OPTIONS.includes(value)) return usageError(io, `${arg} needs a value.`, JOIN_USAGE);
      if (arg === "--name") name = value;
      else if (/^[0-9]{1,4}$/.test(value)) waitSeconds = Number(value);
      else return usageError(io, "--wait takes a number of seconds.", JOIN_USAGE);
    } else if (arg.startsWith("--")) {
      return usageError(io, `Unknown option: ${arg}.`, JOIN_USAGE);
    } else {
      words.push(arg);
    }
  }
  const address = words.join(" ").trim();
  if (!address) return usageError(io, "The Portico server's address is required.", JOIN_USAGE);

  let joined;
  try {
    joined = await joinComputer(
      { address, name, replace, client: "claude-code", waitSeconds },
      { configPath: computerConfigPath(io.env), fetch: deps.fetch, hostname: deps.hostname, out: io.out, now: deps.now, sleep: deps.sleep, pollMs: deps.pollMs },
    );
  } catch (err) {
    if (!(err instanceof JoinWaiting)) throw err;
    io.out(stillWaiting(err.expiresAt));
    return 0;
  }
  if (joined.already) {
    io.out(`This computer is already on Portico at ${joined.url} as computer "${joined.computer}". Nothing to allow.`);
  } else {
    io.out(`Joined Portico at ${joined.url} as computer "${joined.computer}".`);
    io.out(`Wrote ${joined.path} (mode 600).`);
  }
  io.out("New Claude Code sessions on this computer join Portico automatically. Sessions already open join within a few seconds, or after a restart when the plugin was installed after the session started.");
  io.out("To keep a folder off Portico, run /portico:off in a Claude Code session in that folder.");
  for (const folder of joined.unsynced) {
    io.out(`${folder} was off before, but Portico couldn't be told to keep the folder off. Run /portico:off there again.`);
  }
  if (!noAllow) {
    const allowed = allowLine(allowPorticoTools(claudeSettingsPath(io.env)));
    if (allowed) io.out(allowed);
  }
  return 0;
}

async function folderSwitch(args: string[], io: CliIo, deps: CliDeps, joins: boolean): Promise<number> {
  const usage = joins ? "on [folder]" : "off [folder]";
  const option = args.find((arg) => arg.startsWith("--"));
  if (option !== undefined) return usageError(io, `Unknown option: ${option}.`, usage);
  if (args.length > 1) return usageError(io, "Only one folder at a time.", usage);
  const { folder } = await switchFolder({
    configPath: computerConfigPath(io.env),
    folder: realFolder(resolve(io.cwd, args[0] ?? ".")),
    joins,
    fetch: deps.fetch,
  });
  io.out(
    joins
      ? `${folder} is on Portico again: new sessions there join, and sessions already open there join after a restart.`
      : `${folder} is off Portico now: new sessions there stay off, and sessions already open there stay until closed.`,
  );
  return 0;
}

async function leave(args: string[], io: CliIo, deps: CliDeps): Promise<number> {
  if (args.length > 0) return usageError(io, `Unexpected argument: ${args[0]}.`, "leave");
  const lines = await leaveComputer({
    configPath: computerConfigPath(io.env),
    settingsPath: claudeSettingsPath(io.env),
    codexHome: codexHome(io.env),
    fetch: deps.fetch,
    findClaude: deps.findClaude ?? (() => findOnPath("claude", io.env.PATH)),
    uninstall: deps.uninstall,
  });
  for (const line of lines) io.out(line);
  return 0;
}

function status(args: string[], io: CliIo): number {
  if (args.length > 0) return usageError(io, `Unexpected argument: ${args[0]}.`, "status");
  const path = computerConfigPath(io.env);
  const file = readComputerFile(path);
  if (!file) {
    io.err(notJoined(path));
    return 1;
  }
  io.out(`Computer "${file.computer}" on ${file.url}.`);
  io.out(`Computer file: ${path}`);
  if (file.off.length === 0) {
    io.out("Folders off Portico: none.");
  } else {
    io.out("Folders off Portico:");
    for (const folder of file.off) io.out(`  ${folder}`);
  }
  return 0;
}
