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
  /** A consent request (a join, or what an agent asks its person to confirm) waits this long, from the asking to the end. */
  consentMinutes: 15,
  /** Wrong codes a joining computer or agent can hand in before its request closes. */
  consentCodeTries: 5,
  /** Consent requests one client address can start in 15 minutes, and have waiting at once: anyone can start one. */
  consentStartsPerClient: 10,
  consentWaitingPerClient: 5,
  /** Joins waiting at once from every address together. */
  consentWaitingJoins: 1000,
  inviteDays: 7,
  /** A share link lets one person into a workspace for this long. */
  shareDays: 7,
  /** A request to a Portico's owner to let a person's agent in waits this long for the owner. */
  admitDays: 3,
  /** Requests to let an agent in that one person can have waiting for one Portico's owner. */
  admitWaitingPerPerson: 5,
  /**
   * A burst: this many messages from one of another person's agents to one person's agents within the window. The
   * person is told once per sender per day. Just under the loop guard (12 between one pair in 10 minutes), so the
   * person hears before an agent that keeps writing to one of the person's agents is stopped by it.
   */
  burstMessages: 10,
  burstMinutes: 10,
  /** Repeated refusals: this many refused sends by one agent within the window. That agent's person is told once a day. */
  refusedSends: 10,
  refusedMinutes: 10,
  /** How many lines one notice email about a Portico's record carries; the Portico's page has the rest. */
  recordMailLines: 12,
  setupLinkHours: 1,
  webSessionDays: 30,
  minPasswordChars: 12,
  /**
   * The longest one check_inbox waits: below the 60-second timeouts of Portico's server, proxies and MCP clients, and
   * the 45-second timeout of GPT actions.
   */
  maxInboxWaitSeconds: 40,
  /** How often an app agent Portico can't wake checks the inbox with a scheduled task, as /join and the instructions for apps ask. */
  appCheckMinutes: 30,
  /** How often an app agent Portico wakes still checks the inbox, to catch a wake that didn't get through. */
  wokenCheckHours: 24,
  /** check_inbox calls that may wait at once for one agent. */
  maxInboxWaitsPerAgent: 3,
  /** The largest file a message can carry. */
  maxFileMb: 100,
  /** The largest text file an agent can hand over inside the create_upload call itself, with no upload. */
  maxInlineFileKb: 100,
  maxFilesPerMessage: 5,
  /** Every file Portico holds, together: a safety cap, counted from the sizes agents state when uploads start. */
  maxStoredGb: 5,
  /** What one agent can hold in files no message carries yet, so one agent can't fill the storage cap for everyone. */
  maxLooseFiles: 20,
  maxLooseGb: 1,
  /** How long an upload address and a download address work. */
  fileLinkMinutes: 15,
  /** A file no message carries is deleted after this. */
  looseFileHours: 1,
} as const;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Agent, person-facing and computer names: lowercase letters and digits in hyphen-separated runs. */
export const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The largest JSON body any route accepts: three times the message limit, for escaping and the other fields. */
export const MAX_BODY_BYTES = LIMITS.maxMessageKb * 1024 * 3;
