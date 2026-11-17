import { resolve } from "node:path";
import { ConfigError, type HostedConfig, hostedEnv } from "../config";
import { PorticoError } from "../core/errors";
import { Hosted } from "../hosted/router";
import type { CliIo } from "./io";
import { SETUP_LINK_LINE } from "./serve";

const USAGE = "Usage: portico workspace create <name> | portico workspace import <name> <folder> | portico workspace list";

/**
 * `portico workspace`, on a hosted Portico's host with the same settings as `portico serve`. `create` makes a
 * workspace and prints the one-time link that creates its owner, as `portico setup` does for a single Portico.
 * `import` makes a workspace from a single Portico's data folder (its portico.db and signing.key).
 */
export async function workspaceCommand(args: string[], io: CliIo): Promise<number> {
  let config: HostedConfig | null;
  try {
    config = hostedEnv(io.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.err(err.message);
    return 1;
  }
  if (!config) {
    io.err("Workspaces belong to hosted Portico. Set PORTICO_HOSTED_DOMAIN, as portico serve has it.");
    return 1;
  }
  const [action, name, ...rest] = args;
  const wanted = action === "create" ? 1 : action === "import" ? 2 : action === "list" ? 0 : -1;
  if (args.length - 1 !== wanted) {
    io.err(USAGE);
    return 1;
  }
  const hosted = new Hosted(config);
  try {
    if (action === "list") {
      const all = hosted.control.all();
      if (all.length === 0) io.out("No workspaces yet.");
      for (const workspace of all) io.out(`${hosted.url(workspace)}  (made ${workspace.createdAt.slice(0, 10)})`);
      return 0;
    }
    if (action === "import") {
      const { workspace, people, agents } = hosted.importFrom(name, resolve(io.cwd, rest[0]!));
      const url = hosted.url(workspace);
      io.out(`Made ${url} with ${people} ${people === 1 ? "person" : "people"} and ${agents} ${agents === 1 ? "agent" : "agents"}.`);
      io.out("  Passwords work as before. Passkeys belong to the old address, so each person adds new ones in Settings.");
      io.out(`  Agents keep their tokens. Point each computer and app at ${url} in place of the old address.`);
      return 0;
    }
    const workspace = hosted.create(name);
    const { token } = hosted.portico(workspace).accounts.createSetupLink();
    io.out(`Made ${hosted.url(workspace)}. ${SETUP_LINK_LINE}`);
    io.out(`  ${hosted.url(workspace)}/setup#${token}`);
    return 0;
  } catch (err) {
    if (!(err instanceof PorticoError)) throw err;
    io.err(err.message);
    return 1;
  } finally {
    hosted.stop();
  }
}
