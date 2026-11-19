import type { Database } from "bun:sqlite";
import type { Activity } from "./activity";
import type { Agents } from "./agents";
import { checkAgentName } from "./agents";
import type { Changes } from "./changes";
import { APP_KINDS, COMPUTER_KINDS, type Computers, signInCode } from "./computers";
import { PorticoError } from "./errors";
import { DAY_MS, LIMITS, MINUTE_MS } from "./limits";
import type { People } from "./people";
import { cleanEmail } from "./people";
import { DEAD_LINK, type Share, type Shares } from "./shares";
import { hashSecret, newToken, sameSecret } from "./tokens";
import type { Agent, AgentKind, Computer, Person, Workspace } from "./types";
import type { Workspaces } from "./workspaces";

/**
 * What a consent request asks for. `computer` and `agent`: a new computer or app agent joins Portico. `enter`: an agent
 * already on Portico comes into a workspace with a share link. `share`, `remove_person`, `delete`: an agent asks the
 * person who manages it to share a workspace, take a person out of one, or delete one.
 */
export type ConsentKind = "computer" | "agent" | "enter" | "share" | "remove_person" | "delete";
export type ConsentStatus = "pending" | "approved" | "denied" | "expired";
/** The kinds anyone can start, with no token: whoever signs in and types the code becomes the owner. */
export type JoinKind = "computer" | "agent";
/** The kinds an agent asks about a workspace of its person's. */
export type AskKind = "share" | "remove_person" | "delete";

export const isJoin = (kind: ConsentKind): kind is JoinKind => kind === "computer" || kind === "agent";

/** One thing waiting for a person's Allow on the consent page, `/c/<id>`. */
export interface ConsentRequest {
  id: string;
  kind: ConsentKind;
  status: ConsentStatus;
  /** Four digits the asking agent shows in its chat: typing them ties the page to that agent. */
  code: string;
  /** The agent asking (`enter` and the asks), or the app agent that was made (`agent`, once allowed). */
  agentId: string | null;
  /** Who has to confirm, when that is known. Null for a join: whoever signs in and types the code. */
  personId: string | null;
  workspaceId: string | null;
  /** `enter`: the link used. `agent`: the link the new agent brought, when it brought one. */
  shareId: string | null;
  /** The name a joining computer or agent asked for. */
  name: string | null;
  /** `agent`: the app's kind. `computer`: the coding agent that started the join, when it said. */
  agentKind: AgentKind | null;
  /** `share`: the address to email the link to, or null. `remove_person`: the person to take out. */
  detail: { email?: string | null; personId?: string };
  /** `share`, once allowed: the share that was made. */
  result: { shareId?: string } | null;
  /** `computer`, once allowed: the computer that was made. */
  computerId: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** When the token was handed to a joining computer or agent, at its first poll after Allow. */
  issuedAt: string | null;
}

interface Row {
  id: string;
  kind: ConsentKind;
  status: ConsentStatus;
  code: string;
  tries: number;
  poll_hash: string | null;
  client: string | null;
  agent_id: string | null;
  person_id: string | null;
  workspace_id: string | null;
  share_id: string | null;
  name: string | null;
  agent_kind: string | null;
  detail: string;
  result: string | null;
  computer_id: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  issued_at: string | null;
}

/** A request as the person looking at the consent page may see it. */
export interface ConsentView {
  request: ConsentRequest;
  /** The agent asking, for the kinds an agent of the person's asks. */
  agent: Agent | null;
  workspace: Workspace | null;
  share: Share | null;
  /** Who made the share link an agent comes in with. */
  sharedBy: Person | null;
  /** `remove_person`: who would be taken out. */
  target: Person | null;
}

export interface Decided {
  request: ConsentRequest;
  agent: Agent | null;
  computer: Computer | null;
  workspace: Workspace | null;
  /** `share`: the share that was made. */
  share: Share | null;
}

/** How long decided requests are kept. */
const KEEP_MS = 7 * DAY_MS;
/** Requests one person's agents can have waiting at once. */
const MAX_WAITING_PER_PERSON = 20;

