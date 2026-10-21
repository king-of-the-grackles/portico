export type Delivery = "push" | "pull";
export type RuleAction = "allow" | "ask" | "block";
export type TaskStatus =
  | "waiting_approval"
  | "queued"
  | "working"
  | "done"
  | "failed"
  | "denied"
  | "expired";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "waiting_approval",
  "queued",
  "working",
  "done",
  "failed",
  "denied",
  "expired",
];

export const FINAL_STATUSES: readonly TaskStatus[] = ["done", "failed", "denied", "expired"];

export function isFinal(status: TaskStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

export interface AgentConfig {
  name: string;
  description: string;
  delivery: Delivery;
  /** Labels the agent for the directory and for kind: rules. parseConfig fills in the default. */
  kind: string;
}

/** The owner id every member record carries. One owner per hub for now. */
export const OWNER = "owner";

export const ASSISTANT_KINDS = ["muse", "grok-bot", "chatgpt", "codex", "other"] as const;
export type AssistantKind = (typeof ASSISTANT_KINDS)[number];

/** A computer that joined with a join code. Not an agent itself: its name follows the @ in its sessions' addresses. */
export interface Machine {
  id: string;
  owner: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

/** One Claude Code session on a joined machine. Its address is `${name}@${machine}`. */
export interface SessionRecord {
  id: string;
  owner: string;
  machineId: string;
  /** The machine's name, joined in on read. */
  machine: string;
  name: string;
  /** The random ID the plugin made when it started. An identifier, not a secret. */
  key: string;
  /** The repo basename the name came from. */
  folder: string;
  /** HMAC of the full folder path, keyed with the machine token. */
  folderId: string;
  createdAt: string;
  lastSeenAt: string;
}

/** What a push member reports about itself: Claude Code's own status for a session. */
export type SessionStatus = "busy" | "idle" | "waiting";

/** A push member's status in the directory: its reported status while its stream is open, otherwise offline. */
export type LiveStatus = SessionStatus | "offline";

/**
 * How a message or a queued task will reach its receiver: pushed to a live session, queued until a pull member checks
 * its inbox, or held until an offline session returns.
 */
export type DeliveryTier = "pushed" | "queued" | "offline";

/** A push member's live status, kept in memory only. Text fields are defanged, one line and clipped. */
export interface StatusReport {
  status: SessionStatus;
  /** `<title> · <current to-do>`, at most 120 characters. */
  doing: string | null;
  /** A basename, never a path. */
  repo: string | null;
  branch: string | null;
}

/** A pull agent connected on the hub page, with a minted token. */
export interface Assistant {
  id: string;
  owner: string;
  name: string;
  kind: AssistantKind;
  description: string;
  createdAt: string;
}

export interface JoinCode {
  id: string;
  owner: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

/** Anyone a task can be addressed to: a bridge.yaml agent, a hub-page assistant, or a session on a machine. */
export interface Member {
  /** The full address: the name, or `name@machine` for a session. */
  address: string;
  name: string;
  source: "config" | "assistant" | "session";
  kind: string;
  description: string;
  delivery: Delivery;
  /** The machine's name for a session, otherwise null. */
  machine: string | null;
}

/** One member as the live directory shows it. */
export interface DirectoryEntry extends Member {
  /** The short form when unique, otherwise the full address: the name to address it by. */
  display: string;
  /** Null for pull members. */
  status: LiveStatus | null;
  /** Only while connected. */
  doing: string | null;
  repo: string | null;
  branch: string | null;
  /** Push members: the last report or stream close. Pull members: the last check-in. */
  lastSeen: string | null;
}

/** What rules match on: the member's full address and its kind. */
export interface MemberRef {
  address: string;
  kind: string;
}

export interface RuleConfig {
  from: string;
  to: string;
  action: RuleAction;
}

export interface TriggerConfig {
  name: string;
  when: { agent: string; event: string };
  send: { to: string; instructions: string };
}

export interface Limits {
  taskExpiryHours: number;
  tasksPerHourPerAgent: number;
  eventsPerHourPerAgent: number;
  maxTextKb: number;
  maxChainLength: number;
  historyDays: number;
  maxMessageKb: number;
  messageExpiryHours: number;
  messagesPerHourPerAgent: number;
}

export interface NtfyConfig {
  /** ntfy server base URL, without a trailing slash. */
  url: string;
  topic: string;
  token: string | null;
}

export interface BridgeConfig {
  agents: AgentConfig[];
  rules: RuleConfig[];
  triggers: TriggerConfig[];
  limits: Limits;
  /** Public https base URL, without a trailing slash. */
  publicUrl: string;
  /** Agent name -> token. */
  tokens: Record<string, string>;
  dbPath: string;
  port: number;
  /** HMAC key for approval links and hub page sessions. */
  signingSecret: string;
  adminPassword: string;
  /** Null when BRIDGE_NTFY_TOPIC isn't set: no pushes are sent. */
  ntfy: NtfyConfig | null;
}

export interface Task {
  id: string;
  fromAgent: string;
  toAgent: string;
  instructions: string;
  status: TaskStatus;
  result: string | null;
  reason: string | null;
  parentTaskId: string | null;
  chainLength: number;
  eventId: string | null;
  triggerName: string | null;
  senderNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  /** Optional key from the sender; a repeat send with the same key returns this task (spec §8). */
  idempotencyKey: string | null;
}

/** Free-form text between two agents. Not governed by rules; it has no status beyond delivered. */
export interface Message {
  id: string;
  fromAgent: string;
  toAgent: string;
  text: string;
  /** The message this one answers. */
  replyTo: string | null;
  createdAt: string;
  /** Undelivered messages stop being offered after this. */
  expiresAt: string;
  deliveredAt: string | null;
}

export interface BridgeEvent {
  id: string;
  agent: string;
  name: string;
  details: string;
  createdAt: string;
}

/** Things the outside world may need to act on. notifier.ts turns these into nudges and pushes. */
export type Notice =
  | { kind: "queued"; task: Task }
  | { kind: "approval_needed"; task: Task }
  | { kind: "result_ready"; task: Task }
  /** A task that was waiting_approval got its outcome (by link, hub page or expiry). */
  | { kind: "approval_decided"; task: Task; outcome: "approved" | "denied" | "expired" }
  | { kind: "message_queued"; message: Message };
