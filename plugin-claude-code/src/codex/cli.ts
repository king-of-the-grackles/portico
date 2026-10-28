// The Codex bridge's commands: join, update, on, off, status and leave. Without a command, the bridge is the MCP server
// Codex starts for each conversation (see server.ts).
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { computerConfigPath, ComputerFileError, readComputerFile, realFolder, removeComputerFile, writeFileAtomically } from "../computer";
import { CommandError, withoutControls } from "../computer-api";
import { notJoined, switchFolder } from "../folders";
import { joinComputer } from "../join";
import { findOnPath, removeFromCodex, tellPortico } from "../leave";
import { codexHome, type Outcome, setServer, setStopHook } from "../codex-config";

/** Where the bridge is served on every Portico. */
export const BRIDGE_PATH = "/codex/portico-codex.js";

export interface CodexCliIo {
  env: Record<string, string | undefined>;
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CodexCliDeps {
  /** This bridge's own file, which Codex's config runs. Default: the running script. */
  bridgePath?: string;
  fetch?: typeof fetch;
  hostname?: () => string;
  /** Bun's path for Codex's config. Default: bun on the PATH, else the Bun running this. */
  findBun?: () => string;
}

const JOIN_USAGE = "join <line> [--name <computer>] [--replace] [--no-allow]";

const USAGE = `Usage: bun portico-codex.js <command>

Without a command, this file is the MCP server Codex starts for each conversation.

Commands:
  ${JOIN_USAGE}
                  Join this computer to Portico with a Codex join line (or use the line on a computer that already
                  joined), then add Portico to Codex: an MCP server in config.toml and a Stop hook in hooks.json.
  update          Download this file again from Portico.
  off [folder]    Keep new sessions in a folder (default: the current folder) off Portico.
  on [folder]     Let new sessions in a folder join Portico again.
  status          Show the computer, the Portico address and the folders that are off.
  leave           Take this computer off Portico (Claude Code sessions here too), and Portico out of Codex's config.
  help            Show this message.`;

/** Runs one command and returns the exit code. CommandError and ComputerFileError messages go to `err`. */
export async function runCodexCli(argv: string[], io: CodexCliIo, deps: CodexCliDeps = {}): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "join":
        return await join(args, io, deps);
      case "update":
        return await update(args, io, deps);
      case "off":
      case "on":
        return await folderSwitch(args, io, deps, command === "on");
      case "status":
        return status(args, io);
      case "leave":
        return await leave(args, io, deps);
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

function usageError(io: CodexCliIo, problem: string, usage: string): number {
  io.err(`${problem} Usage: ${usage}`);
  return 1;
}

function bridgeFile(deps: CodexCliDeps): string {
  const path = deps.bridgePath ?? Bun.main;
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The line for a changed Codex file: what was written, or what to do by hand. */
function outcomeLine(outcome: Outcome, what: string, manual: string): string | null {
  switch (outcome.kind) {
    case "written":
      return `${what} in ${outcome.path}${outcome.backup ? ` (the original is kept as ${outcome.backup})` : ""}.`;
    case "unchanged":
      return null;
    case "manual":
      return `${outcome.path} was left unchanged (${outcome.why}). ${manual}`;
  }
}

async function join(args: string[], io: CodexCliIo, deps: CodexCliDeps): Promise<number> {
  const words: string[] = [];
  let name: string | undefined;
  let replace = false;
  let allow = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--replace") replace = true;
    else if (arg === "--no-allow") allow = false;
    else if (arg === "--name") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) return usageError(io, `${arg} needs a value.`, JOIN_USAGE);
      name = value;
    } else if (arg.startsWith("--")) return usageError(io, `Unknown option: ${arg}.`, JOIN_USAGE);
    else words.push(arg);
  }
  const line = words.join(" ").trim();
  if (!line) return usageError(io, "A join line is required.", JOIN_USAGE);

  const configPath = computerConfigPath(io.env);
  const joined = await joinComputer({ line, name, replace }, { configPath, fetch: deps.fetch, hostname: deps.hostname });
  if (joined.attached) {
    io.out(`This computer is already on Portico at ${joined.url} as computer "${withoutControls(joined.computer)}". Used the line here.`);
  } else {
    io.out(`Joined Portico at ${joined.url} as computer "${joined.computer}".`);
    io.out(`Wrote ${joined.path} (mode 600).`);
  }
  for (const folder of joined.unsynced) {
    io.out(`${folder} was off before, but Portico couldn't be told to keep the folder off. Run off there again.`);
  }

  const home = codexHome(io.env);
  const bridge = bridgeFile(deps);
  // The settings the join ran with that the bridge reads, since Codex passes the bridge only a few variables.
  const env: Record<string, string> = {};
  for (const key of ["PORTICO_COMPUTER_CONFIG", "PORTICO_POPUP"]) {
    const value = io.env[key]?.trim();
    if (value) env[key] = key === "PORTICO_COMPUTER_CONFIG" ? resolve(io.cwd, value) : value;
  }
  const bun = (deps.findBun ?? (() => findOnPath("bun", io.env.PATH) ?? process.execPath))();
  const server = outcomeLine(
    setServer(home, bridge, { allow, bun, env }),
    `Added Portico as an MCP server (${bun} ${bridge})${allow ? ", with the Portico tools allowed without asking" : ""}`,
    `Add an [mcp_servers.portico] table that runs: bun ${bridge}`,
  );
  if (server) io.out(server);
  const hook = outcomeLine(
    setStopHook(home, true),
    "Added a Stop hook that hands Codex new Portico messages at the end of each turn",
    "Without the Stop hook, Codex sees messages only through check_inbox.",
  );
  if (hook) io.out(hook);
  io.out("Next: in Codex, open /hooks and approve the Portico Stop hook. Codex skips a new hook until a person approves the hook.");
  io.out(
    "Then start a new Codex conversation (or restart Codex). Each conversation joins Portico as <repo>-codex@<computer>; " +
      "conversations already open don't.",
  );
  return 0;
}

