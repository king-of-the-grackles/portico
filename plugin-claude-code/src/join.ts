// Runs before the plugin's dependencies are installed (the join command, and the server's `portico join`), so it imports
// only node:* and the files beside it.
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { hostname as systemHostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { type ComputerFile, ComputerFileError, readComputerFile, writeComputerFile, writeFileAtomically } from "./computer";
import { callPortico, CommandError, refusal, withoutControls } from "./computer-api";
import { switchFolder } from "./folders";

/**
 * A Portico server's address as a person or an agent gives it: `https://<host>`, with `/join` or a trailing slash
 * allowed, and the words "Join Portico at" in front. Returns the base URL. Plain http only for this computer itself.
 */
export function parseServerAddress(text: string): string {
  const found = /https?:\/\/\S+/.exec(text.trim());
  if (!found) throw new CommandError("No Portico address found. Pass the server's address, such as https://portico.example.com.");
  let url: URL;
  try {
    url = new URL(found[0].replace(/[.,;]+$/, ""));
  } catch {
    throw new CommandError("The address isn't a valid URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new CommandError("The address must start with https:// (http:// only for localhost and 127.0.0.1).");
  }
  if (url.username || url.password) throw new CommandError("The address must not contain a user name or password.");
  if (url.search || url.hash) throw new CommandError("The address is the server's own, with nothing after ? or #.");
  const path = url.pathname.replace(/\/join\/?$/, "").replace(/\/+$/, "");
  return `${url.origin}${path}`;
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
  /** The Portico server's address. */
  address: string;
  /** The computer's proposed name. Defaults to the hostname. Portico slugs it and may add `-2`. */
  name?: string;
  /** Join again over an existing computer file, keeping its folders that are off. */
  replace?: boolean;
  /** The coding agent joining, shown to the person on the page that allows the join. */
  client?: "claude-code" | "codex";
  /**
   * How long to wait for the person, in seconds. Default: until the code runs out. 0 only asks and prints the link and
   * code: running the command again keeps waiting on the same request.
   */
  waitSeconds?: number;
}

export interface JoinDeps {
  configPath: string;
  fetch?: typeof fetch;
  hostname?: () => string;
  /** Where the link and the code are printed, as soon as Portico answers. */
  out: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The gap between polls. */
  pollMs?: number;
}

export interface Joined {
  url: string;
  computer: string;
  path: string;
  /** With replace: folders kept off that Portico couldn't be told about. */
  unsynced: string[];
  /** The computer had joined this Portico already (say, Claude Code first, then Codex): nothing was asked or written. */
  already: boolean;
}

/** A join that was asked for and still waits for a person. Kept beside computer.json, mode 600, until it ends. */
interface PendingJoin {
  url: string;
  id: string;
  pollSecret: string;
  link: string;
  code: string;
  expiresAt: string;
}

/** Where a waiting join is kept: `join.json` beside computer.json. */
export function pendingJoinPath(configPath: string): string {
  return join(dirname(configPath), "join.json");
}

function readPending(path: string): PendingJoin | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<PendingJoin>;
    const ok = [data.url, data.id, data.pollSecret, data.link, data.code, data.expiresAt].every((value) => typeof value === "string" && value !== "");
    return ok ? (data as PendingJoin) : null;
  } catch {
    return null;
  }
}

/** The lines a person acts on: the page to open, the code to type there, and when the code runs out. */
export function joinInstructions(pending: Pick<PendingJoin, "link" | "code" | "expiresAt">): string[] {
  return [
    "A person allows this computer on one Portico page:",
    `  1. Open ${pending.link} in a browser and sign in.`,
    `  2. Type the code ${pending.code} there and press Allow.`,
    `The code runs out at ${pending.expiresAt}. Type the code only on that page.`,
  ];
}

/** Still waiting for the person when the wait ran out: nothing is wrong, and the same command keeps waiting. */
export class JoinWaiting extends Error {
  constructor(readonly expiresAt: string) {
    super("Still waiting for a person to allow the join.");
    this.name = "JoinWaiting";
  }
}

/**
 * Asks the Portico server to let this computer join, prints the link and the code a person allows the join with,
 * waits, and writes computer.json once the person has pressed Allow. No secret goes in: the computer belongs to
 * whoever signs in on that page and types the code. A request that still waits is picked up again by the next run;
 * one whose code ran out is replaced by a fresh one. A computer that joined the same server already needs nothing.
 * With replace, the folders that were off are switched off on Portico again, since the new computer starts with every
 * folder on. Throws CommandError (or ComputerFileError) when the join can't go ahead, JoinWaiting when the wait ran out.
 */
