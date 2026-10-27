import type { Database } from "bun:sqlite";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import { DAY_MS, LIMITS } from "./limits";
import { hashSecret, LINK_SECRET, newLinkSecret, seal, unseal } from "./tokens";
import type { Person, PersonStatus, Role } from "./types";

export type InviteStatus = "open" | "claimed" | "revoked" | "expired";

/**
 * A link the owner made for one person. Portico finds an invite by its secret's hash, and keeps the secret sealed with
 * the signing key so the owner can copy an open invite's link again.
 */
export interface Invite {
  id: string;
  /** Who the invite is for, as the owner typed it. */
  name: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  revokedAt: string | null;
  status: InviteStatus;
}

/** A claimed invite waiting for the owner: the pending person and who the invite was for. */
export interface Claim {
  personId: string;
  name: string;
  inviteName: string;
  claimedAt: string;
}

interface InviteRow {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  revoked_at: string | null;
}

/** Invites are kept this long past expiry, so an old link still says it expired; then the daily sweep deletes them. */
const INVITE_RETENTION_DAYS = 30;

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
  /** Seals open invites' secrets, so their links can be copied again. */
  signingKey: string;
  now?: () => Date;
  newId?: () => string;
}

const INVITE_SEAL = "invite";

/**
 * The people who use Portico: one owner, and members who joined by invite. Only the owner invites, by name. An invite
 * link works once and lasts 7 days; claiming it creates a pending member, who waits for the owner to approve the claim.
 */
export class People {
  private readonly db: Database;
  private readonly changes: Changes;
  private readonly now: () => Date;
  private readonly newId: () => string;

  private readonly signingKey: string;

