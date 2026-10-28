import type { Database } from "bun:sqlite";
import type { Bindings } from "../db";
import type { Changes } from "./changes";
import type { Computers } from "./computers";
import { PorticoError } from "./errors";
import { defang } from "./framing";
import { isBroadcast } from "./guards";
import { DAY_MS, HOUR_MS, LIMITS, NAME } from "./limits";
import type { Presence } from "./presence";
import { hashSecret, newToken } from "./tokens";
import { AGENT_KINDS } from "./types";
import type { Agent, AgentKind, AgentType, Computer, DeliveryTier, DirectoryEntry, LiveStatus } from "./types";
import { slugify } from "./words";

interface AgentRow {
  id: string;
  owner_id: string;
  name: string;
  kind: string;
  type: string;
  description: string;
  computer_id: string | null;
  computer: string | null;
  folder: string | null;
  folder_id: string | null;
  approval_required: number;
  created_at: string;
  last_seen_at: string | null;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    kind: row.kind as AgentKind,
    type: row.type as AgentType,
    description: row.description,
    computerId: row.computer_id,
    computer: row.computer,
    folder: row.folder,
    folderId: row.folder_id,
    approvalRequired: row.approval_required === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

const SELECT = "SELECT a.*, c.name AS computer FROM agents a LEFT JOIN computers c ON c.id = a.computer_id";

export function addressOf(agent: Pick<Agent, "name" | "computer">): string {
  return agent.computer ? `${agent.name}@${agent.computer}` : agent.name;
}

/** The coding agents whose sessions join from a computer: Claude Code through its plugin, Codex through its bridge. */
export const SESSION_CLIENTS = ["claude-code", "codex"] as const;
export type SessionClient = (typeof SESSION_CLIENTS)[number];

/** Each client's name suffix and label. Only Claude Code sessions are pushed to; Codex sessions check the inbox. */
const CLIENTS: Record<SessionClient, { suffix: string; label: string; push: boolean }> = {
  "claude-code": { suffix: "-claude", label: "Claude Code", push: true },
  codex: { suffix: "-codex", label: "Codex", push: false },
};

/** A session's client, from its kind. */
export function sessionClient(agent: Pick<Agent, "kind">): SessionClient {
  return agent.kind === "codex" ? "codex" : "claude-code";
}

/**
 * A session's name before deduplication: the slugged repo basename plus the client's suffix (`-claude`, `-codex`). The
 * repo part is clipped so the name, even with a `-99` suffix, stays within the 40 characters every agent name allows.
 */
export function sessionBaseName(repo: string, client: SessionClient = "claude-code"): string {
  const { suffix } = CLIENTS[client];
  const room = LIMITS.maxNameChars - suffix.length - "-99".length;
  return `${slugify(repo, "session").slice(0, room).replace(/-+$/, "")}${suffix}`;
}

/** What a session's plugin or bridge sends when it opens its stream. */
export interface Registration {
  /** The random ID the plugin made when it started: names the run. An identifier, not a secret. */
  key: string;
  /** The repo basename. */
  repo: string;
  /** HMAC of the full folder path, keyed with the computer token. */
  folderId: string;
  /** Which coding agent the session is. Absent, Claude Code (older plugins send none). */
  client?: SessionClient;
}

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const FOLDER_ID = /^[a-f0-9]{64}$/;
const MAX_REPO = 200;
const MAX_DEDUPE = 99;
/** A session's last_seen_at is written by its status reports at most this often. */
const TOUCH_INTERVAL_MS = 60_000;

/** One process start of a session agent: Claude Code or a Codex conversation, in the agent's folder. */
export interface Run {
  id: string;
  agentId: string;
  computerId: string;
  client: SessionClient;
  startedAt: string;
  lastSeenAt: string;
  /** When its stream closed; null while open, or when Portico stopped before it closed. */
  endedAt: string | null;
}

interface RunRow {
  id: string;
  agent_id: string;
  computer_id: string;
  client: string;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    agentId: row.agent_id,
    computerId: row.computer_id,
    client: row.client === "codex" ? "codex" : "claude-code",
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    endedAt: row.ended_at,
  };
}

