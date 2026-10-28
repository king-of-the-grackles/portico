import type { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";
import type { Activity } from "./activity";
import type { Agents } from "./agents";
import { checkAgentName } from "./agents";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import { DAY_MS, HOUR_MS, LIMITS, MINUTE_MS } from "./limits";
import { hashSecret, LINK_SECRET, newLinkSecret, newToken, sameSecret } from "./tokens";
import { AGENT_KINDS } from "./types";
import type { Agent, AgentKind, Computer } from "./types";
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

/** Join lines for coding agents on a computer: the computer joins, then each session registers itself. */
export const COMPUTER_KINDS: readonly AgentKind[] = ["claude-code", "codex"];
/** Join lines for app agents, which ask to sign in and show a code. */
export const APP_KINDS: readonly AgentKind[] = ["muse", "grok-bot", "dots", "claude-duet", "other"];

const COMPUTER_LABELS: Partial<Record<AgentKind, string>> = { "claude-code": "Claude Code", codex: "Codex" };
const APP_LINE = "This join line is for an app agent. Follow the steps for app agents at /join.";
/** Kinds an MCP connector can be, signing in with OAuth from the server address instead of a join line. */
export const CONNECTOR_KINDS: readonly AgentKind[] = ["dots", "claude-duet", "other"];

/** A one-time line from Add agent: a computer joins with it, or an app agent asks to sign in with it. */
export interface JoinLine {
  id: string;
  createdBy: string;
  kind: AgentKind;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  /** Computer lines: the computer the line added. */
  computerId: string | null;
  /** The first agent that joined through the line. */
  agentId: string | null;
}

interface JoinLineRow {
  id: string;
  created_by: string;
  kind: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  computer_id: string | null;
  agent_id: string | null;
}

function toJoinLine(row: JoinLineRow): JoinLine {
  return {
    id: row.id,
    createdBy: row.created_by,
    kind: row.kind as AgentKind,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    computerId: row.computer_id,
    agentId: row.agent_id,
  };
}

export type SignInStatus = "pending" | "approved" | "denied" | "expired";

/** An app agent's request to join, waiting for the person who made the join line. */
export interface SignInRequest {
  id: string;
  joinLineId: string;
  kind: AgentKind;
  /** The name the agent asked for. The person may change the name when approving. */
  name: string;
  /** Four digits the agent shows in its chat, so the person can match the request to the chat. */
  code: string;
  status: SignInStatus;
  agentId: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** When the agent's token was handed over, at the first poll after approval. */
  issuedAt: string | null;
}

interface SignInRow {
  id: string;
  join_line_id: string;
  kind: string;
  name: string;
  code: string;
  poll_hash: string;
  status: string;
  agent_id: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  issued_at: string | null;
}

const MAX_DEDUPE = 99;
/** A computer's last_seen_at is written at most this often. */
const TOUCH_INTERVAL_MS = 60_000;
/** Join lines are deleted a day after they expire; their sign-in requests go with them. */
const JOIN_LINE_KEEP_MS = DAY_MS;
/** Registered OAuth clients with no tokens and no codes are deleted after this. */
const IDLE_CLIENT_MS = 7 * DAY_MS;
const AGAIN = "Make a new one with Add agent on Portico.";

/** A joining computer's proposed name (usually its hostname) as a computer name: slugged, without `.local`. */
export function computerSlug(raw: string): string {
  return slugify(raw.trim().replace(/\.local$/i, ""), "computer");
}

/** The secret of a join line, given alone or as the whole line or link (the part after the last `#`). */
export function joinSecret(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const secret = raw.slice(raw.lastIndexOf("#") + 1).trim();
  return LINK_SECRET.test(secret) ? secret : null;
}

/** Four digits from a secure random source, leading zeros kept. */
export function signInCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, "0");
}

