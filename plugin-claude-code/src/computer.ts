// Runs before the plugin's dependencies are installed (the join, off, on and leave commands), so it imports only node:*.
import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** `~/.portico/computer.json`, written when this computer joins Portico. */
export interface ComputerFile {
  /** Portico's base URL. */
  url: string;
  /** This computer's name on Portico. */
  computer: string;
  /** The computer token. Anyone who can read this file can act as any session on this computer. */
  token: string;
  /**
   * The local copy of the folders whose "Join from the folder" switch is off, as absolute paths with symlinks
   * resolved. Portico holds the switch; this copy lets a session start quietly before Portico answers.
   */
  off: string[];
}

/** computer.json exists but can't be read or isn't valid. The message names the path, so it's for CLI output only. */
export class ComputerFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerFileError";
  }
}

type Env = Record<string, string | undefined>;

/** The folder computer.json lives in by default. */
const OWN_FOLDER = ".portico";

export function computerConfigPath(env: Env): string {
  return env.PORTICO_COMPUTER_CONFIG?.trim() || join(homedir(), OWN_FOLDER, "computer.json");
}

export function claudeHome(env: Env): string {
  return env.PORTICO_CLAUDE_HOME?.trim() || join(homedir(), ".claude");
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Null when the file is missing. Throws ComputerFileError when it can't be read or isn't a computer file. */
export function readComputerFile(path: string): ComputerFile | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ComputerFileError(`${path} could not be read (${(err as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ComputerFileError(`${path} is not valid JSON.`);
  }
  const record = (data ?? {}) as Record<string, unknown>;
  const off = record.off ?? [];
  if (
    typeof data !== "object" ||
    data === null ||
    !nonEmpty(record.url) ||
    !nonEmpty(record.computer) ||
    !nonEmpty(record.token) ||
    !Array.isArray(off) ||
    !off.every((folder) => typeof folder === "string")
  ) {
    throw new ComputerFileError(
      `${path} is not a computer file: "url", "computer" and "token" strings and an "off" list are required.`,
    );
  }
  return { url: record.url.trim(), computer: record.computer.trim(), token: record.token.trim(), off: off as string[] };
}

/** Writes the file with mode 600 through a temp file and a rename, creating its folder with mode 700. */
export function writeComputerFile(path: string, file: ComputerFile): void {
  const dir = dirname(path);
  // A folder made here, or the .portico folder itself, gets mode 700. Any other existing folder is left alone:
  // PORTICO_COMPUTER_CONFIG may point into a shared one.
  const made = mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined;
  if (made || basename(dir) === OWN_FOLDER) chmodSync(dir, 0o700);
  writeFileAtomically(path, `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

/**
 * Removes computer.json, and its folder too when that is the `.portico` folder and nothing else is left in it.
 * Returns false when there was no file.
 */
export function removeComputerFile(path: string): boolean {
  let removed = true;
  try {
    rmSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    removed = false;
  }
  const dir = dirname(path);
  if (basename(dir) === OWN_FOLDER) {
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // gone already, or not ours to clean up
    }
  }
  return removed;
}

/**
 * Writes the text through a temp file beside the path and a rename, so no reader ever sees half a file, and gives the
 * file exactly `mode`. The folder must exist. The temp file is removed when anything fails, and the error rethrown.
 */
export function writeFileAtomically(path: string, text: string, mode: number): void {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, text, { mode, flag: "wx" });
    chmodSync(temp, mode); // the mode above is reduced by the umask
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

/**
 * HMAC-SHA256 of the folder's real path, keyed with the computer token: Portico tells folders apart, and keeps each
 * folder's switch, without learning either.
 */
export function folderId(token: string, folder: string): string {
  return createHmac("sha256", token).update(realFolder(folder)).digest("hex");
}

/** Whether the local copy has the folder off. Exact folders only, as Portico keeps the switch per folder. */
export function isOff(file: Pick<ComputerFile, "off">, folder: string): boolean {
  const target = realFolder(folder);
  return file.off.some((entry) => realFolder(entry) === target);
}

/** Records the folder as off, or on, in the local copy. Throws ComputerFileError when there's no computer file. */
export function setFolderOff(path: string, folder: string, off: boolean): { changed: boolean; file: ComputerFile } {
  const current = readComputerFile(path);
  if (!current) throw new ComputerFileError(`No computer file at ${path}. Join Portico first.`);
  const target = realFolder(folder);
  const listed = current.off.some((entry) => realFolder(entry) === target);
  if (listed === off) return { changed: false, file: current };
  const file = {
    ...current,
    off: off ? [...current.off, target] : current.off.filter((entry) => realFolder(entry) !== target),
  };
  writeComputerFile(path, file);
  return { changed: true, file };
}
