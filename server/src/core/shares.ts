import type { Database } from "bun:sqlite";
import type { Agents } from "./agents";
import { checkAgentName } from "./agents";
import type { Changes } from "./changes";
import { signInCode } from "./computers";
import { PorticoError } from "./errors";
import { DAY_MS, HOUR_MS, LIMITS, MINUTE_MS } from "./limits";
import type { People } from "./people";
import { cleanEmail } from "./people";
import { hashSecret, LINK_SECRET, newLinkSecret, newToken, sameSecret, seal, unseal } from "./tokens";
import { AGENT_KINDS } from "./types";
import type { Agent, AgentKind, Person, Workspace } from "./types";
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

export type RequestStatus = "pending" | "approved" | "denied" | "expired";

/** An agent asking to come into a workspace with a share link. A person confirms it in the browser. */
export interface ShareRequest {
  id: string;
  shareId: string;
  /** An agent already on Portico; null for one that joins Portico through the link. */
  agentId: string | null;
  /** The name and kind a new agent asked for. */
  name: string | null;
  kind: AgentKind | null;
  /** Four digits the agent shows in its chat, so the person knows which agent is asking. */
  code: string;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  issuedAt: string | null;
}

export type AskKind = "share" | "remove_person" | "delete";

/** Something an agent asked for on its owner's behalf that the owner has to confirm. */
export interface WorkspaceAsk {
  id: string;
  agentId: string;
  personId: string;
  workspaceId: string;
  kind: AskKind;
  /** `share`: the address to email the link to, or null for a link only. `remove_person`: the person to take out. */
  detail: { email?: string | null; personId?: string };
  status: RequestStatus;
  /** `share`, once approved: the share that was made. */
  result: { shareId?: string } | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
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

interface RequestRow {
  id: string;
  share_id: string;
  agent_id: string | null;
  name: string | null;
  kind: string | null;
  code: string;
  poll_hash: string | null;
  tries: number;
  status: RequestStatus;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  issued_at: string | null;
}

interface AskRow {
  id: string;
  agent_id: string;
  person_id: string;
  workspace_id: string;
  kind: AskKind;
  detail: string;
  status: RequestStatus;
  result: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
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
const DEAD_LINK = "This share link doesn't work. Ask the person who sent it for a new one.";
/** How long decided requests and asks, and dead links, are kept. */
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
  agents: Agents;
  people: People;
  changes: Changes;
  /** Seals a link's secret, so the person who made the link can copy it again. */
  signingKey: string;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Sharing a workspace. The only way a person comes into someone else's workspace is a share link, confirmed in the
 * browser by that person against a code the agent shows; this module is the only caller of `workspaces.admit`.
 */
export class Shares {
  private readonly db: Database;
  private readonly workspaces: Workspaces;
  private readonly agents: Agents;
  private readonly people: People;
  private readonly changes: Changes;
  private readonly signingKey: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: SharesDeps) {
    this.db = deps.db;
    this.workspaces = deps.workspaces;
    this.agents = deps.agents;
    this.people = deps.people;
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
        this.db.query("UPDATE share_requests SET status = 'expired' WHERE share_id = $id AND status = 'pending'").run({ id });
      }
      this.db
        .query("UPDATE workspace_asks SET status = 'expired' WHERE workspace_id = $workspaceId AND person_id = $personId AND status = 'pending'")
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
      this.db.query("UPDATE share_requests SET status = 'expired' WHERE share_id = $id AND status = 'pending'").run({ id: share.id });
    })();
    this.log("share_revoked", { share_id: share.id });
    this.changes.emit("workspaces", "approvals");
    return { ...share, revokedAt: share.revokedAt ?? at };
  }

  /** The working link with this secret. Anything else, whatever the reason, is the same `not_found`. */
  private usable(rawSecret: unknown): Share {
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
  private mayClaim(share: Share, person: Person): boolean {
    if (share.claimedBy !== null && share.claimedBy !== person.id) return false;
    if (share.email !== null && (person.email === null || person.email.toLowerCase() !== share.email)) return false;
    return true;
  }

  // ---- an agent asks to come in ----

  /**
   * An agent already on Portico asks to come into the workspace a link is for. Nothing changes until the person who
   * manages the agent confirms. Asking again while a request waits answers the same request.
   */
  requestForAgent(agent: Agent, rawSecret: unknown): ShareRequest {
    const share = this.usable(rawSecret);
    const owner = this.people.require(agent.ownerId);
    if (!this.mayClaim(share, owner)) throw new PorticoError("not_found", DEAD_LINK);
    if (this.workspaces.hasAgent(share.workspaceId, agent.id)) {
      throw new PorticoError("wrong_status", `This agent is already in ${this.workspaces.get(share.workspaceId)?.phrase ?? "that Portico"}.`);
    }
    const waiting = this.db
      .query("SELECT * FROM share_requests WHERE share_id = $shareId AND agent_id = $agentId AND status = 'pending' AND expires_at > $now")
      .get({ shareId: share.id, agentId: agent.id, now: this.iso() }) as RequestRow | null;
    if (waiting) return this.toRequest(waiting);
    return this.insertRequest(share, { agentId: agent.id, name: null, kind: null, pollSecret: null });
  }

  /**
   * An agent that isn't on Portico yet asks to join and come into the workspace, with the link as its only
   * credential. The poll secret is returned only here; the agent's token comes at the first poll after the person
   * confirms.
   */
  requestForNewAgent(rawSecret: unknown, input: { name: unknown; kind?: unknown }): { request: ShareRequest; pollSecret: string } {
    const name = checkAgentName(input.name);
    const asked = input.kind;
    if (asked !== undefined && asked !== null && !AGENT_KINDS.some((kind) => kind === asked)) {
      throw new PorticoError("bad_request", `kind must be one of: ${AGENT_KINDS.join(", ")}.`);
    }
    // A coding agent joins from its computer, not with a link: anything else takes the agent's word for its kind.
    const kind: AgentKind = asked && asked !== "claude-code" && asked !== "codex" ? (asked as AgentKind) : "other";
    const share = this.usable(rawSecret);
    const pollSecret = newToken("ps_");
    return { request: this.insertRequest(share, { agentId: null, name, kind, pollSecret }), pollSecret };
  }

  private insertRequest(share: Share, input: { agentId: string | null; name: string | null; kind: AgentKind | null; pollSecret: string | null }): ShareRequest {
    const at = this.now();
    const request: ShareRequest = {
      id: this.newId(),
      shareId: share.id,
      agentId: input.agentId,
      name: input.name,
      kind: input.kind,
      code: signInCode(),
      status: "pending",
      createdAt: at.toISOString(),
      expiresAt: new Date(Math.min(at.getTime() + LIMITS.shareRequestMinutes * MINUTE_MS, Date.parse(share.expiresAt))).toISOString(),
      decidedAt: null,
      decidedBy: null,
      issuedAt: null,
    };
    this.db
      .query(
        `INSERT INTO share_requests (id, share_id, agent_id, name, kind, code, poll_hash, status, created_at, expires_at)
         VALUES ($id, $shareId, $agentId, $name, $kind, $code, $pollHash, 'pending', $createdAt, $expiresAt)`,
      )
      .run({
        id: request.id,
        shareId: request.shareId,
        agentId: request.agentId,
        name: request.name,
        kind: request.kind,
        code: request.code,
        pollHash: input.pollSecret ? hashSecret(input.pollSecret) : null,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      });
    this.log("share_requested", { request_id: request.id, share_id: share.id, new_agent: input.agentId === null });
    this.changes.emit("approvals");
    return request;
  }

  request(id: string): ShareRequest | null {
    const row = this.db.query("SELECT * FROM share_requests WHERE id = $id").get({ id }) as RequestRow | null;
    return row ? this.toRequest(row) : null;
  }

  /** Requests from the person's own agents that still wait, oldest first. */
  pendingFor(personId: string): ShareRequest[] {
    const rows = this.db
      .query(
        `SELECT r.* FROM share_requests r JOIN agents a ON a.id = r.agent_id
         WHERE a.owner_id = $personId AND r.status = 'pending' AND r.expires_at > $now ORDER BY r.created_at, r.id`,
      )
      .all({ personId, now: this.iso() }) as RequestRow[];
    return rows.map((row) => this.toRequest(row));
  }

  /**
   * What a request is for, as the person confirming may see it: the workspace, who shared it, and the agent asking.
   * Null when the request isn't the person's to confirm, which looks the same as no request at all.
   */
  describe(person: Person, requestId: string): { request: ShareRequest; share: Share; workspace: Workspace; sharedBy: Person | null; agent: Agent | null } | null {
    const request = this.request(requestId);
    const share = request ? this.get(request.shareId) : null;
    const workspace = share ? this.workspaces.get(share.workspaceId) : null;
    if (!request || !share || !workspace) return null;
    const agent = request.agentId ? this.agents.get(request.agentId) : null;
    if (request.agentId !== null && agent?.ownerId !== person.id) return null;
    if (!this.mayClaim(share, person)) return null;
    return { request, share, workspace, sharedBy: this.people.get(share.createdBy), agent };
  }

  /**
   * The person's answer to a request. Approving claims the link for the person, lets the person into the workspace
   * and puts the agent in; a new agent is made first, under the person. An agent already on Portico is confirmed by
   * the person who manages it. A new one could be anyone's, so the person types the code the agent shows: a wrong code
   * counts, and the request closes after a few.
   */
  decide(personId: string, requestId: string, input: { decision: unknown; code?: unknown; name?: unknown }): { request: ShareRequest; agent: Agent | null; workspace: Workspace } {
    const { decision } = input;
    if (decision !== "approve" && decision !== "deny") throw new PorticoError("bad_request", "decision must be approve or deny.");
    const person = this.people.require(personId);
    const found = this.describe(person, requestId);
    if (!found) throw new PorticoError("not_found", "No such request.");
    const { request, share, workspace } = found;
    if (request.status !== "pending") {
      throw new PorticoError("wrong_status", request.status === "expired" ? "This request expired. Ask the agent to try the link again." : `This request was already ${request.status}.`);
    }
    if (!this.isOpen(share) || !this.workspaces.hasPerson(share.workspaceId, share.createdBy)) throw new PorticoError("not_found", DEAD_LINK);
    if (request.agentId === null) {
      const typed = typeof input.code === "string" ? input.code.trim() : "";
      if (!sameSecret(hashSecret(typed), hashSecret(request.code))) {
        const tries = this.db.query("UPDATE share_requests SET tries = tries + 1 WHERE id = $id RETURNING tries").get({ id: request.id }) as { tries: number };
        if (tries.tries >= LIMITS.shareCodeTries) {
          this.db.query("UPDATE share_requests SET status = 'denied', decided_at = $at WHERE id = $id").run({ id: request.id, at: this.iso() });
          this.changes.emit("approvals");
          throw new PorticoError("wrong_status", "Too many wrong codes. Ask the agent to try the link again.");
        }
        throw new PorticoError("bad_request", "That code doesn't match the one the agent shows.");
      }
    }
    const at = this.iso();
    if (decision === "deny") {
      this.db.query("UPDATE share_requests SET status = 'denied', decided_at = $at, decided_by = $personId WHERE id = $id").run({ id: request.id, at, personId });
      this.log("share_request_decided", { request_id: request.id, decision });
      this.changes.emit("approvals");
      return { request: { ...request, status: "denied", decidedAt: at, decidedBy: personId }, agent: null, workspace };
    }
    if (person.handle === null) throw new PorticoError("wrong_status", "Pick a handle first.");
    const agent = this.db.transaction(() => {
      let joining = request.agentId ? this.agents.get(request.agentId) : null;
      if (!joining) {
        const chosen = input.name === undefined || input.name === null || input.name === "" ? request.name : input.name;
        joining = this.agents.create({ ownerId: person.id, name: chosen, kind: request.kind ?? "other", type: "app" });
      }
      if (share.claimedBy === null) {
        this.db.query("UPDATE shares SET claimed_by = $personId, claimed_at = $at WHERE id = $id AND claimed_by IS NULL").run({ id: share.id, personId, at });
      }
      // The one place a person comes into someone else's workspace.
      this.workspaces.admit(workspace.id, person.id);
      this.workspaces.addAgent(person.id, workspace.id, joining.id);
      this.db
        .query("UPDATE share_requests SET status = 'approved', agent_id = $agentId, decided_at = $at, decided_by = $personId WHERE id = $id")
        .run({ id: request.id, agentId: joining.id, at, personId });
      return joining;
    })();
    this.log("share_request_decided", { request_id: request.id, decision, agent_id: agent.id, workspace_id: workspace.id });
    this.changes.emit("approvals", "workspaces", "agents", "people");
    return { request: { ...request, status: "approved", agentId: agent.id, decidedAt: at, decidedBy: personId }, agent, workspace };
  }

  /**
   * A new agent's poll, with its poll secret. After the person confirms, the first poll gets the agent's API token,
   * exactly once; later polls see only the status.
   */
  poll(id: string, pollSecret: string | null): { request: ShareRequest; agent: Agent | null; token: string | null } {
    const row = this.db.query("SELECT * FROM share_requests WHERE id = $id").get({ id }) as RequestRow | null;
    if (!row || !row.poll_hash || !pollSecret || !sameSecret(hashSecret(pollSecret), row.poll_hash)) {
      throw new PorticoError("unauthorized", "Missing or wrong poll secret for this request.");
    }
    const request = this.toRequest(row);
    const agent = request.agentId ? this.agents.get(request.agentId) : null;
    if (request.status !== "approved" || !agent || request.issuedAt) return { request, agent, token: null };
    const at = this.iso();
    const claimed = this.db.query("UPDATE share_requests SET issued_at = $at WHERE id = $id AND issued_at IS NULL").run({ id, at }).changes;
    if (claimed === 0) return { request, agent, token: null };
    const token = this.agents.issueToken(agent.id, "api");
    this.agents.checkedIn(agent);
    this.log("share_token_issued", { request_id: id, agent_id: agent.id });
    this.changes.emit("agents");
    return { request: { ...request, issuedAt: at }, agent, token };
  }

  // ---- what an agent asks its owner to confirm ----

  /**
   * An agent asks, for its owner, to share a workspace or take a person out of one. Letting someone in and removing
   * someone are the owner's to confirm, so nothing changes yet. The workspace must be one the owner is in.
   */
  ask(agent: Agent, kind: AskKind, workspaceId: string, input: { email?: unknown; person?: unknown } = {}): WorkspaceAsk {
    const workspace = this.sharedFor(agent.ownerId, workspaceId);
    let detail: WorkspaceAsk["detail"];
    if (kind === "share") {
      detail = { email: input.email === undefined || input.email === null || input.email === "" ? null : cleanEmail(input.email) };
    } else if (kind === "delete") {
      if (workspace.ownerId !== agent.ownerId) throw new PorticoError("not_allowed", `Only the owner of ${workspace.phrase} can delete it.`);
      detail = {};
    } else {
      const target = typeof input.person === "string" ? this.people.byHandle(input.person.trim().toLowerCase()) : null;
      if (!target || !this.workspaces.hasPerson(workspace.id, target.id)) {
        throw new PorticoError("not_found", `Nobody with that handle is in ${workspace.phrase}.`);
      }
      if (target.id !== agent.ownerId && workspace.ownerId !== agent.ownerId) {
        throw new PorticoError("not_allowed", `Only the owner of ${workspace.phrase} can remove another person.`);
      }
      if (target.id === workspace.ownerId) throw new PorticoError("not_allowed", `The owner of ${workspace.phrase} can't leave. Delete the Portico instead.`);
      detail = { personId: target.id };
    }
    const at = this.now();
    const ask: WorkspaceAsk = {
      id: this.newId(),
      agentId: agent.id,
      personId: agent.ownerId,
      workspaceId: workspace.id,
      kind,
      detail,
      status: "pending",
      result: null,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + LIMITS.workspaceAskHours * HOUR_MS).toISOString(),
      decidedAt: null,
    };
    this.db
      .query(
        `INSERT INTO workspace_asks (id, agent_id, person_id, workspace_id, kind, detail, status, created_at, expires_at)
         VALUES ($id, $agentId, $personId, $workspaceId, $kind, $detail, 'pending', $createdAt, $expiresAt)`,
      )
      .run({
        id: ask.id,
        agentId: ask.agentId,
        personId: ask.personId,
        workspaceId: ask.workspaceId,
        kind,
        detail: JSON.stringify(detail),
        createdAt: ask.createdAt,
        expiresAt: ask.expiresAt,
      });
    this.log("workspace_asked", { ask_id: ask.id, kind, agent_id: agent.id });
    this.changes.emit("approvals");
    return ask;
  }

  getAsk(id: string): WorkspaceAsk | null {
    const row = this.db.query("SELECT * FROM workspace_asks WHERE id = $id").get({ id }) as AskRow | null;
    return row ? this.toAsk(row) : null;
  }

  /** What the person's agents asked for that still waits, oldest first. */
  asksFor(personId: string): WorkspaceAsk[] {
    const rows = this.db
      .query("SELECT * FROM workspace_asks WHERE person_id = $personId AND status = 'pending' AND expires_at > $now ORDER BY created_at, id")
      .all({ personId, now: this.iso() }) as AskRow[];
    return rows.map((row) => this.toAsk(row));
  }

  /** Everything the person's agents asked for in the last week, waiting or decided, newest first. */
  asksBy(personId: string): WorkspaceAsk[] {
    const rows = this.db
      .query("SELECT * FROM workspace_asks WHERE person_id = $personId AND created_at > $since ORDER BY created_at DESC, id")
      .all({ personId, since: new Date(this.now().getTime() - 7 * DAY_MS).toISOString() }) as AskRow[];
    return rows.map((row) => this.toAsk(row));
  }

  /** The person's agents' requests to come into workspaces from the last day, newest first. */
  requestsBy(personId: string): ShareRequest[] {
    const rows = this.db
      .query(
        `SELECT r.* FROM share_requests r JOIN agents a ON a.id = r.agent_id
         WHERE a.owner_id = $personId AND r.created_at > $since ORDER BY r.created_at DESC, r.id`,
      )
      .all({ personId, since: new Date(this.now().getTime() - DAY_MS).toISOString() }) as RequestRow[];
    return rows.map((row) => this.toRequest(row));
  }

  /** The owner's answer. Approving does what was asked, as the owner: every rule for the owner applies again. */
  decideAsk(personId: string, askId: string, decision: unknown): WorkspaceAsk {
    if (decision !== "approve" && decision !== "deny") throw new PorticoError("bad_request", "decision must be approve or deny.");
    const ask = this.getAsk(askId);
    if (!ask || ask.personId !== personId) throw new PorticoError("not_found", "No such request.");
    if (ask.status !== "pending") {
      throw new PorticoError("wrong_status", ask.status === "expired" ? "This request expired." : `This request was already ${ask.status}.`);
    }
    const at = this.iso();
    const result = this.db.transaction(() => {
      let done: WorkspaceAsk["result"] = null;
      if (decision === "approve") {
        if (ask.kind === "share") done = { shareId: this.create(personId, ask.workspaceId, { email: ask.detail.email }).share.id };
        else if (ask.kind === "delete") this.workspaces.remove(personId, ask.workspaceId);
        else this.workspaces.removePerson(personId, ask.workspaceId, ask.detail.personId!);
      }
      this.db
        .query("UPDATE workspace_asks SET status = $status, result = $result, decided_at = $at WHERE id = $id")
        .run({ id: ask.id, status: decision === "approve" ? "approved" : "denied", result: done ? JSON.stringify(done) : null, at });
      return done;
    })();
    this.log("workspace_ask_decided", { ask_id: ask.id, decision });
    this.changes.emit("approvals", "workspaces");
    return { ...ask, status: decision === "approve" ? "approved" : "denied", result, decidedAt: at };
  }

  // ---- sweeps ----

  /** Every minute: requests and asks past their time are marked expired. Returns how many. */
  sweepMinute(): number {
    const now = this.iso();
    const requests = this.db.query("UPDATE share_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= $now").run({ now }).changes;
    const asks = this.db.query("UPDATE workspace_asks SET status = 'expired' WHERE status = 'pending' AND expires_at <= $now").run({ now }).changes;
    if (requests + asks > 0) this.changes.emit("approvals");
    return requests + asks;
  }

  /** Daily: links a month past their end, with their requests, and asks decided a month ago. Returns how many. */
  sweep(): number {
    const cutoff = new Date(this.now().getTime() - KEEP_MS).toISOString();
    const shares = this.db.query("DELETE FROM shares WHERE expires_at < $cutoff OR revoked_at < $cutoff").run({ cutoff }).changes;
    const asks = this.db.query("DELETE FROM workspace_asks WHERE expires_at < $cutoff").run({ cutoff }).changes;
    return shares + asks;
  }

  // ---- helpers ----

  /** The shared workspace, for a person in it. Personal ones are never shared; a stranger sees `not_found`. */
  private sharedFor(personId: string, workspaceId: string): Workspace {
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

  private toRequest(row: RequestRow): ShareRequest {
    const late = row.status === "pending" && Date.parse(row.expires_at) <= this.now().getTime();
    return {
      id: row.id,
      shareId: row.share_id,
      agentId: row.agent_id,
      name: row.name,
      kind: row.kind as AgentKind | null,
      code: row.code,
      status: late ? "expired" : row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      issuedAt: row.issued_at,
    };
  }

  private toAsk(row: AskRow): WorkspaceAsk {
    const late = row.status === "pending" && Date.parse(row.expires_at) <= this.now().getTime();
    return {
      id: row.id,
      agentId: row.agent_id,
      personId: row.person_id,
      workspaceId: row.workspace_id,
      kind: row.kind,
      detail: JSON.parse(row.detail) as WorkspaceAsk["detail"],
      status: late ? "expired" : row.status,
      result: row.result ? (JSON.parse(row.result) as WorkspaceAsk["result"]) : null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
    };
  }

  private iso(): string {
    return this.now().toISOString();
  }
}