export interface ConsentsDeps {
  db: Database;
  workspaces: Workspaces;
  shares: Shares;
  agents: Agents;
  people: People;
  computers: Computers;
  changes: Changes;
  activity?: Activity;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
  /** A request whose person is known was just made: the place to email that person the page's link. */
  onAsked?: (request: ConsentRequest) => void;
}

/**
 * Consent requests: everything a person confirms on the one consent page. A request carries a 4-digit code that only
 * the asking agent shows, so the link alone lets nothing in; a few wrong codes close it, and it runs out after a few
 * minutes. Nothing changes until the person presses Allow, and then the change is made as that person, so every rule
 * for the person applies again.
 */
export class Consents {
  private readonly db: Database;
  private readonly workspaces: Workspaces;
  private readonly shares: Shares;
  private readonly agents: Agents;
  private readonly people: People;
  private readonly computers: Computers;
  private readonly changes: Changes;
  private readonly activity: Activity | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  private readonly onAsked: (request: ConsentRequest) => void;

  constructor(deps: ConsentsDeps) {
    this.db = deps.db;
    this.workspaces = deps.workspaces;
    this.shares = deps.shares;
    this.agents = deps.agents;
    this.people = deps.people;
    this.computers = deps.computers;
    this.changes = deps.changes;
    this.activity = deps.activity;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
    this.onAsked = deps.onAsked ?? (() => {});
  }

  // ---- starting a request ----

  /**
   * A computer or an app agent that isn't on Portico asks to join. Anyone can ask, so nothing here names an account:
   * the computer or agent will belong to whoever signs in, opens the page and types the code. `client` is the address
   * the request came from, which caps how many one client has waiting. With `link`, a new app agent also comes into
   * the workspace a share link is for. `replaces` ends an earlier request of the same asker, so asking again for a
   * fresh code leaves one request waiting, not two. The poll secret is returned only here.
   */
  startJoin(
    input: { kind?: unknown; name?: unknown; client?: unknown; link?: unknown; replaces?: unknown },
    client: string,
  ): { request: ConsentRequest; pollSecret: string } {
    const kind = input.kind === undefined || input.kind === null ? "agent" : input.kind;
    if (kind !== "computer" && kind !== "agent") throw new PorticoError("bad_request", "kind must be computer or agent.");
    let name: string;
    let agentKind: AgentKind | null;
    if (kind === "computer") {
      name = typeof input.name === "string" && input.name.trim() !== "" ? input.name.trim().slice(0, 200) : "computer";
      agentKind = COMPUTER_KINDS.find((k) => k === input.client) ?? null;
    } else {
      name = checkAgentName(input.name);
      const asked = input.client;
      if (asked !== undefined && asked !== null && !APP_KINDS.some((k) => k === asked)) {
        throw new PorticoError("bad_request", `client must be one of: ${APP_KINDS.join(", ")}.`);
      }
      agentKind = (asked as AgentKind | undefined | null) ?? "other";
    }
    const share = input.link === undefined || input.link === null || input.link === "" ? null : this.shares.usable(input.link);
    if (share && kind !== "agent") throw new PorticoError("bad_request", "A computer joins without a share link. A session there uses the link afterwards, with join_portico.");
    this.replace(input.replaces);
    const now = this.iso();
    const waiting = (where: string, bindings: Record<string, string>) =>
      (this.db.query(`SELECT COUNT(*) AS n FROM consent_requests WHERE status = 'pending' AND expires_at > $now AND person_id IS NULL AND ${where}`).get({ now, ...bindings }) as { n: number }).n;
    if (waiting("client = $client", { client }) >= LIMITS.consentWaitingPerClient || waiting("1 = 1", {}) >= LIMITS.consentWaitingJoins) {
      throw new PorticoError("rate_limited", "Too many requests to join are waiting. Finish one on Portico's page, or try again in a few minutes.");
    }
    const pollSecret = newToken("ps_");
    const request = this.insert({ kind, name, agentKind, shareId: share?.id ?? null, workspaceId: share?.workspaceId ?? null, client, pollSecret }, share);
    return { request, pollSecret };
  }

