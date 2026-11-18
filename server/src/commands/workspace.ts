import { resolve } from "node:path";
import { ConfigError, type HostedConfig, hostedEnv } from "../config";
import { PorticoError } from "../core/errors";
import { createMain, migrateToMain, previewMigration, readMain } from "../hosted/main";
import { Hosted } from "../hosted/router";
import type { CliIo } from "./io";
import { SETUP_LINK_LINE } from "./serve";

const UNITE_USAGE = "Usage: portico workspace unite <name> [--remove <person>]... [--confirm <name>] | portico workspace unite --empty";

/**
 * `portico workspace unite`: moves hosted Portico from a database per workspace to one database. With a workspace's
 * name, says what the move would do; with --confirm repeating the name, makes the one database as a copy of that
 * workspace's, which stays untouched. `--remove` names a person to leave out, with their agents and conversations.
 * `--empty` starts the one database with nothing in it. The server takes the one database up at its next start.
 */
function uniteCommand(config: HostedConfig, args: string[], io: CliIo): number {
  if (args.length === 1 && args[0] === "--empty") {
    createMain(config);
    io.out("Made an empty database for every account. Restart portico serve to use it.");
    return 0;
  }
  const [name, ...rest] = args;
  const remove: string[] = [];
  let confirm: string | null = null;
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (value === undefined || (rest[i] !== "--remove" && rest[i] !== "--confirm")) {
      io.err(UNITE_USAGE);
      return 1;
    }
    if (rest[i] === "--remove") remove.push(value);
    else confirm = value;
  }
  if (name === undefined || name.startsWith("--")) {
    io.err(UNITE_USAGE);
    return 1;
  }
  if (readMain(config)) {
    io.err("This Portico already keeps one database. Nothing is changed.");
    return 1;
  }
  const slug = name.trim().toLowerCase();
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const holds = (r: { people: number; agents: number; threads: number; messages: number }) =>
    `${plural(r.people, "person", "people")}, ${plural(r.agents, "agent")}, ${plural(r.threads, "conversation")} and ${plural(r.messages, "message")}`;
  if (confirm === null) {
    const preview = previewMigration(config, slug, remove);
    io.out(`${slug} holds ${holds(preview)}. Nothing is changed yet.`);
    for (const gone of preview.removed) {
      io.out(`  Removing ${gone.person} also removes ${plural(gone.agents, "agent")}, ${plural(gone.threads, "conversation")} and ${plural(gone.messages, "message")}.`);
    }
    io.out("  The one database is made as a copy. The workspace's own files stay as they are, for going back.");
    io.out("  Stop or pause portico serve first: what arrives after the copy is not in the copy.");
    io.out(`  portico workspace unite ${slug}${remove.map((person) => ` --remove "${person}"`).join("")} --confirm ${slug}`);
    return 0;
  }
  if (confirm.trim().toLowerCase() !== slug) {
    io.err(`--confirm must repeat the workspace's name, ${slug}. Nothing is changed.`);
    return 1;
  }
  const result = migrateToMain(config, slug, remove);
  io.out(`Made the one database from ${slug}: ${holds(result)}.`);
  for (const gone of result.removed) io.out(`  Removed ${gone.person} with ${plural(gone.agents, "agent")} and ${plural(gone.threads, "conversation")}.`);
  io.out(`  Agents keep their tokens and the address ${config.baseUrl.replace("://", `://${slug}.`)}. Everyone signs in again at ${config.baseUrl}.`);
  io.out("  Restart portico serve to use the one database. To go back, move the data folder's main folder aside and restart.");
  return 0;
}

const USAGE = "Usage: portico workspace create <name> | portico workspace import <name> <folder> | portico workspace link <name> <person> | portico workspace remove <name> [--confirm <name>] | portico workspace list";

/**
 * `portico workspace`, on a hosted Portico's host with the same settings as `portico serve`. `create` makes a
 * workspace and prints the one-time link that creates its owner, as `portico setup` does for a single Portico.
 * `import` makes a workspace from a single Portico's data folder (its portico.db and signing.key). `remove` says what
 * a workspace holds, and removes the workspace for good only when --confirm repeats the name. `link` prints a one-use
 * link that moves a person from a password to the base domain's sign-in.
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
  if (action === "unite") {
    try {
      return uniteCommand(config, args.slice(1), io);
    } catch (err) {
      if (!(err instanceof PorticoError)) throw err;
      io.err(err.message);
      return 1;
    }
  }
  if (readMain(config)) {
    io.err("This Portico keeps one database for every account, so there are no workspaces to make, link or remove here.");
    return 1;
  }
  const removing = action === "remove" && (rest.length === 0 || (rest.length === 2 && rest[0] === "--confirm"));
  const wanted = action === "create" ? 1 : action === "import" || action === "link" ? 2 : action === "list" ? 0 : -1;
  if (name === undefined ? action !== "list" || args.length !== 1 : !removing && args.length - 1 !== wanted) {
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
    if (action === "remove") {
      const workspace = hosted.control.bySlug(name!.trim().toLowerCase());
      if (!workspace) {
        io.err(`No workspace named ${name}.`);
        return 1;
      }
      const url = hosted.url(workspace);
      const { people, agents, messages, files } = hosted.contents(workspace);
      const holds = `${people} ${people === 1 ? "person" : "people"}, ${agents} ${agents === 1 ? "agent" : "agents"}, ${messages} ${messages === 1 ? "message" : "messages"} and ${files} ${files === 1 ? "file" : "files"}`;
      if (rest.length === 0) {
        io.out(`${url} holds ${holds}. Nothing is removed yet.`);
        io.out("  Removing can't be undone. To remove the workspace and everything in it:");
        io.out(`  portico workspace remove ${workspace.slug} --confirm ${workspace.slug}`);
        return 0;
      }
      if (rest[1]!.trim().toLowerCase() !== workspace.slug) {
        io.err(`--confirm must repeat the workspace's name, ${workspace.slug}. Nothing is removed.`);
        return 1;
      }
      await hosted.removeWithFiles(workspace);
      io.out(`Removed ${url}: ${holds}.`);
      return 0;
    }
    if (action === "link") {
      const workspace = hosted.control.bySlug(name!.trim().toLowerCase());
      if (!workspace) {
        io.err(`No workspace named ${name}.`);
        return 1;
      }
      if (config.descopeProjectId === null) {
        io.err("Links need sign-in on the base domain. Set PORTICO_DESCOPE_PROJECT_ID to the value portico serve runs with.");
        return 1;
      }
      const { secret, person } = hosted.linkFor(workspace, rest[0]!);
      io.out(`A link for ${person.name} in ${hosted.url(workspace)}. The link works once and expires in 1 day.`);
      io.out(`  ${config.baseUrl}/link?t=${secret}`);
      io.out(`  Whoever opens the link and signs in becomes ${person.name}, and the password for ${person.name} stops working.`);
      if (person.role !== "owner" && workspace.createdBy === null) {
        io.out("  The owner's link comes first: until the owner uses one, this workspace still signs in with passwords.");
      }
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
