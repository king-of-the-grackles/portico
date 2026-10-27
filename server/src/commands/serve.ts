import { ConfigError, loadConfig, platformUrl } from "../config";
import type { Core } from "../core/core";
import { isLocalUrl } from "../core/settings";
import type { PorticoConfig } from "../core/types";
import { SchemaMismatchError } from "../db";
import { startServer } from "../server";
import type { CliIo } from "./io";

export const SETUP_LINK_LINE = "Open this link in a browser to set up Portico. The link works once and expires in 1 hour.";

/**
 * Running locally (no cloud platform, and no public URL or a localhost one) before setup, each start makes a setup
 * link, so nobody has to run `portico setup` on their own computer. On a server, `portico setup` prints one instead, so
 * the link never lands in a platform's logs.
 */
export function localSetupLink(core: Pick<Core, "config" | "settings" | "accounts">, env: CliIo["env"]): string | null {
  if (core.settings.setupDone() || platformUrl(env)) return null;
  if (core.config.publicUrl && !isLocalUrl(core.config.publicUrl)) return null;
  const { token } = core.accounts.createSetupLink();
  return `${core.settings.publicUrl()}/setup#${token}`;
}

/** A plain explanation for startup failures that aren't bugs, or null for anything else. */
export function startupProblem(err: unknown, config: Pick<PorticoConfig, "port" | "dbPath">): string | null {
  if (err instanceof SchemaMismatchError) {
    return `The database at ${config.dbPath} was written by a different Portico version. Move it aside to start fresh, or run that version.`;
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return `Port ${config.port} is already in use. Stop the other process, or set PORT to a free port.`;
  if (code === "SQLITE_CANTOPEN") {
    return `The database at ${config.dbPath} can't be opened. Check that the folder exists and is writable, or set PORTICO_DB_PATH.`;
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
    const link = localSetupLink(running.portico, io.env);
    if (link) {
      // A plain line on the terminal, never a log line: the link is a secret.
      io.out(`Portico isn't set up yet. ${SETUP_LINK_LINE}`);
      io.out(`  ${link}`);
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
