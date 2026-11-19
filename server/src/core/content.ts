import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openContentDb } from "../db";
import { MINUTE_MS } from "./limits";

/** One workspace's content database, open. Never kept across an `await`: ask Content again instead. */
export interface ContentDb {
  readonly workspaceId: string;
  readonly db: Database;
}

/**
 * Whose content a lookup runs over. The caller is always known, so every read of threads, messages, tasks and files
 * names one: an agent (every workspace the agent is in now or was in before), a person (the same for each of the
 * person's agents), or one workspace. `workspace` beside an agent or a person narrows the set to that one workspace,
 * and gives nothing when the workspace isn't in the set.
 */
export type Scope = { agent: string; workspace?: string } | { person: string; workspace?: string } | { workspace: string };

interface Entry extends ContentDb {
  lastUsed: number;
  /** Sweeps under way on the database. A pinned database is never closed. */
  pins: number;
  /** Opened only for a sweep, which closes the database again unless something else used it meanwhile. */
  transient: boolean;
}

export interface ContentDeps {
  /** The directory: which workspaces exist, and which agents are or were in each. */
  directory: Database;
  /** The data folder. Each workspace's content is at `porticos/<workspace ID>/content.db` inside. */
  dataDir: string;
  /** Tests: content databases in memory, as the directory is. */
  memory?: boolean;
  /** How long a content database stays open with nothing using it. */
  idleMs?: number;
  now?: () => Date;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

const IDLE_MS = 10 * MINUTE_MS;
/** Personal first, then the oldest: the order a set of workspaces always comes in. */
const ORDER = "ORDER BY w.kind = 'personal' DESC, w.created_at, w.id";
/** The folder in the data folder that holds every workspace's own folder. */
export const CONTENT_FOLDER = "porticos";

/**
 * The content databases: one per workspace, holding that workspace's threads, messages and files and nothing else.
 * Content opens each on first use, keeps the open ones, and closes those nothing has used for a while. A database is
 * made by the first write to its workspace; a read of a workspace that has no content yet finds nothing and makes
 * nothing.
 *
 * Every lookup names a scope, and Content turns the scope into a small set of databases. Only the sweeps (`each`) walk
 * every workspace. Closing happens only in `sweepIdle`, `remove` and `close`, never while a call is using a database:
 * all uses are synchronous, and a sweep that awaits pins the database it holds.
 */
export class Content {
  private readonly directory: Database;
  private readonly root: string;
  private readonly memory: boolean;
  private readonly idleMs: number;
  private readonly now: () => Date;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  private readonly entries = new Map<string, Entry>();