/** The registration headers and query, checked. The repo defaults to "session", the client to Claude Code (older plugins send none). */
export function parseRegistration(key: unknown, folderId: unknown, repo: unknown, client?: unknown): Registration {
  if (typeof key !== "string" || !KEY.test(key)) {
    throw new PorticoError("bad_request", "X-Portico-Session must be 8 to 100 letters, digits, hyphens or underscores.");
  }
  if (typeof folderId !== "string" || !FOLDER_ID.test(folderId)) {
    throw new PorticoError("bad_request", "X-Portico-Folder must be 64 lowercase hex characters.");
  }
  if (repo !== undefined && repo !== null && typeof repo !== "string") {
    throw new PorticoError("bad_request", "repo must be a string.");
  }
  if (typeof repo === "string" && repo.length > MAX_REPO) {
    throw new PorticoError("bad_request", `repo must be at most ${MAX_REPO} characters.`);
  }
  if (client !== undefined && client !== null && !SESSION_CLIENTS.some((known) => known === client)) {
    throw new PorticoError("bad_request", `X-Portico-Client must be one of: ${SESSION_CLIENTS.join(", ")}.`);
  }
  // Stored as the session's folder and shown in its description, so it gets the same cleaning as status text, and
  // only its last path segment is kept, even if a client sends a path.
  const cleaned = typeof repo === "string" ? defang(repo).replace(/\s+/g, " ").trim() : "";
  const segment = cleaned.split(/[\\/]/).filter(Boolean).pop()?.trim() ?? "";
  return { key, folderId, repo: segment || "session", client: (client as SessionClient | undefined) ?? "claude-code" };
}

/** The agent list's order: connected sessions by status, then apps and connectors (null), then offline sessions. */
const ORDER: Record<LiveStatus, number> = { busy: 0, waiting: 1, idle: 2, offline: 4 };
const PULL_ORDER = 3;

function order(entry: DirectoryEntry): number {
  return entry.status === null ? PULL_ORDER : ORDER[entry.status];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The later of two timestamps, either of which may be missing. */
function later(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return a ?? b;
  return a > b ? a : b;
}

/** A new or edited agent name: lowercase letters, digits and hyphens, at most 40 characters. */
export function checkAgentName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value.trim())) {
    throw new PorticoError("bad_request", "A name uses lowercase letters, digits and single hyphens.");
  }
  const name = value.trim();
  if (name.length > LIMITS.maxNameChars) {
    throw new PorticoError("bad_request", `A name can be at most ${LIMITS.maxNameChars} characters.`);
  }
  return name;
}

function checkDescription(value: unknown): string {
  if (typeof value !== "string") throw new PorticoError("bad_request", "description must be a string.");
  const description = defang(value).replace(/\s+/g, " ").trim();
  if (Array.from(description).length > LIMITS.maxDescriptionChars) {
    throw new PorticoError("bad_request", `A description can be at most ${LIMITS.maxDescriptionChars} characters.`);
  }
  return description;
}

export interface AgentChanges {
  name?: unknown;
  description?: unknown;
  approvalRequired?: unknown;
  joinFromFolder?: unknown;
}

export interface AgentsDeps {
  db: Database;
  computers: Computers;
  presence: Presence;
  changes: Changes;
  /** Whether the agent has an open stream. A connected session stays listed however long ago its row was written. */
  isConnected?: (agentId: string) => boolean;
  /** Closes the agents' streams, once they're removed. */
  disconnect?: (agentIds: string[]) => void;
  /** Runs after a rename, so a connected session can learn its new address. */
  renamed?: (agent: Agent) => void;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Every agent on Portico: sessions on joined computers, apps that signed in, and connectors. Addresses, the live agent
 * list, session registration, credentials, and the changes an agent's manager can make.
 */
export class Agents {
  private readonly db: Database;
  private readonly computers: Computers;
  private readonly presence: Presence;
  private readonly changes: Changes;
  private readonly isConnected: (agentId: string) => boolean;
  private readonly disconnect: (agentIds: string[]) => void;
  private readonly renamed: (agent: Agent) => void;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: AgentsDeps) {
    this.db = deps.db;
    this.computers = deps.computers;
    this.presence = deps.presence;
    this.changes = deps.changes;
    this.isConnected = deps.isConnected ?? (() => false);
    this.disconnect = deps.disconnect ?? (() => {});
    this.renamed = deps.renamed ?? (() => {});
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
  }

