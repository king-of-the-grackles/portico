// Runs before the plugin's dependencies are installed (the join and off/on commands), so it imports only node:*.
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** `~/.agent-bridge/machine.json`, written when this machine joins a hub. */
export interface MachineFile {
  /** The hub's base URL. */
  hub: string;
  /** This machine's name on the hub. */
  machine: string;
  /** The machine token. Anyone who can read this file can act as any session on this machine. */
  token: string;
  /** Absolute folders whose sessions stay off the network, symlinks resolved. */
  off: string[];
}

/** machine.json exists but can't be read or isn't valid. The message names the path, so it's for CLI output only. */
export class MachineFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineFileError";
  }
}

type Env = Record<string, string | undefined>;

export function machineConfigPath(env: Env): string {
  return env.BRIDGE_MACHINE_CONFIG?.trim() || join(homedir(), ".agent-bridge", "machine.json");
}

export function claudeHome(env: Env): string {
  return env.BRIDGE_CLAUDE_HOME?.trim() || join(homedir(), ".claude");
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Null when the file is missing. Throws MachineFileError when it can't be read or isn't a machine file. */
export function readMachineFile(path: string): MachineFile | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new MachineFileError(`${path} could not be read (${(err as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MachineFileError(`${path} is not valid JSON.`);
  }
  const record = (data ?? {}) as Record<string, unknown>;
  const off = record.off ?? [];
  if (
    typeof data !== "object" ||
    data === null ||
    !nonEmpty(record.hub) ||
    !nonEmpty(record.machine) ||
    !nonEmpty(record.token) ||
    !Array.isArray(off) ||
    !off.every((folder) => typeof folder === "string")
  ) {
    throw new MachineFileError(`${path} is not a machine file: it needs "hub", "machine" and "token" strings and an "off" list.`);
  }
  return { hub: record.hub.trim(), machine: record.machine.trim(), token: record.token.trim(), off: off as string[] };
}

/** Writes the file with mode 600 through a temp file and a rename, creating its folder with mode 700. */
export function writeMachineFile(path: string, file: MachineFile): void {
  const dir = dirname(path);
  // Only a folder made here gets its mode set: BRIDGE_MACHINE_CONFIG may point into a shared folder.
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) chmodSync(dir, 0o700);
  const temp = join(dir, `.machine.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600); // the mode above is reduced by the umask
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** The absolute path with symlinks resolved; just absolute when it doesn't exist (any more). */
export function realFolder(folder: string): string {
  const absolute = resolve(folder);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/** Whether the folder is on the off list, or inside a folder that is. Both sides are compared with symlinks resolved. */
export function isOff(file: Pick<MachineFile, "off">, folder: string): boolean {
  const target = realFolder(folder);
  return file.off.some((entry) => {
    const off = realFolder(entry);
    return target === off || target.startsWith(off.endsWith(sep) ? off : off + sep);
  });
}

/** Adds the folder to the off list, or removes it. Throws MachineFileError when there's no machine file. */
export function setFolderOff(path: string, folder: string, off: boolean): { changed: boolean; file: MachineFile } {
  const current = readMachineFile(path);
  if (!current) throw new MachineFileError(`No machine file at ${path}. Join a hub first.`);
  const target = realFolder(folder);
  const listed = current.off.some((entry) => realFolder(entry) === target);
  if (listed === off) return { changed: false, file: current };
  const file = {
    ...current,
    off: off ? [...current.off, target] : current.off.filter((entry) => realFolder(entry) !== target),
  };
  writeMachineFile(path, file);
  return { changed: true, file };
}
