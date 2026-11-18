import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { ensureSigningKey, type HostedConfig } from "../config";
import { NO_PASSWORD } from "../core/accounts";
import { PorticoError } from "../core/errors";
import { type FileStore, fileStoreFor } from "../core/file-store";
import { MINUTE_MS } from "../core/limits";
import { cleanPersonName } from "../core/people";
import { hashSecret, newLinkSecret } from "../core/tokens";
import type { CentralSignIn, Person, PorticoConfig } from "../core/types";
import { openDb } from "../db";
import { errorName, log } from "../log";
import { createPortico, type Portico } from "../portico";
import { checkSlug, Control, type Workspace } from "./control";
import { type AccountCheck, Descope } from "./descope";
import { noWorkspace, siteRoutes } from "./site";

/** A workspace that is open: its Portico, and what says whether anything still needs it. */
interface OpenWorkspace {
  portico: Portico;
  db: Database;
  lastUsed: number;
  /** Requests being answered now. A live stream's request has already answered, so streams are counted apart. */
  active: number;
  /** Webhook retries waiting to run: each needs the database when it fires. */
  timers: Set<ReturnType<typeof setTimeout>>;
}

export interface HostedOptions {
  now?: () => Date;
  /** How long a workspace stays open with nothing using it. */
  idleMs?: number;
  heartbeatMs?: number;
  /** Who a sign-in token belongs to; by default Descope, when a project is configured. */
  accountCheck?: AccountCheck;
  /** Where a workspace's files are kept; tests pass a fake bucket. */
  fileStore?: (workspace: Workspace) => FileStore;
}

const IDLE_MS = 10 * 60_000;
/** How long a pass from the base domain to a workspace works. */
const PASS_MS = MINUTE_MS;
/** The free beta's cap on workspaces one account can make. */
export const MAX_WORKSPACES_PER_ACCOUNT = 3;

/** A hand-off waiting to be used: which account may enter which workspace, from the browser that asked. */
interface Pass {
  workspaceId: string;
  accountId: string;
  state: string;
  expiresAt: number;
}

/** A workspace as the base domain lists it for one account. */
export interface AccountWorkspace {
  workspace: Workspace;
  url: string;
  person: Person;
}

/**
 * Hosted Portico: one server, many workspaces. Each request's host names a workspace, and the request goes to that
 * workspace's own Portico, over that workspace's own database, signing key and files. Nothing is shared between two
 * workspaces but this router, so a token, a cookie or a file from one means nothing at another's address.
 *
 * A workspace opens on its first request and closes once nothing has used it for a while and no stream is live.
 */
export class Hosted {
  readonly control: Control;
  private readonly site: Hono;
  private readonly open = new Map<string, OpenWorkspace>();
  private readonly now: () => Date;
  private readonly idleMs: number;
  /** Signs people in on the base domain; null when each workspace keeps passwords of its own. */
  readonly accounts: AccountCheck | null;
  /** Passes by hash. In memory: a restart ends hand-offs under way, and the browser starts again. */
  private readonly passes = new Map<string, Pass>();

  constructor(
    readonly config: HostedConfig,
    private readonly opts: HostedOptions = {},
  ) {
    mkdirSync(join(config.dataDir, "w"), { recursive: true });
    this.now = opts.now ?? (() => new Date());
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.control = new Control(join(config.dataDir, "control.db"), this.now);
    this.accounts =
      opts.accountCheck ?? (config.descopeProjectId ? new Descope(config.descopeProjectId, { now: this.now }) : null);
    this.site = siteRoutes(this);
  }

  // ---- sign-in on the base domain ----

  /** A pass that lets the account into the workspace: once, for a minute, from the browser that holds `state`. */
  mintPass(workspace: Workspace, accountId: string, state: string): string {
    const now = this.now().getTime();
    for (const [hash, pass] of this.passes) if (pass.expiresAt <= now) this.passes.delete(hash);
    const secret = newLinkSecret();
    this.passes.set(hashSecret(secret), { workspaceId: workspace.id, accountId, state, expiresAt: now + PASS_MS });
    return secret;
  }

  /** Uses a pass up. Whatever is wrong with it (unknown, used, late, another workspace's, another browser's), null. */
  private takePass(workspaceId: string, secret: string, state: string): string | null {
    const hash = hashSecret(secret);
    const pass = this.passes.get(hash);
    if (!pass) return null;
    this.passes.delete(hash);
    if (state === "" || pass.workspaceId !== workspaceId || pass.state !== state || pass.expiresAt <= this.now().getTime()) return null;
    return pass.accountId;
  }