  // ---- reads ----

  get(id: string): Agent | null {
    const row = this.db.query(`${SELECT} WHERE a.id = $id`).get({ id }) as AgentRow | null;
    return row ? toAgent(row) : null;
  }

  require(id: string): Agent {
    const agent = this.get(id);
    if (!agent) throw new PorticoError("not_found", "No such agent.");
    return agent;
  }

  /** The agent at exactly this address, including a session however long ago it was seen. */
  byAddress(address: string): Agent | null {
    const at = address.indexOf("@");
    const row =
      at < 0
        ? this.db.query(`${SELECT} WHERE a.computer_id IS NULL AND a.name = $name`).get({ name: address })
        : this.db
            .query(`${SELECT} WHERE a.name = $name AND c.name = $computer`)
            .get({ name: address.slice(0, at), computer: address.slice(at + 1) });
    return row ? toAgent(row as AgentRow) : null;
  }

  /** Every agent, by name then computer. */
  all(): Agent[] {
    return (this.db.query(`${SELECT} ORDER BY a.name, c.name`).all() as AgentRow[]).map(toAgent);
  }

  /** The agents the list shows: everyone but sessions offline for more than a day. */
  listed(): Agent[] {
    const cutoff = this.iso(-LIMITS.sessionListHours * HOUR_MS);
    return this.all().filter(
      (agent) => agent.type !== "session" || (agent.lastSeenAt ?? agent.createdAt) >= cutoff || this.isConnected(agent.id),
    );
  }

  /** Agents the person manages, by name. */
  ownedBy(personId: string): Agent[] {
    return this.all().filter((agent) => agent.ownerId === personId);
  }

  address(agent: Agent): string {
    return addressOf(agent);
  }

  /** A session's short name when it alone resolves to the session, otherwise the full address. */
  display(agent: Agent): string {
    if (agent.type !== "session") return agent.name;
    if (this.byAddress(agent.name)) return addressOf(agent);
    const n = (
      this.db.query("SELECT COUNT(*) AS n FROM agents WHERE computer_id IS NOT NULL AND name = $name").get({
        name: agent.name,
      }) as { n: number }
    ).n;
    return n === 1 ? agent.name : addressOf(agent);
  }

  /**
   * Each listed agent but `exceptId` as the agent list shows it: connected sessions by status (busy, waiting, idle),
   * then apps and connectors, then offline sessions, alphabetical within each.
   */
  entries(exceptId?: string): DirectoryEntry[] {
    return this.listed()
      .filter((agent) => agent.id !== exceptId)
      .map((agent) => this.entry(agent))
      .sort((a, b) => order(a) - order(b) || compare(a.display, b.display) || compare(a.address, b.address));
  }

  /**
   * A session shows its reported status while its stream is open (idle until the first report), otherwise offline.
   * Presence keeps the last report after the stream closes, so `doing` shows only while connected; repo and branch stay
   * the last known. Apps and connectors show when they last checked in.
   */
  entry(agent: Agent): DirectoryEntry {
    const base = { agent, address: addressOf(agent), display: this.display(agent) };
    if (agent.type !== "session") {
      const lastSeen = this.presence.lastCheckIn(agent.id) ?? agent.lastSeenAt;
      return {
        ...base,
        status: null,
        doing: null,
        repo: null,
        branch: null,
        lastSeen,
        checkInMinutes: this.presence.checkInMinutes(agent.id),
      };
    }
    const connected = this.isConnected(agent.id);
    const report = this.presence.get(agent.id);
    return {
      ...base,
      status: connected ? (report?.status ?? "idle") : "offline",
      doing: connected ? (report?.doing ?? null) : null,
      repo: report?.repo ?? agent.folder,
      branch: report?.branch ?? null,
      lastSeen: later(report?.at ?? null, agent.lastSeenAt),
      checkInMinutes: null,
    };
  }