  constructor(deps: ContentDeps) {
    this.directory = deps.directory;
    this.root = join(deps.dataDir, CONTENT_FOLDER);
    this.memory = deps.memory ?? false;
    this.idleMs = deps.idleMs ?? IDLE_MS;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  // ---- the databases for a caller ----

  /** The workspace's content database, made on first use. Throws for a workspace the directory doesn't have. */
  for(workspaceId: string): ContentDb {
    if (!this.known(workspaceId)) throw new Error(`no workspace ${workspaceId}`);
    return this.use(workspaceId, true)!;
  }

  /** The workspace's content database, or null when nothing was ever written to the workspace, or the workspace is gone. */
  find(workspaceId: string): ContentDb | null {
    return this.known(workspaceId) ? this.use(workspaceId, false) : null;
  }

  /** The content databases a scope covers that hold anything, personal first, then the oldest. */
  of(scope: Scope): ContentDb[] {
    const found: ContentDb[] = [];
    for (const id of this.workspaceIds(scope)) {
      const content = this.use(id, false);
      if (content) found.push(content);
    }
    return found;
  }

  /** The IDs of the workspaces a scope covers, archived ones too, whether or not anything was written to each. */
  workspaceIds(scope: Scope): string[] {
    let ids: string[];
    if ("agent" in scope) {
      ids = (
        this.directory
          .query(`SELECT w.id FROM workspace_agents x JOIN workspaces w ON w.id = x.workspace_id WHERE x.agent_id = $agent ${ORDER}`)
          .all({ agent: scope.agent }) as { id: string }[]
      ).map((row) => row.id);
    } else if ("person" in scope) {
      ids = (
        this.directory
          .query(
            `SELECT DISTINCT w.id, w.kind, w.created_at FROM agents a
             JOIN workspace_agents x ON x.agent_id = a.id JOIN workspaces w ON w.id = x.workspace_id
             WHERE a.owner_id = $person ${ORDER}`,
          )
          .all({ person: scope.person }) as { id: string }[]
      ).map((row) => row.id);
    } else {
      return this.known(scope.workspace) ? [scope.workspace] : [];
    }
    return scope.workspace === undefined ? ids : ids.filter((id) => id === scope.workspace);
  }

  // ---- sweeps ----

  /**
   * Every workspace's content in turn, archived ones too: for the sweeps only (expiry, history, files), never for a
   * caller's request. A database opened for the sweep closes again afterwards. One workspace failing doesn't stop the
   * rest.
   */
  each(fn: (content: ContentDb) => void): void {
    for (const id of this.allIds()) {
      const held = this.hold(id);
      if (!held) continue;
      try {
        fn(held.entry);
      } catch (err) {
        this.log("content_sweep_failed", { workspace_id: id, error: err instanceof Error ? err.name : "unknown" });
      } finally {
        this.release(held);
      }
    }
  }

  /** `each`, for a sweep that awaits: the database stays open until the step for its workspace settles. */
  async eachAsync(fn: (content: ContentDb) => Promise<void>): Promise<void> {
    for (const id of this.allIds()) {
      const held = this.hold(id);
      if (!held) continue;
      try {
        await fn(held.entry);
      } catch (err) {
        this.log("content_sweep_failed", { workspace_id: id, error: err instanceof Error ? err.name : "unknown" });
      } finally {
        this.release(held);
      }
    }
  }

  /** Closes the databases nothing has used for a while. Databases in memory stay: closing one would empty the workspace. */
  sweepIdle(): number {
    if (this.memory) return 0;
    const cutoff = this.now().getTime() - this.idleMs;
    let closed = 0;
    for (const [id, entry] of [...this.entries]) {
      if (entry.lastUsed > cutoff || entry.pins > 0) continue;
      this.shut(id);
      closed++;
    }
    return closed;
  }

  // ---- removals: the directory's rows go first, then the content ----

  /**
   * For removing agents. Call before the agents' rows go, since the workspaces each was in are read here; then run the
   * function returned once the rows are gone. It deletes every thread one of the agents was in, with the messages, in
   * each of those workspaces, and returns how many threads went. A crash in between leaves threads the daily sweep
   * clears (`sweepLeftovers`).
   */
  gather(agentIds: string[]): () => number {
    const workspaces = new Set<string>();
    for (const agent of agentIds) for (const id of this.workspaceIds({ agent })) workspaces.add(id);
    return () => {
      let removed = 0;
      for (const id of workspaces) {
        const content = this.stored(id);
        if (content) removed += removeAgents(content.db, agentIds);
      }
      if (removed > 0) this.log("content_cleared", { agents: agentIds.length, threads: removed });
      return removed;
    };
  }

  /** Daily: deletes threads of agents the directory no longer has, which a crash during a removal leaves behind. */
  sweepLeftovers(): number {
    const exists = this.directory.query("SELECT 1 FROM agents WHERE id = $id");
    let removed = 0;
    this.each(({ db }) => {
      const ids = (db.query("SELECT a_id AS id FROM threads UNION SELECT b_id FROM threads").all() as { id: string }[]).map((row) => row.id);
      const gone = ids.filter((id) => exists.get({ id }) === null);
      if (gone.length > 0) removed += removeAgents(db, gone);
    });
    return removed;
  }

  /** Whether the workspace holds no thread and no message: true as well when nothing was ever written to the workspace. */
  isEmpty(workspaceId: string): boolean {
    const content = this.stored(workspaceId);
    if (!content) return true;
    const row = content.db.query("SELECT (SELECT COUNT(*) FROM threads) + (SELECT COUNT(*) FROM messages) AS n").get() as { n: number };
    return row.n === 0;
  }

  /**
   * The content of a workspace whether or not the directory still has the workspace, when there is any. For removals
   * only: a caller's request goes through `of`.
   */
  stored(workspaceId: string): ContentDb | null {
    return this.use(workspaceId, false);
  }

  /** Closes the workspace's content database and deletes the workspace's folder, with every file in the folder. */
  remove(workspaceId: string): void {
    this.shut(workspaceId);
    if (!this.memory && safeName(workspaceId)) rmSync(this.dir(workspaceId), { recursive: true, force: true });
    this.log("content_removed", { workspace_id: workspaceId });
  }

  /** Folders in the data folder for workspaces the directory no longer has: what a crash during a removal leaves. */
  orphans(): string[] {
    const names = this.memory ? [...this.entries.keys()] : existsSync(this.root) ? readdirSync(this.root) : [];
    return names.filter((name) => safeName(name) && !this.known(name));
  }

  /** The workspace's folder in the data folder: `content.db`, and `files` for a Portico that keeps files on disk. */
  dir(workspaceId: string): string {
    return join(this.root, workspaceId);
  }

  isOpen(workspaceId: string): boolean {
    return this.entries.has(workspaceId);
  }

  /** Closes every content database: the server is stopping. */
  close(): void {
    for (const id of [...this.entries.keys()]) this.shut(id);
  }

  // ---- helpers ----

  private known(workspaceId: string): boolean {
    return this.directory.query("SELECT 1 FROM workspaces WHERE id = $id").get({ id: workspaceId }) !== null;
  }

  private allIds(): string[] {
    return (this.directory.query("SELECT id FROM workspaces ORDER BY created_at, id").all() as { id: string }[]).map((row) => row.id);
  }

  private path(workspaceId: string): string {
    return join(this.dir(workspaceId), "content.db");
  }

  /** The open database, opened when the workspace has one, and made when `create` says so. Marks the database used. */
  private use(workspaceId: string, create: boolean): Entry | null {
    const entry = this.entry(workspaceId, create);
    if (entry) {
      entry.lastUsed = this.now().getTime();
      entry.transient = false;
    }
    return entry;
  }

  private entry(workspaceId: string, create: boolean): Entry | null {
    const open = this.entries.get(workspaceId);
    if (open) return open;
    if (!safeName(workspaceId)) return null;
    if (!create && (this.memory || !existsSync(this.path(workspaceId)))) return null;
    if (!this.memory) mkdirSync(this.dir(workspaceId), { recursive: true });
    const db = openContentDb(this.memory ? ":memory:" : this.path(workspaceId), (msg, fields) => this.log(msg, { ...fields, workspace_id: workspaceId }));
    const entry: Entry = { workspaceId, db, lastUsed: this.now().getTime(), pins: 0, transient: false };
    this.entries.set(workspaceId, entry);
    return entry;
  }

  private hold(workspaceId: string): { entry: Entry; wasOpen: boolean } | null {
    const wasOpen = this.entries.has(workspaceId);
    const entry = this.entry(workspaceId, false);
    if (!entry) return null;
    if (!wasOpen) entry.transient = true;
    entry.pins++;
    return { entry, wasOpen };
  }

  private release(held: { entry: Entry; wasOpen: boolean }): void {
    held.entry.pins--;
    if (!this.memory && held.entry.transient && held.entry.pins === 0) this.shut(held.entry.workspaceId);
  }

  private shut(workspaceId: string): void {
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    this.entries.delete(workspaceId);
    entry.db.close();
  }
}

/** A workspace ID that is one plain folder name: IDs are made by Portico, and nothing else is ever joined to a path. */
function safeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..");
}

/** Deletes the agents' threads with their messages, and forgets the agents as uploaders. Returns how many threads went. */
function removeAgents(db: Database, agentIds: string[]): number {
  if (agentIds.length === 0) return 0;
  const bindings: Record<string, string> = {};
  const names = agentIds.map((id, i) => {
    bindings[`a${i}`] = id;
    return `$a${i}`;
  });
  const list = names.join(", ");
  return db.transaction(() => {
    db.query(`UPDATE files SET uploader_id = NULL WHERE uploader_id IN (${list})`).run(bindings);
    return db.query(`DELETE FROM threads WHERE a_id IN (${list}) OR b_id IN (${list})`).run(bindings).changes;
  })();
}

/** Lists merged into one, in the order `key` gives. Rows with the same key stay in the order the lists came in. */
export function merged<T>(lists: T[][], key: (item: T) => string, descending = false): T[] {
  if (lists.length === 1) return lists[0]!;
  const order = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return lists.flat().sort((x, y) => (descending ? order(key(y), key(x)) : order(key(x), key(y))));
}