  constructor(deps: PeopleDeps) {
    this.db = deps.db;
    this.changes = deps.changes;
    this.signingKey = deps.signingKey;
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

  // ---- invites ----

  /** A new invite for the named person, and its secret, which goes only into the link. Owner only. */
  createInvite(byId: string, rawName: unknown): { invite: Invite; secret: string } {
    this.requireOwner(byId);
    const name = cleanPersonName(rawName);
    const secret = newLinkSecret();
    const at = this.now();
    const row: InviteRow = {
      id: this.newId(),
      name,
      created_by: byId,
      created_at: at.toISOString(),
      expires_at: new Date(at.getTime() + LIMITS.inviteDays * DAY_MS).toISOString(),
      claimed_at: null,
      revoked_at: null,
    };
    this.db
      .query(
        `INSERT INTO invites (id, name, secret_hash, secret_box, created_by, created_at, expires_at)
         VALUES ($id, $name, $hash, $box, $createdBy, $createdAt, $expiresAt)`,
      )
      .run({
        id: row.id,
        name,
        hash: hashSecret(secret),
        box: seal(this.signingKey, INVITE_SEAL, secret),
        createdBy: byId,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      });
    this.changes.emit("people");
    return { invite: this.toInvite(row), secret };
  }

  invite(id: string): Invite | null {
    const row = this.db.query("SELECT * FROM invites WHERE id = $id").get({ id }) as InviteRow | null;
    return row ? this.toInvite(row) : null;
  }

  /** An open invite's secret, for copying its link again. Null once it's claimed, revoked or expired. */
  inviteSecret(id: string): string | null {
    const row = this.db
      .query(
        "SELECT secret_box FROM invites WHERE id = $id AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at > $now",
      )
      .get({ id, now: this.iso() }) as { secret_box: string | null } | null;
    return row?.secret_box ? unseal(this.signingKey, INVITE_SEAL, row.secret_box) : null;
  }

  /** Invites still waiting to be claimed, newest first. */
  openInvites(): Invite[] {
    const rows = this.db
      .query(
        `SELECT * FROM invites WHERE claimed_at IS NULL AND revoked_at IS NULL AND expires_at > $now
         ORDER BY created_at DESC, id DESC`,
      )
      .all({ now: this.iso() }) as InviteRow[];
    return rows.map((row) => this.toInvite(row));
  }

  /** The invite a link's secret belongs to, in any state. It never changes anything, so opening a link uses nothing up. */
  lookupInvite(secret: unknown): Invite {
    const row =
      typeof secret === "string" && LINK_SECRET.test(secret)
        ? (this.db.query("SELECT * FROM invites WHERE secret_hash = $hash").get({ hash: hashSecret(secret) }) as InviteRow | null)
        : null;
    if (!row) throw new PorticoError("not_found", "This invite link isn't valid. Check that the whole link was copied.");
    return this.toInvite(row);
  }

  /** The invite for a link that can still be claimed, or an error saying why it can't be. */
  openInvite(secret: unknown): Invite {
    const invite = this.lookupInvite(secret);
    switch (invite.status) {
      case "claimed":
        throw new PorticoError("wrong_status", "This invite link was already used. Each invite link works once.");
      case "revoked":
        throw new PorticoError("wrong_status", "This invite link was revoked.");
      case "expired":
        throw new PorticoError("wrong_status", `This invite link expired. Invite links last ${LIMITS.inviteDays} days.`);
      case "open":
        return invite;
    }
  }

  /** Revokes an invite that hasn't been claimed. Owner only. Revoking twice changes nothing. */
  revokeInvite(byId: string, inviteId: string): Invite {
    this.requireOwner(byId);
    const invite = this.invite(inviteId);
    if (!invite) throw new PorticoError("not_found", "No such invite.");
    if (invite.status === "revoked") return invite;
    if (invite.status === "claimed") {
      throw new PorticoError(
        "wrong_status",
        `The invite for ${invite.name} was already claimed. Approve or decline the claim instead.`,
      );
    }
    this.db.query("UPDATE invites SET revoked_at = $at WHERE id = $id").run({ id: invite.id, at: this.iso() });
    this.changes.emit("people");
    return this.invite(invite.id)!;
  }

  // ---- claims ----

  /**
   * Claims an open invite: creates a pending member with the chosen name and password, and uses the link up. Both
   * happen together or not at all, so a name in use leaves the link open for another try.
   */
  claim(input: { secret: unknown; name: unknown; passwordHash: string }): Person {
    return this.db.transaction(() => {
      const invite = this.openInvite(input.secret);
      const person = this.create({
        name: cleanPersonName(input.name),
        role: "member",
        status: "pending",
        passwordHash: input.passwordHash,
        inviteId: invite.id,
      });
      this.db.query("UPDATE invites SET claimed_at = $at WHERE id = $id").run({ id: invite.id, at: person.createdAt });
      return person;
    })();
  }

  /** Claims waiting for the owner, oldest first. */
  claims(): Claim[] {
    const rows = this.db
      .query(
        `SELECT p.id, p.name, i.name AS invite_name, COALESCE(i.claimed_at, p.created_at) AS claimed_at
         FROM people p LEFT JOIN invites i ON i.id = p.invite_id
         WHERE p.status = 'pending' ORDER BY p.created_at, p.id`,
      )
      .all() as { id: string; name: string; invite_name: string | null; claimed_at: string }[];
    return rows.map((row) => ({
      personId: row.id,
      name: row.name,
      inviteName: row.invite_name ?? "",
      claimedAt: row.claimed_at,
    }));
  }

  /** Lets a claimed invite's person into Portico. Owner only. */
  approveClaim(byId: string, personId: string): Person {
    this.requireOwner(byId);
    return this.activate(this.requirePending(personId).id);
  }

  /** Turns a claim down: deletes the pending person and leaves the invite revoked. Owner only. */
  declineClaim(byId: string, personId: string): Person {
    this.requireOwner(byId);
    const person = this.requirePending(personId);
    this.db.transaction(() => {
      if (person.inviteId) {
        this.db
          .query("UPDATE invites SET revoked_at = $at WHERE id = $id AND revoked_at IS NULL")
          .run({ id: person.inviteId, at: this.iso() });
      }
      this.remove(person.id);
    })();
    return person;
  }

  /**
   * Removes a member (or a claim) with their agents, computers and sign-ins. Owner only; the owner can't be removed.
   * The caller closes the removed agents' streams and the person's open pages.
   */
  removeMember(byId: string, personId: string): Person {
    this.requireOwner(byId);
    const person = this.require(personId);
    if (person.role === "owner") throw new PorticoError("not_allowed", "The owner of Portico can't be removed.");
    this.remove(person.id);
    return person;
  }

  /** Daily: deletes invites a month past expiry, except one a claim still waits on. Returns how many. */
  sweep(): number {
    const cutoff = new Date(this.now().getTime() - INVITE_RETENTION_DAYS * DAY_MS).toISOString();
    return this.db
      .query(
        `DELETE FROM invites WHERE expires_at <= $cutoff
         AND id NOT IN (SELECT invite_id FROM people WHERE status = 'pending' AND invite_id IS NOT NULL)`,
      )
      .run({ cutoff }).changes;
  }

  private requireOwner(byId: string): Person {
    const person = this.get(byId);
    if (!person || person.role !== "owner" || person.status !== "active") {
      throw new PorticoError("not_allowed", "Only the owner can do this.");
    }
    return person;
  }

  private requirePending(personId: string): Person {
    const person = this.require(personId);
    if (person.status !== "pending") throw new PorticoError("wrong_status", `${person.name} already joined Portico.`);
    return person;
  }

  private toInvite(row: InviteRow): Invite {
    const status: InviteStatus = row.revoked_at
      ? "revoked"
      : row.claimed_at
        ? "claimed"
        : Date.parse(row.expires_at) <= this.now().getTime()
          ? "expired"
          : "open";
    return {
      id: row.id,
      name: row.name,
      createdBy: row.created_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      claimedAt: row.claimed_at,
      revokedAt: row.revoked_at,
      status,
    };
  }

  private iso(): string {
    return this.now().toISOString();
  }
}
