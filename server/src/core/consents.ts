import type { Database } from "bun:sqlite";
import type { Activity } from "./activity";
import type { Agents } from "./agents";
import { checkAgentName } from "./agents";
import type { Changes } from "./changes";
import { APP_KINDS, COMPUTER_KINDS, type Computers, signInCode } from "./computers";
import { PorticoError } from "./errors";
import { quote } from "./framing";
import { DAY_MS, LIMITS, MINUTE_MS } from "./limits";
import { requireUnreservedName } from "./names";
import type { People } from "./people";
import { DEAD_LINK, IN_ALREADY, type Share, type Shares } from "./shares";
import { hashSecret, newToken, sameSecret } from "./tokens";
import type { Agent, AgentKind, AgentsPolicy, Computer, Person, Workspace } from "./types";
import { cleanAgentsPolicy, cleanWorkspaceName, type Workspaces } from "./workspaces";

/**
 * What a consent request asks for. `computer` and `agent`: a new computer or app agent joins Portico. `enter`: an agent
 * already on Portico comes into a workspace with a share link. `share`, `remove_person`, `delete`: an agent asks the
 * person who manages it to share a workspace, take a person out of one, or delete one. `add_agent`: an agent asks its
 * person to put one of that person's agents into a workspace someone else owns. `admit_agent`: the same, waiting for
 * the workspace's owner, who chose to be asked for each agent that person adds. `create`, `remove_agent`, `rename` (and
 * `add_agent` for a workspace the person owns): what an agent nobody vouched for asks before it changes anything.
 */
export type ConsentKind = "computer" | "agent" | "enter" | "share" | "remove_person" | "delete" | "add_agent" | "admit_agent" | "create" | "remove_agent" | "rename";
/**
 * What an agent nobody vouched for asks its person before changing that person's workspaces, where a vouched-for agent
 * acts at once: make a workspace, put an agent into one the person owns, take one out, or rename one.
 */
export type Change =
  | { kind: "create"; name: unknown; agents: Agent[] }
  | { kind: "add_agent"; workspaceId: string; subject: Agent }
  | { kind: "remove_agent"; workspaceId: string; subject: Agent }
  | { kind: "rename"; workspaceId: string; name: unknown };
/**
 * `allowed` is only for a join: a person pressed Allow and the page shows that person a code, but nothing has joined.
 * The join happens (`approved`) once the asker hands that code back.
 */
export type ConsentStatus = "pending" | "allowed" | "approved" | "denied" | "expired";
/** The kinds anyone can start, with no token: whoever signs in, presses Allow and gives the asker the code becomes the owner. */
export type JoinKind = "computer" | "agent";
/** The kinds an agent asks about a workspace of its person's. */
export type AskKind = "share" | "remove_person" | "delete";

export const isJoin = (kind: ConsentKind): kind is JoinKind => kind === "computer" || kind === "agent";
/** The states in which a request still waits: for a person's answer, or (a join) for the code. */
const OPEN = "status IN ('pending', 'allowed')";

/** One thing waiting for a person's Allow on the consent page, `/c/<id>`. */
export interface ConsentRequest {
  id: string;
  kind: ConsentKind;
  status: ConsentStatus;
  /**
   * Only for a join, and only once a person pressed Allow: four digits the consent page shows that person, to hand to
   * the computer or agent that asked. The asker never gets the code from Portico, so a join started by someone else
   * ends with nothing unless the person hands that someone the code.
   */
  code: string | null;
  /** The agent asking (`enter` and the asks), or the app agent that was made (`agent`, once allowed). */
  agentId: string | null;
  /** Who has to confirm, when that is known: only that person can open the page. Null for a join: whoever signs in. */
  personId: string | null;
  workspaceId: string | null;
  /** `enter`: the link used. `agent`: the link the new agent brought, when it brought one. */
  shareId: string | null;
  /** The name a joining computer or agent asked for. */
  name: string | null;
  /** `agent`: the app's kind. `computer`: the coding agent that started the join, when it said. */
  agentKind: AgentKind | null;
  /**
   * `share`: the address to email the link to, or null, and the owner's choice for the person coming in.
   * `remove_person`: the person to take out. `add_agent` and `admit_agent`: the agent to put in; `admit_agent` also
   * the person who asked (`personId`). `agent` with a share link, once allowed: the person's own agents ticked to
   * come in too (`bring`). A join, once allowed: whether the person ticked "started this join" (`mine`).
   */
  detail: { email?: string | null; personId?: string; agents?: AgentsPolicy; agentId?: string; bring?: string[]; mine?: boolean; allow?: boolean; name?: string; agentIds?: string[] };
  /** `share`, once allowed: the share that was made. `create`: the workspace that was made. */
  result: { shareId?: string; workspaceId?: string } | null;
  /** `computer`, once joined: the computer that was made. */
  computerId: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** When the token was handed to a joining computer or agent: with the answer to the right code. */
  issuedAt: string | null;
}

