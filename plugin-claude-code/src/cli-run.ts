// Runs before the plugin's dependencies are installed (the join, off, on and leave commands, and the server's
// `portico join` and `portico leave`), so it imports only node:* and the files beside it. No side effects: src/cli.ts
// is the entry that calls runCli.
import { resolve } from "node:path";
import { allowLine, allowPorticoTools, claudeSettingsPath } from "./claude-settings";
import { ComputerFileError, computerConfigPath, readComputerFile, realFolder } from "./computer";
import { CommandError } from "./computer-api";
import { notJoined, switchFolder } from "./folders";
import { joinComputer } from "./join";
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
}

const JOIN_USAGE = "join <line> [--name <computer>] [--replace] [--no-allow]";
const JOIN_OPTIONS = ["--name", "--replace", "--no-allow"];

const USAGE = `Usage: bun src/cli.ts <command>

Commands:
  ${JOIN_USAGE}
                  Join this computer to Portico with a join line, write the computer file, and allow the Portico tools in Claude Code.
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

/**
 * The words that aren't options are joined with spaces into the line: the slash command passes the line as one
 * quoted argument, while a shell user may pass several words.
 */
async function join(args: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const words: string[] = [];
  let name: string | undefined;
  let replace = false;
  let noAllow = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--replace") {
      replace = true;
    } else if (arg === "--no-allow") {
      noAllow = true;
    } else if (arg === "--name") {
      const value = args[++i];
      if (value === undefined || JOIN_OPTIONS.includes(value)) return usageError(io, `${arg} needs a value.`, JOIN_USAGE);
      name = value;
    } else if (arg.startsWith("--")) {
      return usageError(io, `Unknown option: ${arg}.`, JOIN_USAGE);
    } else {
      words.push(arg);
    }
  }
  const line = words.join(" ").trim();
  if (!line) return usageError(io, "A join line is required.", JOIN_USAGE);

  const joined = await joinComputer(
    { line, name, replace },
    { configPath: computerConfigPath(io.env), fetch: deps.fetch, hostname: deps.hostname },
  );
  io.out(`Joined Portico at ${joined.url} as computer "${joined.computer}".`);
  io.out(`Wrote ${joined.path} (mode 600).`);
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
