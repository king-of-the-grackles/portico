import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, hostUrl, parseEnv, platformUrl } from "../config";
import { Accounts } from "../core/accounts";
import { Changes } from "../core/changes";
import { People } from "../core/people";
import { Settings } from "../core/settings";
import type { PorticoConfig } from "../core/types";
import { openDb } from "../db";
import type { CliIo } from "./io";
import { SETUP_LINK_LINE, startupProblem } from "./serve";

const USAGE = "Usage: portico setup [--reset]";

const RESET_LINK_LINE =
  "Open this link in a browser to set a new owner password. Every browser signed in as the owner is signed out. The link works once and expires in 1 hour.";

/**
 * `portico setup [--reset]`, run on the host with the same settings as `portico serve`: prints a one-time link (1 h,
 * single use) that creates the owner account. Once setup is done, only `--reset` prints a link, and that link sets a
 * new owner password. `--reset` also stops every unused link. The link goes to the terminal only, never to the log.
 */
export async function setupCommand(args: string[], io: CliIo): Promise<number> {
  const unknown = args.find((arg) => arg !== "--reset");
  if (unknown !== undefined) {
    io.err(`Unknown option: ${unknown}. ${USAGE}`);
    return 1;
  }
  const reset = args.includes("--reset");
  let config: PorticoConfig;
  try {
    config = parseEnv(io.env, "");
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.err(err.message);
    return 1;
  }
  // A missing database means a different folder or PORTICO_DB_PATH than serve's: a link made here wouldn't work there.
  if (!existsSync(resolve(io.cwd, config.dbPath))) {
    io.err(
      `No Portico database at ${config.dbPath}. Start Portico with portico serve first, or set PORTICO_DB_PATH to the database Portico uses.`,
    );
    return 1;
  }
  let db: ReturnType<typeof openDb>;
  try {
    db = openDb(resolve(io.cwd, config.dbPath));
  } catch (err) {
    const problem = startupProblem(err, config);
    if (!problem) throw err;
    io.err(problem);
    return 1;
  }
  try {
    const settings = new Settings(db, config);
    const accounts = new Accounts({ db, people: new People({ db, changes: new Changes(), signingKey: config.signingKey }) });
    const done = settings.setupDone();
    if (done && !reset) {
      io.err("Portico is already set up. To set a new owner password, run portico setup --reset.");
      return 1;
    }
    const { token } = accounts.createSetupLink({ reset });
    const saved = settings.get("public_url");
    const base = hostUrl(config, io.env, saved);
    io.out(done ? RESET_LINK_LINE : SETUP_LINK_LINE);
    io.out(`  ${base}/setup#${token}`);
    if (!config.publicUrl && !saved && !platformUrl(io.env)) {
      io.out(`If a browser reaches Portico at another address, use that address in place of ${base}.`);
    }
    return 0;
  } finally {
    db.close();
  }
}
