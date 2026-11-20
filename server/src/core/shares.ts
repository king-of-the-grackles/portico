import type { Database } from "bun:sqlite";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import { DAY_MS, LIMITS } from "./limits";
import { cleanEmail } from "./people";
import type { SecretPlace, Secrets } from "./secrets";
import { hashSecret, LINK_SECRET, newLinkSecret } from "./tokens";
import type { Agent, AgentsPolicy, Person, Workspace } from "./types";
import { cleanAgentsPolicy, type Workspaces } from "./workspaces";

/** A link that lets one person into a shared workspace, once. */
export interface Share {
  id: string;
  workspaceId: string;
  createdBy: string;
  /** Set when the link was sent by email: only the person with this address can claim it. */
  email: string | null;
  /**
   * The owner's choice for the person the link lets in: `self`, that person adds more of their own agents alone;
   * `ask`, each one waits for the owner's Allow.
   */
  agentsPolicy: AgentsPolicy;
  createdAt: string;
  expiresAt: string;
  /** The person who came in with the link. The link is used up then: it lets nobody in again, that person included. */
  claimedBy: string | null;
  claimedAt: string | null;
  revokedAt: string | null;
  /**
   * The link's maker chose, when making it, to allow messages from the agents of the person the link lets in: no
   * first-contact question for that one person. Only the maker's own choice on Portico's page sets this.
   */
  allowsBack: boolean;
}

interface ShareRow {
  id: string;
  workspace_id: string;
  created_by: string;
  email: string | null;
  agents_policy: AgentsPolicy;
  created_at: string;
  expires_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  revoked_at: string | null;
  allow_back: number;
}

const toShare = (row: ShareRow): Share => ({
  id: row.id,
  workspaceId: row.workspace_id,
  createdBy: row.created_by,
  email: row.email,
  agentsPolicy: row.agents_policy,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  claimedBy: row.claimed_by,
  claimedAt: row.claimed_at,
  revokedAt: row.revoked_at,
  allowsBack: row.allow_back === 1,
});

/** What links' secrets were sealed as, with the signing key, before the secrets key: read only by the start's pass over old rows. */
export const SHARE_SEAL = "share-link";
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
  /** Encrypts each link's secret, so the link can be shown again to the person who made it. */
  secrets: Secrets;
  /**
   * Whether a link can be for one address only: true where signing in gives each person a verified address. With
   * Portico's own accounts nobody has one, so a link bound to an address could never be used.
   */
  bindsEmail?: boolean;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Share links. The only way a person comes into someone else's workspace is a share link, confirmed on the consent
 * page by that person, signed in (core/consents.ts); `enter` here is the only caller of
 * `workspaces.admit`.
 */
/** What a person already in the workspace hears when a share link is used again for one more agent. */
export const IN_ALREADY = (phrase: string) => `The person who manages this agent is already in ${phrase}, and a share link only brings a new person in. To put an agent there, use add_to_portico.`;

