import { Database } from "bun:sqlite";
import { PorticoError } from "../core/errors";
import { DAY_MS, LIMITS, NAME } from "../core/limits";
import { hashSecret, newLinkSecret, newToken } from "../core/tokens";

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
const VERSION = 3;

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
 * The control database: the list of workspaces, who is signed in on the base domain, and which accounts have a place
 * in which workspace (for the base domain's list only: each workspace's own people decide who gets in). Whatever
 * happens inside a workspace (agents, messages, tokens) lives in that workspace's own database and never here.
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
        this.db.run("PRAGMA user_version = 1");
      })();
    }
    if (version < 2) {
      this.db.transaction(() => {
        this.db.run(`CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )`);
        this.db.run(`CREATE TABLE members (
          account_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          PRIMARY KEY (account_id, workspace_id)
        )`);
        this.db.run("PRAGMA user_version = 2");
      })();
    }
    if (version < 3) {
      this.db.transaction(() => {
        // A one-use link that ties whoever signs in with it to a person already in a workspace.
        this.db.run(`CREATE TABLE links (
          secret_hash TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          person_id TEXT NOT NULL,
          expires_at TEXT NOT NULL
        )`);
        this.db.run("PRAGMA user_version = 3");
      })();
    }
  }

  // ---- sign-ins on the base domain ----

  /** A new sign-in for the account. The token goes in the base domain's cookie and is stored only as a hash. */
  startSession(accountId: string): { token: string; expiresAt: string } {
    const token = newToken("pb_");
    const at = this.now();
    const expiresAt = new Date(at.getTime() + LIMITS.webSessionDays * DAY_MS).toISOString();
    this.db
      .query("INSERT INTO sessions (token_hash, account_id, created_at, expires_at) VALUES ($hash, $accountId, $at, $expiresAt)")
      .run({ hash: hashSecret(token), accountId, at: at.toISOString(), expiresAt });
    return { token, expiresAt };
  }

  /** The account signed in with this cookie token, or null when the token is unknown or expired. */
  accountForSession(token: string | undefined): string | null {
    if (!token) return null;
    const row = this.db
      .query("SELECT account_id, expires_at FROM sessions WHERE token_hash = $hash")
      .get({ hash: hashSecret(token) }) as { account_id: string; expires_at: string } | null;
    return row && Date.parse(row.expires_at) > this.now().getTime() ? row.account_id : null;
  }

  endSession(token: string | undefined): void {
    if (token) this.db.query("DELETE FROM sessions WHERE token_hash = $hash").run({ hash: hashSecret(token) });
  }

  /** Daily: deletes expired sign-ins and links. Returns how many. */
  sweep(): number {
    const now = this.now().toISOString();
    this.db.query("DELETE FROM links WHERE expires_at <= $now").run({ now });
    return this.db.query("DELETE FROM sessions WHERE expires_at <= $now").run({ now }).changes;
  }

  // ---- links that tie a sign-in to a person already in a workspace ----

  /** A new link for the person, replacing any earlier one. The secret goes only into the link, and works for a day. */
  createLink(workspaceId: string, personId: string): string {
    const secret = newLinkSecret();
    const expiresAt = new Date(this.now().getTime() + DAY_MS).toISOString();
    this.db.transaction(() => {
      this.db.query("DELETE FROM links WHERE workspace_id = $workspaceId AND person_id = $personId").run({ workspaceId, personId });
      this.db
        .query("INSERT INTO links (secret_hash, workspace_id, person_id, expires_at) VALUES ($hash, $workspaceId, $personId, $expiresAt)")
        .run({ hash: hashSecret(secret), workspaceId, personId, expiresAt });
    })();
    return secret;
  }

  /** Whom a link is for, or null when the link is unknown or expired. `take` uses the link up. */
  link(secret: unknown, take = false): { workspaceId: string; personId: string } | null {
    if (typeof secret !== "string" || secret === "") return null;
    const hash = hashSecret(secret);
    const row = this.db.query("SELECT workspace_id, person_id, expires_at FROM links WHERE secret_hash = $hash").get({ hash }) as {
      workspace_id: string;
      person_id: string;
      expires_at: string;
    } | null;
    if (take) this.db.query("DELETE FROM links WHERE secret_hash = $hash").run({ hash });
    if (!row || Date.parse(row.expires_at) <= this.now().getTime()) return null;
    return { workspaceId: row.workspace_id, personId: row.person_id };
  }

  /** Says which account the workspace belongs to. A workspace with an account signs people in on the base domain. */
  setCreatedBy(workspaceId: string, accountId: string): void {
    this.db.query("UPDATE workspaces SET created_by = $accountId WHERE id = $workspaceId").run({ accountId, workspaceId });
  }

  // ---- which accounts have a place where ----

  addMember(accountId: string, workspaceId: string): void {
    this.db
      .query("INSERT OR IGNORE INTO members (account_id, workspace_id) VALUES ($accountId, $workspaceId)")
      .run({ accountId, workspaceId });
  }

  removeMember(accountId: string, workspaceId: string): void {
    this.db.query("DELETE FROM members WHERE account_id = $accountId AND workspace_id = $workspaceId").run({ accountId, workspaceId });
  }

  /** The workspaces the account was last known to have a place in, oldest first. */
  memberOf(accountId: string): Workspace[] {
    const rows = this.db
      .query(
        `SELECT w.* FROM workspaces w JOIN members m ON m.workspace_id = w.id
         WHERE m.account_id = $accountId ORDER BY w.created_at, w.id`,
      )
      .all({ accountId }) as WorkspaceRow[];
    return rows.map(toWorkspace);
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
    this.db.transaction(() => {
      this.db.query("DELETE FROM members WHERE workspace_id = $id").run({ id });
      this.db.query("DELETE FROM links WHERE workspace_id = $id").run({ id });
      this.db.query("DELETE FROM workspaces WHERE id = $id").run({ id });
    })();
  }

  close(): void {
    this.db.close();
  }
}
