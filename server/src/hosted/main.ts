import { Database } from "bun:sqlite";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, ensureSigningKey, type HostedConfig } from "../config";
import { PorticoError } from "../core/errors";
import { type FileStore, fileStoreFor } from "../core/file-store";
import { withOrigin } from "../core/request-origin";
import type { AccountSignIn, PorticoConfig } from "../core/types";
import { openDb } from "../db";
import { log } from "../log";
import { createPortico, type Portico } from "../portico";
import { checkSlug, Control } from "./control";
import { type AccountCheck, accountFrom, Descope } from "./descope";
import { noWorkspace } from "./site";

/**
 * What the one database's folder says about itself, in `main/main.json`. The control database is left exactly as the
 * release before wrote it, so that release still starts on the same data folder.
 */
export interface MainState {
  /** Addresses under the base domain that also reach this Portico: `super` for `super.<domain>`. */
  aliases: string[];
  /** Where files sit in a shared bucket. A migrated workspace's files stay where they were. */
  filesPrefix: string;
}

const STATE_FILE = "main.json";

export const mainDir = (config: Pick<HostedConfig, "dataDir">) => join(config.dataDir, "main");

/** The one database's state, or null where hosted Portico still keeps a database per workspace. */
export function readMain(config: Pick<HostedConfig, "dataDir">): MainState | null {
  const path = join(mainDir(config), STATE_FILE);
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<MainState>;
  const aliases = Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === "string") : [];
  return { aliases, filesPrefix: typeof value.filesPrefix === "string" ? value.filesPrefix : "main/files/" };
}

