import type { Database } from "bun:sqlite";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import { DAY_MS, LIMITS } from "./limits";
import { cleanEmail } from "./people";
import { hashSecret, LINK_SECRET, newLinkSecret, seal, unseal } from "./tokens";
import type { Agent, Person, Workspace } from "./types";
import type { Workspaces } from "./workspaces";

/** A link that lets one person into a shared workspace. */
export interface Share {
  id: string;
  workspaceId: string;
  createdBy: string;
  /** Set when the link was sent by email: only the person with this address can claim it. */
  email: string | null;
  createdAt: string;
  expiresAt: string;
  /** The person the link turned out to be for: the first to confirm with it. Nobody else can use it afterwards. */
  claimedBy: string | null;
  claimedAt: string | null;
  revokedAt: string | null;
}

interface ShareRow {
  id: string;
  workspace_id: string;
  created_by: string;
  email: string | null;
  created_at: string;
  expires_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  revoked_at: string | null;
}

const toShare = (row: ShareRow): Share => ({
  id: row.id,
  workspaceId: row.workspace_id,
  createdBy: row.created_by,
  email: row.email,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  claimedBy: row.claimed_by,
  claimedAt: row.claimed_at,
  revokedAt: row.revoked_at,
});

const SHARE_SEAL = "share-link";
/** One answer for a link that is unknown, revoked, expired or someone else's, so a link tells a stranger nothing. */
export const DEAD_LINK = "This share link doesn't work. Ask the person who sent the link for a new one.";
/** How long dead links are kept. */
const KEEP_MS = 30 * DAY_MS;

/** The secret in a share link or on its own: the part after `#`, when a whole link was pasted. */
export function shareSecret(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  const secret = text.includes("#") ? text.slice(text.lastIndexOf("#") + 1) : text;
  return LINK_SECRET.test(secret) ? secret : null;
}

export interface SharesDeps {
  db: Database;
  workspaces: Workspaces;
  changes: Changes;
  /** Seals a link's secret, so the person who made the link can copy it again. */
  signingKey: string;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Share links. The only way a person comes into someone else's workspace is a share link, confirmed on the consent
 * page by that person against a code the agent shows (core/consents.ts); `enter` here is the only caller of
 * `workspaces.admit`.
 */
export class Shares {
  private readonly db: Database;
  private readonly workspaces: Workspaces;
  private readonly changes: Changes;
  private readonly signingKey: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: SharesDeps) {
    this.db = deps.db;
    this.workspaces = deps.workspaces;
    this.changes = deps.changes;
    this.signingKey = deps.signingKey;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
    this.workspaces.onPersonRemoved = (workspaceId, personId) => this.personRemoved(workspaceId, personId);
  }

  // ---- links ----

