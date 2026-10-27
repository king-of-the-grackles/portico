import type { NetworkStore } from "../network-store";
import { PorticoError } from "./errors";
import { isBroadcast } from "./guards";
import type { Presence } from "./presence";
import type {
  AgentConfig,
  Assistant,
  DeliveryTier,
  DirectoryEntry,
  LiveStatus,
  Member,
  MemberRef,
  PorticoConfig,
  SessionRecord,
} from "./types";

/** Sessions not seen for this long drop out of members(), though their address keeps resolving. */
export const SESSION_LIST_HOURS = 24;

const HOUR_MS = 3_600_000;

/** The directory's order: connected members by status, then pull members (null), then offline members. */
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

export function addressOf(name: string, machine: string): string {
  return `${name}@${machine}`;
}

function configMember(agent: AgentConfig): Member {
  return {
    address: agent.name,
    name: agent.name,
    source: "config",
    kind: agent.kind,
    description: agent.description,
    delivery: agent.delivery,
    machine: null,
  };
}

function assistantMember(assistant: Assistant): Member {
  return {
    address: assistant.name,
    name: assistant.name,
    source: "assistant",
    kind: assistant.kind,
    description: assistant.description,
    delivery: "pull",
    machine: null,
  };
}

function sessionMember(session: SessionRecord): Member {
  return {
    address: addressOf(session.name, session.machine),
    name: session.name,
    source: "session",
    kind: "claude-code",
    description: `Claude Code in ${session.folder} on ${session.machine}`,
    delivery: "push",
    machine: session.machine,
  };
}

export interface DirectoryDeps {
  config: PorticoConfig;
  network: NetworkStore;
  /** Whether the address has an open stream. A connected session stays listed however long ago its row was written. */
  isConnected?: (address: string) => boolean;
  /** Live status reports and check-ins, for the directory's entries. */
  presence: Presence;
  now?: () => Date;
}

/**
 * Everyone a task can be addressed to: portico.yaml agents, hub-page assistants and sessions. An assistant whose name
 * a portico.yaml agent also has is shadowed: left out everywhere, so the portico.yaml agent wins.
 */
export class Directory {
  private readonly config: PorticoConfig;
  private readonly network: NetworkStore;
  private readonly isConnected: (address: string) => boolean;
  private readonly presence: Presence;
  private readonly now: () => Date;

  constructor(deps: DirectoryDeps) {
    this.config = deps.config;
    this.network = deps.network;
    this.isConnected = deps.isConnected ?? (() => false);
    this.presence = deps.presence;
    this.now = deps.now ?? (() => new Date());
  }

  /** The portico.yaml agents in file order, then unshadowed assistants, then sessions seen in the last 24 hours. */
  members(): Member[] {
    return this.listed().map(({ member }) => member);
  }

  /**
   * Each member but the caller as the live directory shows it (spec §6): connected members by status (busy, waiting,
   * idle), then pull members, then offline members, alphabetical within each.
   */
  entries(caller?: string): DirectoryEntry[] {
    return this.listed()
      .filter(({ member }) => member.address !== caller)
      .map(({ member, session }) => this.entry(member, session))
      .sort((a, b) => order(a) - order(b) || compare(a.display, b.display) || compare(a.address, b.address));
  }

  /** How a message, or a queued task, reaches the address right now. */
  tier(address: string): DeliveryTier {
    if (!this.isPush(address)) return "queued";
    return this.isConnected(address) ? "pushed" : "offline";
  }

  /** The member at exactly this address, including any stored session however long ago it was seen. */
  find(address: string): Member | null {
    // portico.yaml agents come first, so a shadowed assistant is never found.
    const agent = this.config.agents.find((a) => a.name === address);
    if (agent) return configMember(agent);
    const at = address.indexOf("@");
    if (at < 0) {
      const assistant = this.network.assistantByName(address);
      return assistant ? assistantMember(assistant) : null;
    }
    const session = this.network.sessionByAddress(address.slice(0, at), address.slice(at + 1));
    return session ? sessionMember(session) : null;
  }