export async function joinComputer(opts: JoinOptions, deps: JoinDeps): Promise<Joined> {
  const url = parseServerAddress(opts.address);
  const path = deps.configPath;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const existing = readExisting(path, opts.replace === true);
  if (existing && !opts.replace && existing.url === url) {
    const answer = await callPortico(url, "GET", "/api/computer", { token: existing.token, fetch: deps.fetch });
    if (answer.status === 401) {
      throw new CommandError(
        "Portico no longer accepts this computer's token (the computer may have been removed in Settings). Run again with --replace to join as a new computer.",
      );
    }
    if (!answer.ok) throw new CommandError(refusal(url, answer));
    return { url, computer: existing.computer, path, unsynced: [], already: true };
  }
  if (existing && !opts.replace) {
    throw new CommandError(
      `${path} already exists (computer "${existing.computer}" on ${existing.url}). Nothing was written. Run again with --replace to join again.`,
    );
  }

  const pendingPath = pendingJoinPath(path);
  const earlier = readPending(pendingPath);
  let pending = earlier && earlier.url === url && Date.parse(earlier.expiresAt) > now() ? earlier : null;
  if (!pending) {
    const name = opts.name ?? defaultComputerName((deps.hostname ?? systemHostname)());
    const replaces = earlier && earlier.url === url ? { id: earlier.id, poll_secret: earlier.pollSecret } : undefined;
    const answer = await callPortico(url, "POST", "/api/join", { body: { kind: "computer", name, client: opts.client, replaces }, fetch: deps.fetch });
    if (!answer.ok) throw new CommandError(refusal(url, answer));
    const { id, link, code, poll_secret: pollSecret, expires_at: expiresAt } = answer.body ?? {};
    // The link is shown to a person, so it has to be a consent page for this request and nothing else: the server's
    // public address (which may differ from the one typed here, behind a proxy say), then /c/<id>.
    const page = typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? consentPage(link, id) : null;
    const fits =
      page !== null &&
      typeof code === "string" &&
      /^[0-9]{4}$/.test(code) &&
      typeof pollSecret === "string" &&
      pollSecret !== "" &&
      typeof expiresAt === "string" &&
      !Number.isNaN(Date.parse(expiresAt));
    if (!fits) throw new CommandError(`Portico at ${url} sent an answer that isn't a request to join. Nothing was written.`);
    pending = { url, id: id as string, pollSecret: pollSecret as string, link: page!, code: code as string, expiresAt: new Date(Date.parse(expiresAt as string)).toISOString() };
    try {
      // The same folder rules as computer.json: the poll secret is this computer's until the join ends.
      writeComputerFolder(path);
      writeFileAtomically(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 0o600);
    } catch (err) {
      const reason = (err as NodeJS.ErrnoException).code ?? "error";
      throw new CommandError(`${pendingPath} could not be written (${reason}), so the join can't be finished from here. Nothing changed on Portico.`);
    }
  }
  for (const line of joinInstructions(pending)) deps.out(line);

  const expires = Date.parse(pending.expiresAt);
  const until = opts.waitSeconds === undefined ? expires : Math.min(expires, now() + opts.waitSeconds * 1000);
  const forget = () => rmSync(pendingPath, { force: true });
  for (;;) {
    const answer = await callPortico(url, "GET", `/api/join/${pending.id}`, { token: pending.pollSecret, fetch: deps.fetch });
    const status = answer.ok ? answer.body?.status : null;
    if (status === "approved") {
      const answered = (answer.body?.computer as { name?: unknown } | undefined)?.name;
      const computer = typeof answered === "string" ? withoutControls(answered) : "";
      const token = answer.body?.token;
      forget();
      if (!computer || typeof token !== "string" || !token) {
        throw new CommandError(`Portico at ${url} allowed the join but sent no token (the token is handed over once). Run the command again to ask anew.`);
      }
      return finish(url, computer, token, existing, path, deps);
    }
    if (status === "denied") {
      forget();
      throw new CommandError("The join wasn't allowed on Portico. Nothing was written.");
    }
    if (status === "expired" || (!answer.ok && answer.status === 401)) {
      forget();
      throw new CommandError("The code ran out before anyone allowed the join. Run the command again for a fresh link and code.");
    }
    if (!answer.ok && answer.status !== 429 && answer.status < 500) throw new CommandError(refusal(url, answer));
    if (now() >= until) {
      if (now() >= expires) {
        forget();
        throw new CommandError("The code ran out before anyone allowed the join. Run the command again for a fresh link and code.");
      }
      throw new JoinWaiting(pending.expiresAt);
    }
    await sleep(Math.max(0, Math.min(deps.pollMs ?? 3000, until - now())));
  }
}

/** The link as a consent page's address, `<server>/c/<id>` with nothing else in it, or null. */
function consentPage(link: unknown, id: string): string | null {
  if (typeof link !== "string" || /[\s\p{Cc}]/u.test(link)) return null;
  let page: string;
  try {
    page = `${parseServerAddress(link.replace(/\/c\/[^/]+$/, ""))}/c/${id}`;
  } catch {
    return null;
  }
  return page === link ? page : null;
}

/** Makes computer.json's folder the way writeComputerFile does, before anything is kept there. */
function writeComputerFolder(path: string): void {
  const dir = dirname(path);
  const made = mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined;
  if (made || basename(dir) === ".portico") chmodSync(dir, 0o700);
}

async function finish(url: string, computer: string, token: string, existing: ComputerFile | null, path: string, deps: JoinDeps): Promise<Joined> {
  const off = existing?.off ?? [];
  try {
    writeComputerFile(path, { url, computer, token, off });
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? "error";
    throw new CommandError(`${path} could not be written (${reason}). The join was allowed but its token is lost: remove computer "${computer}" in Settings, then join again.`);
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
  return { url, computer, path, unsynced, already: false };
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