  /** The base-domain sign-in as one workspace sees it. */
  private central(workspace: Workspace): CentralSignIn {
    return {
      homeUrl: this.config.baseUrl,
      startUrl: (state, next) =>
        `${this.config.baseUrl}/go/${workspace.slug}?state=${encodeURIComponent(state)}&next=${encodeURIComponent(next)}`,
      take: (pass, state) => this.takePass(workspace.id, pass, state),
      joined: (accountId) => this.control.addMember(accountId, workspace.id),
    };
  }

  /**
   * Makes a workspace for a signed-in account, with the account as its owner under the name given. There is no setup
   * link: the workspace is ready as soon as it exists.
   */
  createFor(accountId: string, input: { slug: unknown; name: unknown }): Workspace {
    const name = cleanPersonName(input.name);
    checkSlug(input.slug);
    if (this.control.createdBy(accountId).length >= MAX_WORKSPACES_PER_ACCOUNT) {
      throw new PorticoError("rate_limited", `One account can make ${MAX_WORKSPACES_PER_ACCOUNT} workspaces.`);
    }
    const workspace = this.create(input.slug, accountId);
    try {
      const portico = this.portico(workspace);
      portico.db.transaction(() => {
        portico.people.create({ name, role: "owner", status: "active", passwordHash: NO_PASSWORD, externalId: accountId });
        portico.settings.set("setup_done_at", this.now().toISOString());
      })();
      this.control.addMember(accountId, workspace.id);
    } catch (err) {
      this.remove(workspace);
      throw err;
    }
    return workspace;
  }

  /**
   * The workspaces where the account has a person, asked of each workspace's own people. A workspace that removed the
   * person drops off the list.
   */
  workspacesFor(accountId: string): AccountWorkspace[] {
    const found: AccountWorkspace[] = [];
    for (const workspace of this.control.memberOf(accountId)) {
      try {
        const wasOpen = this.open.has(workspace.id);
        const entry = this.entry(workspace);
        const person = entry.portico.people.byExternalId(accountId);
        // Looking is not using: a workspace opened only for the list closes at the next sweep.
        if (!wasOpen) entry.lastUsed = 0;
        if (person) found.push({ workspace, url: this.url(workspace), person });
        else this.control.removeMember(accountId, workspace.id);
      } catch (err) {
        // One workspace that can't open doesn't hide the others.
        log("error", "workspace_list_failed", { workspace_id: workspace.id, error: errorName(err) });
      }
    }
    return found;
  }

  /** The address agents and people use for the workspace. */
  url(workspace: Pick<Workspace, "slug">): string {
    return this.config.baseUrl.replace("://", `://${workspace.slug}.`);
  }

  private dir(workspace: Pick<Workspace, "id">): string {
    return join(this.config.dataDir, "w", workspace.id);
  }

  /** The workspace's Portico settings: exactly a self-hosted Portico's, in the workspace's own folder. */
  private workspaceConfig(workspace: Workspace): PorticoConfig {
    const dataDir = this.dir(workspace);
    mkdirSync(dataDir, { recursive: true });
    return {
      port: this.config.port,
      dbPath: join(dataDir, "portico.db"),
      dataDir,
      pluginSource: this.config.pluginSource,
      publicUrl: this.url(workspace),
      signingKey: ensureSigningKey(dataDir),
      webhooksAllowPrivate: this.config.webhooksAllowPrivate,
      workspaces: false,
      files: this.config.files,
      // A workspace of its own shares nothing by link, so nothing is emailed.
      mail: null,
    };
  }

  /** Makes a workspace and its folder. The workspace's own setup then runs at its address. */
  create(slug: unknown, createdBy: string | null = null): Workspace {
    const workspace = this.control.create(slug, createdBy);
    this.workspaceConfig(workspace);
    log("info", "workspace_created", { workspace_id: workspace.id });
    return workspace;
  }

