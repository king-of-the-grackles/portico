// Runs before the plugin's dependencies are installed (the join command, and the server's `portico join`), so it imports
// only node:* and the files beside it.
import { hostname as systemHostname } from "node:os";
import { type ComputerFile, ComputerFileError, readComputerFile, writeComputerFile } from "./computer";
import { callPortico, CommandError, refusal, withoutControls } from "./computer-api";
import { switchFolder } from "./folders";

/** What a join line's token looks like: what Portico makes, with room for longer ones. */
const JOIN_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/** The words before the address in a join line. */
export const JOIN_PREFIX = "Join Portico: ";

export interface JoinTarget {
  /** Portico's base URL, without /join or a trailing slash. */
  url: string;
  /** The join line's one-time token. */
  token: string;
}

/** Finds Portico's address and the token in a join line (`Join Portico: https://<host>/join#<token>`) or a bare link. */
export function parseJoinLine(line: string): JoinTarget {
  const found = /https?:\/\/\S+/.exec(line.trim());
  if (!found) throw new CommandError("No Portico address found. Pass the whole join line, which contains https://…/join#<token>.");
  let url: URL;
  try {
    url = new URL(found[0]);
  } catch {
    throw new CommandError("The address in the join line isn't a valid URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new CommandError("The address must start with https:// (http:// only for localhost and 127.0.0.1).");
  }
  if (url.username || url.password) throw new CommandError("The address must not contain a user name or password.");
  const token = url.hash.replace(/^#/, "").trim();
  if (!JOIN_TOKEN.test(token)) throw new CommandError("The join token is missing or malformed. Ask for a new join line.");
  const path = url.pathname.replace(/\/join\/?$/, "").replace(/\/+$/, "");
  return { url: `${url.origin}${path}`, token };
}

/** The hostname as a computer name, the way Portico slugs it: without `.local`, lowercase letters, digits and hyphens. */
export function defaultComputerName(hostname: string): string {
  const slug = hostname
    .trim()
    .replace(/\.local$/i, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "computer";
}

export interface JoinOptions {
  /** The join line, or the bare link. */
  line: string;
  /** The computer's proposed name. Defaults to the hostname. Portico slugs it and may add `-2`. */
  name?: string;
  /** Join again over an existing computer file, keeping its folders that are off. */
  replace?: boolean;
}

export interface JoinDeps {
  configPath: string;
  fetch?: typeof fetch;
  hostname?: () => string;
}

export interface Joined {
  url: string;
  computer: string;
  path: string;
  /** With replace: folders kept off that Portico couldn't be told about. */
  unsynced: string[];
}

/**
 * Redeems the join line's token on Portico and writes computer.json. With replace, the folders that were off are
 * switched off on Portico again, since the new computer starts with every folder on. Throws CommandError (or
 * ComputerFileError) when the join can't go ahead.
 */
export async function joinComputer(opts: JoinOptions, deps: JoinDeps): Promise<Joined> {
  const { url, token: joinToken } = parseJoinLine(opts.line);
  const path = deps.configPath;
  const existing = readExisting(path, opts.replace === true);
  if (existing && !opts.replace) {
    throw new CommandError(
      `${path} already exists (computer "${existing.computer}" on ${existing.url}). Nothing was written. Run again with --replace to join again.`,
    );
  }
  const name = opts.name ?? defaultComputerName((deps.hostname ?? systemHostname)());
  const answer = await callPortico(url, "POST", "/api/computer/join", {
    body: { token: joinToken, computer: name },
    fetch: deps.fetch,
  });
  if (!answer.ok) throw new CommandError(refusal(url, answer));
  const answered = (answer.body?.computer as { name?: unknown } | undefined)?.name;
  const computer = typeof answered === "string" ? withoutControls(answered) : "";
  const token = answer.body?.token;
  if (!computer || typeof token !== "string" || !token) {
    throw new CommandError(`Portico at ${url} sent an answer that isn't a join result. Nothing was written.`);
  }
  const off = existing?.off ?? [];
  try {
    writeComputerFile(path, { url, computer, token, off });
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? "error";
    throw new CommandError(`${path} could not be written (${reason}). The join line is used up: ask for a new one, then join again.`);
  }
  const unsynced: string[] = [];
  for (const folder of off) {
    try {
      await switchFolder({ configPath: path, folder, joins: false, fetch: deps.fetch });
    } catch (err) {
      if (!(err instanceof CommandError)) throw err;
      unsynced.push(folder);
    }
  }
  return { url, computer, path, unsynced };
}

/** The current computer file, or null. With replace, a broken file counts as none, so joining again repairs it. */
function readExisting(path: string, replace: boolean): ComputerFile | null {
  try {
    return readComputerFile(path);
  } catch (err) {
    if (replace && err instanceof ComputerFileError) return null;
    throw err;
  }
}