function writeMain(dir: string, state: MainState): void {
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

/** The one Portico's settings over the database in `dataDir`. */
function porticoConfig(config: HostedConfig, dataDir: string): PorticoConfig {
  mkdirSync(dataDir, { recursive: true });
  return {
    port: config.port,
    dbPath: join(dataDir, "portico.db"),
    dataDir,
    pluginSource: config.pluginSource,
    publicUrl: config.baseUrl,
    signingKey: ensureSigningKey(dataDir),
    webhooksAllowPrivate: config.webhooksAllowPrivate,
    workspaces: true,
    files: config.files,
    mail: config.mail,
  };
}

const mainConfig = (config: HostedConfig) => porticoConfig(config, mainDir(config));

export interface MainOptions {
  now?: () => Date;
  heartbeatMs?: number;
  /** Who a sign-in token belongs to; by default Descope. */
  accountCheck?: AccountCheck;
  /** Where files are kept; tests pass a fake bucket. */
  fileStore?: FileStore;
}

/**
 * Hosted Portico over one database. Every account, agent and conversation lives in `main/portico.db`, and workspaces
 * (core/workspaces.ts) decide which agents reach which. People sign in at the base domain. An address an agent joined
 * at before (`super.<domain>`) keeps answering as the same Portico, so no agent has to join again.
 */
export class MainHosted {
  readonly portico: Portico;
  private readonly db: Database;
  private readonly state: MainState;
  private readonly origins: Map<string, string>;

  constructor(
    readonly config: HostedConfig,
    opts: MainOptions = {},
  ) {
    const state = readMain(config);
    if (!state) throw new Error(`No ${STATE_FILE} in ${mainDir(config)}.`);
    this.state = state;
    const check = opts.accountCheck ?? (config.descopeProjectId ? new Descope(config.descopeProjectId, { now: opts.now }) : null);
    if (!check) throw new ConfigError(["Hosted Portico with one database signs people in with Descope: set PORTICO_DESCOPE_PROJECT_ID"]);
    this.origins = new Map([[config.domain, config.baseUrl]]);
    for (const alias of state.aliases) this.origins.set(`${alias}.${config.domain}`, config.baseUrl.replace("://", `://${alias}.`));
    const host = config.domain.split(":")[0]!;
    const accountSignIn: AccountSignIn = {
      projectId: config.descopeProjectId ?? "",
      account: (token) => accountFrom(check, token),
      homeUrl: config.baseUrl,
      addresses: () => [...this.origins.values()],
      // One sign-in for every address. A bare host such as localhost takes no Domain, so there the cookie stays put.
      cookieDomain: state.aliases.length > 0 && host.includes(".") ? host : null,
    };
    const portico = mainConfig(config);
    this.db = openDb(portico.dbPath, (msg, fields) => log("info", msg, fields));
    try {
      this.portico = createPortico(portico, {
        db: this.db,
        now: opts.now,
        heartbeatMs: opts.heartbeatMs,
        fileStore: opts.fileStore ?? fileStoreFor(portico, state.filesPrefix),
        accountSignIn,
      });
      if (!this.portico.settings.setupDone()) this.portico.settings.set("setup_done_at", (opts.now?.() ?? new Date()).toISOString());
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  /** The address a request's host names, or null for one that isn't this Portico's. */
  origin(host: string | null): string | null {
    return this.origins.get((host ?? "").trim().toLowerCase()) ?? null;
  }

  fetch = async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname === "/healthz") return Response.json({ ok: true });
    const origin = this.origin(request.headers.get("host") ?? new URL(request.url).host);
    if (origin === null) return noWorkspace(request, this.config.baseUrl);
    return withOrigin(origin, () => this.portico.app.fetch(request));
  };

  get takesUploads(): boolean {
    return this.config.files === null;
  }

  sweepMinute(): void {
    this.portico.sweepMinute();
  }

  async sweepAll(daily = false): Promise<void> {
    if (daily) this.portico.sweepDaily();
  }

  stop(): void {
    this.db.close();
  }
}

/** Starts the one database empty, for a hosted Portico with no workspaces to bring over. */
export function createMain(config: HostedConfig): void {
  if (readMain(config)) throw new PorticoError("conflict", "This Portico already has its one database.");
  mainConfig(config);
  writeMain(mainDir(config), { aliases: [], filesPrefix: "main/files/" });
}

export interface MigrationResult {
  people: number;
  agents: number;
  threads: number;
  messages: number;
  removed: { person: string; agents: number; threads: number; messages: number }[];
}

/** What removing these people would take with them, counted in the given database. */
function countsFor(db: Database, personId: string): { agents: number; threads: number; messages: number } {
  const n = (sql: string) => (db.query(sql).get({ personId }) as { n: number }).n;
  const mine = "(SELECT id FROM agents WHERE owner_id = $personId)";
  return {
    agents: n("SELECT COUNT(*) AS n FROM agents WHERE owner_id = $personId"),
    threads: n(`SELECT COUNT(*) AS n FROM threads WHERE a_id IN ${mine} OR b_id IN ${mine}`),
    messages: n(`SELECT COUNT(*) AS n FROM messages WHERE from_id IN ${mine} OR to_id IN ${mine}`),
  };
}

/**
 * Says what moving a workspace into the one database would do, without doing it: who is there, and what removing each
 * named person would take along.
 */
export function previewMigration(config: HostedConfig, slug: string, remove: string[] = []): MigrationResult {
  const control = new Control(join(config.dataDir, "control.db"));
  let source: Database | null = null;
  try {
    const workspace = control.bySlug(checkSlug(slug));
    if (!workspace) throw new PorticoError("not_found", `No workspace named ${slug}.`);
    source = new Database(join(config.dataDir, "w", workspace.id, "portico.db"), { readonly: true, strict: true });
    const n = (table: string) => (source!.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const removed = remove.map((name) => {
      const person = source!.query("SELECT id, name FROM people WHERE name = $name").get({ name: name.trim() }) as { id: string; name: string } | null;
      if (!person) throw new PorticoError("not_found", `No person named ${name} in ${slug}.`);
      return { person: person.name, ...countsFor(source!, person.id) };
    });
    return { people: n("people"), agents: n("agents"), threads: n("threads"), messages: n("messages"), removed };
  } finally {
    source?.close();
    control.close();
  }
}

/**
 * Makes the one database out of a workspace's: a copy, so the workspace's own files stay exactly as they were and the
 * release before still runs on them. Each person left gets a personal workspace holding their agents, and every
 * conversation is stamped with the workspace it runs through. Everyone signs in again. `remove` names people who are
 * deleted from the copy with their agents and conversations.
 *
 * The server must not be writing while this runs: what the workspace takes in after the copy is not in the copy.
 */
export function migrateToMain(config: HostedConfig, slug: string, remove: string[] = [], now: () => Date = () => new Date()): MigrationResult {
  if (readMain(config)) throw new PorticoError("conflict", "This Portico already has its one database.");
  const preview = previewMigration(config, slug, remove);
  const control = new Control(join(config.dataDir, "control.db"));
  const workspace = control.bySlug(checkSlug(slug))!;
  control.close();
  const from = join(config.dataDir, "w", workspace.id);
  const dir = mainDir(config);
  // Built beside its final place, so a migration that fails leaves nothing that looks finished.
  const building = `${dir}.building`;
  rmSync(building, { recursive: true, force: true });
  mkdirSync(building, { recursive: true });
  try {
    const source = new Database(join(from, "portico.db"), { readonly: true, strict: true });
    try {
      // A whole, settled copy, whatever the source's write-ahead log still holds.
      source.run(`VACUUM INTO '${join(building, "portico.db").replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    // The workspace's signing key comes along, so every agent's and computer's token still checks out.
    copyFileSync(join(from, "signing.key"), join(building, "signing.key"));
    if (config.files === null && existsSync(join(from, "files"))) cpSync(join(from, "files"), join(building, "files"), { recursive: true });

    const portico = porticoConfig(config, building);
    const db = openDb(portico.dbPath, (msg, fields) => log("info", msg, fields));
    try {
      const core = createPortico(portico, { db, now });
      db.transaction(() => {
        for (const name of remove) {
          const person = core.people.byName(name.trim());
          if (person) db.query("DELETE FROM people WHERE id = $id").run({ id: person.id });
        }
        for (const person of core.people.list()) core.workspaces.personal(person.id);
        const threads = db.query("SELECT id, a_id, b_id FROM threads").all() as { id: string; a_id: string; b_id: string }[];
        const stamp = db.query("UPDATE threads SET workspace_id = $workspaceId WHERE id = $id");
        for (const thread of threads) stamp.run({ id: thread.id, workspaceId: core.workspaces.stamp(thread.a_id, thread.b_id) });
        // Everyone signs in once more, at the base domain. What only the old sign-in used goes.
        db.run("DELETE FROM web_sessions");
        db.run("DELETE FROM setup_links");
        db.run("DELETE FROM invites WHERE id NOT IN (SELECT invite_id FROM people WHERE invite_id IS NOT NULL)");
        db.run("DELETE FROM settings WHERE key = 'public_url'");
      })();
      const broken = (db.query("PRAGMA foreign_key_check").all() as unknown[]).length;
      const sound = (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
      if (broken > 0 || sound !== "ok") throw new Error(`The new database failed its checks: ${broken} broken links, integrity ${sound}.`);
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    // The state file goes in before the folder takes its place, so the folder is whole the moment it appears.
    writeMain(building, { aliases: [workspace.slug], filesPrefix: config.files ? `w/${workspace.id}/files/` : "main/files/" });
    renameSync(building, dir);
    log("info", "main_migrated", { workspace_id: workspace.id });
  } catch (err) {
    rmSync(building, { recursive: true, force: true });
    throw err;
  }
  const after = new Database(join(dir, "portico.db"), { readonly: true, strict: true });
  try {
    const n = (table: string) => (after.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { people: n("people"), agents: n("agents"), threads: n("threads"), messages: n("messages"), removed: preview.removed };
  } finally {
    after.close();
  }
}
