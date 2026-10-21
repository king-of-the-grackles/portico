// Runs before the plugin's dependencies are installed (the join command, and the hub's `bridge join`), so it imports
// only node:* and machine.ts.
import { hostname as systemHostname } from "node:os";
import { type MachineFile, MachineFileError, readMachineFile, writeMachineFile } from "./machine";

/** How long the hub gets to answer the join. */
const JOIN_TIMEOUT_MS = 15_000;
const JOIN_CODE = /^[A-Za-z0-9_-]{16,64}$/;

/** A join that can't go ahead. The message is for the person running it. */
export class JoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JoinError";
  }
}

export interface JoinTarget {
  /** The hub's base URL, without /join or a trailing slash. */
  hub: string;
  code: string;
}

/**
 * Finds the hub and the code in a join line (`Join my agent bridge: https://<hub>/join#<code>`), a bare link, or a hub
 * address with the code passed separately.
 */
export function parseJoinLine(line: string, code?: string): JoinTarget {
  const found = /https?:\/\/\S+/.exec(line.trim());
  if (!found) throw new JoinError("No hub address found. Pass the whole join line, which contains https://…/join#<code>.");
  let url: URL;
  try {
    url = new URL(found[0]);
  } catch {
    throw new JoinError("The hub address in the join line isn't a valid URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new JoinError("The hub address must start with https:// (http:// only for localhost and 127.0.0.1).");
  }
  if (url.username || url.password) throw new JoinError("The hub address must not contain a user name or password.");
  const finalCode = (code ?? url.hash.replace(/^#/, "")).trim();
  if (!JOIN_CODE.test(finalCode)) throw new JoinError("The join code is missing or malformed. Ask for a new join line.");
  const path = url.pathname.replace(/\/join\/?$/, "").replace(/\/+$/, "");
  return { hub: `${url.origin}${path}`, code: finalCode };
}

/** The hostname as a machine name, the way the hub slugs it: without `.local`, lowercase letters, digits and hyphens. */
export function defaultMachineName(hostname: string): string {
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
  return slug || "machine";
}

export interface JoinOptions {
  /** The join line, a bare link, or the hub address when `code` is given. */
  line: string;
  code?: string;
  /** The machine's proposed name. Defaults to the hostname. The hub slugs it and may add `-2`. */
  name?: string;
  /** Join again over an existing machine file, keeping its off list. */
  replace?: boolean;
}

export interface JoinDeps {
  configPath: string;
  fetch?: typeof fetch;
  hostname?: () => string;
}

/** Redeems the code on the hub and writes the machine file. Throws JoinError (or MachineFileError) when it can't. */
export async function joinMachine(opts: JoinOptions, deps: JoinDeps): Promise<{ hub: string; machine: string; path: string }> {
  const { hub, code } = parseJoinLine(opts.line, opts.code);
  const path = deps.configPath;
  const existing = readExisting(path, opts.replace === true);
  if (existing && !opts.replace) {
    throw new JoinError(
      `${path} already exists (machine "${existing.machine}" on ${existing.hub}). Nothing was written. Run again with --replace to join again.`,
    );
  }
  const name = opts.name ?? defaultMachineName((deps.hostname ?? systemHostname)());
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${hub}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, machine: name }),
      // A redirect is answered, not followed: the code goes only to the hub named in the line, and never over plain http.
      redirect: "manual",
      signal: AbortSignal.timeout(JOIN_TIMEOUT_MS),
    });
  } catch {
    throw new JoinError(`The hub at ${hub} could not be reached.`);
  }
  const body = (await res.json().catch(() => null)) as { message?: unknown; machine?: { name?: unknown }; token?: unknown } | null;
  if (!res.ok) {
    const message = typeof body?.message === "string" ? withoutControls(body.message).trim() : "";
    throw new JoinError(message || `The hub at ${hub} answered HTTP ${res.status}.`);
  }
  const answeredName = body?.machine?.name;
  const machine = typeof answeredName === "string" ? withoutControls(answeredName) : null;
  const token = body?.token;
  if (!machine || typeof token !== "string" || !token) {
    throw new JoinError(`The hub at ${hub} sent an answer that isn't a join result. Nothing was written.`);
  }
  try {
    writeMachineFile(path, { hub, machine, token, off: existing?.off ?? [] });
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? "error";
    throw new JoinError(`${path} could not be written (${reason}). The join code is used up: ask for a new join line, then join again.`);
  }
  return { hub, machine, path };
}

/** The hub's text without control characters (C0, DEL and C1, ESC included), so it can't drive the terminal. */
function withoutControls(text: string): string {
  return text.replace(/\p{Cc}/gu, "");
}

/** The current machine file, or null. With replace, a broken file counts as none, so joining again repairs the file. */
function readExisting(path: string, replace: boolean): MachineFile | null {
  try {
    return readMachineFile(path);
  } catch (err) {
    if (replace && err instanceof MachineFileError) return null;
    throw err;
  }
}
