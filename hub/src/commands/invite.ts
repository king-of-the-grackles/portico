import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { ConfigError, loadConfig } from "../config";
import { joinLine, NetworkService } from "../core/network";
import type { BridgeConfig } from "../core/types";
import { openDb } from "../db";
import { NetworkStore } from "../network-store";
import type { CliIo } from "./io";
import { startupProblem } from "./serve";

/**
 * Prints a one-time join line for a new machine. It writes the code to the hub's database, so it runs where the hub's
 * config and database are.
 */
export async function inviteCommand(args: string[], io: CliIo, deps: { now?: () => Date } = {}): Promise<number> {
  if (args.length > 0) {
    io.err(`Unknown option: ${args[0]}. Usage: bridge invite`);
    return 1;
  }
  let config: BridgeConfig;
  try {
    config = await loadConfig({ ...io.env, BRIDGE_CONFIG: resolve(io.cwd, io.env.BRIDGE_CONFIG?.trim() || "bridge.yaml") });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    for (const problem of err.problems) io.err(problem);
    return 1;
  }

  let db: Database;
  try {
    db = openDb(resolve(io.cwd, config.dbPath));
  } catch (err) {
    const problem = startupProblem(err, config);
    if (!problem) throw err;
    io.err(problem);
    return 1;
  }
  try {
    const network = new NetworkService({ store: new NetworkStore(db), config, now: deps.now });
    const { code, expiresAt } = network.createJoinCode();
    io.out(`Join line for a new machine (one use, expires ${expiresAt.slice(0, 16).replace("T", " ")} UTC):`);
    io.out(joinLine(config.publicUrl, code));
    io.out("Paste the line into Claude Code on the new machine, or open the link there for the steps.");
    return 0;
  } finally {
    db.close();
  }
}