  /**
   * The agent a sender means by `to`: an exact address, or a session's short name when only one session has it.
   * Patterns are refused, since a message goes to one agent.
   */
  resolve(to: unknown, callerId: string): Agent {
    if (typeof to !== "string" || to.trim() === "") throw new PorticoError("bad_request", "to must be an agent name.");
    if (isBroadcast(to)) {
      throw new PorticoError("bad_request", `"${to}" is a pattern. Name one agent from list_agents.`);
    }
    const exact = this.byAddress(to);
    if (exact) return exact;
    if (!to.includes("@")) {
      const named = (
        this.db.query(`${SELECT} WHERE a.computer_id IS NOT NULL AND a.name = $name ORDER BY c.name`).all({
          name: to,
        }) as AgentRow[]
      ).map(toAgent);
      if (named.length === 1) return named[0]!;
      if (named.length > 1) {
        const addresses = named.map(addressOf).join(", ");
        throw new PorticoError("unknown_agent", `"${to}" is on ${named.length} computers. Use one of: ${addresses}.`);
      }
    }
    const valid = this.listed()
      .filter((agent) => agent.id !== callerId)
      .map((agent) => this.display(agent))
      .join(", ");
    throw new PorticoError("unknown_agent", `No agent named "${to}". Valid agents: ${valid || "none yet"}.`);
  }

  /** Claude Code sessions are pushed to; Codex sessions, apps and connectors check their inbox. */
  isPush(agent: Agent): boolean {
    return agent.type === "session" && CLIENTS[sessionClient(agent)].push;
  }

  /** How a message that isn't held reaches the agent right now. A session that isn't connected is offline. */
  tier(agent: Agent): Exclude<DeliveryTier, "held"> {
    if (agent.type !== "session") return "queued";
    if (!this.isConnected(agent.id)) return "offline";
    return this.isPush(agent) ? "pushed" : "queued";
  }

  // ---- sessions ----

  /**
   * Each coding agent in each folder is one agent; each process start is a run of it. The same key reconnecting keeps
   * its run. A new key in the folder is a new run of the folder's agent, made the first time with the first free name on
   * the computer: `<repo>-claude`, then `-2`, `-3` for other folders with the same name. A new key in a folder whose
   * switch is off is refused with `folder_off`.
   */
  registerSession(computer: Computer, registration: Registration): { agent: Agent; runId: string; created: boolean } {
    const reg = { ...registration, client: registration.client ?? "claude-code" };
    const at = this.iso();
    const outcome = this.db.transaction(() => {
      const same = this.db
        .query("SELECT agent_id, id FROM agent_runs WHERE computer_id = $computerId AND session_key = $key")
        .get({ computerId: computer.id, key: reg.key }) as { agent_id: string; id: string } | null;
      if (same) {
        this.presence.startRun(same.id);
        this.db.query("UPDATE agent_runs SET last_seen_at = $at, ended_at = NULL WHERE id = $id").run({ id: same.id, at });
        this.db.query("UPDATE agents SET last_seen_at = $at WHERE id = $id").run({ id: same.agent_id, at });
        return { agent: this.require(same.agent_id), runId: same.id, created: false };
      }

      if (this.computers.folderJoins(computer.id, reg.folderId) === false) {
        throw new PorticoError(
          "folder_off",
          `Sessions in ${reg.repo} on ${computer.name} stay off Portico. Turn the folder back on with /portico:on in Claude ` +
            "Code, or with `bun ~/.portico/portico-codex.js on` in a terminal there.",
        );
      }

      const existing = this.db
        .query(
          `SELECT id FROM agents WHERE type = 'session' AND computer_id = $computerId AND folder_id = $folderId AND kind = $kind`,
        )
        .get({ computerId: computer.id, folderId: reg.folderId, kind: reg.client }) as { id: string } | null;
      let agentId = existing?.id;
      if (!agentId) {
        const base = sessionBaseName(reg.repo, reg.client);
        const taken = new Set(this.sessionsOn(computer.id).map((s) => s.name));
        let name = base;
        for (let n = 2; taken.has(name); n++) {
          if (n > MAX_DEDUPE) throw new PorticoError("rate_limited", `Too many sessions named ${base} on ${computer.name}.`);
          name = `${base}-${n}`;
        }
        const folder = reg.repo.slice(0, 100);
        agentId = this.newId();
        this.insert({
          id: agentId,
          ownerId: computer.ownerId,
          name,
          kind: reg.client,
          type: "session",
          description: `${CLIENTS[reg.client].label} in ${folder} on ${computer.name}`,
          computerId: computer.id,
          folder,
          folderId: reg.folderId,
          createdAt: at,
          lastSeenAt: at,
        });
        this.log("session_registered", { agent_id: agentId });
      } else {
        this.db.query("UPDATE agents SET last_seen_at = $at WHERE id = $id").run({ id: agentId, at });
      }
      const runId = this.newId();
      this.db
        .query(
          `INSERT INTO agent_runs (id, agent_id, computer_id, session_key, client, started_at, last_seen_at)
           VALUES ($id, $agentId, $computerId, $key, $client, $at, $at)`,
        )
        .run({ id: runId, agentId, computerId: computer.id, key: reg.key, client: reg.client, at });
      this.log("run_started", { agent_id: agentId, run_id: runId });
      return { agent: this.require(agentId), runId, created: !existing };
    })();
    this.changes.emit("agents");
    return outcome;
  }

