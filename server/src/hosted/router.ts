import type { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { ensureSigningKey, type HostedConfig } from "../config";
import { fileStoreFor } from "../core/file-store";
import type { PorticoConfig } from "../core/types";
import { openDb } from "../db";
import { errorName, log } from "../log";
import { createPortico, type Portico } from "../portico";
import { Control, type Workspace } from "./control";
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
}

const IDLE_MS = 10 * 60_000;

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

  constructor(
    readonly config: HostedConfig,
    private readonly opts: HostedOptions = {},
  ) {
    mkdirSync(join(config.dataDir, "w"), { recursive: true });
    this.now = opts.now ?? (() => new Date());
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.control = new Control(join(config.dataDir, "control.db"), this.now);
    this.site = siteRoutes(config);
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
      files: this.config.files,
    };
  }

  /** Makes a workspace and its folder. The workspace's own setup then runs at its address. */
  create(slug: unknown, createdBy: string | null = null): Workspace {
    const workspace = this.control.create(slug, createdBy);
    this.workspaceConfig(workspace);
    log("info", "workspace_created", { workspace_id: workspace.id });
    return workspace;
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
    const config = this.workspaceConfig(workspace);
    const db = openDb(config.dbPath, (msg, fields) => log("info", msg, { ...fields, workspace_id: workspace.id }));
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const portico = createPortico(config, {
      db,
      now: this.opts.now,
      heartbeatMs: this.opts.heartbeatMs,
      // In a shared bucket, each workspace's files sit under the workspace's own prefix.
      fileStore: fileStoreFor(config, `w/${workspace.id}/files/`),
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

  /** Removes a workspace for good: its record, then its folder. Files in a bucket go through the bucket's own rules. */
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