export interface ComputersDeps {
  db: Database;
  changes: Changes;
  activity?: Activity;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Computers that joined, and their folders' "Join from the folder" switches; join lines, which add a computer or let
 * an app agent ask to sign in; and app agents' sign-in requests.
 */
export class Computers {
  private readonly db: Database;
  private readonly changes: Changes;
  private readonly activity: Activity | undefined;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  private readonly touchedAt = new Map<string, number>();

  constructor(deps: ComputersDeps) {
    this.db = deps.db;
    this.changes = deps.changes;
    this.activity = deps.activity;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
    // A computer line's first session registers through the agents module; linking it here lets the Add agent sheet
    // see "<name> joined" without the agents module knowing about join lines.
    this.changes.on((topics) => {
      if (topics.includes("agents")) this.linkFirstSessions();
    });
  }

  // ---- computers ----

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
    this.activity?.record("computer_joined", { personId: ownerId, detail: { computer: computer.name } });
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

  // ---- join lines ----

  /** A join line for one kind of agent. The secret is returned only here and stored only as a hash. */
  createJoinLine(personId: string, kind: unknown): { joinLine: JoinLine; secret: string } {
    const kinds = [...COMPUTER_KINDS, ...APP_KINDS];
    if (!kinds.some((k) => k === kind)) throw new PorticoError("bad_request", `kind must be one of: ${kinds.join(", ")}.`);
    const secret = newLinkSecret();
    const at = this.now();
    const joinLine: JoinLine = {
      id: this.newId(),
      createdBy: personId,
      kind: kind as AgentKind,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + LIMITS.joinLineHours * HOUR_MS).toISOString(),
      usedAt: null,
      computerId: null,
      agentId: null,
    };
    this.db
      .query(
        `INSERT INTO join_lines (id, created_by, kind, secret_hash, created_at, expires_at)
         VALUES ($id, $createdBy, $kind, $hash, $createdAt, $expiresAt)`,
      )
      .run({
        id: joinLine.id,
        createdBy: personId,
        kind: joinLine.kind,
        hash: hashSecret(secret),
        createdAt: joinLine.createdAt,
        expiresAt: joinLine.expiresAt,
      });
    this.log("join_line_created", { join_line_id: joinLine.id, kind: joinLine.kind });
    this.changes.emit("join-lines");
    return { joinLine, secret };
  }

  joinLine(id: string): JoinLine | null {
    const row = this.db.query("SELECT * FROM join_lines WHERE id = $id").get({ id }) as JoinLineRow | null;
    return row ? toJoinLine(row) : null;
  }

  /**
   * Redeems a computer line: adds a computer for the person who made the line, under the first free form of the
   * proposed name, and returns its token once. The line works once.
   */
  redeem(rawSecret: unknown, proposedName: unknown): { computer: Computer; token: string; joinLine: JoinLine } {
    const name = typeof proposedName === "string" && proposedName.trim() !== "" ? proposedName.slice(0, 200) : "computer";
    return this.db.transaction(() => {
      const line = this.usableLine(rawSecret);
      if (!COMPUTER_KINDS.includes(line.kind)) throw new PorticoError("bad_request", APP_LINE);
      const { computer, token } = this.create(line.createdBy, name);
      const at = this.iso();
      this.db
        .query("UPDATE join_lines SET used_at = $at, computer_id = $computerId WHERE id = $id")
        .run({ id: line.id, at, computerId: computer.id });
      this.log("computer_joined", { join_line_id: line.id, computer: computer.name });
      this.changes.emit("join-lines");
      return { computer, token, joinLine: { ...line, usedAt: at, computerId: computer.id } };
    })();
  }

