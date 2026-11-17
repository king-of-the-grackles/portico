import { Database } from "bun:sqlite";
import { PorticoError } from "../core/errors";
import { NAME } from "../core/limits";

/** One workspace: a whole Portico of its own, at `<slug>.<base domain>`. */
export interface Workspace {
  id: string;
  slug: string;
  /** The account that made the workspace. Null for one made from the command line. */
  createdBy: string | null;
  createdAt: string;
}

interface WorkspaceRow {
  id: string;
  slug: string;
  created_by: string | null;
  created_at: string;
}

const toWorkspace = (row: WorkspaceRow): Workspace => ({ id: row.id, slug: row.slug, createdBy: row.created_by, createdAt: row.created_at });

/** Names a workspace can't take: addresses Portico or a visitor would expect to mean something else. */
const RESERVED = new Set([
  "www", "app", "api", "admin", "auth", "login", "signin", "signup", "account", "accounts", "billing", "blog", "cdn",
  "dashboard", "docs", "files", "help", "mail", "mcp", "portico", "root", "static", "status", "support", "system", "test",
]);

const MIN_SLUG = 3;
const MAX_SLUG = 40;
const VERSION = 1;

/** A workspace's address name as given: lowercase letters, digits and hyphens, 3 to 40 characters, not reserved. */
export function checkSlug(value: unknown): string {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (slug.length < MIN_SLUG || slug.length > MAX_SLUG || !NAME.test(slug)) {
    throw new PorticoError(
      "bad_request",
      `A workspace name is ${MIN_SLUG} to ${MAX_SLUG} lowercase letters, digits and hyphens, such as acme-team.`,
    );
  }
  if (RESERVED.has(slug)) throw new PorticoError("conflict", `The name ${slug} is reserved. Pick another.`);
  return slug;
}

/**
 * The control database: the list of workspaces and nothing else. Whatever happens inside a workspace (people, agents,
 * messages, tokens) lives in that workspace's own database and never here.
 */
export class Control {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > VERSION) {
      this.db.close();
      throw new Error(`The control database at ${path} was written by a newer Portico version.`);
    }
    if (version === 0) {
      this.db.transaction(() => {
        this.db.run(`CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          slug TEXT NOT NULL UNIQUE,
          created_by TEXT,
          created_at TEXT NOT NULL
        )`);
        this.db.run("CREATE INDEX workspaces_created_by ON workspaces (created_by)");
        this.db.run(`PRAGMA user_version = ${VERSION}`);
      })();
    }
  }

  create(slug: unknown, createdBy: string | null = null): Workspace {
    const workspace: Workspace = { id: this.newId(), slug: checkSlug(slug), createdBy, createdAt: this.now().toISOString() };
    try {
      this.db
        .query("INSERT INTO workspaces (id, slug, created_by, created_at) VALUES ($id, $slug, $createdBy, $createdAt)")
        .run({ ...workspace });
    } catch (err) {
      if (String((err as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT")) {
        throw new PorticoError("conflict", `The name ${workspace.slug} is taken. Pick another.`);
      }
      throw err;
    }
    return workspace;
  }

  bySlug(slug: string): Workspace | null {
    const row = this.db.query("SELECT * FROM workspaces WHERE slug = $slug").get({ slug }) as WorkspaceRow | null;
    return row ? toWorkspace(row) : null;
  }

  get(id: string): Workspace | null {
    const row = this.db.query("SELECT * FROM workspaces WHERE id = $id").get({ id }) as WorkspaceRow | null;
    return row ? toWorkspace(row) : null;
  }

  /** Every workspace, oldest first. */
  all(): Workspace[] {
    return (this.db.query("SELECT * FROM workspaces ORDER BY created_at, id").all() as WorkspaceRow[]).map(toWorkspace);
  }

  /** The workspaces one account made, oldest first. */
  createdBy(accountId: string): Workspace[] {
    const rows = this.db
      .query("SELECT * FROM workspaces WHERE created_by = $accountId ORDER BY created_at, id")
      .all({ accountId }) as WorkspaceRow[];
    return rows.map(toWorkspace);
  }

  remove(id: string): void {
    this.db.query("DELETE FROM workspaces WHERE id = $id").run({ id });
  }

  close(): void {
    this.db.close();
  }
}