  /** Ends the asker's earlier request, named by its ID and poll secret. Anything else is ignored. */
  private replace(replaces: unknown): void {
    if (typeof replaces !== "object" || replaces === null) return;
    const { id, poll_secret: secret } = replaces as { id?: unknown; poll_secret?: unknown };
    if (typeof id !== "string" || typeof secret !== "string") return;
    const row = this.row(id);
    if (!row?.poll_hash || !sameSecret(hashSecret(secret), row.poll_hash)) return;
    this.db.query("UPDATE consent_requests SET status = 'expired' WHERE id = $id AND status = 'pending'").run({ id });
  }

  /**
   * An agent already on Portico asks to come into the workspace a share link is for. Nothing changes until the person
   * who manages the agent allows it. Asking again while a request waits answers the same request; once that has run
   * out, a fresh one.
   */
  enter(agent: Agent, rawLink: unknown): ConsentRequest {
    const share = this.shares.usable(rawLink);
    const owner = this.people.require(agent.ownerId);
    if (!this.shares.mayClaim(share, owner)) throw new PorticoError("not_found", DEAD_LINK);
    if (this.workspaces.hasAgent(share.workspaceId, agent.id)) {
      throw new PorticoError("wrong_status", `This agent is already in ${this.workspaces.get(share.workspaceId)?.phrase ?? "that Portico"}.`);
    }
    return this.askOnce({ kind: "enter", agentId: agent.id, personId: owner.id, workspaceId: share.workspaceId, shareId: share.id }, share);
  }

  /**
   * An agent asks, for the person who manages it, to share a workspace, take a person out of one, or delete one. Those
   * are the person's to confirm, so nothing changes yet. The workspace must be one the person is in. Asking again while
   * the same request waits answers that request; once it has run out, a fresh one.
   */
  ask(agent: Agent, kind: AskKind, workspaceId: string, input: { email?: unknown; person?: unknown } = {}): ConsentRequest {
    const workspace = this.shares.sharedFor(agent.ownerId, workspaceId);
    let detail: ConsentRequest["detail"];
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
    return this.askOnce({ kind, agentId: agent.id, personId: agent.ownerId, workspaceId: workspace.id, detail });
  }

  /** The same request while one waits; otherwise the old one is closed and a fresh one made. */
  private askOnce(
    input: { kind: ConsentKind; agentId: string; personId: string; workspaceId: string; shareId?: string; detail?: ConsentRequest["detail"] },
    share: Share | null = null,
  ): ConsentRequest {
    const detail = JSON.stringify(input.detail ?? {});
    const same = { kind: input.kind, agentId: input.agentId, workspaceId: input.workspaceId, shareId: input.shareId ?? null, detail };
    const match = "kind = $kind AND agent_id = $agentId AND workspace_id = $workspaceId AND share_id IS $shareId AND detail = $detail AND status = 'pending'";
    const waiting = this.db.query(`SELECT * FROM consent_requests WHERE ${match} AND expires_at > $now`).get({ ...same, now: this.iso() }) as Row | null;
    if (waiting) return this.toRequest(waiting);
    this.db.query(`UPDATE consent_requests SET status = 'expired' WHERE ${match}`).run(same);
    const open = (this.db.query("SELECT COUNT(*) AS n FROM consent_requests WHERE person_id = $personId AND status = 'pending' AND expires_at > $now").get({ personId: input.personId, now: this.iso() }) as { n: number }).n;
    if (open >= MAX_WAITING_PER_PERSON) {
      throw new PorticoError("rate_limited", "Too many requests are waiting for this person. list_porticos shows them; ask again once some are answered or have run out.");
    }
    const request = this.insert({ ...input, shareId: input.shareId ?? null, name: null, agentKind: null, client: null, pollSecret: null }, share);
    this.onAsked(request);
    return request;
  }

