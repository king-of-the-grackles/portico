// Runs before the plugin's dependencies are installed (the join, off and on commands, and the hub's `portico join`), so
// it imports only node:* and the files beside it. No side effects: src/cli.ts is the entry that calls runCli.
import { resolve } from "node:path";
import { allowLine, allowPorticoTools, claudeSettingsPath } from "./claude-settings";
import { JoinError, joinMachine } from "./join";
import { isOff, MachineFileError, machineConfigPath, readMachineFile, realFolder, setFolderOff } from "./machine";

/** What a command needs from the outside world, so tests can run commands without a real process. */
export interface CliIo {
  env: Record<string, string | undefined>;
  /** The folder that relative paths resolve against, and the default folder for off and on. */
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliDeps {
  fetch?: typeof fetch;
  hostname?: () => string;
}

const JOIN_USAGE = "join <line> [--code <code>] [--name <machine>] [--replace] [--no-allow]";
const JOIN_OPTIONS = ["--code", "--name", "--replace", "--no-allow"];

const USAGE = `Usage: bun src/cli.ts <command>

Commands:
  ${JOIN_USAGE}
                  Join this machine to a hub with a join line, write the machine file, and allow the network tools in Claude Code.
  off [folder]    Keep new sessions in a folder (default: the current folder) off the network.
  on [folder]     Put a folder back on the network for new sessions.
  status          Show the machine, the hub and the folders off the network.
  help            Show this message.`;

/** Runs one command and returns the exit code. MachineFileError and JoinError messages go to `err`. */
export async function runCli(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "join":
        return await join(args, io, deps);
      case "off":
        return folderSwitch(args, io, true);
      case "on":
        return folderSwitch(args, io, false);
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
    if (err instanceof JoinError || err instanceof MachineFileError) {
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

function notJoined(io: CliIo, path: string): number {
  io.err(`This machine hasn't joined a hub: ${path} doesn't exist. Run join with a join line first.`);
  return 1;
}

/**
 * The words that aren't options are joined with spaces into the line: the slash command passes the line as one
 * quoted argument, while a shell user may pass several words.
 */
async function join(args: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const words: string[] = [];
  let code: string | undefined;
  let name: string | undefined;
  let replace = false;
  let noAllow = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--replace") {
      replace = true;
    } else if (arg === "--no-allow") {
      noAllow = true;
    } else if (arg === "--code" || arg === "--name") {
      // Only another option counts as a missing value: a join code may itself start with "-".
      const value = args[++i];
      if (value === undefined || JOIN_OPTIONS.includes(value)) return usageError(io, `${arg} needs a value.`, JOIN_USAGE);
      if (arg === "--code") code = value;
      else name = value;
    } else if (arg.startsWith("--")) {
      return usageError(io, `Unknown option: ${arg}.`, JOIN_USAGE);
    } else {
      words.push(arg);
    }
  }
  const line = words.join(" ").trim();
  if (!line) return usageError(io, "A join line is required.", JOIN_USAGE);

  const joined = await joinMachine(
    { line, code, name, replace },
    { configPath: machineConfigPath(io.env), fetch: deps.fetch, hostname: deps.hostname },
  );
  io.out(`Joined ${joined.hub} as machine "${joined.machine}".`);
  io.out(`Wrote ${joined.path} (mode 600).`);
  io.out("New Claude Code sessions on this machine now appear on the network. Sessions already open join after a restart.");
  io.out("To keep a folder off the network, run /portico:off in a Claude Code session in that folder.");
  if (!noAllow) {
    const line = allowLine(allowPorticoTools(claudeSettingsPath(io.env)));
    if (line) io.out(line);
  }
  return 0;
}

function folderSwitch(args: string[], io: CliIo, off: boolean): number {
  const usage = off ? "off [folder]" : "on [folder]";
  const option = args.find((arg) => arg.startsWith("--"));
  if (option !== undefined) return usageError(io, `Unknown option: ${option}.`, usage);
  if (args.length > 1) return usageError(io, "Only one folder at a time.", usage);
  const path = machineConfigPath(io.env);
  const current = readMachineFile(path);
  if (!current) return notJoined(io, path);

  const folder = realFolder(resolve(io.cwd, args[0] ?? "."));
  const { changed } = setFolderOff(path, folder, off);
  if (off) {
    io.out(
      changed
        ? `${folder} is now off the network. New sessions there don't register; open sessions there leave after a restart.`
        : `${folder} was already off the network.`,
    );
    return 0;
  }
  // The folder may still be off because a folder above it is on the list.
  const parent = current.off.find((entry) => isOff({ off: [entry] }, folder) && realFolder(entry) !== folder);
  if (parent !== undefined) {
    io.out(`${folder} is inside ${parent}, which is off the network. Run on in ${parent} instead.`);
  } else {
    io.out(changed ? `${folder} is back on the network for new sessions.` : `${folder} wasn't off the network.`);
  }
  return 0;
}

function status(args: string[], io: CliIo): number {
  if (args.length > 0) return usageError(io, `Unexpected argument: ${args[0]}.`, "status");
  const path = machineConfigPath(io.env);
  const file = readMachineFile(path);
  if (!file) return notJoined(io, path);
  io.out(`Machine "${file.machine}" on ${file.hub}.`);
  io.out(`Machine file: ${path}`);
  if (file.off.length === 0) {
    io.out("Folders off the network: none.");
  } else {
    io.out("Folders off the network:");
    for (const folder of file.off) io.out(`  ${folder}`);
  }
  return 0;
}
