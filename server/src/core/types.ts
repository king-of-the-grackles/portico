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
  /** The prefix other people's agents address this person's agents by (`robert/muse`). Null until the person picks one. */
  handle: string | null;
  /** The verified email of the person's sign-in, where Portico knows one. */
  email: string | null;
}

/** `personal` is a person's own Portico: only that person's agents, never shared. `shared` brings other people's agents in. */
export type WorkspaceKind = "personal" | "shared";

/**
 * A Portico, the place: a list of people and agents. Two agents reach each other only while both are in one. The code
 * calls it a workspace, since `Portico` here names the running app; nothing a person or an agent sees does.
 */
export interface Workspace {
  id: string;
  /**
   * What everyone calls it: the name someone gave it, the people in it when nobody has ("Chris and Robert"), or
   * "Chris's Portico" for a person's own.
   */
  name: string;
  /** Whether someone gave it a name. */
  named: boolean;
  /** The shared Portico its owner started with, not renamed yet: "Shared Portico" to its owner. */
  starter?: boolean;
  /** How a sentence names it: "the Launch Portico", "Chris's Portico". */
  phrase: string;
  kind: WorkspaceKind;
  ownerId: string;
  createdAt: string;
  /** Set while its owner has it paused: everyone stays in it, and nothing moves through it. */
  pausedAt: string | null;
}

/** The owner's choice for one person in a Portico: the person adds more of the person's own agents alone, or each waits for the owner. */
export type AgentsPolicy = "self" | "ask";
export const AGENTS_POLICIES: readonly AgentsPolicy[] = ["self", "ask"];

/** A computer a person let join Portico. Its sessions' addresses end in `@<name>`. */
export interface Computer {
  id: string;
  ownerId: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** Nobody chose Always allow for this computer yet: each session started here is asked about once per agent it writes to. */
  unproven: boolean;
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
  /** "Ask me before this agent sends to other people's agents": each such message waits for the agent's own person first. */
  outboundHold: boolean;
  /** Joined without its person saying "I started this myself": its first message to each of the person's other agents is held once. */
  unproven: boolean;
  /** Set once the agent's person revoked it: its tokens are gone, it is in no Portico, and it can't come back. */
  revokedAt: string | null;
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

export type MessageStatus = "held" | "pending" | "delivered" | "declined" | "expired" | "withdrawn";
/**
 * Whose decision a held message waits on, and why. `outbound`: the sender's own person, who asked to see what that
 * agent sends to other people's agents. `first_contact`: the receiver's person, who hasn't allowed the sender's person
 * yet. `approval`: the receiver's person, for an agent that takes messages only from senders on its own list.
 * `new_agent`: the same person manages both, and the sender joined lately without that person saying "I started this
 * myself": if a stranger talked the person into allowing the join, this is where the person sees it.
 */
export type HeldFor = "outbound" | "first_contact" | "approval" | "new_agent";
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
  /**
   * The workspace the thread lives in: the one whose content database holds it. A thread never moves. Once the
   * workspace stops joining the two agents, the thread is read-only, and the pair's next conversation starts a thread
   * in another workspace the two share.
   */
  workspaceId: string;
}

export interface Message {
  id: string;
  /** The workspace the message went through: the one whose content database holds the message. */
  workspaceId: string;
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
  /** Why the message is or was held, and so who decides. */
  heldFor: HeldFor | null;
  decision: Decision | null;
  /** The person who decided. */
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  /** A held or pending message expires after this. */
  expiresAt: string;
  deliveredAt: string | null;
  /** When the message was withdrawn: its Portico was paused, or one of its two agents left the Portico or was revoked. */
  withdrawnAt: string | null;
  /** When the sender was told how a held message ended. */
  senderNotifiedAt: string | null;
}

/** Things the outside world acts on: stream nudges, wake URLs and person updates. portico.ts routes them. */
export type Notice =
  | { kind: "message_sent"; message: Message }
  | { kind: "message_decided"; message: Message }
  | { kind: "message_expired"; message: Message }
  | { kind: "message_withdrawn"; message: Message }
  | { kind: "message_delivered"; message: Message };

/** Sending email through Resend: the API key, the sender, and the secret that signs Resend's webhooks. */
export interface MailConfig {
  apiKey: string;
  /** Such as `Portico <invites@mail.portico.example>`. */
  from: string;
  webhookSecret: string | null;
}

/** An S3-compatible bucket for files (Tigris on Fly, say). */
export interface BucketConfig {
  bucket: string;
  endpoint: string | null;
  region: string | null;
  accessKeyId: string;
  secretAccessKey: string;
}

/** An account with the outside sign-in service, as a checked sign-in token names it. */
export interface Account {
  id: string;
  /** The account's verified email address, when the token carries one. */
  email: string | null;
  name: string | null;
}

/**
 * Signing in with an outside account (Descope, on hosted Portico): the first sign-in makes the person, and the welcome
 * page asks for a name and handle. No passwords, passkeys, setup link or invites. Where Core has none, people sign in
 * with this server's own passwords and passkeys. After sign-in nothing differs between the two.
 */
export interface AccountSignIn {
  /** The sign-in service's project, shown on the sign-in page. */
  projectId: string;
  /** The account a sign-in token belongs to, or `unauthorized`. */
  account(token: unknown): Promise<Account>;
}

export interface PorticoConfig {
  port: number;
  /** The directory database, `<dataDir>/portico.db`. ":memory:" in tests, where every workspace's content is in memory too. */
  dbPath: string;
  /** PORTICO_DATA_DIR, the data folder: the directory, each workspace's content under `porticos`, the signing key and files live here. */
  dataDir: string;
  /** PORTICO_PLUGIN_SOURCE: the marketplace source /join tells computers to install from. */
  pluginSource: string | null;
  /** PORTICO_PUBLIC_URL, when set: wins over the address confirmed at setup. No trailing slash. */
  publicUrl: string | null;
  /** HMAC key for short-lived signed values, generated into the data folder on first start. */
  signingKey: string;
  /**
   * PORTICO_SECRETS_KEY: 32 bytes as base64, kept outside the data folder. Encrypts the secrets Portico must be able to
   * read again (wake URL keys, event secrets). Null when unset: commands that only read settings still run, and the
   * server refuses to start.
   */
  secretsKey: string | null;
  /** PORTICO_SECRETS_KEY_OLD: the key before a change of key. A start moves every value under it to the new one. */
  secretsKeyOld: string | null;
  /**
   * PORTICO_WEBHOOKS_ALLOW_PRIVATE=1: wake URLs and event callbacks may use http:// and private addresses. For local
   * development only; otherwise Portico posts only to public https:// addresses.
   */
  webhooksAllowPrivate: boolean;
  /**
   * PORTICO_RETIRED_HOSTS: host names this server used to answer on and no longer does, such as an address from before
   * a move. A request to one gets 410 Gone and the address to use now, whatever the path.
   */
  retiredHosts: string[];
  /** PORTICO_COMMIT: the git commit this build was made from, set by the image build. "unknown" when unset. */
  commit: string;
  /** Where files' bytes live: a bucket when one is configured, otherwise the data folder. */
  files: BucketConfig | null;
  /** Emails share links when set. Null: Share gives the link only. */
  mail: MailConfig | null;
  /**
   * PORTICO_DESCOPE_PROJECT_ID: people sign in with Descope, and signing in creates the account (hosted Portico). Null:
   * passwords and passkeys, with a setup link for the first account and invites for the rest (a self-hosted server).
   */
  descopeProjectId: string | null;
}