  private insert(
    input: {
      kind: ConsentKind;
      agentId?: string | null;
      personId?: string | null;
      workspaceId: string | null;
      shareId: string | null;
      name: string | null;
      agentKind: AgentKind | null;
      detail?: ConsentRequest["detail"];
      client: string | null;
      pollSecret: string | null;
    },
    share: Share | null,
  ): ConsentRequest {
    const at = this.now();
    // A request never outlives the link it came with.
    const until = Math.min(at.getTime() + LIMITS.consentMinutes * MINUTE_MS, share ? Date.parse(share.expiresAt) : Infinity);
    const request: ConsentRequest = {
      id: this.newId(),
      kind: input.kind,
      status: "pending",
      code: signInCode(),
      agentId: input.agentId ?? null,
      personId: input.personId ?? null,
      workspaceId: input.workspaceId,
      shareId: input.shareId,
      name: input.name,
      agentKind: input.agentKind,
      detail: input.detail ?? {},
      result: null,
      computerId: null,
      createdAt: at.toISOString(),
      expiresAt: new Date(until).toISOString(),
      decidedAt: null,
      decidedBy: null,
      issuedAt: null,
    };
    this.db
      .query(
        `INSERT INTO consent_requests (id, kind, status, code, poll_hash, client, agent_id, person_id, workspace_id, share_id, name, agent_kind, detail, created_at, expires_at)
         VALUES ($id, $kind, 'pending', $code, $pollHash, $client, $agentId, $personId, $workspaceId, $shareId, $name, $agentKind, $detail, $createdAt, $expiresAt)`,
      )
      .run({
        id: request.id,
        kind: request.kind,
        code: request.code,
        pollHash: input.pollSecret ? hashSecret(input.pollSecret) : null,
        client: input.client,
        agentId: request.agentId,
        personId: request.personId,
        workspaceId: request.workspaceId,
        shareId: request.shareId,
        name: request.name,
        agentKind: request.agentKind,
        detail: JSON.stringify(request.detail),
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      });
    this.log("consent_asked", { request_id: request.id, kind: request.kind });
    this.changes.emit("approvals");
    return request;
  }

  // ---- reading ----

  get(id: string): ConsentRequest | null {
    const row = this.row(id);
    return row ? this.toRequest(row) : null;
  }

  /** What the person's agents asked for that still waits, oldest first. Joins are nobody's until allowed, so never here. */
  waitingFor(personId: string): ConsentRequest[] {
    const rows = this.db
      .query("SELECT * FROM consent_requests WHERE person_id = $personId AND status = 'pending' AND expires_at > $now ORDER BY created_at, id")
      .all({ personId, now: this.iso() }) as Row[];
    return rows.map((row) => this.toRequest(row));
  }

  /** Everything the person's agents asked for in the last day, waiting or answered, newest first. */
  recentFor(personId: string): ConsentRequest[] {
    const rows = this.db
      .query("SELECT * FROM consent_requests WHERE person_id = $personId AND created_at > $since ORDER BY created_at DESC, id")
      .all({ personId, since: new Date(this.now().getTime() - DAY_MS).toISOString() }) as Row[];
    return rows.map((row) => this.toRequest(row));
  }

  /**
   * The request as this person may see it on the consent page, or null, which looks the same as no request at all.
   * What an agent of someone's asked is only that person's to see. A join is nobody's yet, so anyone signed in who has
   * its link may see it while it waits (it names no account), and afterwards only the person who answered it. A join
   * that came with a share link is only for a person the link is for.
   */
  describe(viewer: Person, id: string): ConsentView | null {
    const request = this.get(id);
    if (!request) return null;
    if (request.personId !== null && request.personId !== viewer.id) return null;
    if (request.personId === null && request.decidedBy !== null && request.decidedBy !== viewer.id) return null;
    const share = request.shareId ? this.shares.get(request.shareId) : null;
    if (request.shareId && (!share || !this.shares.mayClaim(share, viewer))) return null;
    const workspace = request.workspaceId ? this.workspaces.known(request.workspaceId) : null;
    if (request.workspaceId && !workspace) return null;
    return {
      request,
      agent: request.agentId ? this.agents.get(request.agentId) : null,
      workspace,
      share,
      sharedBy: share ? this.people.get(share.createdBy) : null,
      target: request.detail.personId ? this.people.get(request.detail.personId) : null,
    };
  }

