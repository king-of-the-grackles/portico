import type { Database } from "bun:sqlite";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import type { Person, PersonStatus, Role } from "./types";

interface PersonRow {
  id: string;
  name: string;
  role: string;
  status: string;
  password_hash: string;
  invite_id: string | null;
  created_at: string;
  approved_at: string | null;
}

function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    role: row.role as Role,
    status: row.status as PersonStatus,
    inviteId: row.invite_id,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

const MAX_PERSON_NAME = 60;

/** A person's name as typed: trimmed, on one line, 1 to 60 characters. */
export function cleanPersonName(value: unknown): string {
  if (typeof value !== "string") throw new PorticoError("bad_request", "name must be a string.");
  const name = value.replace(/\s+/g, " ").trim();
  if (name === "" || /[\u0000-\u001f\u007f]/.test(name)) throw new PorticoError("bad_request", "Enter a name.");
  if (Array.from(name).length > MAX_PERSON_NAME) {
    throw new PorticoError("bad_request", `A name can be at most ${MAX_PERSON_NAME} characters.`);
  }
  return name;
}

export interface PeopleDeps {
  db: Database;
  changes: Changes;
  now?: () => Date;
  newId?: () => string;
}

/**
 * The people who use Portico: one owner, and members who joined by invite. The People track adds invites and claims
 * here.
 */
export class People {
  private readonly db: Database;
  private readonly changes: Changes;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: PeopleDeps) {
    this.db = deps.db;
    this.changes = deps.changes;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** Throws `conflict` when the name is taken by anyone, in any letter case. */
  create(input: { name: string; role: Role; status: PersonStatus; passwordHash: string; inviteId?: string | null }): Person {
    const name = cleanPersonName(input.name);
    if (this.byName(name)) throw new PorticoError("conflict", `The name ${name} is already in use.`);
    if (input.role === "owner" && this.owner()) throw new PorticoError("conflict", "Portico already has an owner.");
    const at = this.iso();
    const person: Person = {
      id: this.newId(),
      name,
      role: input.role,
      status: input.status,
      inviteId: input.inviteId ?? null,
      createdAt: at,
      approvedAt: input.status === "active" ? at : null,
    };
    this.db
      .query(
        `INSERT INTO people (id, name, role, status, password_hash, invite_id, created_at, approved_at)
         VALUES ($id, $name, $role, $status, $passwordHash, $inviteId, $createdAt, $approvedAt)`,
      )
      .run({ ...person, passwordHash: input.passwordHash });
    this.changes.emit("people");
    return person;
  }

  get(id: string): Person | null {
    const row = this.db.query("SELECT * FROM people WHERE id = $id").get({ id }) as PersonRow | null;
    return row ? toPerson(row) : null;
  }

  byName(name: string): Person | null {
    const row = this.db.query("SELECT * FROM people WHERE name = $name").get({ name: name.trim() }) as PersonRow | null;
    return row ? toPerson(row) : null;
  }

  owner(): Person | null {
    const row = this.db.query("SELECT * FROM people WHERE role = 'owner'").get() as PersonRow | null;
    return row ? toPerson(row) : null;
  }

  /** The owner first, then members by name. */
  list(): Person[] {
    const rows = this.db
      .query("SELECT * FROM people ORDER BY role = 'owner' DESC, name COLLATE NOCASE")
      .all() as PersonRow[];
    return rows.map(toPerson);
  }

  passwordHash(id: string): string | null {
    const row = this.db.query("SELECT password_hash FROM people WHERE id = $id").get({ id }) as {
      password_hash: string;
    } | null;
    return row?.password_hash ?? null;
  }

  rename(id: string, raw: string): Person {
    const name = cleanPersonName(raw);
    const taken = this.byName(name);
    if (taken && taken.id !== id) throw new PorticoError("conflict", `The name ${name} is already in use.`);
    this.db.query("UPDATE people SET name = $name WHERE id = $id").run({ id, name });
    this.changes.emit("people", "agents", "me");
    return this.require(id);
  }

  setPasswordHash(id: string, passwordHash: string): void {
    this.db.query("UPDATE people SET password_hash = $passwordHash WHERE id = $id").run({ id, passwordHash });
  }

  activate(id: string): Person {
    this.db.query("UPDATE people SET status = 'active', approved_at = $at WHERE id = $id").run({ id, at: this.iso() });
    this.changes.emit("people", "me");
    return this.require(id);
  }

  /** Deletes the person and, by cascade, their sign-ins, computers and agents. */
  remove(id: string): void {
    this.db.query("DELETE FROM people WHERE id = $id").run({ id });
    this.changes.emit("people", "agents", "threads", "approvals", "computers");
  }

  require(id: string): Person {
    const person = this.get(id);
    if (!person) throw new PorticoError("not_found", "No such person.");
    return person;
  }

  /** The People track's daily cleanup (expired invites) goes here. */
  sweep(): void {}

  private iso(): string {
    return this.now().toISOString();
  }
}