async function update(args: string[], io: CodexCliIo, deps: CodexCliDeps): Promise<number> {
  if (args.length > 0) return usageError(io, `Unexpected argument: ${args[0]}.`, "update");
  const configPath = computerConfigPath(io.env);
  const file = readComputerFile(configPath);
  if (!file) throw new CommandError(notJoined(configPath));
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${file.url}${BRIDGE_PATH}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new CommandError(`Portico at ${file.url} could not be reached. Nothing changed.`);
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("javascript")) {
    throw new CommandError(`Portico at ${file.url} didn't send the bridge (HTTP ${res.status}). Nothing changed.`);
  }
  const bridge = bridgeFile(deps);
  writeFileAtomically(bridge, await res.text(), 0o644);
  io.out(`Updated ${bridge} from ${file.url}. New Codex conversations use the new copy.`);
  return 0;
}

async function folderSwitch(args: string[], io: CodexCliIo, deps: CodexCliDeps, joins: boolean): Promise<number> {
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
      ? `${folder} is on Portico again: new conversations there join.`
      : `${folder} is off Portico now: new conversations there stay off, and ones already open stay until closed.`,
  );
  return 0;
}

function status(args: string[], io: CodexCliIo): number {
  if (args.length > 0) return usageError(io, `Unexpected argument: ${args[0]}.`, "status");
  const path = computerConfigPath(io.env);
  const file = readComputerFile(path);
  if (!file) {
    io.err(notJoined(path));
    return 1;
  }
  io.out(`Computer "${file.computer}" on ${file.url}.`);
  io.out(`Computer file: ${path}`);
  io.out(file.off.length === 0 ? "Folders off Portico: none." : ["Folders off Portico:", ...file.off.map((f) => `  ${f}`)].join("\n"));
  return 0;
}

async function leave(args: string[], io: CodexCliIo, deps: CodexCliDeps): Promise<number> {
  if (args.length > 0) return usageError(io, `Unexpected argument: ${args[0]}.`, "leave");
  const configPath = computerConfigPath(io.env);
  let file = null;
  try {
    file = readComputerFile(configPath);
  } catch (err) {
    if (!(err instanceof ComputerFileError)) throw err;
    io.out(`${err.message} Portico wasn't told; remove the computer in Settings › Computers.`);
  }
  if (file) io.out(await tellPortico(file, deps.fetch));
  if (removeComputerFile(configPath)) io.out(`Removed ${configPath}.`);
  for (const line of removeFromCodex(codexHome(io.env))) io.out(line);
  io.out(`This computer has left Portico. To remove the bridge too, delete ${bridgeFile(deps)} (in ${dirname(bridgeFile(deps))}).`);
  return 0;
}