  // ---- the person's answer ----

  /**
   * The person's answer. Allow needs the code the asking agent shows: a wrong code counts, and the request closes
   * after a few. Allowing does what was asked, as the person: a computer or app agent is made under the person, an
   * agent comes into the shared workspace, or the workspace is shared, loses a person or is deleted. `name` renames a
   * joining app agent. `handle` is for a person who has none yet: it is taken only once the code is right.
   */
  decide(personId: string, id: string, input: { decision: unknown; code?: unknown; name?: unknown; handle?: unknown }): Decided {
    const { decision } = input;
    if (decision !== "approve" && decision !== "deny") throw new PorticoError("bad_request", "decision must be approve or deny.");
    const person = this.people.require(personId);
    const found = this.describe(person, id);
    if (!found) throw new PorticoError("not_found", "No such request.");
    const { request, share } = found;
    if (request.status !== "pending") {
      throw new PorticoError("wrong_status", request.status === "expired" ? "This code ran out. Ask the agent for a new code." : `This request was already ${request.status === "approved" ? "allowed" : "turned down"}.`);
    }
    const at = this.iso();
    if (decision === "deny") {
      this.db.query("UPDATE consent_requests SET status = 'denied', decided_at = $at, decided_by = $personId WHERE id = $id AND status = 'pending'").run({ id, at, personId });
      this.log("consent_decided", { request_id: id, kind: request.kind, decision });
      if (request.kind === "agent") this.activity?.record("sign_in_denied", { personId, detail: { name: request.name ?? "", kind: request.agentKind ?? "other" } });
      this.changes.emit("approvals");
      return { request: { ...request, status: "denied", decidedAt: at, decidedBy: personId }, agent: null, computer: null, workspace: found.workspace, share: null };
    }
    if (person.status !== "active") throw new PorticoError("not_allowed", "Waiting for the owner to approve this account.");
    const typed = typeof input.code === "string" ? input.code.replace(/\s+/g, "") : "";
    if (!sameSecret(hashSecret(typed), hashSecret(request.code))) {
      const { tries } = this.db.query("UPDATE consent_requests SET tries = tries + 1 WHERE id = $id RETURNING tries").get({ id }) as { tries: number };
      if (tries >= LIMITS.consentCodeTries) {
        this.db.query("UPDATE consent_requests SET status = 'denied', decided_at = $at WHERE id = $id").run({ id, at });
        this.changes.emit("approvals");
        throw new PorticoError("wrong_status", "Too many wrong codes. Ask the agent for a new code.");
      }
      throw new PorticoError("bad_request", "That code doesn't match the one the agent shows.");
    }
    const wanted = typeof input.handle === "string" ? input.handle.trim().toLowerCase() : "";
    if (person.handle === null && wanted === "") throw new PorticoError("bad_request", "Pick a handle first.");
    const done = this.db.transaction(() => {
      if (person.handle === null) {
        this.people.setHandle(person.id, wanted);
        this.workspaces.personal(person.id);
      }
      let agent: Agent | null = request.agentId ? this.agents.get(request.agentId) : null;
      let computer: Computer | null = null;
      let workspace = found.workspace;
      let made: Share | null = null;
      switch (request.kind) {
        case "computer":
          // The token made here is never handed out: the computer gets its own at its first poll.
          computer = this.computers.create(person.id, request.name ?? "computer").computer;
          break;
        case "agent": {
          const chosen = input.name === undefined || input.name === null || input.name === "" ? request.name : input.name;
          agent = this.agents.create({ ownerId: person.id, name: chosen, kind: request.agentKind ?? "other", type: "app" });
          if (share) workspace = this.shares.enter(share, person, agent);
          break;
        }
        case "enter":
          if (!agent || agent.ownerId !== person.id || !share) throw new PorticoError("not_found", "No such request.");
          workspace = this.shares.enter(share, person, agent);
          break;
        case "share":
          made = this.shares.create(person.id, request.workspaceId!, { email: request.detail.email }).share;
          break;
        case "delete":
          this.workspaces.remove(person.id, request.workspaceId!);
          break;
        case "remove_person":
          this.workspaces.removePerson(person.id, request.workspaceId!, request.detail.personId!);
          break;
      }
      const result = made ? { shareId: made.id } : null;
      this.db
        .query(
          `UPDATE consent_requests SET status = 'approved', agent_id = $agentId, computer_id = $computerId, result = $result, decided_at = $at, decided_by = $personId
           WHERE id = $id`,
        )
        .run({ id, agentId: agent?.id ?? null, computerId: computer?.id ?? null, result: result ? JSON.stringify(result) : null, at, personId });
      const decided: ConsentRequest = { ...request, status: "approved", agentId: agent?.id ?? null, computerId: computer?.id ?? null, result, decidedAt: at, decidedBy: personId };
      return { request: decided, agent, computer, workspace, share: made };
    })();
    this.log("consent_decided", { request_id: id, kind: request.kind, decision });
    this.changes.emit("approvals", "workspaces", "agents", "people", "computers");
    return done;
  }

