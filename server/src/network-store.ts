import type { Database } from "bun:sqlite";
import { addressOf } from "./core/directory";
import type { Assistant, AssistantKind, JoinCode, Machine, SessionRecord } from "./core/types";

interface MachineRow {
  id: string;
  owner: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
}

/** A sessions row with its machine's name joined in. */
interface SessionRow {
  id: string;
  owner: string;
  machine_id: string;
  machine: string;
  name: string;
  key: string;
  folder: string;
  folder_id: string;
  created_at: string;
  last_seen_at: string;
}

interface AssistantRow {
  id: string;
  owner: string;
  name: string;
  kind: string;
  description: string;
  token_hash: string;
  created_at: string;
}

interface JoinCodeRow {
  id: string;
  owner: string;
  code_hash: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

type Bindings = Record<string, string | number | null>;

function toMachine(row: MachineRow): Machine {
  return { id: row.id, owner: row.owner, name: row.name, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    owner: row.owner,
    machineId: row.machine_id,
    machine: row.machine,
    name: row.name,
    key: row.key,
    folder: row.folder,
    folderId: row.folder_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toAssistant(row: AssistantRow): Assistant {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    kind: row.kind as AssistantKind,
    description: row.description,
    createdAt: row.created_at,
  };
}

function toJoinCode(row: JoinCodeRow): JoinCode {
  return { id: row.id, owner: row.owner, createdAt: row.created_at, expiresAt: row.expires_at, usedAt: row.used_at };
}

const SESSION_SELECT = "SELECT s.*, m.name AS machine FROM sessions s JOIN machines m ON m.id = s.machine_id";

export type SessionChanges = Partial<Pick<SessionRecord, "key" | "folder" | "lastSeenAt">>;

const SESSION_CHANGE_COLUMNS: Record<keyof SessionChanges, string> = {
  key: "key",
  folder: "folder",
  lastSeenAt: "last_seen_at",
};

/** Machines, sessions, assistants and join codes. Tokens and codes are stored only as hashes. */
export class NetworkStore {
  constructor(private readonly db: Database) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- machines ----

  insertMachine(machine: Machine, tokenHash: string): void {
    this.db
      .query(
        `INSERT INTO machines (id, owner, name, token_hash, created_at, last_seen_at)
         VALUES ($id, $owner, $name, $tokenHash, $createdAt, $lastSeenAt)`,
      )
      .run({
        id: machine.id,
        owner: machine.owner,
        name: machine.name,
        tokenHash,
        createdAt: machine.createdAt,
        lastSeenAt: machine.lastSeenAt,
      });
  }

  machineByTokenHash(hash: string): Machine | null {
    const row = this.db.query("SELECT * FROM machines WHERE token_hash = $hash").get({ hash }) as MachineRow | null;
    return row ? toMachine(row) : null;
  }

  machineByName(name: string): Machine | null {
    const row = this.db.query("SELECT * FROM machines WHERE name = $name").get({ name }) as MachineRow | null;
    return row ? toMachine(row) : null;
  }

  /** By name, each with its number of stored sessions. */
  listMachines(): (Machine & { sessions: number })[] {
    const rows = this.db
      .query(
        `SELECT m.*, (SELECT COUNT(*) FROM sessions s WHERE s.machine_id = m.id) AS sessions
         FROM machines m ORDER BY m.name`,
      )
      .all() as (MachineRow & { sessions: number })[];
    return rows.map((row) => ({ ...toMachine(row), sessions: row.sessions }));
  }

  touchMachine(id: string, at: string): void {
    this.db.query("UPDATE machines SET last_seen_at = $at WHERE id = $id").run({ id, at });
  }

  /** Deletes the machine and, by cascade, its sessions. Returns the sessions it had. */
  deleteMachine(id: string): SessionRecord[] {
    return this.transaction(() => {
      const sessions = this.sessionsOnMachine(id);
      this.db.query("DELETE FROM machines WHERE id = $id").run({ id });
      return sessions;
    });
  }

  // ---- sessions ----

  /** `session.machine` is ignored: the machine's name is joined in on read. */
  insertSession(session: SessionRecord): void {
    this.db
      .query(
        `INSERT INTO sessions (id, owner, machine_id, name, key, folder, folder_id, created_at, last_seen_at)
         VALUES ($id, $owner, $machineId, $name, $key, $folder, $folderId, $createdAt, $lastSeenAt)`,
      )
      .run({
        id: session.id,
        owner: session.owner,
        machineId: session.machineId,
        name: session.name,
        key: session.key,
        folder: session.folder,
        folderId: session.folderId,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
      });
  }

  private sessionById(id: string): SessionRecord | null {
    const row = this.db.query(`${SESSION_SELECT} WHERE s.id = $id`).get({ id }) as SessionRow | null;
    return row ? toSession(row) : null;
  }

  sessionByKey(machineId: string, key: string): SessionRecord | null {
    const row = this.db
      .query(`${SESSION_SELECT} WHERE s.machine_id = $machineId AND s.key = $key`)
      .get({ machineId, key }) as SessionRow | null;
    return row ? toSession(row) : null;
  }

  sessionByAddress(name: string, machine: string): SessionRecord | null {
    const row = this.db
      .query(`${SESSION_SELECT} WHERE s.name = $name AND m.name = $machine`)
      .get({ name, machine }) as SessionRow | null;
    return row ? toSession(row) : null;
  }

  /** Every stored session with this name, on any machine, by machine name. */
  sessionsNamed(name: string): SessionRecord[] {
    const rows = this.db.query(`${SESSION_SELECT} WHERE s.name = $name ORDER BY m.name`).all({ name }) as SessionRow[];
    return rows.map(toSession);
  }

  /** By name. */
  sessionsOnMachine(machineId: string): SessionRecord[] {
    const rows = this.db
      .query(`${SESSION_SELECT} WHERE s.machine_id = $machineId ORDER BY s.name`)
      .all({ machineId }) as SessionRow[];
    return rows.map(toSession);
  }

  /** By name, then machine. With `seenSince`, only sessions seen at or after it. */
  listSessions(seenSince?: string): SessionRecord[] {
    const where = seenSince === undefined ? "" : "WHERE s.last_seen_at >= $seenSince";
    const bindings: Bindings = seenSince === undefined ? {} : { seenSince };
    const rows = this.db.query(`${SESSION_SELECT} ${where} ORDER BY s.name, m.name`).all(bindings) as SessionRow[];
    return rows.map(toSession);
  }

  updateSession(id: string, changes: SessionChanges): SessionRecord {
    // Skip undefined values: an optional field left out must not clear the column.
    const keys = (Object.keys(changes) as (keyof SessionChanges)[]).filter((key) => changes[key] !== undefined);
    if (keys.length > 0) {
      const assignments = keys.map((key) => `${SESSION_CHANGE_COLUMNS[key]} = $${key}`).join(", ");
      const bindings: Bindings = { id };
      for (const key of keys) bindings[key] = changes[key] ?? null;
      this.db.query(`UPDATE sessions SET ${assignments} WHERE id = $id`).run(bindings);
    }
    const session = this.sessionById(id);
    if (!session) throw new Error(`session ${id} not found`);
    return session;
  }

  /** Writes the session's last_seen_at. False, and nothing written, when no row has this ID. */
  touchSession(id: string, at: string): boolean {
    return this.db.query("UPDATE sessions SET last_seen_at = $at WHERE id = $id").run({ id, at }).changes === 1;
  }

  /** Deletes sessions last seen before the cutoff, except those whose address `keep` accepts. Returns how many. */
  deleteSessionsSeenBefore(cutoff: string, keep: (address: string) => boolean): number {
    return this.transaction(() => {
      const stale = this.db
        .query(`${SESSION_SELECT} WHERE s.last_seen_at < $cutoff`)
        .all({ cutoff }) as SessionRow[];
      const remove = this.db.query("DELETE FROM sessions WHERE id = $id");
      let deleted = 0;
      for (const row of stale) {
        if (keep(addressOf(row.name, row.machine))) continue;
        deleted += remove.run({ id: row.id }).changes;
      }
      return deleted;
    });
  }

  // ---- assistants ----

  insertAssistant(assistant: Assistant, tokenHash: string): void {
    this.db
      .query(
        `INSERT INTO assistants (id, owner, name, kind, description, token_hash, created_at)
         VALUES ($id, $owner, $name, $kind, $description, $tokenHash, $createdAt)`,
      )
      .run({
        id: assistant.id,
        owner: assistant.owner,
        name: assistant.name,
        kind: assistant.kind,
        description: assistant.description,
        tokenHash,
        createdAt: assistant.createdAt,
      });
  }

  assistantByTokenHash(hash: string): Assistant | null {
    const row = this.db.query("SELECT * FROM assistants WHERE token_hash = $hash").get({ hash }) as AssistantRow | null;
    return row ? toAssistant(row) : null;
  }

  assistantByName(name: string): Assistant | null {
    const row = this.db.query("SELECT * FROM assistants WHERE name = $name").get({ name }) as AssistantRow | null;
    return row ? toAssistant(row) : null;
  }

  /** By name. */
  listAssistants(): Assistant[] {
    return (this.db.query("SELECT * FROM assistants ORDER BY name").all() as AssistantRow[]).map(toAssistant);
  }

  deleteAssistant(id: string): void {
    this.db.query("DELETE FROM assistants WHERE id = $id").run({ id });
  }

  // ---- join codes ----

  insertJoinCode(code: JoinCode, codeHash: string): void {
    this.db
      .query(
        `INSERT INTO join_codes (id, owner, code_hash, created_at, expires_at, used_at)
         VALUES ($id, $owner, $codeHash, $createdAt, $expiresAt, $usedAt)`,
      )
      .run({
        id: code.id,
        owner: code.owner,
        codeHash,
        createdAt: code.createdAt,
        expiresAt: code.expiresAt,
        usedAt: code.usedAt,
      });
  }

  joinCodeByHash(hash: string): JoinCode | null {
    const row = this.db.query("SELECT * FROM join_codes WHERE code_hash = $hash").get({ hash }) as JoinCodeRow | null;
    return row ? toJoinCode(row) : null;
  }

  /** True when this call used the code. Guarded by used_at IS NULL, so two racing redemptions can't both win. */
  markJoinCodeUsed(id: string, at: string): boolean {
    return this.db.query("UPDATE join_codes SET used_at = $at WHERE id = $id AND used_at IS NULL").run({ id, at })
      .changes === 1;
  }

  /** Deletes codes that expired, or were used, before the cutoff. Returns how many. */
  deleteJoinCodesBefore(cutoff: string): number {
    return this.db
      .query("DELETE FROM join_codes WHERE expires_at < $cutoff OR (used_at IS NOT NULL AND used_at < $cutoff)")
      .run({ cutoff }).changes;
  }
}