  /**
   * The member a sender means by `to`: an exact address, or a session's short name when only one session has it.
   * Patterns are refused, since a task goes to one agent.
   */
  resolve(to: unknown, caller: string): Member {
    if (typeof to !== "string" || to.trim() === "") throw new PorticoError("bad_request", "to must be an agent name.");
    if (isBroadcast(to)) {
      throw new PorticoError(
        "bad_request",
        `"${to}" is a pattern. Broadcasts aren't supported: name one agent from list_agents.`,
      );
    }
    const exact = this.find(to);
    if (exact) return exact;
    if (!to.includes("@")) {
      const named = this.network.sessionsNamed(to);
      if (named.length === 1) return sessionMember(named[0]!);
      if (named.length > 1) {
        const addresses = named.map((session) => addressOf(session.name, session.machine)).join(", ");
        throw new PorticoError("unknown_agent", `"${to}" is on ${named.length} machines. Use one of: ${addresses}.`);
      }
    }
    const valid = this.members()
      .filter((member) => member.address !== caller)
      .map((member) => this.displayName(member.address))
      .join(", ");
    throw new PorticoError("unknown_agent", `No agent named "${to}". Valid agents: ${valid}.`);
  }

  /** Push members get nudged on their stream; everyone else checks in. */
  isPush(address: string): boolean {
    return this.find(address)?.delivery === "push";
  }

  /** What rules match on. An address nothing knows gets kind "unknown". */
  ref(address: string): MemberRef {
    return { address, kind: this.find(address)?.kind ?? "unknown" };
  }

  /** A session's short name when it alone resolves to this address, otherwise the address itself. */
  displayName(address: string): string {
    const at = address.indexOf("@");
    if (at < 0) return address;
    const name = address.slice(0, at);
    if (this.find(name)) return address;
    const named = this.network.sessionsNamed(name);
    return named.length === 1 && addressOf(named[0]!.name, named[0]!.machine) === address ? name : address;
  }

  private listed(): { member: Member; session: SessionRecord | null }[] {
    const cutoff = new Date(this.now().getTime() - SESSION_LIST_HOURS * HOUR_MS).toISOString();
    const sessions = this.network
      .listSessions()
      .filter((session) => session.lastSeenAt >= cutoff || this.isConnected(addressOf(session.name, session.machine)));
    return [
      ...this.config.agents.map((agent) => ({ member: configMember(agent), session: null })),
      ...this.network
        .listAssistants()
        .filter((assistant) => !this.isConfigAgent(assistant.name))
        .map((assistant) => ({ member: assistantMember(assistant), session: null })),
      ...sessions.map((session) => ({ member: sessionMember(session), session })),
    ];
  }

  /**
   * A push member shows its reported status while its stream is open (idle until the first report), otherwise offline.
   * Presence keeps the last report after the stream closes, so `doing` is shown only while connected; repo and branch
   * stay the last known. Last seen is the later of the last report and the session's stored last_seen_at, which is
   * written when its stream closes.
   */
  private entry(member: Member, session: SessionRecord | null): DirectoryEntry {
    const display = this.displayName(member.address);
    if (member.delivery === "pull") {
      const lastSeen = this.presence.lastCheckIn(member.address);
      return { ...member, display, status: null, doing: null, repo: null, branch: null, lastSeen };
    }
    const connected = this.isConnected(member.address);
    const report = this.presence.get(member.address);
    return {
      ...member,
      display,
      status: connected ? (report?.status ?? "idle") : "offline",
      doing: connected ? (report?.doing ?? null) : null,
      repo: report?.repo ?? session?.folder ?? null,
      branch: report?.branch ?? null,
      lastSeen: later(report?.at ?? null, session?.lastSeenAt ?? null),
    };
  }

  private isConfigAgent(name: string): boolean {
    return this.config.agents.some((agent) => agent.name === name);
  }
}
