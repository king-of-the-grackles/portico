import type { NetworkStore } from "../network-store";
import { BridgeError } from "./errors";
import { isBroadcast } from "./guards";
import type { AgentConfig, Assistant, BridgeConfig, Member, MemberRef, SessionRecord } from "./types";

/** Sessions not seen for this long drop out of members(), though their address keeps resolving. */
export const SESSION_LIST_HOURS = 24;

const HOUR_MS = 3_600_000;

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
  config: BridgeConfig;
  network: NetworkStore;
  /** Whether the address has an open stream. A connected session stays listed however long ago its row was written. */
  isConnected?: (address: string) => boolean;
  now?: () => Date;
}

/**
 * Everyone a task can be addressed to: bridge.yaml agents, hub-page assistants and sessions. An assistant whose name
 * a bridge.yaml agent also has is shadowed: left out everywhere, so the bridge.yaml agent wins.
 */
export class Directory {
  private readonly config: BridgeConfig;
  private readonly network: NetworkStore;
  private readonly isConnected: (address: string) => boolean;
  private readonly now: () => Date;

  constructor(deps: DirectoryDeps) {
    this.config = deps.config;
    this.network = deps.network;
    this.isConnected = deps.isConnected ?? (() => false);
    this.now = deps.now ?? (() => new Date());
  }

  /** The bridge.yaml agents in file order, then unshadowed assistants, then sessions seen in the last 24 hours. */
  members(): Member[] {
    const cutoff = new Date(this.now().getTime() - SESSION_LIST_HOURS * HOUR_MS).toISOString();
    const sessions = this.network
      .listSessions()
      .filter((session) => session.lastSeenAt >= cutoff || this.isConnected(addressOf(session.name, session.machine)));
    return [
      ...this.config.agents.map(configMember),
      ...this.network
        .listAssistants()
        .filter((assistant) => !this.isConfigAgent(assistant.name))
        .map(assistantMember),
      ...sessions.map(sessionMember),
    ];
  }

  /** The member at exactly this address, including any stored session however long ago it was seen. */
  find(address: string): Member | null {
    // bridge.yaml agents come first, so a shadowed assistant is never found.
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
    if (typeof to !== "string" || to.trim() === "") throw new BridgeError("bad_request", "to must be an agent name.");
    if (isBroadcast(to)) {
      throw new BridgeError(
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
        throw new BridgeError("unknown_agent", `"${to}" is on ${named.length} machines. Use one of: ${addresses}.`);
      }
    }
    const valid = this.members()
      .filter((member) => member.address !== caller)
      .map((member) => this.displayName(member.address))
      .join(", ");
    throw new BridgeError("unknown_agent", `No agent named "${to}". Valid agents: ${valid}.`);
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

  private isConfigAgent(name: string): boolean {
    return this.config.agents.some((agent) => agent.name === name);
  }
}