  /**
   * A new link into a shared workspace, made by anyone in it. The secret is returned here and can be read again by
   * the people who may see the link. With an email address, only the person with that address can claim the link.
   */
  create(byId: string, workspaceId: string, input: { email?: unknown } = {}): { share: Share; secret: string } {
    const workspace = this.sharedFor(byId, workspaceId);
    const email = input.email === undefined || input.email === null || input.email === "" ? null : cleanEmail(input.email);
    const secret = newLinkSecret();
    const at = this.now();
    const share: Share = {
      id: this.newId(),
      workspaceId: workspace.id,
      createdBy: byId,
      email,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + LIMITS.shareDays * DAY_MS).toISOString(),
      claimedBy: null,
      claimedAt: null,
      revokedAt: null,
    };
    this.db
      .query(
        `INSERT INTO shares (id, workspace_id, created_by, secret_hash, secret_box, email, created_at, expires_at)
         VALUES ($id, $workspaceId, $createdBy, $hash, $box, $email, $createdAt, $expiresAt)`,
      )
      .run({
        id: share.id,
        workspaceId: share.workspaceId,
        createdBy: share.createdBy,
        hash: hashSecret(secret),
        box: seal(this.signingKey, SHARE_SEAL, secret),
        email,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
      });
    this.log("share_created", { share_id: share.id, workspace_id: workspace.id, emailed: email !== null });
    this.changes.emit("workspaces");
    return { share, secret };
  }

  get(id: string): Share | null {
    const row = this.db.query("SELECT * FROM shares WHERE id = $id").get({ id }) as ShareRow | null;
    return row ? toShare(row) : null;
  }

  /** Whether the link still lets someone in. */
  isOpen(share: Share): boolean {
    return share.revokedAt === null && Date.parse(share.expiresAt) > this.now().getTime();
  }

  /**
   * A person left a workspace or was taken out: every link there that the person made or came in with ends, and so
   * does every request waiting on one. Otherwise the person's old link would let the person straight back in.
   */
  personRemoved(workspaceId: string, personId: string): void {
    const at = this.iso();
    this.db.transaction(() => {
      const ids = (
        this.db
          .query("SELECT id FROM shares WHERE workspace_id = $workspaceId AND revoked_at IS NULL AND (created_by = $personId OR claimed_by = $personId)")
          .all({ workspaceId, personId }) as { id: string }[]
      ).map((row) => row.id);
      for (const id of ids) {
        this.db.query("UPDATE shares SET revoked_at = $at WHERE id = $id").run({ id, at });
        this.db.query("UPDATE consent_requests SET status = 'expired' WHERE share_id = $id AND status = 'pending'").run({ id });
      }
      this.db
        .query("UPDATE consent_requests SET status = 'expired' WHERE workspace_id = $workspaceId AND person_id = $personId AND status = 'pending'")
        .run({ workspaceId, personId });
    })();
    this.changes.emit("approvals", "workspaces");
  }

  /**
   * The workspace's links that still work, as the person may see them: the ones the person made, and every one for
   * the workspace's owner. Oldest first.
   */
  openFor(personId: string, workspaceId: string): Share[] {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !this.workspaces.hasPerson(workspace.id, personId)) return [];
    const rows = this.db
      .query("SELECT * FROM shares WHERE workspace_id = $workspaceId AND revoked_at IS NULL AND expires_at > $now ORDER BY created_at, id")
      .all({ workspaceId, now: this.iso() }) as ShareRow[];
    return rows.map(toShare).filter((share) => share.createdBy === personId || workspace.ownerId === personId);
  }

  /** The link's secret, for the person who made the link or the workspace's owner, while the link works. */
  secretFor(personId: string, shareId: string): string | null {
    const share = this.get(shareId);
    if (!share || !this.isOpen(share)) return null;
    const workspace = this.workspaces.get(share.workspaceId);
    if (!workspace || !this.workspaces.hasPerson(workspace.id, personId)) return null;
    if (share.createdBy !== personId && workspace.ownerId !== personId) return null;
    const row = this.db.query("SELECT secret_box FROM shares WHERE id = $id").get({ id: share.id }) as { secret_box: string };
    return unseal(this.signingKey, SHARE_SEAL, row.secret_box);
  }

  /** Ends a link: the person who made it can, and so can the workspace's owner. Requests waiting on it end too. */
  revoke(byId: string, shareId: string): Share {
    const share = this.get(shareId);
    const workspace = share ? this.workspaces.get(share.workspaceId) : null;
    if (!share || !workspace || !this.workspaces.hasPerson(workspace.id, byId)) throw new PorticoError("not_found", "No such share link.");
    if (share.createdBy !== byId && workspace.ownerId !== byId) {
      throw new PorticoError("not_allowed", `Only the person who made a share link, or the owner of ${workspace.phrase}, can end the link.`);
    }
    const at = this.iso();
    this.db.transaction(() => {
      this.db.query("UPDATE shares SET revoked_at = $at WHERE id = $id AND revoked_at IS NULL").run({ id: share.id, at });
      this.db.query("UPDATE consent_requests SET status = 'expired' WHERE share_id = $id AND status = 'pending'").run({ id: share.id });
    })();
    this.log("share_revoked", { share_id: share.id });
    this.changes.emit("workspaces", "approvals");
    return { ...share, revokedAt: share.revokedAt ?? at };
  }

  /** The working link with this secret. Anything else, whatever the reason, is the same `not_found`. */
  usable(rawSecret: unknown): Share {
    const secret = shareSecret(rawSecret);
    const row = secret ? (this.db.query("SELECT * FROM shares WHERE secret_hash = $hash").get({ hash: hashSecret(secret) }) as ShareRow | null) : null;
    const share = row ? toShare(row) : null;
    if (!share || !this.isOpen(share) || !this.workspaces.get(share.workspaceId)) throw new PorticoError("not_found", DEAD_LINK);
    // A link lets someone in on its maker's word, so the link ends when the maker is no longer in the workspace.
    if (!this.workspaces.hasPerson(share.workspaceId, share.createdBy)) throw new PorticoError("not_found", DEAD_LINK);
    return share;
  }

  /**
   * Whether the link is for this person: unclaimed or claimed by the same person, and, for an emailed link, the
   * address the sign-in service verified for the person. Never says which rule failed.
   */
  mayClaim(share: Share, person: Person): boolean {
    if (share.claimedBy !== null && share.claimedBy !== person.id) return false;
    if (share.email !== null && (person.email === null || person.email.toLowerCase() !== share.email)) return false;
    return true;
  }

  /** Whether the link still lets this person in: open, its maker still in the workspace, and meant for the person. */
  worksFor(share: Share, person: Person): boolean {
    return this.isOpen(share) && this.workspaces.get(share.workspaceId) !== null && this.workspaces.hasPerson(share.workspaceId, share.createdBy) && this.mayClaim(share, person);
  }

  /**
   * The person comes into the link's workspace with one agent, once the person allowed that on the consent page. Claims
   * the link for the person. The one place a person comes into someone else's workspace; call inside a transaction.
   */
  enter(share: Share, person: Person, agent: Agent): Workspace {
    const workspace = this.workspaces.get(share.workspaceId);
    if (!workspace || !this.worksFor(share, person)) throw new PorticoError("not_found", DEAD_LINK);
    if (share.claimedBy === null) {
      this.db.query("UPDATE shares SET claimed_by = $personId, claimed_at = $at WHERE id = $id AND claimed_by IS NULL").run({ id: share.id, personId: person.id, at: this.iso() });
    }
    this.workspaces.admit(workspace.id, person.id);
    this.workspaces.addAgent(person.id, workspace.id, agent.id);
    this.log("share_entered", { share_id: share.id, workspace_id: workspace.id, agent_id: agent.id });
    return workspace;
  }

  // ---- sweeps ----

  /** Daily: links a month past their end. Returns how many. */
  sweep(): number {
    const cutoff = new Date(this.now().getTime() - KEEP_MS).toISOString();
    return this.db.query("DELETE FROM shares WHERE expires_at < $cutoff OR revoked_at < $cutoff").run({ cutoff }).changes;
  }

  // ---- helpers ----

  /** The shared workspace, for a person in it. Personal ones are never shared; a stranger sees `not_found`. */
  sharedFor(personId: string, workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !this.workspaces.hasPerson(workspace.id, personId)) throw new PorticoError("not_found", "No such Portico.");
    if (workspace.kind !== "shared") {
      throw new PorticoError(
        "not_allowed",
        `${workspace.name} holds only the agents of one person: it can't be shared or deleted. Make a new Portico to bring someone else's agents in.`,
      );
    }
    return workspace;
  }

  private iso(): string {
    return this.now().toISOString();
  }
}
