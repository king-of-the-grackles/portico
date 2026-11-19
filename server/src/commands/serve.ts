import { ConfigError, loadConfig, platformUrl } from "../config";
import type { Core } from "../core/core";
import { isLocalUrl } from "../core/settings";
import type { PorticoConfig } from "../core/types";
import { FRESH_FOLDER, SchemaMismatchError } from "../db";
import { startServer } from "../server";
import type { CliIo } from "./io";

export const SETUP_LINK_LINE = "Open this link in a browser to set up Portico. The link works once and expires in 1 hour.";

/** What a local start says instead of the link when its output isn't a terminal: the link is a secret, and output that is kept is a log. */
export const SETUP_LINK_HINT = "Portico isn't set up yet. Run portico setup for a one-time setup link.";

/** Whether this start is a local one before setup: no cloud platform, and no public URL or a localhost one. */
export function localBeforeSetup(core: Pick<Core, "config" | "settings">, env: CliIo["env"]): boolean {
  if (core.settings.setupDone() || platformUrl(env)) return false;
  return !core.config.publicUrl || isLocalUrl(core.config.publicUrl);
}

/**
 * Running locally before setup, in a terminal, each start makes a setup link, so nobody has to run `portico setup` on
 * their own computer. The links earlier starts made stop working, so only the one on screen opens setup. Anywhere the
 * output is kept instead of read (a container's log, a service manager's, a pipe), and on a server, `portico setup`
 * prints one instead, so the link never lands in a log.
 */
export function localSetupLink(core: Pick<Core, "config" | "settings" | "accounts">, env: CliIo["env"], tty: boolean): string | null {
  if (!tty || !localBeforeSetup(core, env)) return null;
  const { token } = core.accounts.createSetupLink({ reset: true });
  return `${core.settings.publicUrl()}/setup#${token}`;
}

/** A plain explanation for startup failures that aren't bugs, or null for anything else. */
export function startupProblem(err: unknown, config: Pick<PorticoConfig, "port" | "dbPath">): string | null {
  if (err instanceof SchemaMismatchError) {
    if (err.newer) {
      return (
        `The database at ${config.dbPath} was written by a newer Portico version. Run that version, or restore the copy ` +
        `saved beside the database before it was upgraded (delete the -wal and -shm files first). The copy brings back ` +
        `everything removed since the upgrade, such as people, computers, agents, tokens and old passwords, so remove ` +
        `those again, and rerun portico setup --reset if the owner password was reset.`
      );
    }
    if (err.reason === "wrong_kind") {
      return `The file at ${config.dbPath} is a Portico database of another kind, not the directory. Set PORTICO_DATA_DIR to the data folder itself.`;
    }
    return `${FRESH_FOLDER} The database found is ${config.dbPath}.`;
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return `Port ${config.port} is already in use. Stop the other process, or set PORT to a free port.`;
  if (code === "SQLITE_CANTOPEN") {
    return `The database at ${config.dbPath} can't be opened. Check that the data folder is writable, or set PORTICO_DATA_DIR to another folder.`;
  }
  return null;
}

export async function serveCommand(io: CliIo): Promise<number | "running"> {
  let config: PorticoConfig;
  try {
    config = loadConfig(io.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
  try {
    const running = startServer(config);
    const link = localSetupLink(running.portico, io.env, io.tty === true);
    if (link) {
      // A plain line on the terminal, never a log line: the link is a secret.
      io.out(`Portico isn't set up yet. ${SETUP_LINK_LINE}`);
      io.out(`  ${link}`);
    } else if (localBeforeSetup(running.portico, io.env)) {
      io.out(SETUP_LINK_HINT);
    }
    const shutdown = () => {
      running.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return "running";
  } catch (err) {
    const problem = startupProblem(err, config);
    if (problem) {
      io.err(problem);
      return 1;
    }
    throw err;
  }
}
