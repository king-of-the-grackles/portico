import { ConfigError, loadConfig } from "../config";
import type { PorticoConfig } from "../core/types";
import { SchemaMismatchError } from "../db";
import { startServer } from "../server";
import type { CliIo } from "./io";

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