  /**
   * Uses a computer line on a computer that already joined, e.g. a Codex line on a computer where Claude Code joined
   * first: the line is marked used by that computer, and no second computer is made. Only the computer's own person's
   * line can attach.
   */
  attach(computer: Computer, rawSecret: unknown): JoinLine {
    return this.db.transaction(() => {
      const line = this.usableLine(rawSecret);
      if (!COMPUTER_KINDS.includes(line.kind)) throw new PorticoError("bad_request", APP_LINE);
      if (line.createdBy !== computer.ownerId) {
        throw new PorticoError(
          "not_allowed",
          "This join line is from a different person than the one this computer joined for. Ask that person for a join line.",
        );
      }
      const at = this.iso();
      this.db
        .query("UPDATE join_lines SET used_at = $at, computer_id = $computerId WHERE id = $id")
        .run({ id: line.id, at, computerId: computer.id });
      this.log("join_line_attached", { join_line_id: line.id, computer: computer.name });
      this.changes.emit("join-lines");
      return { ...line, usedAt: at, computerId: computer.id };
    })();
  }

  /**
   * Sets each recent computer line's agent to the agent of the first run of the line's kind started on its computer
   * since the line was used, once one has.
   */
  linkFirstSessions(): number {
    const first = `FROM agent_runs r WHERE r.computer_id = join_lines.computer_id AND r.client = join_lines.kind
           AND r.started_at >= join_lines.used_at`;
    const changed = this.db
      .query(
        `UPDATE join_lines SET agent_id = (SELECT r.agent_id ${first} ORDER BY r.started_at, r.id LIMIT 1)
         WHERE agent_id IS NULL AND computer_id IS NOT NULL AND used_at >= $since AND EXISTS (SELECT 1 ${first})`,
      )
      .run({ since: this.iso(-LIMITS.joinLineHours * HOUR_MS) }).changes;
    if (changed > 0) this.changes.emit("join-lines");
    return changed;
  }

  // ---- app agents' sign-in requests ----