  /** The session and run behind a computer token and a session key, or null when the key isn't registered there. */
  sessionByKey(computerId: string, key: string): { agent: Agent; runId: string } | null {
    const row = this.db
      .query("SELECT agent_id, id FROM agent_runs WHERE computer_id = $computerId AND session_key = $key")
      .get({ computerId, key }) as { agent_id: string; id: string } | null;
    const agent = row ? this.get(row.agent_id) : null;
    return agent ? { agent, runId: row!.id } : null;
  }

  /** The agent a run belongs to, or null when the run is gone. */
  byRun(runId: string): Agent | null {
    const row = this.db.query("SELECT agent_id FROM agent_runs WHERE id = $runId").get({ runId }) as { agent_id: string } | null;
    return row ? this.get(row.agent_id) : null;
  }

  /** The agent's runs, newest first. */
  runs(agentId: string, limit = 20): Run[] {
    return (
      this.db
        .query("SELECT * FROM agent_runs WHERE agent_id = $agentId ORDER BY started_at DESC, id LIMIT $limit")
        .all({ agentId, limit }) as RunRow[]
    ).map(toRun);
  }

  /** How many runs the agent has had, as far back as they're kept. */
  runCount(agentId: string): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id = $agentId").get({ agentId }) as { n: number }).n;
  }

  /** Ends a run when its stream closes, and writes when the agent was last here. Does nothing when the rows are gone. */
  seen(agentId: string, runId: string): void {
    const at = this.iso();
    this.db.query("UPDATE agent_runs SET last_seen_at = $at, ended_at = $at WHERE id = $id").run({ id: runId, at });
    this.db.query("UPDATE agents SET last_seen_at = $at WHERE id = $id").run({ id: agentId, at });
    this.presence.endRun(agentId, runId);
    this.changes.emit("agents");
  }

  /** Writes a session's last_seen_at for a status report, at most once a minute, on the agent and its run. */
  touch(agent: Agent, runId?: string | null): void {
    const now = this.now();
    if (agent.lastSeenAt && now.getTime() - Date.parse(agent.lastSeenAt) < TOUCH_INTERVAL_MS) return;
    const at = now.toISOString();
    this.db.query("UPDATE agents SET last_seen_at = $at WHERE id = $id").run({ id: agent.id, at });
    if (runId) this.db.query("UPDATE agent_runs SET last_seen_at = $at WHERE id = $id").run({ id: runId, at });
  }

  // ---- apps and connectors ----

  /** An app or connector agent. Throws `conflict` when another app or connector has the name. */
  create(input: { ownerId: string; name: unknown; kind: unknown; type: "app" | "connector"; description?: unknown }): Agent {
    const name = checkAgentName(input.name);
    if (!AGENT_KINDS.some((kind) => kind === input.kind)) {
      throw new PorticoError("bad_request", `kind must be one of: ${AGENT_KINDS.join(", ")}.`);
    }
    if (this.nameTaken(name)) throw new PorticoError("conflict", `The name ${name} is already in use.`);
    const id = this.newId();
    this.insert({
      id,
      ownerId: input.ownerId,
      name,
      kind: input.kind as AgentKind,
      type: input.type,
      description: input.description === undefined ? "" : checkDescription(input.description),
      computerId: null,
      folder: null,
      folderId: null,
      createdAt: this.iso(),
      lastSeenAt: null,
    });
    this.log("agent_added", { agent_id: id, kind: input.kind, type: input.type });
    this.changes.emit("agents");
    return this.require(id);
  }

  /** Mints a token for the agent, returned only here and stored only as a hash. */
  issueToken(agentId: string, kind: "api" | "access" | "refresh", opts: { clientId?: string; expiresAt?: string } = {}): string {
    const token = newToken(kind === "api" ? "pa_" : kind === "access" ? "pt_" : "pr_");
    this.db
      .query(
        `INSERT INTO agent_tokens (id, agent_id, kind, token_hash, client_id, created_at, expires_at)
         VALUES ($id, $agentId, $kind, $hash, $clientId, $createdAt, $expiresAt)`,
      )
      .run({
        id: this.newId(),
        agentId,
        kind,
        hash: hashSecret(token),
        clientId: opts.clientId ?? null,
        createdAt: this.iso(),
        expiresAt: opts.expiresAt ?? null,
      });
    return token;
  }

  /** The agent an unexpired token of one of these kinds belongs to. */
  byToken(token: string, kinds: ("api" | "access" | "refresh")[] = ["api", "access"]): Agent | null {
    const row = this.db
      .query("SELECT agent_id, kind, expires_at FROM agent_tokens WHERE token_hash = $hash")
      .get({ hash: hashSecret(token) }) as { agent_id: string; kind: "api" | "access" | "refresh"; expires_at: string | null } | null;
    if (!row || !kinds.includes(row.kind)) return null;
    if (row.expires_at !== null && Date.parse(row.expires_at) <= this.now().getTime()) return null;
    return this.get(row.agent_id);
  }

  /** Deletes one token, e.g. a refresh token once it's used. */
  revokeToken(token: string): void {
    this.db.query("DELETE FROM agent_tokens WHERE token_hash = $hash").run({ hash: hashSecret(token) });
  }

  /** Marks an app or connector seen when it calls Portico. */
  checkedIn(agent: Agent): void {
    const at = this.iso();
    this.presence.checkedIn(agent.id, at);
    if (agent.type !== "session") this.touch(agent);
  }

  // ---- what an agent's manager can change ----

  /** Only the person who manages the agent may change it. */
  requireManaged(personId: string, agentId: string): Agent {
    const agent = this.require(agentId);
    if (agent.ownerId !== personId) {
      throw new PorticoError("not_allowed", "Only the person who manages this agent can change it.");
    }
    return agent;
  }

  /** Name and description edits go live at once. A name already in use answers `conflict`. */
  update(personId: string, agentId: string, changes: AgentChanges): Agent {
    const agent = this.requireManaged(personId, agentId);
    const sets: string[] = [];
    const bindings: Bindings = { id: agent.id };
    let renamed = false;
    if (changes.name !== undefined) {
      const name = checkAgentName(changes.name);
      if (name !== agent.name) {
        const taken = agent.computerId
          ? this.db
              .query("SELECT 1 FROM agents WHERE computer_id = $computerId AND name = $name")
              .get({ computerId: agent.computerId, name })
          : this.nameTaken(name, agent.id);
        if (taken) throw new PorticoError("conflict", `The name ${name} is already in use.`);
        sets.push("name = $name");
        bindings.name = name;
        renamed = true;
      }
    }
    if (changes.description !== undefined) {
      sets.push("description = $description");
      bindings.description = checkDescription(changes.description);
    }
    if (changes.approvalRequired !== undefined) {
      if (typeof changes.approvalRequired !== "boolean") {
        throw new PorticoError("bad_request", "approvalRequired must be true or false.");
      }
      sets.push("approval_required = $approval");
      bindings.approval = changes.approvalRequired ? 1 : 0;
    }
    if (changes.joinFromFolder !== undefined) {
      if (typeof changes.joinFromFolder !== "boolean") {
        throw new PorticoError("bad_request", "joinFromFolder must be true or false.");
      }
      if (!agent.computerId || !agent.folderId) {
        throw new PorticoError("bad_request", "Only a session on a computer has a folder switch.");
      }
      this.computers.setFolder(agent.computerId, agent.folderId, agent.folder ?? "session", changes.joinFromFolder);
    }
    if (sets.length > 0) this.db.query(`UPDATE agents SET ${sets.join(", ")} WHERE id = $id`).run(bindings);
    const updated = this.require(agent.id);
    if (renamed) {
      this.log("agent_renamed", { agent_id: agent.id });
      this.renamed(updated);
    }
    this.changes.emit("agents", "threads", "approvals");
    return updated;
  }

  /** The folder switch of a session's folder: true on (also when never set). Null for agents without a folder. */
  joinsFromFolder(agent: Agent): boolean | null {
    if (!agent.computerId || !agent.folderId) return null;
    return this.computers.folderJoins(agent.computerId, agent.folderId) !== false;
  }

  /** Removes the agent, its credentials and its threads, and signs it out. */
  remove(personId: string, agentId: string): Agent {
    const agent = this.requireManaged(personId, agentId);
    this.db.query("DELETE FROM agents WHERE id = $id").run({ id: agent.id });
    this.forget([agent.id]);
    this.log("agent_removed", { agent_id: agent.id });
    this.changes.emit("agents", "threads", "approvals", "computers");
    return agent;
  }

  /** Closes the streams of agents whose rows are gone and drops their live state. */
  forget(agentIds: string[]): void {
    this.disconnect(agentIds);
    for (const id of agentIds) this.presence.forget(id);
  }

  /**
   * Deletes runs last seen more than the history window ago, except a run that may still be open (no end, and its
   * agent connected). Agents themselves are kept. Returns how many.
   */
  pruneRuns(): number {
    const cutoff = this.iso(-LIMITS.historyDays * DAY_MS);
    const old = (
      this.db
        .query("SELECT id, agent_id, ended_at FROM agent_runs WHERE COALESCE(ended_at, last_seen_at) < $cutoff")
        .all({ cutoff }) as { id: string; agent_id: string; ended_at: string | null }[]
    ).filter((run) => run.ended_at !== null || !this.isConnected(run.agent_id));
    const remove = this.db.query("DELETE FROM agent_runs WHERE id = $id");
    for (const run of old) remove.run({ id: run.id });
    return old.length;
  }

  // ---- helpers ----

  /**
   * Whether an app or connector can't take the name: another app or connector has it, or a session does. A session's
   * short name is how agents address it, so an app taking it would receive that session's messages.
   */
  private nameTaken(name: string, exceptId?: string): boolean {
    const row = this.db
      .query("SELECT id FROM agents WHERE name = $name AND id != $exceptId LIMIT 1")
      .get({ name, exceptId: exceptId ?? "" });
    return row !== null;
  }

  private sessionsOn(computerId: string): Agent[] {
    return (this.db.query(`${SELECT} WHERE a.computer_id = $computerId ORDER BY a.name`).all({ computerId }) as AgentRow[]).map(
      toAgent,
    );
  }

  private insert(a: Omit<Agent, "computer" | "approvalRequired">): void {
    this.db
      .query(
        `INSERT INTO agents (id, owner_id, name, kind, type, description, computer_id, folder, folder_id,
           approval_required, created_at, last_seen_at)
         VALUES ($id, $ownerId, $name, $kind, $type, $description, $computerId, $folder, $folderId,
           0, $createdAt, $lastSeenAt)`,
      )
      .run({
        id: a.id,
        ownerId: a.ownerId,
        name: a.name,
        kind: a.kind,
        type: a.type,
        description: a.description,
        computerId: a.computerId,
        folder: a.folder,
        folderId: a.folderId,
        createdAt: a.createdAt,
        lastSeenAt: a.lastSeenAt,
      });
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }
}
