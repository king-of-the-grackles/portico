/** What an agent is, for icons and labels. */
export const AGENT_KINDS = ["claude-code", "codex", "muse", "grok-bot", "dots", "claude-duet", "other"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** How an agent joined: a session on a computer, an app with a token, or an MCP connector with OAuth. */
export type AgentType = "session" | "app" | "connector";

export type Role = "owner" | "member";
/** A claimed invite waits as `pending` until the owner approves it. */
export type PersonStatus = "active" | "pending";

export interface Person {
  id: string;
  name: string;
  role: Role;
  status: PersonStatus;
  inviteId: string | null;
  createdAt: string;
  approvedAt: string | null;
}

/** A computer that joined with a join line. Its sessions' addresses end in `@<name>`. */
export interface Computer {
  id: string;
  ownerId: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface Agent {
  id: string;
  ownerId: string;
  name: string;
  kind: AgentKind;
  type: AgentType;
  description: string;
  /** Sessions only: the computer, and its name joined in on read. */
  computerId: string | null;
  computer: string | null;
  /** Sessions only: the repo basename. */
  folder: string | null;
  /**
   * Sessions only: HMAC of the full folder path, keyed with the computer token. With the kind, it names the agent: every
   * session of one coding agent in one folder is the same agent. Null for an agent that left its folder.
   */
  folderId: string | null;
  approvalRequired: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  /** What the agent said it's doing, with update_profile, and when. One line, defanged. */
  doing: string | null;
  doingAt: string | null;
}

/** What a session reports about itself: Claude Code's own status. */
export type SessionStatus = "busy" | "idle" | "waiting";

/** A session's status in the agent list: its reported status while its stream is open, otherwise offline. */
export type LiveStatus = SessionStatus | "offline";

/** A session's live status, kept in memory only. Text fields are defanged, one line and clipped. */
export interface StatusReport {
  status: SessionStatus;
  /** `<title> · <current to-do>`, at most 120 characters. */
  doing: string | null;
  /** A basename, never a path. */
  repo: string | null;
  branch: string | null;
}

/** One agent as the agent list shows it. */
export interface DirectoryEntry {
  agent: Agent;
  /** The full address: the name, or `name@computer` for a session. */
  address: string;
  /** The short form when unique, otherwise the full address: the name to address it by. */
  display: string;
  /** Null for apps and connectors, which check in rather than stay connected. */
  status: LiveStatus | null;
  doing: string | null;
  repo: string | null;
  branch: string | null;
  /** Sessions: the last report or stream close. Others: the last check-in. */
  lastSeen: string | null;
  /** Apps and connectors: the usual minutes between check-ins, once known. */
  checkInMinutes: number | null;
}

/**
 * How a message will reach its receiver: pushed to a live session, queued until an app checks its inbox, waiting for
 * an offline session, or held for a person's approval.
 */
export type DeliveryTier = "pushed" | "queued" | "offline" | "held";

export type MessageStatus = "held" | "pending" | "delivered" | "declined" | "expired";
export type Decision = "allow_once" | "always_allow" | "deny";
export const DECISIONS: readonly Decision[] = ["allow_once", "always_allow", "deny"];

/** The message history between two agents. `aId` sorts before `bId`. */
export interface Thread {
  id: string;
  aId: string;
  bId: string;
  /** The agent that sent the first message. */
  startedBy: string;
  createdAt: string;
  lastMessageAt: string;
}

export interface Message {
  id: string;
  threadId: string;
  fromId: string;
  toId: string;
  /** One line, at most 120 characters, written by the sender: the headline of an approval card. */
  subject: string;
  text: string;
  /** The message this one answers. */
  replyTo: string | null;
  /** The first message of its conversation (its reply_to chain): the task it belongs to. Its own ID for a new one. */
  rootId: string;
  /** Optional, one line, at most 120 characters: the sender's own summary of a long answer, shown on the task. */
  summary: string | null;
  /** False for a reply that says more is coming (done: false): the task stays in progress. */
  final: boolean;
  /** The sender's own key for the message: sending again with the same key returns this message. */
  sendKey: string | null;
  status: MessageStatus;
  /** Set when the message was held for approval; it stays set after the decision. */
  heldAt: string | null;
  decision: Decision | null;
  /** The person who decided. */
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  /** A held or pending message expires after this. */
  expiresAt: string;
  deliveredAt: string | null;
  /** When the sender was told how a held message ended. */
  senderNotifiedAt: string | null;
}

/** Things the outside world acts on: stream nudges, pop-ups and person updates. portico.ts routes them. */
export type Notice =
  | { kind: "message_sent"; message: Message }
  | { kind: "message_decided"; message: Message }
  | { kind: "message_expired"; message: Message }
  | { kind: "message_delivered"; message: Message };

export interface PorticoConfig {
  port: number;
  /** ":memory:" in tests. */
  dbPath: string;
  /** The database's folder: the signing key lives here. */
  dataDir: string;
  /** PORTICO_PLUGIN_SOURCE: the marketplace source /join tells computers to install from. */
  pluginSource: string | null;
  /** PORTICO_PUBLIC_URL, when set: wins over the address confirmed at setup. No trailing slash. */
  publicUrl: string | null;
  /** HMAC key for short-lived signed values, generated into the data folder on first start. */
  signingKey: string;
}
