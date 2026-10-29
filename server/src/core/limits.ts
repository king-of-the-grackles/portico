/** Portico's built-in limits. There are no settings for them. */
export const LIMITS = {
  maxMessageKb: 64,
  maxSubjectChars: 120,
  maxDescriptionChars: 500,
  maxNameChars: 40,
  messagesPerHour: 120,
  /**
   * A task's window: a held message is decided, a pending one picked up, and a picked-up one answered (or updated with
   * done: false) within this, or the task didn't go through.
   */
  messageExpiryHours: 72,
  /** A reply isn't held when the receiver itself wrote in the conversation within this. */
  replyWindowHours: 24,
  /** An agent's own doing line shows for this long after the agent set it. */
  doingHours: 24,
  historyDays: 30,
  /** Offline sessions leave the agents' list_agents after this; they stay on Portico. */
  sessionListHours: 24,
  joinLineHours: 24,
  signInRequestMinutes: 10,
  inviteDays: 7,
  setupLinkHours: 1,
  webSessionDays: 30,
  minPasswordChars: 12,
  /**
   * The longest one check_inbox waits: below the 60-second timeouts of Portico's server, proxies and MCP clients, and
   * the 45-second timeout of GPT actions.
   */
  maxInboxWaitSeconds: 40,
  /** How often an app agent's scheduled task checks the inbox, as /join and the instructions for apps ask. */
  appCheckMinutes: 30,
  /** check_inbox calls that may wait at once for one agent. */
  maxInboxWaitsPerAgent: 3,
} as const;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Agent, person-facing and computer names: lowercase letters and digits in hyphen-separated runs. */
export const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The largest JSON body any route accepts: three times the message limit, for escaping and the other fields. */
export const MAX_BODY_BYTES = LIMITS.maxMessageKb * 1024 * 3;