interface Row {
  id: string;
  kind: ConsentKind;
  status: ConsentStatus;
  code: string | null;
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
  /** `remove_person`: who would be taken out. `admit_agent`: whose agent asks to come in. */
  target: Person | null;
  /** `add_agent` and `admit_agent`: the agent to put in. */
  subject: Agent | null;
  /** `enter`, and `agent` with a share link: the viewer's own agents that could come in too, the asking one first. */
  candidates: Agent[];
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
/** Requests other people's agents can have waiting for one workspace owner at once, counted apart from the owner's own. */
const MAX_ADMITS_WAITING_PER_OWNER = 100;

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
  /** A request ended: allowed (for a join, once it joined) or turned down. The place to tell the person what joined. */
  onDecided?: (request: ConsentRequest) => void;
}

/**
 * Consent requests: everything a person confirms on the one consent page. What an agent of a person's asks can be
 * opened and answered only by that person, signed in, and takes no code. A join is started by a computer or agent that
 * nobody owns yet, so its link can be sent to anyone: pressing Allow there joins nothing, and only shows the person a
 * 4-digit code. The join happens once the asker hands that code back, so only an asker the person gave the code to
 * gets in; a few wrong codes close the request, and it runs out after a few minutes. Every change is made as the
 * person, so every rule for the person applies again.
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
  private readonly onDecided: (request: ConsentRequest) => void;

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
    this.onDecided = deps.onDecided ?? (() => {});
  }

  // ---- starting a request ----

  /**
   * A computer or an app agent that isn't on Portico asks to join. Anyone can ask, so nothing here names an account:
   * the computer or agent will belong to whoever signs in, presses Allow on the page and gives the asker the code the
   * page then shows. `client` is the address the request came from, which caps how many one client has waiting. With
   * `link`, a new app agent also comes into the workspace a share link is for. `replaces` ends an earlier request of
   * the same asker, so asking again leaves one request waiting, not two. The poll secret is returned only here.
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
      (this.db.query(`SELECT COUNT(*) AS n FROM consent_requests WHERE ${OPEN} AND expires_at > $now AND person_id IS NULL AND ${where}`).get({ now, ...bindings }) as { n: number }).n;
    // Across every client, a request nobody signed in to look at stops counting after a few minutes: requests made
    // only to use the limit up can't keep everyone else from joining for the full time a request waits.
    const fresh = new Date(this.now().getTime() - LIMITS.consentUnopenedMinutes * MINUTE_MS).toISOString();
    // "local" stands for every client without an address of its own, so it has no limit of its own to use up.
    const perClient = client !== "local" && waiting("client = $client", { client }) >= LIMITS.consentWaitingPerClient;
    if (perClient || waiting("(opened_at IS NOT NULL OR created_at > $fresh)", { fresh }) >= LIMITS.consentWaitingJoins) {
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
    this.db.query(`UPDATE consent_requests SET status = 'expired' WHERE id = $id AND ${OPEN}`).run({ id });
  }

  /**
   * An agent already on Portico asks to come into the workspace a share link is for. Nothing changes until the person
   * who manages the agent allows it. Asking again while a request waits answers the same request; once that has run
   * out, a fresh one.
   */
  enter(agent: Agent, rawLink: unknown): ConsentRequest {
    const owner = this.people.require(agent.ownerId);
    // A link works once. Only the person it let in is told so, with the way to bring more agents in.
    const already = this.shares.usedBy(rawLink, owner.id);
    if (already) {
      throw new PorticoError(
        "wrong_status",
        `This share link already let ${quote(owner.name)} into ${already.phrase}, and a link works once. To put this agent there too, use add_to_portico.`,
      );
    }
    const share = this.shares.usable(rawLink);
    if (!this.shares.mayClaim(share, owner)) throw new PorticoError("not_found", DEAD_LINK);
    const place = this.workspaces.get(share.workspaceId);
    if (place && this.workspaces.hasPerson(place.id, owner.id) && !this.workspaces.hasAgent(place.id, agent.id)) throw new PorticoError("wrong_status", IN_ALREADY(place.phrase));
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
  ask(agent: Agent, kind: AskKind, workspaceId: string, input: { email?: unknown; person?: unknown; agents?: unknown } = {}): ConsentRequest {
    const workspace = this.shares.sharedFor(agent.ownerId, workspaceId);
    let detail: ConsentRequest["detail"];
    if (kind === "share") {
      if (workspace.ownerId !== agent.ownerId) {
        throw new PorticoError("not_allowed", `Only the owner of ${workspace.phrase} can share that Portico: the owner decides who comes in.`);
      }
      detail = { email: this.shares.emailFor(input.email), agents: cleanAgentsPolicy(input.agents) };
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

  /**
   * An agent asks to put one of its person's agents into a workspace someone else owns. Where the person adds agents
   * alone, the person confirms on the consent page. Where the owner chose to be asked, the request goes to the owner
   * instead (`askOwner`).
   */
  askToAdd(agent: Agent, workspaceId: string, subject: Agent): ConsentRequest {
    const workspace = this.shares.sharedFor(agent.ownerId, workspaceId);
    if (subject.ownerId !== agent.ownerId) throw new PorticoError("not_allowed", "Only the person who manages an agent can add the agent to a Portico.");
    if (this.workspaces.hasAgent(workspace.id, subject.id)) throw new PorticoError("wrong_status", `That agent is already in ${workspace.phrase}.`);
    if (this.workspaces.asksOwner(workspace.id, agent.ownerId)) return this.askOwner(agent.ownerId, workspace.id, subject, agent);
    return this.askOnce({ kind: "add_agent", agentId: agent.id, personId: agent.ownerId, workspaceId: workspace.id, detail: { agentId: subject.id } });
  }

  /**
   * An agent nobody vouched for asks its person for a change that a vouched-for agent makes at once. Everything is
   * checked here as far as it can be, and again when the person allows it, as the person.
   */
  askChange(agent: Agent, change: Change): ConsentRequest {
    const input = { agentId: agent.id, personId: agent.ownerId };
    if (change.kind === "create") {
      const name = cleanWorkspaceName(change.name);
      if (change.agents.some((a) => a.ownerId !== agent.ownerId)) throw new PorticoError("not_allowed", "Only the person who manages an agent can add the agent to a Portico.");
      return this.askOnce({ ...input, kind: "create", workspaceId: null, detail: { name, agentIds: change.agents.map((a) => a.id) } });
    }
    const workspace = this.workspaces.get(change.workspaceId);
    if (!workspace || !this.workspaces.hasPerson(workspace.id, agent.ownerId)) throw new PorticoError("not_found", "No such Portico.");
    if (change.kind === "rename") {
      if (workspace.ownerId !== agent.ownerId) throw new PorticoError("not_allowed", `Only the owner of ${workspace.phrase} can rename that Portico.`);
      return this.askOnce({ ...input, kind: "rename", workspaceId: workspace.id, detail: { name: cleanWorkspaceName(change.name) } });
    }
    if (change.subject.ownerId !== agent.ownerId) throw new PorticoError("not_allowed", "Only the person who manages an agent can move the agent.");
    return this.askOnce({ ...input, kind: change.kind, workspaceId: workspace.id, detail: { agentId: change.subject.id } });
  }

  /**
   * A person in a workspace whose owner chose to be asked wants one more of the person's own agents in. The request
   * waits for the owner, for days rather than minutes: nobody but the owner, signed in, can answer.
   * `asker` is the agent that asked, when one did.
   */
  askOwner(personId: string, workspaceId: string, subject: Agent, asker: Agent | null = null): ConsentRequest {
    const workspace = this.shares.sharedFor(personId, workspaceId);
    if (subject.ownerId !== personId) throw new PorticoError("not_allowed", "Only the person who manages an agent can add the agent to a Portico.");
    if (subject.revokedAt !== null) throw new PorticoError("not_allowed", "A revoked agent can't be put in a Portico.");
    if (this.workspaces.hasAgent(workspace.id, subject.id)) throw new PorticoError("wrong_status", `That agent is already in ${workspace.phrase}.`);
    // One request for one agent, whoever asked: the agent itself, another agent of the person, or the person's pages.
    const same = this.db
      .query("SELECT * FROM consent_requests WHERE kind = 'admit_agent' AND workspace_id = $workspaceId AND status = 'pending' AND expires_at > $now AND json_extract(detail, '$.agentId') = $agentId")
      .get({ workspaceId: workspace.id, agentId: subject.id, now: this.iso() }) as Row | null;
    if (same) return this.toRequest(same);
    const waiting = (
      this.db
        .query("SELECT COUNT(*) AS n FROM consent_requests WHERE kind = 'admit_agent' AND workspace_id = $workspaceId AND status = 'pending' AND expires_at > $now AND json_extract(detail, '$.personId') = $personId AND json_extract(detail, '$.agentId') != $agentId")
        .get({ workspaceId: workspace.id, personId, agentId: subject.id, now: this.iso() }) as { n: number }
    ).n;
    if (waiting >= LIMITS.admitWaitingPerPerson) {
      throw new PorticoError("rate_limited", `Too many requests already wait for the owner of ${workspace.phrase}. Ask again once some are answered.`);
    }
    return this.askOnce(
      { kind: "admit_agent", agentId: asker?.id ?? subject.id, personId: workspace.ownerId, workspaceId: workspace.id, detail: { agentId: subject.id, personId } },
      null,
      LIMITS.admitDays * DAY_MS,
    );
  }

  /** The same request while one waits; otherwise the old one is closed and a fresh one made. */
  private askOnce(
    input: { kind: ConsentKind; agentId: string; personId: string; workspaceId: string | null; shareId?: string; detail?: ConsentRequest["detail"] },
    share: Share | null = null,
    waitMs: number = LIMITS.consentMinutes * MINUTE_MS,
  ): ConsentRequest {
    const detail = JSON.stringify(input.detail ?? {});
    const same = { kind: input.kind, agentId: input.agentId, workspaceId: input.workspaceId, shareId: input.shareId ?? null, detail };
    const match = "kind = $kind AND agent_id = $agentId AND workspace_id IS $workspaceId AND share_id IS $shareId AND detail = $detail AND status = 'pending'";
    const waiting = this.db.query(`SELECT * FROM consent_requests WHERE ${match} AND expires_at > $now`).get({ ...same, now: this.iso() }) as Row | null;
    if (waiting) return this.toRequest(waiting);
    this.db.query(`UPDATE consent_requests SET status = 'expired' WHERE ${match}`).run(same);
    // What other people ask a workspace's owner (`admit_agent`) is counted apart, with its own limits in `askOwner`:
    // members can't use up what the owner's own agents may ask.
    const counted = input.kind === "admit_agent" ? "kind = 'admit_agent'" : "kind != 'admit_agent'";
    const open = (this.db.query(`SELECT COUNT(*) AS n FROM consent_requests WHERE person_id = $personId AND ${counted} AND status = 'pending' AND expires_at > $now`).get({ personId: input.personId, now: this.iso() }) as { n: number }).n;
    if (open >= (input.kind === "admit_agent" ? MAX_ADMITS_WAITING_PER_OWNER : MAX_WAITING_PER_PERSON)) {
      throw new PorticoError("rate_limited", "Too many requests are waiting for this person. list_porticos shows them; ask again once some are answered or have run out.");
    }
    const request = this.insert({ ...input, shareId: input.shareId ?? null, name: null, agentKind: null, client: null, pollSecret: null }, share, waitMs);
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
    waitMs: number = LIMITS.consentMinutes * MINUTE_MS,
  ): ConsentRequest {
    const at = this.now();
    // A request never outlives the link it came with.
    const until = Math.min(at.getTime() + waitMs, share ? Date.parse(share.expiresAt) : Infinity);
    const request: ConsentRequest = {
      id: this.newId(),
      kind: input.kind,
      status: "pending",
      code: null,
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
        `INSERT INTO consent_requests (id, kind, status, poll_hash, client, agent_id, person_id, workspace_id, share_id, name, agent_kind, detail, created_at, expires_at)
         VALUES ($id, $kind, 'pending', $pollHash, $client, $agentId, $personId, $workspaceId, $shareId, $name, $agentKind, $detail, $createdAt, $expiresAt)`,
      )
      .run({
        id: request.id,
        kind: request.kind,
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
    this.changes.about({ people: [request.personId, request.detail.personId] }, "approvals");
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

  /** What this person, or an agent of this person's, asked the owners of other people's workspaces in the last day, newest first. */
  recentAskedBy(personId: string): ConsentRequest[] {
    const rows = this.db
      .query("SELECT * FROM consent_requests WHERE kind = 'admit_agent' AND json_extract(detail, '$.personId') = $personId AND created_at > $since ORDER BY created_at DESC, id")
      .all({ personId, since: new Date(this.now().getTime() - DAY_MS).toISOString() }) as Row[];
    return rows.map((row) => this.toRequest(row));
  }

  /**
   * The request as this person may see it on the consent page, or null, which looks the same as no request at all.
   * What an agent of someone's asked is only that person's to see. A join is nobody's yet, so anyone signed in who has
   * its link may see it while it waits (it names no account), and afterwards only the person who answered it: the code
   * is on this view, so nobody else ever reads it. A join that came with a share link is only for a person the link is
   * for.
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
    const agent = request.agentId ? this.agents.get(request.agentId) : null;
    // With a share link the person picks any number of their own agents, on the one page: every agent of the person
    // that isn't in the workspace yet, the asking one first.
    const picks = share && request.status === "pending" && (request.kind === "enter" || request.kind === "agent");
    const candidates = picks
      ? this.agents
          .ownedBy(viewer.id)
          .filter((a) => a.revokedAt === null && !this.workspaces.hasAgent(share.workspaceId, a.id))
          .sort((a, b) => Number(b.id === agent?.id) - Number(a.id === agent?.id))
      : [];
    return {
      request,
      agent,
      workspace,
      share,
      sharedBy: share ? this.people.get(share.createdBy) : null,
      target: request.detail.personId ? this.people.get(request.detail.personId) : null,
      subject: request.detail.agentId ? this.agents.get(request.detail.agentId) : null,
      candidates,
    };
  }

  /** A signed-in person opened a join's page: the request counts as one somebody is answering. */
  opened(id: string): void {
    this.db.query("UPDATE consent_requests SET opened_at = $at WHERE id = $id AND opened_at IS NULL AND person_id IS NULL").run({ id, at: this.iso() });
  }

  // ---- the person's answer ----

  /**
   * The person's answer. For what an agent of the person's asked, Allow does it at once, as the person: an agent comes
   * into the shared workspace, or the workspace is shared, loses a person or is deleted. For a join, Allow joins
   * nothing: it makes the code the page then shows the person, and the join waits for the asker to hand that code back
   * (`submitCode`). `name` renames a joining app agent. `handle` is for a person who has none yet. `agents` is for a
   * share link: the person's own agents that come in, any number, under the one Allow (by default the asking one).
   * `mine` is the join page's tick, "I started this join myself": without it the new agent, or every session on the
   * new computer, starts unproven, and its first message to each other agent of the person waits for the person.
   * Don't allow also ends a join that was allowed and still waits for its code.
   */
  decide(personId: string, id: string, input: { decision: unknown; name?: unknown; handle?: unknown; person?: unknown; agents?: unknown; mine?: unknown; allow?: unknown }): Decided {
    const { decision } = input;
    if (decision !== "approve" && decision !== "deny") throw new PorticoError("bad_request", "decision must be approve or deny.");
    const person = this.people.require(personId);
    const found = this.describe(person, id);
    if (!found) throw new PorticoError("not_found", "No such request.");
    const { request, share } = found;
    const awaitsCode = request.status === "allowed";
    // Allow pressed twice changes nothing: the page shows the same code.
    if (awaitsCode && decision === "approve") return { request, agent: null, computer: null, workspace: found.workspace, share: null };
    if (request.status !== "pending" && !awaitsCode) {
      throw new PorticoError("wrong_status", request.status === "expired" ? "This request ran out. Ask the agent to ask again." : `This request was already ${request.status === "approved" ? "allowed" : "turned down"}.`);
    }
    const at = this.iso();
    if (decision === "deny") {
      this.db.query(`UPDATE consent_requests SET status = 'denied', code = NULL, decided_at = $at, decided_by = $personId WHERE id = $id AND ${OPEN}`).run({ id, at, personId });
      this.log("consent_decided", { request_id: id, kind: request.kind, decision });
      if (request.kind === "agent") this.activity?.record("sign_in_denied", { personId, detail: { name: request.name ?? "", kind: request.agentKind ?? "other" } });
      this.changes.about({ people: [personId, request.personId, request.detail.personId], agents: [request.agentId] }, "approvals");
      const denied: ConsentRequest = { ...request, status: "denied", code: null, decidedAt: at, decidedBy: personId };
      this.onDecided(denied);
      return { request: denied, agent: null, computer: null, workspace: found.workspace, share: null };
    }
    if (person.status !== "active") throw new PorticoError("not_allowed", "Waiting for the owner to approve this account.");
    const wanted = typeof input.handle === "string" ? input.handle.trim().toLowerCase() : "";
    if (person.handle === null && wanted === "") throw new PorticoError("bad_request", "Pick a handle first.");
    // A new person gives a name on the same page, once. An account that came with one (Google's, say) keeps it unless
    // the person typed another.
    const ownName = typeof input.person === "string" ? input.person.trim() : "";
    if (person.handle === null && ownName === "" && person.name === "New person") throw new PorticoError("bad_request", "Type your name first.");
    // The person's own agents picked on the page to come in with a share link. Anything else named is ignored.
    const pickable = new Map(found.candidates.map((a) => [a.id, a]));
    const picked = Array.isArray(input.agents)
      ? [...new Set(input.agents.filter((item): item is string => typeof item === "string"))].map((item) => pickable.get(item)).filter((a): a is Agent => a !== undefined)
      : null;
    if (isJoin(request.kind)) {
      // The name is settled here, where the person can still change it: the asker's call with the code can't.
      let name = request.name;
      if (request.kind === "agent") {
        name = checkAgentName(input.name === undefined || input.name === null || input.name === "" ? request.name : input.name);
        requireUnreservedName(name);
        if (!this.agents.nameFree(name, person.id)) throw new PorticoError("conflict", `Another agent of ${person.name}'s is named ${name}, or reads the same at a glance. Pick another name.`);
      }
      // `allow`: the person's own tick on the page, with a share link, to take messages from the inviter's agents.
      const detail = { ...request.detail, mine: input.mine === true, ...(share ? { bring: (picked ?? []).map((a) => a.id), allow: input.allow === true } : {}) };
      const code = signInCode();
      this.db.transaction(() => {
        if (person.handle === null) {
          if (ownName !== "") this.people.rename(person.id, ownName);
          this.people.setHandle(person.id, wanted);
          this.workspaces.personal(person.id);
        }
        const changed = this.db
          .query(
            `UPDATE consent_requests SET status = 'allowed', code = $code, tries = 0, name = $name, detail = $detail, decided_at = $at, decided_by = $personId
             WHERE id = $id AND status = 'pending'`,
          )
          .run({ id, code, name, detail: JSON.stringify(detail), at, personId }).changes;
        if (changed === 0) throw new PorticoError("wrong_status", "This request was answered already.");
      })();
      this.log("consent_allowed", { request_id: id, kind: request.kind });
      this.changes.about({ people: [personId] }, "approvals", "people");
      const allowed: ConsentRequest = { ...request, status: "allowed", code, name, detail, decidedAt: at, decidedBy: personId };
      return { request: allowed, agent: null, computer: null, workspace: found.workspace, share: null };
    }
    const done = this.db.transaction(() => {
      if (person.handle === null) {
        if (ownName !== "") this.people.rename(person.id, ownName);
        this.people.setHandle(person.id, wanted);
        this.workspaces.personal(person.id);
      }
      const agent: Agent | null = request.agentId ? this.agents.get(request.agentId) : null;
      let workspace = found.workspace;
      let made: Share | null = null;
      switch (request.kind) {
        case "enter": {
          if (!agent || agent.ownerId !== person.id || !share) throw new PorticoError("not_found", "No such request.");
          const coming = picked ?? [agent];
          if (coming.length === 0) throw new PorticoError("bad_request", "Pick at least one agent to bring in.");
          workspace = this.shares.enter(share, person, coming, { allowInviter: input.allow === true });
          break;
        }
        case "share":
          // `allow` is the person's tick on this page: the asking agent can't set it.
          made = this.shares.create(person.id, request.workspaceId!, { email: request.detail.email, agents: request.detail.agents, allow: input.allow === true }).share;
          break;
        case "add_agent": {
          const subject = found.subject;
          if (!subject || subject.ownerId !== person.id) throw new PorticoError("not_found", "No such request.");
          // The owner may have asked to be asked since: the person's own Allow then isn't enough.
          this.workspaces.addAgent(person.id, request.workspaceId!, subject.id);
          break;
        }
        case "admit_agent": {
          const subject = found.subject;
          const asker = request.detail.personId;
          if (!subject || !asker || subject.ownerId !== asker || found.workspace?.ownerId !== person.id) throw new PorticoError("not_found", "No such request.");
          if (!this.workspaces.hasPerson(request.workspaceId!, asker)) throw new PorticoError("wrong_status", "That person isn't in the Portico any more.");
          this.workspaces.addAgent(asker, request.workspaceId!, subject.id, { ownerAllowed: true });
          break;
        }
        case "delete":
          this.workspaces.remove(person.id, request.workspaceId!);
          break;
        case "create": {
          workspace = this.workspaces.create(person.id, request.detail.name, "consent");
          const wanted = new Set(request.detail.agentIds ?? []);
          for (const a of this.agents.ownedBy(person.id)) if (wanted.has(a.id) && a.revokedAt === null) this.workspaces.addAgent(person.id, workspace.id, a.id);
          break;
        }
        case "remove_agent": {
          const subject = found.subject;
          if (!subject || subject.ownerId !== person.id) throw new PorticoError("not_found", "No such request.");
          this.workspaces.removeAgent(person.id, request.workspaceId!, subject.id);
          break;
        }
        case "rename":
          workspace = this.workspaces.rename(person.id, request.workspaceId!, request.detail.name ?? "");
          break;
        case "remove_person":
          this.workspaces.removePerson(person.id, request.workspaceId!, request.detail.personId!);
          break;
      }
      const result = made ? { shareId: made.id } : request.kind === "create" && workspace ? { workspaceId: workspace.id } : null;
      this.db
        .query("UPDATE consent_requests SET status = 'approved', result = $result, workspace_id = COALESCE($madeId, workspace_id), decided_at = $at, decided_by = $personId WHERE id = $id")
        .run({ id, result: result ? JSON.stringify(result) : null, madeId: result?.workspaceId ?? null, at, personId });
      const decided: ConsentRequest = { ...request, status: "approved", workspaceId: result?.workspaceId ?? request.workspaceId, result, decidedAt: at, decidedBy: personId };
      return { request: decided, agent, computer: null, workspace, share: made };
    })();
    this.log("consent_decided", { request_id: id, kind: request.kind, decision });
    this.changes.about({ people: [personId, request.personId, request.detail.personId], agents: [request.agentId], workspaces: [done.request.workspaceId] }, "approvals", "workspaces", "agents", "people", "computers");
    this.onDecided(done.request);
    return done;
  }

  // ---- the asker's side of a join ----

  /**
   * The asker hands back the code its person read on the consent page, with its poll secret. The right code is what
   * joins: the computer or app agent is made under the person who pressed Allow, and the token comes back here,
   * exactly once. A wrong code counts, and the request closes after a few, so the code can't be guessed. Before a
   * person pressed Allow there is no code, and nothing here says who that person is.
   */
  submitCode(id: string, pollSecret: string | null, code: unknown): { request: ConsentRequest; agent: Agent | null; computer: Computer | null; token: string | null } {
    const row = this.asker(id, pollSecret);
    const request = this.toRequest(row);
    if (request.status === "pending") throw new PorticoError("wrong_status", "Nobody has pressed Allow on Portico's page yet. The page shows the code after Allow.");
    if (request.status !== "allowed" || request.code === null || request.decidedBy === null) {
      throw new PorticoError(
        "wrong_status",
        request.status === "approved" ? "This request already joined." : request.status === "expired" ? "This request ran out. Ask to join again." : "This request was turned down or closed. Ask to join again.",
      );
    }
    const at = this.iso();
    const typed = typeof code === "string" ? code.replace(/\s+/g, "") : "";
    if (!sameSecret(hashSecret(typed), hashSecret(request.code))) {
      const { tries } = this.db.query("UPDATE consent_requests SET tries = tries + 1 WHERE id = $id RETURNING tries").get({ id }) as { tries: number };
      const left = LIMITS.consentCodeTries - tries;
      if (left <= 0) {
        this.db.query("UPDATE consent_requests SET status = 'denied', code = NULL, decided_at = $at WHERE id = $id").run({ id, at });
        this.changes.about({ people: [request.decidedBy] }, "approvals");
        throw new PorticoError("wrong_status", "Too many wrong codes. This request is closed: ask to join again.");
      }
      throw new PorticoError("bad_request", `That code doesn't match the one Portico's page shows. ${left === 1 ? "1 try is" : `${left} tries are`} left.`);
    }
    const person = this.people.require(request.decidedBy);
    if (person.status !== "active") throw new PorticoError("not_allowed", "The account that allowed this request can't take a new agent right now.");
    const share = request.shareId ? this.shares.get(request.shareId) : null;
    const done = this.db.transaction(() => {
      let agent: Agent | null = null;
      let computer: Computer | null = null;
      if (request.kind === "computer") {
        // The token made here is never handed out: the computer gets its own just below.
        computer = this.computers.create(person.id, request.name ?? "computer").computer;
      } else {
        agent = this.agents.create({ ownerId: person.id, name: request.name, kind: request.agentKind ?? "other", type: "app" });
        if (request.shareId) {
          if (!share) throw new PorticoError("not_found", DEAD_LINK);
          const ticked = new Set(request.detail.bring ?? []);
          const more = this.agents.ownedBy(person.id).filter((a) => ticked.has(a.id) && a.revokedAt === null && !this.workspaces.hasAgent(share.workspaceId, a.id));
          if (this.workspaces.hasPerson(share.workspaceId, person.id)) {
            // The person is in that workspace already, so the link brings nobody in and stays unused. The agents go
            // in the way add_to_portico puts them: at once, or by asking the owner where the owner chose to be asked.
            for (const coming of [agent, ...more]) {
              if (this.workspaces.asksOwner(share.workspaceId, person.id)) this.askOwner(person.id, share.workspaceId, coming, agent);
              else this.workspaces.addAgent(person.id, share.workspaceId, coming.id);
            }
          } else {
            this.shares.enter(share, person, [agent, ...more], { allowInviter: request.detail.allow === true });
          }
        }
      }
      // Nobody vouched for the join: the newcomer's first message to each other agent of the person is asked about.
      if (request.detail.mine !== true) this.agents.markUnproven(agent ? { agentId: agent.id } : { computerId: computer!.id });
      const claimed = this.db
        .query("UPDATE consent_requests SET status = 'approved', code = NULL, agent_id = $agentId, computer_id = $computerId, issued_at = $at WHERE id = $id AND status = 'allowed'")
        .run({ id, agentId: agent?.id ?? null, computerId: computer?.id ?? null, at }).changes;
      if (claimed === 0) throw new PorticoError("wrong_status", "This request already joined.");
      const joined: ConsentRequest = { ...request, status: "approved", code: null, agentId: agent?.id ?? null, computerId: computer?.id ?? null, issuedAt: at };
      return { request: joined, agent: agent ? this.agents.get(agent.id) : null, computer };
    })();
    let token: string;
    if (done.computer) token = this.computers.issueToken(done.computer.id);
    else {
      token = this.agents.issueToken(done.agent!.id, "api");
      this.agents.checkedIn(done.agent!);
    }
    this.log("consent_decided", { request_id: id, kind: request.kind, decision: "approve" });
    this.log("consent_token_issued", { request_id: id, kind: request.kind });
    this.changes.about({ people: [person.id], workspaces: [request.workspaceId] }, "approvals", "workspaces", "agents", "people", "computers");
    this.onDecided(done.request);
    // The person is told at once what joined the account, with the one step that undoes it.
    if (done.agent) this.agents.onJoined?.(done.agent);
    if (done.computer) this.computers.onJoined?.(done.computer);
    return { ...done, token };
  }

  /**
   * A joining computer's or agent's poll, with its poll secret: where the request stands, and nothing else. `allowed`
   * says a person pressed Allow and holds the code; never the code, and never who. A missing or wrong secret answers
   * the same as no request.
   */
  poll(id: string, pollSecret: string | null): { request: ConsentRequest; agent: Agent | null; computer: Computer | null } {
    const request = this.toRequest(this.asker(id, pollSecret));
    const agent = request.kind === "agent" && request.agentId ? this.agents.get(request.agentId) : null;
    const computer = request.computerId ? this.computers.get(request.computerId) : null;
    return { request, agent, computer };
  }

  private asker(id: string, pollSecret: string | null): Row {
    const row = this.row(id);
    if (!row || !row.poll_hash || !pollSecret || !sameSecret(hashSecret(pollSecret), row.poll_hash)) {
      throw new PorticoError("unauthorized", "Missing or wrong poll secret for this request.");
    }
    return row;
  }

  // ---- sweeps ----

  /** Every minute: requests past their time are marked expired. Returns how many. */
  sweepMinute(): number {
    const expired = this.db.query(`UPDATE consent_requests SET status = 'expired', code = NULL WHERE ${OPEN} AND expires_at <= $now`).run({ now: this.iso() }).changes;
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
    const late = (row.status === "pending" || row.status === "allowed") && Date.parse(row.expires_at) <= this.now().getTime();
    return {
      id: row.id,
      kind: row.kind,
      status: late ? "expired" : row.status,
      code: late ? null : row.code,
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