export class Shares {
  private readonly db: Database;
  private readonly workspaces: Workspaces;
  private readonly changes: Changes;
  private readonly secrets: Secrets;
  readonly bindsEmail: boolean;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: SharesDeps) {
    this.db = deps.db;
    this.workspaces = deps.workspaces;
    this.changes = deps.changes;
    this.secrets = deps.secrets;
    this.bindsEmail = deps.bindsEmail ?? true;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
    this.workspaces.onPersonRemoved = (workspaceId, personId) => this.personRemoved(workspaceId, personId);
  }

  /**
   * The address a new link is for, or null: checked as typed, and kept only where a link can be bound to one. Elsewhere
   * the address is left out, and the link is for whoever uses it first, once.
   */
  emailFor(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === "") return null;
    const email = cleanEmail(raw);
    return this.bindsEmail ? email : null;
  }

  // ---- links ----

  /**
   * A new link into a shared workspace. Only the workspace's owner makes one: nobody else brings a new person in. The
   * secret is returned here and the owner can read it again. With an email address, only the person with that address
   * can claim the link. `agents` is the owner's choice for the person coming in: `self` (the default) or `ask`.
   */
  create(byId: string, workspaceId: string, input: { email?: unknown; agents?: unknown; allow?: unknown } = {}): { share: Share; secret: string } {
    const workspace = this.sharedFor(byId, workspaceId);
    if (workspace.ownerId !== byId) {
      throw new PorticoError("not_allowed", `Only the owner of ${workspace.phrase} can share that Portico: the owner decides who comes in.`);
    }
    const email = this.emailFor(input.email);
    const agentsPolicy = cleanAgentsPolicy(input.agents);
    const secret = newLinkSecret();
    const at = this.now();
    const share: Share = {
      id: this.newId(),
      workspaceId: workspace.id,
      createdBy: byId,
      email,
      agentsPolicy,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + LIMITS.shareDays * DAY_MS).toISOString(),
      claimedBy: null,
      claimedAt: null,
      revokedAt: null,
      allowsBack: input.allow === true,
    };
    this.db
      .query(
        `INSERT INTO shares (id, workspace_id, created_by, secret_hash, secret_box, email, agents_policy, created_at, expires_at, allow_back)
         VALUES ($id, $workspaceId, $createdBy, $hash, $box, $email, $agentsPolicy, $createdAt, $expiresAt, $allowBack)`,
      )
      .run({
        id: share.id,
        workspaceId: share.workspaceId,
        createdBy: share.createdBy,
        hash: hashSecret(secret),
        box: this.secrets.sealSync(Shares.place(share.id), secret),
        email,
        agentsPolicy,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        allowBack: share.allowsBack ? 1 : 0,
      });
    this.log("share_created", { share_id: share.id, workspace_id: workspace.id, emailed: email !== null });
    this.changes.about({ workspaces: [workspace.id] }, "workspaces");
    this.onShared?.(share, workspace);
    return { share, secret };
  }

  get(id: string): Share | null {
    const row = this.db.query("SELECT * FROM shares WHERE id = $id").get({ id }) as ShareRow | null;
    return row ? toShare(row) : null;
  }

  /** Whether the link still lets someone in: not ended, not run out, and not used yet. A link works once. */
  isOpen(share: Share): boolean {
    return share.revokedAt === null && share.claimedBy === null && Date.parse(share.expiresAt) > this.now().getTime();
  }

  /** Set by portico.ts: a link was made, or ended, for the workspace's record. */
  onShared: ((share: Share, workspace: Workspace) => void) | null = null;
  onEnded: ((share: Share, workspace: Workspace, byId: string) => void) | null = null;
  /** Set by portico.ts: the first person takes messages from the second person's agents with no first-contact question. */
  allowPeople?: (personId: string, senderPersonId: string) => void;
  /** Set by portico.ts: a person came in with a link, with these agents. The link's maker is told who. */
  onEntered: ((share: Share, workspace: Workspace, person: Person, agents: Agent[]) => void) | null = null;

  /**
   * The workspace a link already let this person into, when the secret is that link's and the person is still there.
   * Only the person who used a link learns that it was used: anyone else gets the one answer for every dead link.
   */
  usedBy(rawSecret: unknown, personId: string): Workspace | null {
    const secret = shareSecret(rawSecret);
    const row = secret ? (this.db.query("SELECT * FROM shares WHERE secret_hash = $hash").get({ hash: hashSecret(secret) }) as ShareRow | null) : null;
    if (!row || row.claimed_by !== personId || !this.workspaces.hasPerson(row.workspace_id, personId)) return null;
    return this.workspaces.get(row.workspace_id);
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
    this.changes.about({ people: [personId], workspaces: [workspaceId] }, "approvals", "workspaces");
  }

  /**
   * The workspace's links that still work, as the person may see them: the ones the person made, and every one for
   * the workspace's owner. Oldest first.
   */
  openFor(personId: string, workspaceId: string): Share[] {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || !this.workspaces.hasPerson(workspace.id, personId)) return [];
    const rows = this.db
      .query("SELECT * FROM shares WHERE workspace_id = $workspaceId AND revoked_at IS NULL AND claimed_by IS NULL AND expires_at > $now ORDER BY created_at, id")
      .all({ workspaceId, now: this.iso() }) as ShareRow[];
    return rows.map(toShare).filter((share) => share.createdBy === personId || workspace.ownerId === personId);
  }

  /** Where a link's secret is stored: what its encrypted form is bound to. */
  static place(shareId: string): SecretPlace {
    return { table: "shares", column: "secret_box", row: shareId };
  }

  /**
   * The link's secret, for the person who made the link or the workspace's owner, while the link works. Null too for
   * one Portico can't read any more (another secrets key): that link can't be shown again, only ended and replaced.
   */
  secretFor(personId: string, shareId: string): string | null {
    const share = this.get(shareId);
    if (!share || !this.isOpen(share)) return null;
    const workspace = this.workspaces.get(share.workspaceId);
    if (!workspace || !this.workspaces.hasPerson(workspace.id, personId)) return null;
    if (share.createdBy !== personId && workspace.ownerId !== personId) return null;
    const row = this.db.query("SELECT secret_box FROM shares WHERE id = $id").get({ id: share.id }) as { secret_box: string };
    const opened = this.secrets.openSync(Shares.place(share.id), row.secret_box);
    return opened.ok ? opened.value : null;
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
    this.changes.about({ workspaces: [workspace.id] }, "workspaces", "approvals");
    if (share.revokedAt === null) this.onEnded?.(share, workspace, byId);
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
   * The person comes into the link's workspace with the agents the person picked, once the person allowed that on the
   * consent page. Uses the link up: it lets nobody in again. The owner's choice on the link becomes the person's in the
   * workspace. The one place a person comes into someone else's workspace; call inside a transaction.
   */
  enter(share: Share, person: Person, agents: Agent[], opts: { allowInviter?: boolean } = {}): Workspace {
    const workspace = this.workspaces.get(share.workspaceId);
    if (!workspace || !this.worksFor(share, person)) throw new PorticoError("not_found", DEAD_LINK);
    // A link brings a person in. Someone already there adds agents the way the owner chose for that person, never by a link.
    if (this.workspaces.hasPerson(workspace.id, person.id)) throw new PorticoError("wrong_status", IN_ALREADY(workspace.phrase));
    if (agents.some((agent) => agent.ownerId !== person.id)) throw new PorticoError("not_allowed", "Only the person who manages an agent can add the agent to a Portico.");
    const claimed = this.db
      .query("UPDATE shares SET claimed_by = $personId, claimed_at = $at WHERE id = $id AND claimed_by IS NULL")
      .run({ id: share.id, personId: person.id, at: this.iso() }).changes;
    if (claimed !== 1) throw new PorticoError("not_found", DEAD_LINK);
    // Every other request waiting on the link ends with it.
    this.db.query("UPDATE consent_requests SET status = 'expired' WHERE share_id = $id AND status = 'pending'").run({ id: share.id });
    this.workspaces.admit(workspace.id, person.id, share.agentsPolicy);
    for (const agent of agents) this.workspaces.addAgent(person.id, workspace.id, agent.id, { allowed: true });
    // An invitation taken up is the first-contact decision between these two people, each way only where that person
    // chose so on Portico's own page: the one coming in here, the link's maker when making the link. Nobody else in the
    // workspace is covered, and no agent's word counts.
    if (opts.allowInviter === true) this.allowPeople?.(person.id, share.createdBy);
    if (share.allowsBack) this.allowPeople?.(share.createdBy, person.id);
    this.log("share_entered", { share_id: share.id, workspace_id: workspace.id, agents: agents.length });
    this.onEntered?.({ ...share, claimedBy: person.id }, workspace, person, agents);
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
