import type { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";
import type { Activity } from "./activity";
import type { Changes } from "./changes";
import type { Content } from "./content";
import { PorticoError } from "./errors";
import { isReservedName, nameKey } from "./names";
import { HOUR_MS } from "./limits";
import { hashSecret, newToken } from "./tokens";
import type { AgentKind, Computer } from "./types";
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

/** Coding agents on a computer: the computer joins, then each session registers itself. */
export const COMPUTER_KINDS: readonly AgentKind[] = ["claude-code", "codex"];
/** App agents, which join over the HTTP API. */
export const APP_KINDS: readonly AgentKind[] = ["muse", "grok-bot", "dots", "claude-duet", "other"];
/** Kinds an MCP connector can be, signing in with OAuth from the server address. */
export const CONNECTOR_KINDS: readonly AgentKind[] = ["dots", "claude-duet", "other"];

const MAX_DEDUPE = 99;
/** A computer's last_seen_at is written at most this often. */
const TOUCH_INTERVAL_MS = 60_000;
/** Registered OAuth clients with no tokens and no codes are deleted after this: registration is open to anyone. */
const UNUSED_CLIENT_MS = HOUR_MS;
/** A joining computer's proposed name (usually its hostname) as a computer name: slugged, without `.local`. */
export function computerSlug(raw: string): string {
  return slugify(raw.trim().replace(/\.local$/i, ""), "computer");
}

/** Four digits from a secure random source, leading zeros kept. */
export function signInCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, "0");
}

export interface ComputersDeps {
  db: Database;
  changes: Changes;
  activity?: Activity;
  /** Each workspace's own database: the threads of a removed computer's sessions are deleted there. */
  content: Content;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Computers that joined, and their folders' "Join from the folder" switches. A computer comes to exist when a person
 * allows its join on the consent page (core/consents.ts).
 */
export class Computers {
  private readonly db: Database;
  private readonly changes: Changes;
  private readonly activity: Activity | undefined;
  private readonly content: Content;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  private readonly touchedAt = new Map<string, number>();

  constructor(deps: ComputersDeps) {
    this.db = deps.db;
    this.changes = deps.changes;
    this.activity = deps.activity;
    this.content = deps.content;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
  }

  // ---- computers ----

  /** Adds a computer for the owner under the first free form of the proposed name. The token is returned only here. */
  create(ownerId: string, proposedName: string): { computer: Computer; token: string } {
    const token = newToken("pc_");
    const computer: Computer = {
      id: this.newId(),
      ownerId,
      name: this.freeName(computerSlug(proposedName), ownerId),
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
    this.activity?.record("computer_joined", { personId: ownerId, detail: { computer: computer.name } });
    this.changes.about({ people: [ownerId] }, "computers", "agents");
    return { computer, token };
  }

  /** Set by portico.ts, and called where a person allowed a computer's join: the person is told at once. */
  onJoined: ((computer: Computer) => void) | null = null;

  /** A new token for the computer, returned only here. The one before stops working. */
  issueToken(id: string): string {
    const token = newToken("pc_");
    this.db.query("UPDATE computers SET token_hash = $hash WHERE id = $id").run({ id, hash: hashSecret(token) });
    return token;
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

  /** By name. With an owner, only that person's computers. */
  list(ownerId?: string): Computer[] {
    const rows = ownerId
      ? this.db.query("SELECT * FROM computers WHERE owner_id = $ownerId ORDER BY name").all({ ownerId })
      : this.db.query("SELECT * FROM computers ORDER BY name").all();
    return (rows as ComputerRow[]).map(toComputer);
  }

  /**
   * Deletes the computer and, by cascade, its sessions and folders, so its token fails at once. Once the directory
   * rows are gone, the sessions' threads and messages are deleted in each workspace the sessions were in. Returns the
   * IDs of the sessions it had, so their streams can be closed.
   */
  remove(id: string): string[] {
    const ownerId = this.get(id)?.ownerId;
    const sessions = (this.db.query("SELECT id FROM agents WHERE computer_id = $id").all({ id }) as { id: string }[]).map((row) => row.id);
    const clearContent = this.content.gather(sessions);
    const removed = this.db.query("DELETE FROM computers WHERE id = $id").run({ id }).changes;
    if (removed === 0) return sessions;
    clearContent();
    this.log("computer_removed", { computer_id: id, sessions: sessions.length });
    this.changes.about({ people: [ownerId] }, "computers", "agents", "threads", "approvals");
    return sessions;
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
    this.changes.about({ people: [this.get(computerId)?.ownerId] }, "agents", "computers");
  }

  // ---- sweeps ----

  /** Minute cleanup: registered OAuth clients that got no code or token within the hour. Returns how many. */
  sweepUnusedClients(): number {
    return this.db
      .query(
        `DELETE FROM oauth_clients WHERE created_at < $cutoff
           AND client_id NOT IN (SELECT client_id FROM agent_tokens WHERE client_id IS NOT NULL)
           AND client_id NOT IN (SELECT client_id FROM oauth_codes)`,
      )
      .run({ cutoff: this.iso(-UNUSED_CLIENT_MS) }).changes;
  }

  /** Daily cleanup: expired OAuth codes and connector tokens. */
  sweep(): { oauthCodes: number; tokens: number } {
    const now = this.iso();
    return this.db.transaction(() => {
      const oauthCodes = this.db.query("DELETE FROM oauth_codes WHERE expires_at < $now").run({ now }).changes;
      const tokens = this.db
        .query("DELETE FROM agent_tokens WHERE expires_at IS NOT NULL AND expires_at < $now")
        .run({ now }).changes;
      return { oauthCodes, tokens };
    })();
  }

  // ---- helpers ----

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  /** The base name, or the first free `<base>-2` … `<base>-99`. A name is unique among its owner's computers. */
  /**
   * The first free form of the name among the owner's computers. A name that only reads like another computer's
   * (look-alike characters folded, as for handles) counts as taken, and a reserved word gets `-computer` added.
   */
  private freeName(proposed: string, ownerId: string): string {
    const base = isReservedName(proposed) ? `${proposed}-computer` : proposed;
    const keys = new Set((this.db.query("SELECT name FROM computers WHERE owner_id = $ownerId").all({ ownerId }) as { name: string }[]).map((row) => nameKey(row.name)));
    const taken = (name: string) => keys.has(nameKey(name));
    let name = base;
    for (let n = 2; taken(name); n++) {
      if (n > MAX_DEDUPE) throw new PorticoError("rate_limited", `Too many computers named ${base}. Remove some first.`);
      name = `${base}-${n}`;
    }
    return name;
  }
}