  /**
   * Makes a workspace out of a single Portico's data folder: its database and its signing key, so every agent's and
   * computer's token still works at the new address. The folder is only read. The workspace keeps its people's
   * passwords, as one made from the command line does.
   */
  importFrom(slug: unknown, folder: string): { workspace: Workspace; people: number; agents: number } {
    const dbPath = join(folder, "portico.db");
    const keyPath = join(folder, "signing.key");
    if (!existsSync(dbPath) || !existsSync(keyPath)) {
      throw new PorticoError("bad_request", `${folder} needs a Portico's portico.db and signing.key.`);
    }
    let source: Database;
    try {
      source = new Database(dbPath, { readonly: true });
    } catch {
      throw new PorticoError("bad_request", `${dbPath} doesn't open as a database.`);
    }
    let workspace: Workspace | null = null;
    try {
      const has = (table: string) => source.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;
      let known = false;
      try {
        known = has("people") && has("settings") && has("agents");
      } catch {
        // Not a database at all.
      }
      if (!known) throw new PorticoError("bad_request", `${dbPath} isn't a Portico database.`);
      const done = source.query("SELECT 1 FROM settings WHERE key = 'setup_done_at'").get();
      if (!done) throw new PorticoError("bad_request", "That Portico was never set up, so there's nothing to bring over.");
      // Files on a disk stay behind: only what the database holds comes over.
      if (has("files") && source.query("SELECT 1 FROM files LIMIT 1").get()) {
        throw new PorticoError("bad_request", "That Portico holds attached files, and import doesn't bring files over yet.");
      }
      workspace = this.create(slug);
      const dir = this.dir(workspace);
      // A whole, settled copy, whatever the source's write-ahead log still holds.
      rmSync(join(dir, "portico.db"), { force: true });
      source.run(`VACUUM INTO '${join(dir, "portico.db").replaceAll("'", "''")}'`);
      copyFileSync(keyPath, join(dir, "signing.key"));
      const portico = this.portico(workspace);
      const people = (portico.db.query("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n;
      const agents = (portico.db.query("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n;
      log("info", "workspace_imported", { workspace_id: workspace.id, people, agents });
      return { workspace, people, agents };
    } catch (err) {
      if (workspace) this.remove(workspace);
      throw err;
    } finally {
      source.close();
    }
  }

  /** The workspace's Portico, opened if it was closed. */
  portico(workspace: Workspace): Portico {
    return this.entry(workspace).portico;
  }

  private entry(workspace: Workspace): OpenWorkspace {
    const known = this.open.get(workspace.id);
    if (known) {
      known.lastUsed = this.now().getTime();
      return known;
    }
    // The record as the control database has it now: whether the workspace has an account decides how people sign in.
    workspace = this.control.get(workspace.id) ?? workspace;
    const config = this.workspaceConfig(workspace);
    const db = openDb(config.dbPath, (msg, fields) => log("info", msg, { ...fields, workspace_id: workspace.id }));
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const portico = createPortico(config, {
      db,
      now: this.opts.now,
      heartbeatMs: this.opts.heartbeatMs,
      fileStore: this.fileStore(workspace, config),
      // A workspace made from the command line keeps the setup link and passwords: nobody there has an account.
      central: this.accounts && workspace.createdBy !== null ? this.central(workspace) : undefined,
      schedule: (fn, ms) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          fn();
        }, ms);
        timers.add(timer);
      },
    });
    const opened: OpenWorkspace = { portico, db, lastUsed: this.now().getTime(), active: 0, timers };
    this.open.set(workspace.id, opened);
    log("info", "workspace_opened", { workspace_id: workspace.id });
    return opened;
  }

  private busy(entry: OpenWorkspace): boolean {
    return (
      entry.active > 0 ||
      entry.timers.size > 0 ||
      entry.portico.agentStreams.count() > 0 ||
      entry.portico.personStreams.count() > 0
    );
  }

  private close(id: string): void {
    const entry = this.open.get(id);
    if (!entry) return;
    for (const timer of entry.timers) clearTimeout(timer);
    this.open.delete(id);
    entry.db.close();
    log("info", "workspace_closed", { workspace_id: id });
  }

  /** The workspace a host names: `<slug>.<base domain>`, one label and no more. "base" is the base domain's own site. */
  resolve(host: string | null): Workspace | "base" | null {
    const name = (host ?? "").trim().toLowerCase();
    if (name === this.config.domain) return "base";
    const suffix = `.${this.config.domain}`;
    if (!name.endsWith(suffix)) return null;
    const slug = name.slice(0, -suffix.length);
    return slug.includes(".") ? null : this.control.bySlug(slug);
  }

  /** Every request comes through here. */
  fetch = async (request: Request): Promise<Response> => {
    // The host's health check names no domain, so it gets an answer at any address.
    if (new URL(request.url).pathname === "/healthz") return Response.json({ ok: true });
    const target = this.resolve(request.headers.get("host") ?? new URL(request.url).host);
    if (target === "base") return this.site.fetch(request);
    if (target === null) return noWorkspace(request, this.config.baseUrl);
    const entry = this.entry(target);
    entry.active++;
    try {
      return await entry.portico.app.fetch(request);
    } finally {
      entry.active--;
      entry.lastUsed = this.now().getTime();
    }
  };

  /** Whether uploads come through this server, so its body limit has to allow a file. */
  get takesUploads(): boolean {
    return this.config.files === null;
  }

  isOpen(workspaceId: string): boolean {
    return this.open.has(workspaceId);
  }

  /** Every minute: open workspaces' expiries, then closing the ones nothing uses. */
  sweepMinute(): void {
    const cutoff = this.now().getTime() - this.idleMs;
    for (const [id, entry] of [...this.open]) {
      entry.portico.sweepMinute();
      if (entry.lastUsed <= cutoff && !this.busy(entry)) this.close(id);
    }
  }

  /**
   * Closed workspaces still have messages that expire and files that go, so each is opened, swept and closed again.
   * With `daily`, every workspace also gets the daily sweep: history, old sessions and links.
   */
  async sweepAll(daily = false): Promise<void> {
    if (daily) this.control.sweep();
    for (const workspace of this.control.all()) {
      const wasOpen = this.open.has(workspace.id);
      try {
        const entry = this.entry(workspace);
        if (!wasOpen) entry.lastUsed = 0;
        if (daily) entry.portico.sweepDaily();
        if (!wasOpen) {
          entry.portico.sweepMinute();
          await entry.portico.sweepFiles();
          if (!this.busy(entry) && entry.lastUsed === 0) this.close(workspace.id);
        }
      } catch (err) {
        log("error", "workspace_sweep_failed", { workspace_id: workspace.id, error: errorName(err) });
      }
    }
  }

  /**
   * A one-use link for a person already in a workspace. Whoever signs in on the base domain with the link becomes
   * that person's account. This is how an imported workspace's people move from passwords to the base domain's sign-in.
   */
  linkFor(workspace: Workspace, personName: string): { secret: string; person: Person } {
    const person = this.portico(workspace).people.byName(personName.trim());
    if (!person || person.status !== "active") throw new PorticoError("not_found", `No active person named ${personName} in ${workspace.slug}.`);
    return { secret: this.control.createLink(workspace.id, person.id), person };
  }

  /** Whom a link is for, without using the link up. Null when the link, its workspace or its person is gone. */
  linkTarget(secret: unknown): { workspace: Workspace; person: Person } | null {
    const link = this.control.link(secret);
    const workspace = link ? this.control.get(link.workspaceId) : null;
    const person = workspace ? this.portico(workspace).people.get(link!.personId) : null;
    return workspace && person ? { workspace, person } : null;
  }

  /**
   * Uses a link up: the account becomes the person's sign-in, and the person's password stops working. When the
   * person is the owner, the workspace becomes the account's, so the whole workspace signs in on the base domain
   * from then on; the other people each need a link of their own.
   */
  useLink(secret: unknown, accountId: string): Workspace {
    const target = this.linkTarget(secret);
    this.control.link(secret, true);
    if (!target) throw new PorticoError("not_found", "This link doesn't work any more. Ask for a new one.");
    const { workspace, person } = target;
    const portico = this.portico(workspace);
    const other = portico.people.byExternalId(accountId);
    if (other && other.id !== person.id) {
      throw new PorticoError("conflict", `This sign-in already belongs to ${other.name} in ${workspace.slug}.`);
    }
    portico.db.transaction(() => {
      portico.people.setExternalId(person.id, accountId);
      portico.people.setPasswordHash(person.id, NO_PASSWORD);
    })();
    this.control.addMember(accountId, workspace.id);
    if (person.role === "owner" && workspace.createdBy === null) {
      this.control.setCreatedBy(workspace.id, accountId);
      // Opened again with the base domain's sign-in. Live streams reconnect by themselves.
      this.close(workspace.id);
    }
    log("info", "person_linked", { workspace_id: workspace.id, person_id: person.id });
    return this.control.get(workspace.id)!;
  }

  /** In a shared bucket, each workspace's files sit under the workspace's own prefix. */
  private fileStore(workspace: Workspace, config: PorticoConfig): FileStore {
    return this.opts.fileStore?.(workspace) ?? fileStoreFor(config, `w/${workspace.id}/files/`);
  }

  /** What a workspace holds, for the person about to remove it. */
  contents(workspace: Workspace): { people: number; agents: number; messages: number; files: number } {
    const db = this.portico(workspace).db;
    const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { people: count("people"), agents: count("agents"), messages: count("messages"), files: count("files") };
  }

  /**
   * Removes a workspace and everything in it: its files from wherever they are kept, then its record and its folder.
   * A file that can't be removed stops the removal, so nothing is left in a bucket with no workspace to find it by.
   */
  async removeWithFiles(workspace: Workspace): Promise<{ files: number }> {
    const config = this.workspaceConfig(workspace);
    const store = this.fileStore(workspace, config);
    const ids = (this.portico(workspace).db.query("SELECT id FROM files").all() as { id: string }[]).map((row) => row.id);
    for (const id of ids) await store.remove(id);
    this.remove(workspace);
    return { files: ids.length };
  }

  /** Removes a workspace's record and folder. Files in a bucket stay: removeWithFiles takes those too. */
  remove(workspace: Workspace): void {
    this.close(workspace.id);
    this.control.remove(workspace.id);
    rmSync(this.dir(workspace), { recursive: true, force: true });
    log("info", "workspace_removed", { workspace_id: workspace.id });
  }

  stop(): void {
    for (const id of [...this.open.keys()]) this.close(id);
    this.control.close();
  }
}
