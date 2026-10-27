import type { Database } from "bun:sqlite";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import { hashSecret, newToken } from "./tokens";
import type { Computer } from "./types";
import { slugify } from "./words";

interface ComputerRow {
  id: string;
  owner_id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
}

function toComputer(row: ComputerRow): Computer {
  return { id: row.id, ownerId: row.owner_id, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
}

const MAX_DEDUPE = 99;
/** A computer's last_seen_at is written at most this often. */
const TOUCH_INTERVAL_MS = 60_000;

/** A joining computer's proposed name (usually its hostname) as a computer name: slugged, without `.local`. */
export function computerSlug(raw: string): string {
  return slugify(raw.trim().replace(/\.local$/i, ""), "computer");
}

export interface ComputersDeps {
  db: Database;
  changes: Changes;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Computers that joined, and their folders' "Join from the folder" switches. The Onboarding track adds join lines and
 * app agents' sign-in requests here.
 */
export class Computers {
  private readonly db: Database;
  private readonly changes: Changes;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  private readonly touchedAt = new Map<string, number>();

  constructor(deps: ComputersDeps) {
    this.db = deps.db;
    this.changes = deps.changes;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
  }

  /** Adds a computer for the owner under the first free form of the proposed name. The token is returned only here. */
  create(ownerId: string, proposedName: string): { computer: Computer; token: string } {
    const token = newToken("pc_");
    const computer: Computer = {
      id: this.newId(),
      ownerId,
      name: this.freeName(computerSlug(proposedName)),
      createdAt: this.iso(),
      lastSeenAt: null,
    };
    this.db
      .query(
        `INSERT INTO computers (id, owner_id, name, token_hash, created_at, last_seen_at)
         VALUES ($id, $ownerId, $name, $tokenHash, $createdAt, NULL)`,
      )
      .run({ id: computer.id, ownerId, name: computer.name, tokenHash: hashSecret(token), createdAt: computer.createdAt });
    this.log("computer_added", { computer: computer.name });
    this.changes.emit("computers", "agents");
    return { computer, token };
  }

  /** The computer this token belongs to. Marks it seen, at most once a minute. */
  byToken(token: string): Computer | null {
    const row = this.db
      .query("SELECT * FROM computers WHERE token_hash = $hash")
      .get({ hash: hashSecret(token) }) as ComputerRow | null;
    if (!row) return null;
    const at = this.now().getTime();
    const last = this.touchedAt.get(row.id);
    if (last === undefined || at - last >= TOUCH_INTERVAL_MS) {
      this.touchedAt.set(row.id, at);
      this.db.query("UPDATE computers SET last_seen_at = $at WHERE id = $id").run({ id: row.id, at: new Date(at).toISOString() });
    }
    return toComputer(row);
  }

  get(id: string): Computer | null {
    const row = this.db.query("SELECT * FROM computers WHERE id = $id").get({ id }) as ComputerRow | null;
    return row ? toComputer(row) : null;
  }

  byName(name: string): Computer | null {
    const row = this.db.query("SELECT * FROM computers WHERE name = $name").get({ name }) as ComputerRow | null;
    return row ? toComputer(row) : null;
  }

  /** By name. With an owner, only that person's computers. */
  list(ownerId?: string): Computer[] {
    const rows = ownerId
      ? this.db.query("SELECT * FROM computers WHERE owner_id = $ownerId ORDER BY name").all({ ownerId })
      : this.db.query("SELECT * FROM computers ORDER BY name").all();
    return (rows as ComputerRow[]).map(toComputer);
  }

  /**
   * Deletes the computer and, by cascade, its sessions and folders, so its token fails at once. Returns the IDs of the
   * sessions it had, so their streams can be closed.
   */
  remove(id: string): string[] {
    return this.db.transaction(() => {
      const sessions = (this.db.query("SELECT id FROM agents WHERE computer_id = $id").all({ id }) as { id: string }[]).map(
        (row) => row.id,
      );
      const removed = this.db.query("DELETE FROM computers WHERE id = $id").run({ id }).changes;
      if (removed > 0) {
        this.log("computer_removed", { computer_id: id, sessions: sessions.length });
        this.changes.emit("computers", "agents", "threads", "approvals");
      }
      return sessions;
    })();
  }

  /** The folder's switch: true on, false off, null when never set (on). */
  folderJoins(computerId: string, folderId: string): boolean | null {
    const row = this.db
      .query("SELECT joins FROM folders WHERE computer_id = $computerId AND folder_id = $folderId")
      .get({ computerId, folderId }) as { joins: number } | null;
    return row ? row.joins === 1 : null;
  }

  setFolder(computerId: string, folderId: string, name: string, joins: boolean): void {
    this.db
      .query(
        `INSERT INTO folders (computer_id, folder_id, name, joins, updated_at)
         VALUES ($computerId, $folderId, $name, $joins, $at)
         ON CONFLICT (computer_id, folder_id) DO UPDATE SET name = $name, joins = $joins, updated_at = $at`,
      )
      .run({ computerId, folderId, name, joins: joins ? 1 : 0, at: this.iso() });
    this.changes.emit("agents", "computers");
  }

  /** The Onboarding track's minute sweep (expired sign-in requests) goes here. */
  sweepMinute(): void {}

  /** The Onboarding track's daily cleanup (old join lines, OAuth codes) goes here. */
  sweep(): void {}

  private iso(): string {
    return this.now().toISOString();
  }

  /** The base name, or the first free `<base>-2` … `<base>-99`. */
  private freeName(base: string): string {
    let name = base;
    for (let n = 2; this.byName(name); n++) {
      if (n > MAX_DEDUPE) throw new PorticoError("rate_limited", `Too many computers named ${base}. Remove some first.`);
      name = `${base}-${n}`;
    }
    return name;
  }
}