  /**
   * An app agent asks to join with an app line. Creating the request uses up the line. The agent shows the 4-digit
   * code in its chat and polls with the poll secret, which is returned only here.
   */
  requestSignIn(rawSecret: unknown, input: { name: unknown; kind?: unknown }): { request: SignInRequest; pollSecret: string } {
    const name = checkAgentName(input.name);
    if (input.kind !== undefined && input.kind !== null && !AGENT_KINDS.some((k) => k === input.kind)) {
      throw new PorticoError("bad_request", `kind must be one of: ${AGENT_KINDS.join(", ")}.`);
    }
    return this.db.transaction(() => {
      const line = this.usableLine(rawSecret);
      if (!APP_KINDS.includes(line.kind)) {
        const label = COMPUTER_LABELS[line.kind] ?? "a coding agent";
        throw new PorticoError("bad_request", `This join line is for ${label} on a computer. Follow the ${label} steps at /join.`);
      }
      // The person picked the kind with the line. Only a line for any other app takes the agent's own word for it.
      const asked = input.kind as AgentKind | undefined;
      const kind = line.kind === "other" && asked && APP_KINDS.includes(asked) ? asked : line.kind;
      const pollSecret = newToken("ps_");
      const at = this.now();
      const request: SignInRequest = {
        id: this.newId(),
        joinLineId: line.id,
        kind,
        name,
        code: signInCode(),
        status: "pending",
        agentId: null,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + LIMITS.signInRequestMinutes * MINUTE_MS).toISOString(),
        decidedAt: null,
        decidedBy: null,
        issuedAt: null,
      };
      this.db
        .query(
          `INSERT INTO sign_in_requests (id, join_line_id, kind, name, code, poll_hash, status, created_at, expires_at)
           VALUES ($id, $lineId, $kind, $name, $code, $pollHash, 'pending', $createdAt, $expiresAt)`,
        )
        .run({
          id: request.id,
          lineId: line.id,
          kind,
          name,
          code: request.code,
          pollHash: hashSecret(pollSecret),
          createdAt: request.createdAt,
          expiresAt: request.expiresAt,
        });
      this.db.query("UPDATE join_lines SET used_at = $at WHERE id = $id").run({ id: line.id, at: request.createdAt });
      this.log("sign_in_requested", { request_id: request.id, kind });
      this.changes.emit("approvals", "join-lines");
      return { request, pollSecret };
    })();
  }

  /** The request, reported `expired` once its time is up even before the minute sweep marks it. */
  signInRequest(id: string): SignInRequest | null {
    const row = this.db.query("SELECT * FROM sign_in_requests WHERE id = $id").get({ id }) as SignInRow | null;
    return row ? this.toSignIn(row) : null;
  }

  /** The sign-in request made with a join line. A line makes at most one. */
  signInForLine(joinLineId: string): SignInRequest | null {
    const row = this.db
      .query("SELECT * FROM sign_in_requests WHERE join_line_id = $joinLineId ORDER BY created_at DESC LIMIT 1")
      .get({ joinLineId }) as SignInRow | null;
    return row ? this.toSignIn(row) : null;
  }

  /** Requests still waiting from join lines the person made, oldest first. */
  pendingSignIns(personId: string): SignInRequest[] {
    const rows = this.db
      .query(
        `SELECT r.* FROM sign_in_requests r JOIN join_lines l ON l.id = r.join_line_id
         WHERE l.created_by = $personId AND r.status = 'pending' AND r.expires_at > $now
         ORDER BY r.created_at, r.id`,
      )
      .all({ personId, now: this.iso() }) as SignInRow[];
    return rows.map((row) => this.toSignIn(row));
  }

  /**
   * Approves or denies a request. Only the person who made the join line may decide, and only while the request waits.
   * Approving adds the app agent under the given name or the requested one (`conflict` when the name is taken).
   */
  decideSignIn(
    agents: Agents,
    personId: string,
    id: string,
    decision: unknown,
    name?: unknown,
  ): { request: SignInRequest; agent: Agent | null } {
    if (decision !== "approve" && decision !== "deny") {
      throw new PorticoError("bad_request", "decision must be approve or deny.");
    }
    return this.db.transaction(() => {
      const request = this.signInRequest(id);
      if (!request) throw new PorticoError("not_found", "No such sign in request.");
      const line = this.joinLine(request.joinLineId);
      if (!line || line.createdBy !== personId) {
        throw new PorticoError("not_allowed", "Only the person who made the join line can decide this sign in request.");
      }
      if (request.status !== "pending") {
        throw new PorticoError(
          "wrong_status",
          request.status === "expired" ? "This sign in request expired." : `This sign in request was already ${request.status}.`,
        );
      }
      const at = this.iso();
      let agent: Agent | null = null;
      if (decision === "approve") {
        const chosen = name === undefined || name === null || name === "" ? request.name : name;
        agent = agents.create({ ownerId: personId, name: chosen, kind: request.kind, type: "app" });
        this.db.query("UPDATE join_lines SET agent_id = $agentId WHERE id = $id AND agent_id IS NULL").run({
          id: line.id,
          agentId: agent.id,
        });
      }
      const status: SignInStatus = decision === "approve" ? "approved" : "denied";
      this.db
        .query(
          `UPDATE sign_in_requests SET status = $status, agent_id = $agentId, decided_at = $at, decided_by = $personId
           WHERE id = $id`,
        )
        .run({ id, status, agentId: agent?.id ?? null, at, personId });
      this.log("sign_in_decided", { request_id: id, decision, agent_id: agent?.id ?? null });
      if (decision === "deny") {
        this.activity?.record("sign_in_denied", { personId, detail: { name: request.name, kind: request.kind } });
      }
      this.changes.emit("approvals", "join-lines", "agents");
      return { request: { ...request, status, agentId: agent?.id ?? null, decidedAt: at, decidedBy: personId }, agent };
    })();
  }

  /**
   * The agent's poll. After approval, the first poll gets the agent's API token, exactly once; later polls only see
   * the status. A missing or wrong poll secret answers `unauthorized`.
   */
  pollSignIn(agents: Agents, id: string, pollSecret: string | null): { request: SignInRequest; agent: Agent | null; token: string | null } {
    const row = this.db.query("SELECT * FROM sign_in_requests WHERE id = $id").get({ id }) as SignInRow | null;
    if (!row || !pollSecret || !sameSecret(hashSecret(pollSecret), row.poll_hash)) {
      throw new PorticoError("unauthorized", "Missing or wrong poll secret for this sign in request.");
    }
    const request = this.toSignIn(row);
    const agent = request.agentId ? agents.get(request.agentId) : null;
    if (request.status !== "approved" || !agent || request.issuedAt) return { request, agent, token: null };
    const at = this.iso();
    const claimed = this.db
      .query("UPDATE sign_in_requests SET issued_at = $at WHERE id = $id AND issued_at IS NULL")
      .run({ id, at }).changes;
    if (claimed === 0) return { request, agent, token: null };
    const token = agents.issueToken(agent.id, "api");
    agents.checkedIn(agent);
    this.log("sign_in_token_issued", { request_id: id, agent_id: agent.id });
    this.changes.emit("agents", "join-lines");
    return { request: { ...request, issuedAt: at }, agent, token };
  }

  // ---- sweeps ----

  /** Marks sign-in requests past their 10 minutes expired. Returns how many. */
  sweepMinute(): number {
    const expired = this.db
      .query("UPDATE sign_in_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= $now")
      .run({ now: this.iso() }).changes;
    if (expired > 0) this.changes.emit("approvals", "join-lines");
    return expired;
  }

  /**
   * Daily cleanup: join lines a day past expiry (with their sign-in requests), expired OAuth codes and connector
   * tokens, and registered OAuth clients that never got a token.
   */
  sweep(): { joinLines: number; oauthCodes: number; tokens: number; oauthClients: number } {
    const now = this.iso();
    return this.db.transaction(() => {
      const joinLines = this.db
        .query("DELETE FROM join_lines WHERE expires_at < $cutoff")
        .run({ cutoff: this.iso(-JOIN_LINE_KEEP_MS) }).changes;
      const oauthCodes = this.db.query("DELETE FROM oauth_codes WHERE expires_at < $now").run({ now }).changes;
      const tokens = this.db
        .query("DELETE FROM agent_tokens WHERE expires_at IS NOT NULL AND expires_at < $now")
        .run({ now }).changes;
      const oauthClients = this.db
        .query(
          `DELETE FROM oauth_clients WHERE created_at < $cutoff
             AND client_id NOT IN (SELECT client_id FROM agent_tokens WHERE client_id IS NOT NULL)
             AND client_id NOT IN (SELECT client_id FROM oauth_codes)`,
        )
        .run({ cutoff: this.iso(-IDLE_CLIENT_MS) }).changes;
      return { joinLines, oauthCodes, tokens, oauthClients };
    })();
  }

  // ---- helpers ----

  /** The unused, unexpired line with this secret. Unknown secrets are `not_found`; used or expired lines `wrong_status`. */
  private usableLine(rawSecret: unknown): JoinLine {
    const secret = joinSecret(rawSecret);
    const row = secret
      ? (this.db.query("SELECT * FROM join_lines WHERE secret_hash = $hash").get({ hash: hashSecret(secret) }) as JoinLineRow | null)
      : null;
    if (!row) throw new PorticoError("not_found", `This join line isn't valid. ${AGAIN}`);
    const line = toJoinLine(row);
    if (line.usedAt) throw new PorticoError("wrong_status", `This join line was already used. ${AGAIN}`);
    if (Date.parse(line.expiresAt) <= this.now().getTime()) {
      throw new PorticoError("wrong_status", `This join line expired. ${AGAIN}`);
    }
    return line;
  }

  private toSignIn(row: SignInRow): SignInRequest {
    const late = row.status === "pending" && Date.parse(row.expires_at) <= this.now().getTime();
    return {
      id: row.id,
      joinLineId: row.join_line_id,
      kind: row.kind as AgentKind,
      name: row.name,
      code: row.code,
      status: late ? "expired" : (row.status as SignInStatus),
      agentId: row.agent_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      issuedAt: row.issued_at,
    };
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
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
