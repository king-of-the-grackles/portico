// Runs before the plugin's dependencies are installed (the off, on and join commands), so it imports only node:* and
// the files beside it.
import { basename } from "node:path";
import { type ComputerFile, folderId, readComputerFile, realFolder, setFolderOff } from "./computer";
import { callPortico, CommandError, type PorticoAnswer, refusal } from "./computer-api";

/** Portico answered 401 to the computer token: the computer is gone there. */
export const TOKEN_GONE =
  "Portico no longer accepts this computer's token (the computer may have been removed in Settings). Join again with a new join line.";

export function notJoined(path: string): string {
  return `This computer hasn't joined Portico: ${path} doesn't exist. Run join with a join line first.`;
}

export interface FolderSwitch {
  configPath: string;
  folder: string;
  /** The "Join from the folder" switch: true lets new sessions there join, false keeps them off. */
  joins: boolean;
  fetch?: typeof fetch;
}

/**
 * Sets the folder's switch on Portico, by folder ID, then keeps the local copy in computer.json in step. Portico must
 * answer: when it can't be reached or refuses, nothing changes on either side and CommandError says why.
 */
export async function switchFolder(opts: FolderSwitch): Promise<{ folder: string; file: ComputerFile }> {
  const current = readComputerFile(opts.configPath);
  if (!current) throw new CommandError(notJoined(opts.configPath));
  const folder = realFolder(opts.folder);
  let answer: PorticoAnswer;
  try {
    answer = await callPortico(current.url, "PUT", `/api/computer/folders/${folderId(current.token, folder)}`, {
      token: current.token,
      body: { joins: opts.joins, name: basename(folder) || folder },
      fetch: opts.fetch,
    });
  } catch (err) {
    if (err instanceof CommandError) throw new CommandError(`${err.message} Nothing changed.`);
    throw err;
  }
  if (answer.status === 401) throw new CommandError(TOKEN_GONE);
  if (!answer.ok) throw new CommandError(`${refusal(current.url, answer)} Nothing changed.`);
  const { file } = setFolderOff(opts.configPath, folder, !opts.joins);
  return { folder, file };
}