  /**
   * A joining computer's or agent's poll, with its poll secret. After the person allows the join, the first poll gets
   * the token, exactly once; later polls see only the status. A missing or wrong secret answers the same as no request.
   */
  poll(id: string, pollSecret: string | null): { request: ConsentRequest; agent: Agent | null; computer: Computer | null; token: string | null } {
    const row = this.row(id);
    if (!row || !row.poll_hash || !pollSecret || !sameSecret(hashSecret(pollSecret), row.poll_hash)) {
      throw new PorticoError("unauthorized", "Missing or wrong poll secret for this request.");
    }
    const request = this.toRequest(row);
    const agent = request.kind === "agent" && request.agentId ? this.agents.get(request.agentId) : null;
    const computer = request.computerId ? this.computers.get(request.computerId) : null;
    if (request.status !== "approved" || request.issuedAt || (!agent && !computer)) return { request, agent, computer, token: null };
    const at = this.iso();
    const claimed = this.db.query("UPDATE consent_requests SET issued_at = $at WHERE id = $id AND issued_at IS NULL").run({ id, at }).changes;
    if (claimed === 0) return { request, agent, computer, token: null };
    let token: string;
    if (computer) token = this.computers.issueToken(computer.id);
    else {
      token = this.agents.issueToken(agent!.id, "api");
      this.agents.checkedIn(agent!);
    }
    this.log("consent_token_issued", { request_id: id, kind: request.kind });
    this.changes.emit("agents", "computers");
    return { request: { ...request, issuedAt: at }, agent, computer, token };
  }

  // ---- sweeps ----

  /** Every minute: requests past their time are marked expired. Returns how many. */
  sweepMinute(): number {
    const expired = this.db.query("UPDATE consent_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= $now").run({ now: this.iso() }).changes;
    if (expired > 0) this.changes.emit("approvals");
    return expired;
  }

  /** Daily: requests that ended a week ago. Returns how many. */
  sweep(): number {
    return this.db.query("DELETE FROM consent_requests WHERE expires_at < $cutoff").run({ cutoff: new Date(this.now().getTime() - KEEP_MS).toISOString() }).changes;
  }

  // ---- helpers ----

  private row(id: string): Row | null {
    return this.db.query("SELECT * FROM consent_requests WHERE id = $id").get({ id }) as Row | null;
  }

  private toRequest(row: Row): ConsentRequest {
    const late = row.status === "pending" && Date.parse(row.expires_at) <= this.now().getTime();
    return {
      id: row.id,
      kind: row.kind,
      status: late ? "expired" : row.status,
      code: row.code,
      agentId: row.agent_id,
      personId: row.person_id,
      workspaceId: row.workspace_id,
      shareId: row.share_id,
      name: row.name,
      agentKind: row.agent_kind as AgentKind | null,
      detail: JSON.parse(row.detail) as ConsentRequest["detail"],
      result: row.result ? (JSON.parse(row.result) as ConsentRequest["result"]) : null,
      computerId: row.computer_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      issuedAt: row.issued_at,
    };
  }

  private iso(): string {
    return this.now().toISOString();
  }
}
