import type { Database } from "bun:sqlite";
import type { Agents } from "./agents";
import type { Changes } from "./changes";
import { type Content, type ContentDb, merged, type Scope } from "./content";
import { PorticoError } from "./errors";
import { checkLength, trimField } from "./lengths";
import { LOOP_LIMIT, LOOP_WINDOW_MS, loopGuardRetryAt } from "./guards";
import type { InboxWaits } from "./inbox-waits";
import { DAY_MS, HOUR_MS, LIMITS, MINUTE_MS } from "./limits";
import { letThrough } from "./tasks";
import type { Workspaces } from "./workspaces";
import { finalFacts, finalValue } from "./types";
import type { Agent, Decision, DeliveryTier, HeldFor, Message, MessageStatus, Notice, Thread, Workspace } from "./types";

interface MessageRow {
  id: string;
  thread_id: string;
  from_id: string;
  to_id: string;
  subject: string;
  text: string;
  reply_to: string | null;
  root_id: string;
  summary: string | null;
  final: number;
  send_key: string | null;
  status: string;
  held_at: string | null;
  held_for: string | null;
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  expires_at: string;
  delivered_at: string | null;
  withdrawn_at: string | null;
  sender_notified_at: string | null;
}

interface ThreadRow {
  id: string;
  a_id: string;
  b_id: string;
  started_by: string;
  created_at: string;
  last_message_at: string;
}

/** A row as a message of the workspace whose content database the row came from. */
function toMessage(row: MessageRow, workspaceId: string): Message {
  return {
    id: row.id,
    workspaceId,
    threadId: row.thread_id,
    fromId: row.from_id,
    toId: row.to_id,
    subject: row.subject,
    text: row.text,
    replyTo: row.reply_to,
    rootId: row.root_id,
    summary: row.summary,
    // The `final` column holds two facts: see FINAL in types.ts.
    ...finalFacts(row.final),
    sendKey: row.send_key,
    status: row.status as MessageStatus,
    heldAt: row.held_at,
    heldFor: row.held_for as HeldFor | null,
    decision: row.decision as Decision | null,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deliveredAt: row.delivered_at,
    withdrawnAt: row.withdrawn_at,
    senderNotifiedAt: row.sender_notified_at,
  };
}

function toThread(row: ThreadRow, workspaceId: string): Thread {
  return {
    id: row.id,
    aId: row.a_id,
    bId: row.b_id,
    startedBy: row.started_by,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    workspaceId,
  };
}

/** `$p0, $p1, …` for a list of values, added to the bindings. */
function among(values: string[], prefix: string, bindings: Record<string, string | number>): string {
  return values
    .map((value, i) => {
      bindings[`${prefix}${i}`] = value;
      return `$${prefix}${i}`;
    })
    .join(", ");
}

/** The most of each kind one deliveries list holds, and one ack may name, so a single ack always covers a list. */
export const DELIVERY_BATCH_MAX = 500;

/** How many messages one page of a thread holds by default, and at most. */
export const THREAD_PAGE = 200;
export const THREAD_PAGE_MAX = 2000;

/**
 * What the sender hears about once: a held message that ended, a message that expired before it was picked up, and a
 * message that was withdrawn.
 */
const UPDATE =
  "from_id = $agent AND sender_notified_at IS NULL AND " +
  "((held_at IS NOT NULL AND status IN ('delivered', 'declined', 'expired')) OR (held_at IS NULL AND status = 'expired') OR status = 'withdrawn')";
/** A message the agent can pick up now. */
const PENDING = "to_id = $agent AND status = 'pending' AND expires_at > $now";

/** Anything that breaks a line, or that a frame would turn into a line break: CR, LF, NEL and the Unicode separators. */
export const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;

/**
 * A subject as given: trimmed, one line, 1 to 120 characters. A longer one is cut to fit at a word boundary, and
 * `notes` gets a sentence saying so.
 */
export function checkSubject(value: unknown, notes?: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PorticoError("bad_request", "subject is required: one line saying what the message asks for.");
  }
  if (LINE_BREAK.test(value.trim())) throw new PorticoError("bad_request", "subject must be one line.");
  return trimField("subject", value.trim(), LIMITS.maxSubjectChars, notes);
}

/** An optional summary: trimmed, one line, at most 120 characters, a longer one cut to fit; empty or absent is none. */
export function checkSummary(value: unknown, notes?: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PorticoError("bad_request", "summary must be a string.");
  const summary = value.trim();
  if (summary === "") return null;
  if (LINE_BREAK.test(summary)) throw new PorticoError("bad_request", "summary must be one line.");
  return trimField("summary", summary, LIMITS.maxSubjectChars, notes);
}

/** An optional key: trimmed, one line, at most 200 characters; empty or absent is none. */
function checkSendKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PorticoError("bad_request", "key must be a string.");
  const key = value.trim();
  if (key === "") return null;
  if (LINE_BREAK.test(key)) throw new PorticoError("bad_request", "key must be one line.");
  checkLength("key", key, LIMITS.maxSendKeyChars);
  return key;
}

function checkText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new PorticoError("bad_request", "text must be a non-empty string.");
  if (new TextEncoder().encode(value).length > LIMITS.maxMessageKb * 1024) {
    throw new PorticoError("too_large", `text is larger than ${LIMITS.maxMessageKb} KB.`);
  }
  return value;
}

/** What sending needs from files: which ones a sender may attach, putting them on a message, and reading them back. */
export interface MessageFiles {
  /** The IDs as given, cleaned, with no check of who may attach them. */
  ids(attachments: unknown): string[];
  /** The files a send may carry, checked, each with where its bytes are now. */
  attachable(caller: Agent, attachments: unknown): { id: string }[];
  /** Puts the files `attachable` gave on a message, inside the send's transaction in the message's own content database. */
  attach(content: ContentDb, messageId: string, files: { id: string }[]): void;
  /** After the send's transaction: the files' bytes are copied into the message's workspace. */
  attached(message: Message, files: { id: string }[]): void;
  of(message: Pick<Message, "id" | "workspaceId">): { id: string }[];
}

export interface MessagesDeps {
  /** Each workspace's own database: every thread and message lives in one. */
  content: Content;
  agents: Agents;
  /** The reach rule, and which workspace a conversation goes in. */
  workspaces: Workspaces;
  /** Whether the receiver always allows messages from the sender: the agent's own list. */
  alwaysAllows: (agentId: string, senderId: string) => boolean;
  /** First contact: whether the agents of one person get through to the agents of another. By default, everyone's do. */
  peopleAllowed?: (personId: string, senderPersonId: string) => boolean;
  /** The name of the person, for the sentences a held send answers with. */
  personName?: (personId: string) => string;
  /** The page where a held message is decided. */
  heldLink?: (messageId: string) => string;
  /** A send was refused: for the Portico's record and the alert about repeated refusals. Never the message. */
  onRefused?: (refusal: { caller: Agent; receiver: Agent | null; workspace: Workspace | null; code: string }) => void;
  changes: Changes;
  /** Where check_inbox calls wait; Portico wakes them as it nudges sessions. */
  waits: InboxWaits;
  /** The files a message can carry. Without it, messages carry none. */
  files?: MessageFiles;
  now?: () => Date;
  newId?: () => string;
  notify?: (notice: Notice) => void;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * The start of the SQL for "not a message that never left someone else's side": close with the test for whose side
 * reads, and a parenthesis. The same rule as `neverSent` in tasks.ts.
 */
const NEVER_SENT_ELSEWHERE = "NOT (held_for IS 'outbound' AND status NOT IN ('pending', 'delivered')";

/**
 * Messages between agents, the threads they form, holds for approval, and what each agent picks up. Every thread and
 * message lives in one workspace's content database. A read names whose content to look in (a scope), or starts from
 * a thread or message already found, which says which workspace it is in. Nothing here searches every workspace for a
 * caller; only the sweeps (`expireDue`, `prune`) walk them all.
 */
export class Messages {
  private readonly content: Content;
  private readonly agents: Agents;
  private readonly workspaces: Workspaces;
  private readonly alwaysAllows: (agentId: string, senderId: string) => boolean;
  private readonly peopleAllowed: (personId: string, senderPersonId: string) => boolean;
  private readonly personName: (personId: string) => string;
  private readonly heldLink: ((messageId: string) => string) | null;
  private readonly onRefused: NonNullable<MessagesDeps["onRefused"]>;
  private readonly changes: Changes;
  private readonly waits: InboxWaits;
  private readonly files: MessageFiles | null;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly notify: (notice: Notice) => void;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  /** check_inbox calls waiting now, by slot (a session's run, or the agent). */
  private readonly waitingSlots = new Map<string, number>();

  constructor(deps: MessagesDeps) {
    this.content = deps.content;
    this.agents = deps.agents;
    this.workspaces = deps.workspaces;
    this.alwaysAllows = deps.alwaysAllows;
    this.peopleAllowed = deps.peopleAllowed ?? (() => true);
    this.personName = deps.personName ?? (() => "that agent's person");
    this.heldLink = deps.heldLink ?? null;
    this.onRefused = deps.onRefused ?? (() => {});
    this.changes = deps.changes;
    this.waits = deps.waits;
    this.files = deps.files ?? null;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.notify = deps.notify ?? (() => {});
    this.log = deps.log ?? (() => {});
  }

  /**
   * Sends a message. Three things can hold it for a person, the first that applies:
   * - outbound: the sender's own person asked to see what the sender writes to other people's agents;
   * - first contact: the receiver's person hasn't allowed the sender's person yet, whatever the receiver's own setting;
   * - approval: the receiver requires approval and doesn't always allow the sender.
   * The last two never hold a reply in a conversation the receiver itself wrote in during the last 24 hours, and two
   * agents of one person are never held by the first two. Every message obeys the size limit, the hourly limit and
   * the loop guard. A reply with done: false says more is coming. A message with no_reply_needed tells the receiver not
   * to answer only to acknowledge: a reply is still accepted. A message with a key the
   * sender used before isn't sent again: the first one comes back. Attachments are file IDs: finished uploads of the
   * sender's own, or files the sender received.
   *
   * The two agents must be in one workspace now. A name (`to`) finds only agents the sender reaches. A new conversation
   * goes in the most private workspace the two share (`Workspaces.route`). A reply (`reply_to`) stays in the workspace
   * of the message it answers while that workspace still joins the two. When it no longer does and another workspace
   * joins them, the old conversation is read-only: the message starts a new conversation in the routed workspace, with
   * no reply_to, and the result's note says so. When the two share no workspace, the send is refused.
   */
  send(
    caller: Agent,
    input: {
      to?: unknown;
      subject: unknown;
      text: unknown;
      replyTo?: unknown;
      summary?: unknown;
      done?: unknown;
      noReplyNeeded?: unknown;
      key?: unknown;
      attachments?: unknown;
    },
  ): { message: Message; delivery: DeliveryTier; note: string | null; workspace: Workspace | null } {
    // What the sender hears besides the message: first, anything Portico trimmed to fit.
    const notes: string[] = [];
    const subject = checkSubject(input.subject, notes);
    const text = checkText(input.text);
    const summary = checkSummary(input.summary, notes);
    const sendKey = checkSendKey(input.key);
    if (input.done !== undefined && input.done !== null && typeof input.done !== "boolean") {
      throw new PorticoError("bad_request", "done must be true or false.");
    }
    const final = input.done !== false;
    if (input.noReplyNeeded !== undefined && input.noReplyNeeded !== null && typeof input.noReplyNeeded !== "boolean") {
      throw new PorticoError("bad_request", "no_reply_needed must be true or false.");
    }
    const noReplyNeeded = input.noReplyNeeded === true;
    if (noReplyNeeded && !final) {
      throw new PorticoError("bad_request", "no_reply_needed can't go with done: false, which says more is coming. Leave one of the two out.");
    }
    if (sendKey !== null) {
      const first = this.sentWithKey(caller.id, sendKey);
      if (first) {
        // A retry repeats the message. Anything else under the same key is a different message, and coming back with
        // the first one would drop it silently, so say so instead.
        const replyTo = typeof input.replyTo === "string" && input.replyTo !== "" ? input.replyTo : null;
        const to = typeof input.to === "string" && input.to.trim() !== "" ? this.agents.resolve(input.to, caller.id).id : first.toId;
        // Compared as named, before any check of the files: a retry stays safe after the first message's files went
        // (a declined message drops them), and then there is nothing left to compare.
        const namedFiles = this.files?.ids(input.attachments) ?? [];
        const firstFiles = (this.files?.of(first) ?? []).map((file) => file.id);
        const sameFiles =
          (first.status === "declined" && firstFiles.length === 0) ||
          (firstFiles.length === namedFiles.length && firstFiles.every((id, i) => id === namedFiles[i]));
        // A reply that started a new conversation, because its workspace stopped joining the two, was stored with no
        // reply_to: the message the retry names is then in another workspace than the first message.
        const named = (id: string) => this.get({ agent: caller.id }, id);
        const sameReply = first.replyTo === replyTo || (first.replyTo === null && replyTo !== null && (named(replyTo)?.workspaceId ?? first.workspaceId) !== first.workspaceId);
        if (
          first.subject !== subject ||
          first.text !== text ||
          first.final !== final ||
          first.noReplyNeeded !== noReplyNeeded ||
          !sameReply ||
          first.toId !== to ||
          !sameFiles
        ) {
          throw new PorticoError(
            "conflict",
            `The key ${sendKey} already sent message ${first.id} (${first.subject}), which differs from this one. A retry ` +
              "already went through; for a new message, use a new key.",
          );
        }
        const receiver = this.agents.get(first.toId);
        return {
          message: first,
          delivery: first.status === "held" || !receiver ? "held" : this.agents.tier(receiver),
          note: [
            ...notes,
            "Already sent with this key, so nothing new was sent. This is the first message.",
            ...(receiver && first.noReplyNeeded && first.status !== "held" ? [noReplyNote(first, this.agents.nameFor(receiver, caller.ownerId))] : []),
          ].join(" "),
          workspace: this.workspaces.known(first.workspaceId),
        };
      }
    }
    const attachments = this.attachable(caller, input.attachments);
    let receiver: Agent | null = null;
    if (typeof input.to === "string" && input.to.trim() !== "") {
      try {
        receiver = this.agents.resolve(input.to, caller.id);
      } catch (err) {
        // A name that reaches nobody is a refused send too: many in a row is what a misled agent looks like.
        if (err instanceof PorticoError && (err.code === "unknown_agent" || err.code === "not_allowed")) this.onRefused({ caller, receiver: null, workspace: null, code: err.code });
        throw err;
      }
    }
    let original: Message | null = null;
    if (input.replyTo !== undefined && input.replyTo !== null && input.replyTo !== "") {
      // Only among the caller's own workspaces: a message anywhere else answers the same as one that doesn't exist.
      original = typeof input.replyTo === "string" ? this.get({ agent: caller.id }, input.replyTo) : null;
      if (!original || (original.toId !== caller.id && original.fromId !== caller.id)) {
        throw new PorticoError("bad_request", "reply_to must be the ID of a message sent to or by this agent.");
      }
      // A message a person hasn't let through isn't the receiver's to answer: answering would open the conversation.
      if (original.toId === caller.id && !letThrough(original)) {
        throw new PorticoError("bad_request", "reply_to must be the ID of a message sent to or by this agent.");
      }
      const other = original.toId === caller.id ? original.fromId : original.toId;
      if (receiver && receiver.id !== other) {
        throw new PorticoError("bad_request", "reply_to names a message from a different thread. Leave out to, or fix reply_to.");
      }
      receiver ??= this.agents.require(other);
    }
    if (!receiver) throw new PorticoError("bad_request", "to is required unless reply_to is given.");
    if (!final && original === null) {
      throw new PorticoError("bad_request", "done: false marks a reply as an update with more to come, so reply_to is required.");
    }
    if (receiver.id === caller.id) throw new PorticoError("bad_request", "An agent can't send a message to itself.");
    const everyShared = this.workspaces.shared(caller.id, receiver.id);
    if (everyShared.length === 0) {
      this.onRefused({ caller, receiver, workspace: null, code: "not_allowed" });
      throw new PorticoError(
        "not_allowed",
        `You and \`${this.agents.nameFor(receiver, caller.ownerId)}\` no longer share a Portico, so the conversation is ` +
          "read-only. list_agents shows who can be reached now.",
      );
    }
    // Nothing moves through a paused workspace. The two may still share another.
    const shared = everyShared.filter((w) => w.pausedAt === null);
    if (shared.length === 0) {
      const paused = everyShared[0]!;
      this.onRefused({ caller, receiver, workspace: paused, code: "paused" });
      throw new PorticoError(
        "not_allowed",
        `${paused.phrase.charAt(0).toUpperCase()}${paused.phrase.slice(1)} is paused, so nothing moves through that Portico: this message was not sent. ` +
          `${this.personName(paused.ownerId)}, who paused the Portico, can resume the Portico on Portico's pages.`,
      );
    }
    // A reply stays where the conversation is while that workspace still joins the two. Otherwise the conversation is
    // read-only, and the message starts a new one where a new conversation between the two goes.
    const stays = original !== null && shared.some((w) => w.id === original.workspaceId);
    const workspace: Workspace = stays ? shared.find((w) => w.id === original!.workspaceId)! : this.workspaces.route(caller.id, receiver.id)!;
    const moved = original !== null && !stays;
    const replyTo = stays ? original!.id : null;
    const rootId = stays ? original!.rootId : null;
    try {
      this.requireBudget(caller, receiver, shared);
    } catch (err) {
      if (err instanceof PorticoError) this.onRefused({ caller, receiver, workspace, code: err.code });
      throw err;
    }

    const at = this.iso();
    const content = this.content.for(workspace.id);
    const message = content.db.transaction(() => {
      const thread = this.threadIn(content, caller.id, receiver.id) ?? this.startThread(content, caller.id, receiver.id, at);
      // A newly joined agent nobody vouched for is held on its way out too, whatever its switch says: its own person
      // sees what it sends to other people's agents before anyone on the receiving side is asked anything.
      const heldFor: HeldFor | null =
        (caller.outboundHold || caller.unproven) && caller.ownerId !== receiver.ownerId ? "outbound" : this.arrivalHold(content.db, caller, receiver, replyTo);
      const held = heldFor !== null;
      const id = this.newId();
      const m: Message = {
        id,
        workspaceId: workspace.id,
        threadId: thread.id,
        fromId: caller.id,
        toId: receiver.id,
        subject,
        text,
        replyTo,
        rootId: rootId ?? id,
        summary,
        final,
        noReplyNeeded,
        sendKey,
        status: held ? "held" : "pending",
        heldAt: held ? at : null,
        heldFor,
        decision: null,
        decidedBy: null,
        decidedAt: null,
        createdAt: at,
        expiresAt: this.iso(LIMITS.messageExpiryHours * HOUR_MS),
        deliveredAt: null,
        withdrawnAt: null,
        senderNotifiedAt: null,
      };
      this.insert(content.db, m);
      if (attachments.length > 0) this.files!.attach(content, id, attachments);
      content.db.query("UPDATE threads SET last_message_at = $at WHERE id = $id").run({ id: thread.id, at });
      return m;
    })();
    if (attachments.length > 0) this.files!.attached(message, attachments);

    const delivery: DeliveryTier = message.status === "held" ? "held" : this.agents.tier(receiver);
    this.log("message_sent", { message_id: message.id, workspace_id: workspace.id, from: caller.id, to: receiver.id, delivery, moved });
    this.notify({ kind: "message_sent", message });
    this.changes.about({ agents: [message.fromId, message.toId] }, ...(message.status === "held" ? (["threads", "approvals"] as const) : (["threads"] as const)));
    const name = this.agents.nameFor(receiver, caller.ownerId);
    if (moved) {
      notes.push(
        `The message reply_to names is in a conversation whose Portico no longer joins this agent and ${name}, so ` +
          `that conversation is read-only. This message started a new conversation in ${workspace.phrase}, ` +
          "with no reply_to.",
      );
    }
    if (delivery === "held") notes.push(this.heldNote(message, caller, receiver, name));
    else if (noReplyNeeded) notes.push(noReplyNote(message, name));
    return { message, delivery, note: notes.length > 0 ? notes.join(" ") : null, workspace };
  }

  /**
   * Picks up the caller's pending messages (they become delivered) and the outcomes of its held messages (marked
   * reported), from every workspace the caller is or was in, oldest first. Marks the caller checked in.
   */
  inbox(caller: Agent): { messages: Message[]; updates: Message[] } {
    const at = this.iso();
    const messages: Message[][] = [];
    const updates: Message[][] = [];
    const open = this.deliverable(caller.id);
    for (const content of this.content.of({ agent: caller.id })) {
      content.db.transaction(() => {
        // Only through a workspace the caller is in now, that isn't deleted or paused. Outcomes come from anywhere.
        const pending = open.has(content.workspaceId) ? this.pendingFor(content, caller.id, at, -1) : [];
        const outcomes = this.updatesFor(content, caller.id, -1);
        this.markDelivered(content.db, caller.id, pending.map((m) => m.id), at);
        this.markNotified(content.db, caller.id, outcomes.map((m) => m.id), at);
        messages.push(pending.map((m) => ({ ...m, status: "delivered" as const, deliveredAt: at })));
        updates.push(outcomes.map((m) => ({ ...m, senderNotifiedAt: at })));
      })();
    }
    const outcome = { messages: merged(messages, sentAt), updates: merged(updates, endedAt) };
    this.agents.checkedIn(caller);
    this.afterDelivery(outcome.messages);
    return outcome;
  }

  /** What a session's plugin has to deliver, oldest first, at most DELIVERY_BATCH_MAX of each. Changes nothing. */
  pending(caller: Agent): { messages: Message[]; updates: Message[] } {
    const at = this.iso();
    const contents = this.content.of({ agent: caller.id });
    const open = this.deliverable(caller.id);
    const pending = {
      messages: merged(contents.filter((c) => open.has(c.workspaceId)).map((c) => this.pendingFor(c, caller.id, at, DELIVERY_BATCH_MAX)), sentAt).slice(0, DELIVERY_BATCH_MAX),
      updates: merged(contents.map((c) => this.updatesFor(c, caller.id, DELIVERY_BATCH_MAX)), endedAt).slice(0, DELIVERY_BATCH_MAX),
    };
    this.agents.checkedIn(caller);
    return pending;
  }

  /** Marks delivered messages delivered and reported updates reported: only the caller's own, only those still waiting. */
  ack(caller: Agent, ack: { messages: string[]; updates: string[] }): { messages: number; updates: number } {
    const at = this.iso();
    const ids = [...new Set(ack.messages)];
    const updateIds = [...new Set(ack.updates)];
    const delivered: Message[] = [];
    let notified = 0;
    const open = this.deliverable(caller.id);
    for (const content of this.content.of({ agent: caller.id })) {
      content.db.transaction(() => {
        // Marked first, then read back: only the ones this ack delivered carry this delivered_at.
        if (open.has(content.workspaceId)) this.markDelivered(content.db, caller.id, ids, at);
        for (const id of ids) {
          const m = this.getIn(content, id);
          if (m && m.toId === caller.id && m.deliveredAt === at) delivered.push(m);
        }
        notified += this.markNotified(content.db, caller.id, updateIds, at);
      })();
    }
    this.afterDelivery(delivered);
    return { messages: delivered.length, updates: notified };
  }

  /** Pending messages and unreported outcomes: what the caller's next check_inbox would pick up. */
  unreadCount(agentId: string): number {
    const now = this.iso();
    let count = 0;
    const open = this.deliverable(agentId);
    for (const { db, workspaceId } of this.content.of({ agent: agentId })) {
      const row = db
        .query(
          `SELECT (SELECT COUNT(*) FROM messages WHERE ${PENDING}) AS pending,
                  (SELECT COUNT(*) FROM messages WHERE ${UPDATE}) AS updates`,
        )
        .get({ agent: agentId, now }) as { pending: number; updates: number };
      count += (open.has(workspaceId) ? row.pending : 0) + row.updates;
    }
    return count + this.extraUnread(agentId);
  }

  /** What else waits for an agent besides messages and outcomes: Portico's own notices. Set by portico.ts. */
  extraUnread: (agentId: string) => number = () => 0;

  /** The workspaces a message can reach the agent through now: the agent is in each, and none is deleted or paused. */
  private deliverable(agentId: string): Set<string> {
    return new Set(
      this.workspaces
        .ofAgent(agentId)
        .filter((w) => w.pausedAt === null)
        .map((w) => w.id),
    );
  }

  hasWaiting(agentId: string): boolean {
    return this.unreadCount(agentId) > 0;
  }

  /**
   * Waits up to `ms` until the caller has something to pick up, and marks it checked in as the wait starts. Ends early
   * when the caller's credential stops working (`valid`, checked on every wake; by default, while the agent exists) or
   * when the signal aborts because the caller went away or cancelled; then nothing should be picked up. Times out by
   * the real clock: a wait is real time.
   */
  async waitForInbox(
    caller: Agent,
    ms: number,
    opts: { signal?: AbortSignal; valid?: () => boolean; slot?: string } = {},
  ): Promise<"ready" | "timeout" | "gone" | "aborted"> {
    const valid = opts.valid ?? (() => this.agents.get(caller.id) !== null);
    // Counted per slot: a session's run, so the conversations sharing a folder's agent each get the allowance.
    const slot = opts.slot ?? caller.id;
    const waiting = this.waitingSlots.get(slot) ?? 0;
    if (waiting >= LIMITS.maxInboxWaitsPerAgent) {
      throw new PorticoError(
        "rate_limited",
        `${LIMITS.maxInboxWaitsPerAgent} check_inbox calls are already waiting for this agent. Let one finish first.`,
      );
    }
    this.waitingSlots.set(slot, waiting + 1);
    try {
      this.agents.checkedIn(caller);
      const deadline = Date.now() + ms;
      for (;;) {
        if (opts.signal?.aborted) return "aborted";
        if (!valid()) return "gone";
        if (this.hasWaiting(caller.id)) return "ready";
        const left = deadline - Date.now();
        if (left <= 0) return "timeout";
        await this.waits.sleep(caller.id, left, opts.signal);
      }
    } finally {
      const left = (this.waitingSlots.get(slot) ?? 1) - 1;
      if (left <= 0) this.waitingSlots.delete(slot);
      else this.waitingSlots.set(slot, left);
    }
  }

  /** The message with the ID, looked for only in the scope's workspaces. */
  get(scope: Scope, id: string): Message | null {
    for (const content of this.content.of(scope)) {
      const message = this.getIn(content, id);
      if (message) return message;
    }
    return null;
  }

  require(scope: Scope, id: string): Message {
    const message = this.get(scope, id);
    if (!message) throw new PorticoError("not_found", "No such message.");
    return message;
  }

  /** The message this one answers: it is in the same workspace, or gone with the history. */
  original(message: Pick<Message, "workspaceId" | "replyTo">): Message | null {
    return message.replyTo ? this.get({ workspace: message.workspaceId }, message.replyTo) : null;
  }

  // ---- threads ----

  /** The thread with the ID, looked for only in the scope's workspaces. */
  thread(scope: Scope, id: string): Thread | null {
    for (const { db, workspaceId } of this.content.of(scope)) {
      const row = db.query("SELECT * FROM threads WHERE id = $id").get({ id }) as ThreadRow | null;
      if (row) return toThread(row, workspaceId);
    }
    return null;
  }

  /**
   * The threads between the two agents, the latest message first: one in each workspace the pair has talked through.
   * Looked for in the workspaces the first agent is or was in.
   */
  threadsBetween(x: string, y: string): Thread[] {
    const threads = this.content.of({ agent: x }).flatMap((content) => {
      const thread = this.threadIn(content, x, y);
      return thread ? [thread] : [];
    });
    return threads.sort((s, t) => (s.lastMessageAt < t.lastMessageAt ? 1 : s.lastMessageAt > t.lastMessageAt ? -1 : 0));
  }

  /**
   * The scope's threads, most recent first. With `involving`, only threads with at least one of those agents; with
   * `agentId`, only that agent's threads. A person's request always names `involving`: the person's own agents.
   */
  threads(scope: Scope, filter: { involving?: string[]; agentId?: string; limit?: number } = {}): Thread[] {
    // Filtered before the limit, so a member's or an agent's threads never fall behind everyone else's.
    const limit = filter.limit ?? 500;
    const clauses: string[] = [];
    const bindings: Record<string, string | number> = { limit };
    if (filter.involving) {
      if (filter.involving.length === 0) return [];
      const names = among(filter.involving, "i", bindings);
      clauses.push(`(a_id IN (${names}) OR b_id IN (${names}))`);
    }
    if (filter.agentId) {
      clauses.push("(a_id = $agentId OR b_id = $agentId)");
      bindings.agentId = filter.agentId;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const lists = this.content.of(scope).map(({ db, workspaceId }) =>
      (db.query(`SELECT * FROM threads ${where} ORDER BY last_message_at DESC, id LIMIT $limit`).all(bindings) as ThreadRow[]).map((row) =>
        toThread(row, workspaceId),
      ),
    );
    return merged(lists, (thread) => thread.lastMessageAt, true).slice(0, limit);
  }

  /**
   * A page of the thread, oldest first: the newest `limit` messages, or with `before`, the newest `limit` sent before
   * that message. `more` says whether older messages remain.
   */
  inThread(thread: Pick<Thread, "id" | "workspaceId">, page: { before?: string; limit?: number } = {}): { messages: Message[]; more: boolean } {
    const content = this.content.find(thread.workspaceId);
    if (!content) return { messages: [], more: false };
    const threadId = thread.id;
    const limit = Math.min(Math.max(1, Math.floor(page.limit ?? THREAD_PAGE)), THREAD_PAGE_MAX);
    const cursor = page.before
      ? (content.db
          .query("SELECT created_at AS at, rowid AS n FROM messages WHERE id = $id AND thread_id = $threadId")
          .get({ id: page.before, threadId }) as { at: string; n: number } | null)
      : null;
    // Pruning deletes the oldest messages first, so when the cursor is gone, so is everything older.
    if (page.before && !cursor) return { messages: [], more: false };
    const rows = content.db
      .query(
        `SELECT * FROM messages WHERE thread_id = $threadId
           ${cursor ? "AND (created_at < $at OR (created_at = $at AND rowid < $n))" : ""}
         ORDER BY created_at DESC, rowid DESC LIMIT $limit`,
      )
      .all({ threadId, limit: limit + 1, ...(cursor ? { at: cursor.at, n: cursor.n } : {}) }) as MessageRow[];
    return {
      messages: rows
        .slice(0, limit)
        .reverse()
        .map((row) => toMessage(row, content.workspaceId)),
      more: rows.length > limit,
    };
  }

  /**
   * The thread's newest message, its count, and how many are held. With `reader`, the agents of the person reading:
   * a message that never left someone else's side (see `neverSent`) is not the newest, and is not counted.
   */
  threadSummary(thread: Pick<Thread, "id" | "workspaceId">, reader: string[] | null = null): { last: Message | null; count: number; held: number } {
    const content = this.content.find(thread.workspaceId);
    if (!content) return { last: null, count: 0, held: 0 };
    const bindings: Record<string, string | number> = { threadId: thread.id };
    const sent = reader === null ? "" : `AND ${NEVER_SENT_ELSEWHERE} AND from_id NOT IN (${reader.length > 0 ? among(reader, "r", bindings) : "''"}))`;
    const last = content.db
      .query(`SELECT * FROM messages WHERE thread_id = $threadId ${sent} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(bindings) as MessageRow | null;
    const counts = content.db
      .query(`SELECT COUNT(*) AS n, SUM(status = 'held') AS held FROM messages WHERE thread_id = $threadId ${sent}`)
      .get(bindings) as { n: number; held: number | null };
    return { last: last ? toMessage(last, content.workspaceId) : null, count: counts.n, held: counts.held ?? 0 };
  }

  /**
   * The message sent just before this one in its thread, as the people deciding this one may know it: a message of
   * the other agent that never left that agent's side (`neverSent`) is passed over, as if it weren't there.
   */
  previous(message: Message): Message | null {
    const content = this.content.find(message.workspaceId);
    if (!content) return null;
    const row = content.db
      .query(
        `SELECT * FROM messages WHERE thread_id = $threadId
           AND (created_at < $at OR (created_at = $at AND rowid < (SELECT rowid FROM messages WHERE id = $id)))
           AND ${NEVER_SENT_ELSEWHERE} AND from_id IS NOT $fromId)
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get({ threadId: message.threadId, at: message.createdAt, id: message.id, fromId: message.fromId }) as MessageRow | null;
    return row ? toMessage(row, content.workspaceId) : null;
  }

  // ---- holds ----

  /**
   * Whether the receiver itself wrote in the conversation `messageId` belongs to (its reply_to chain) during the last 24
   * hours. Only the receiver's own messages count: a sender chooses reply_to, so its own earlier messages can't open the
   * way. Answers to the protected agent, and the back-and-forth once it has replied, are never held.
   */
  private receiverInConversation(db: Database, messageId: string, receiverId: string): boolean {
    const row = db
      .query(
        `WITH RECURSIVE chain(id, reply_to, from_id, created_at) AS (
           SELECT id, reply_to, from_id, created_at FROM messages WHERE id = $id
           UNION
           SELECT m.id, m.reply_to, m.from_id, m.created_at FROM messages m JOIN chain c ON m.id = c.reply_to
         )
         SELECT 1 AS ok FROM chain WHERE from_id = $receiver AND created_at > $since LIMIT 1`,
      )
      .get({ id: messageId, receiver: receiverId, since: this.iso(-LIMITS.replyWindowHours * HOUR_MS) }) as { ok: number } | null;
    return row !== null;
  }

  /** The message the sender already sent with this key, if any, in any workspace the sender is or was in. */
  private sentWithKey(fromId: string, sendKey: string): Message | null {
    for (const { db, workspaceId } of this.content.of({ agent: fromId })) {
      const row = db.query("SELECT * FROM messages WHERE from_id = $fromId AND send_key = $sendKey").get({ fromId, sendKey }) as MessageRow | null;
      if (row) return toMessage(row, workspaceId);
    }
    return null;
  }

  /**
   * Held messages the person decides, oldest first: those held on arrival for agents the person manages, and those
   * held on their way out from agents the person manages. Two steps: the directory says which agents are the person's,
   * and each of the person's workspaces is asked for held messages of those agents.
   */
  heldFor(personId: string): Message[] {
    const mine = this.agents.ownedBy(personId).map((agent) => agent.id);
    if (mine.length === 0) return [];
    const bindings: Record<string, string | number> = {};
    const names = among(mine, "m", bindings);
    const lists = this.content.of({ person: personId }).map(({ db, workspaceId }) =>
      (
        db
          .query(
            `SELECT * FROM messages WHERE status = 'held'
               AND ((to_id IN (${names}) AND held_for IS NOT 'outbound') OR (from_id IN (${names}) AND held_for = 'outbound'))
             ORDER BY created_at, rowid`,
          )
          .all(bindings) as MessageRow[]
      ).map((row) => toMessage(row, workspaceId)),
    );
    return merged(lists, sentAt);
  }

  /** First contacts held from one person's agents for another person's decision, oldest first. */
  heldFromPerson(senderPersonId: string, personId: string): Message[] {
    const from = this.agents.ownedBy(senderPersonId).map((agent) => agent.id);
    const to = this.agents.ownedBy(personId).map((agent) => agent.id);
    if (from.length === 0 || to.length === 0) return [];
    const bindings: Record<string, string | number> = {};
    const senders = among(from, "f", bindings);
    const receivers = among(to, "t", bindings);
    const lists = this.content.of({ person: personId }).map(({ db, workspaceId }) =>
      (
        db
          .query(`SELECT * FROM messages WHERE status = 'held' AND held_for = 'first_contact' AND from_id IN (${senders}) AND to_id IN (${receivers}) ORDER BY created_at, rowid`)
          .all(bindings) as MessageRow[]
      ).map((row) => toMessage(row, workspaceId)),
    );
    return merged(lists, sentAt);
  }

  /**
   * The sender's person allowed a message held on its way out. The message goes on to whatever the receiving side
   * requires: held again, now for the receiver's person, or pending. Null when the message isn't held any more.
   * Checked here, for every caller: a message whose workspace no longer joins the two agents, or is paused or gone,
   * can't go on, so it is withdrawn instead, and comes back with that status.
   */
  releaseOutbound(held: Pick<Message, "id" | "workspaceId">, personId: string, at: string): Message | null {
    const content = this.content.stored(held.workspaceId);
    if (!content) return null;
    let withdrawn = false;
    const after = content.db.transaction(() => {
      const now = this.getIn(content, held.id);
      if (!now || now.status !== "held" || now.heldFor !== "outbound") return null;
      if (!this.workspaces.joins(now.workspaceId, now.fromId, now.toId)) {
        content.db.query("UPDATE messages SET status = 'withdrawn', withdrawn_at = $at WHERE id = $id AND status = 'held'").run({ id: now.id, at });
        withdrawn = true;
        return this.getIn(content, held.id);
      }
      const caller = this.agents.get(now.fromId);
      const receiver = this.agents.get(now.toId);
      const next = caller && receiver ? this.arrivalHold(content.db, caller, receiver, now.replyTo) : null;
      if (next) {
        // `decided_by` keeps who let the message go on, until the receiver's person decides.
        content.db.query("UPDATE messages SET held_for = $next, held_at = $at, decided_by = $personId WHERE id = $id AND status = 'held'").run({ id: now.id, next, at, personId });
      } else {
        content.db
          .query("UPDATE messages SET status = 'pending', decision = 'allow_once', decided_by = $personId, decided_at = $at WHERE id = $id AND status = 'held'")
          .run({ id: now.id, personId, at });
      }
      return this.getIn(content, held.id);
    })();
    if (after && withdrawn) {
      this.log("message_withdrawn", { message_id: after.id, workspace_id: after.workspaceId });
      this.notify({ kind: "message_withdrawn", message: after });
    }
    return after;
  }

  /**
   * Withdraws messages that can no longer be delivered: held or pending ones in the workspace, from or to the agents
   * named, or every one with `null` (the workspace was paused or deleted). A withdrawn message is never delivered; its
   * sender is told once, as for a message that expired.
   */
  withdraw(workspaceId: string, agentIds: string[] | null): Message[] {
    if (agentIds !== null && agentIds.length === 0) return [];
    const content = this.content.stored(workspaceId);
    if (!content) return [];
    const at = this.iso();
    const bindings: Record<string, string | number> = {};
    const names = agentIds === null ? "" : among(agentIds, "w", bindings);
    const which = agentIds === null ? "" : `AND (from_id IN (${names}) OR to_id IN (${names}))`;
    const withdrawn = content.db.transaction(() => {
      const rows = content.db.query(`SELECT * FROM messages WHERE status IN ('held', 'pending') ${which} ORDER BY created_at, rowid`).all(bindings) as MessageRow[];
      if (rows.length === 0) return [];
      content.db.query(`UPDATE messages SET status = 'withdrawn', withdrawn_at = $at WHERE status IN ('held', 'pending') ${which}`).run({ ...bindings, at });
      return rows.map((row) => ({ ...toMessage(row, content.workspaceId), status: "withdrawn" as const, withdrawnAt: at }));
    })();
    for (const message of withdrawn) {
      this.log("message_withdrawn", { message_id: message.id, workspace_id: workspaceId });
      this.notify({ kind: "message_withdrawn", message });
    }
    if (withdrawn.length > 0) this.changes.about({ agents: withdrawn.flatMap((m) => [m.fromId, m.toId]), workspaces: [workspaceId] }, "threads", "approvals");
    return withdrawn;
  }

  /** Held messages from the sender to the receiver, oldest first, in every workspace the receiver is or was in. */
  heldBetween(fromId: string, toId: string): Message[] {
    const lists = this.content.of({ agent: toId }).map(({ db, workspaceId }) =>
      (
        db
          .query("SELECT * FROM messages WHERE from_id = $fromId AND to_id = $toId AND status = 'held' ORDER BY created_at, rowid")
          .all({ fromId, toId }) as MessageRow[]
      ).map((row) => toMessage(row, workspaceId)),
    );
    return merged(lists, sentAt);
  }

  /** Earlier decisions on messages from the sender to the receiver, newest first. */
  decisionsBetween(fromId: string, toId: string, exceptId: string, limit = 3): { decision: Decision; at: string }[] {
    const lists = this.content.of({ agent: toId }).map(({ db }) =>
      (
        db
          .query(
            `SELECT decision, decided_at FROM messages
             WHERE from_id = $fromId AND to_id = $toId AND decision IS NOT NULL AND id != $exceptId AND held_for IS NOT 'outbound'
             ORDER BY decided_at DESC LIMIT $limit`,
          )
          .all({ fromId, toId, exceptId, limit }) as { decision: Decision; decided_at: string }[]
      ).map((row) => ({ decision: row.decision, at: row.decided_at })),
    );
    return merged(lists, (row) => row.at, true).slice(0, limit);
  }

  /**
   * Records a person's decision on held messages: Allow once and Always allow make each pending, Deny declines it.
   * Returns the ones decided now: a message that isn't held any more is left out. One transaction per workspace.
   */
  decideHeld(held: Pick<Message, "id" | "workspaceId">[], decision: Decision, personId: string, at: string): Message[] {
    const status: MessageStatus = decision === "deny" ? "declined" : "pending";
    const decided: Message[] = [];
    for (const workspaceId of new Set(held.map((m) => m.workspaceId))) {
      const content = this.content.find(workspaceId);
      if (!content) continue;
      content.db.transaction(() => {
        const mark = content.db.query(
          `UPDATE messages SET status = $status, decision = $decision, decided_by = $personId, decided_at = $at
           WHERE id = $id AND status = 'held'`,
        );
        for (const m of held) {
          if (m.workspaceId !== workspaceId || mark.run({ id: m.id, status, decision, personId, at }).changes !== 1) continue;
          const now = this.getIn(content, m.id);
          if (now) decided.push(now);
        }
      })();
    }
    return decided;
  }

  /** Expires held and pending messages past their time, in every workspace. */
  expireDue(): Message[] {
    const at = this.iso();
    const expired: Message[] = [];
    this.content.each(({ db, workspaceId }) => {
      db.transaction(() => {
        const rows = db
          .query("SELECT * FROM messages WHERE status IN ('held', 'pending') AND expires_at <= $at ORDER BY expires_at, rowid")
          .all({ at }) as MessageRow[];
        if (rows.length === 0) return;
        db.query("UPDATE messages SET status = 'expired' WHERE status IN ('held', 'pending') AND expires_at <= $at").run({ at });
        expired.push(...rows.map((row) => ({ ...toMessage(row, workspaceId), status: "expired" as const })));
      })();
    });
    for (const message of expired) {
      this.log("message_expired", { message_id: message.id, held: message.heldAt !== null });
      this.notify({ kind: "message_expired", message });
    }
    if (expired.length > 0) this.changes.about({ agents: expired.flatMap((m) => [m.fromId, m.toId]) }, "threads", "approvals");
    return expired;
  }

  /**
   * In every workspace: deletes whole tasks (a conversation's messages, by root_id) whose newest message is older than
   * the history limit and that wait on nothing, then threads left empty. A task never loses its first message while
   * its replies stay. Then clears threads of agents the directory no longer has, which a crash during a removal leaves.
   */
  prune(): { messages: number; threads: number } {
    const cutoff = this.iso(-LIMITS.historyDays * DAY_MS);
    const removed = { messages: 0, threads: 0 };
    this.content.each(({ db }) => {
      db.transaction(() => {
        removed.messages += db
          .query(
            `DELETE FROM messages WHERE root_id IN (
               SELECT root_id FROM messages GROUP BY root_id
               HAVING MAX(created_at) < $cutoff AND SUM(status IN ('held', 'pending')) = 0)`,
          )
          .run({ cutoff }).changes;
        removed.threads += db.query("DELETE FROM threads WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id)").run().changes;
      })();
    });
    removed.threads += this.content.sweepLeftovers();
    return removed;
  }

  // ---- helpers ----

  /**
   * What holds a message when it reaches the receiving side, if anything. Neither rule holds a reply in a conversation
   * the receiver itself wrote in during the last 24 hours.
   */
  private arrivalHold(db: Database, caller: Agent, receiver: Agent, replyTo: string | null): HeldFor | null {
    const firstContact = caller.ownerId !== receiver.ownerId && !this.peopleAllowed(receiver.ownerId, caller.ownerId);
    const allowed = this.alwaysAllows(receiver.id, caller.id);
    // A newly joined agent nobody vouched for, writing to another agent of the same person: asked about once per pair.
    const newAgent = caller.unproven && caller.ownerId === receiver.ownerId && !allowed;
    const approval = receiver.approvalRequired && !allowed;
    if (!firstContact && !approval && !newAgent) return null;
    if (replyTo !== null && this.receiverInConversation(db, replyTo, receiver.id)) return null;
    return firstContact ? "first_contact" : newAgent ? "new_agent" : "approval";
  }

  /** What a held send says: plainly that the message is held and for whom, never that it was delivered. */
  private heldNote(message: Message, caller: Agent, receiver: Agent, name: string): string {
    const outcome = `The message is not delivered. A person decides within ${LIMITS.messageExpiryHours / 24} days; check_inbox reports whether the message was delivered, declined or expired.`;
    if (message.heldFor === "outbound") {
      const person = this.personName(caller.ownerId);
      const where = this.heldLink ? ` on Portico's page, ${this.heldLink(message.id)}` : " on Portico's pages";
      const why = caller.outboundHold
        ? `${person} asked to see each message this agent sends to other people's agents first`
        : `this agent joined Portico lately, so until ${person} vouches for this agent, ${person} sees each message this agent sends to other people's agents first`;
      return (
        `Held for ${person}: ${why}, and decides${where}. ` +
        `Once allowed, the message goes on to ${name}, whose own person may be asked too. ${outcome}`
      );
    }
    if (message.heldFor === "new_agent") {
      const person = this.personName(caller.ownerId);
      return `Held: this agent joined Portico lately, so ${person} is asked once before this agent's first message reaches ${name}. ${outcome}`;
    }
    if (message.heldFor === "first_contact") {
      const person = this.personName(receiver.ownerId);
      return (
        `Held: ${person}, who manages ${name}, hasn't allowed messages from ${this.personName(caller.ownerId)}'s agents yet, so ${person} is asked about this one first. ` +
        outcome
      );
    }
    return (
      `Held: ${name} requires approval for new conversations. Replies (reply_to) in a ` +
      `conversation ${name} wrote in during the last ${LIMITS.replyWindowHours} hours aren't held. ${outcome}`
    );
  }

  private getIn(content: ContentDb, id: string): Message | null {
    const row = content.db.query("SELECT * FROM messages WHERE id = $id").get({ id }) as MessageRow | null;
    return row ? toMessage(row, content.workspaceId) : null;
  }

  private threadIn(content: ContentDb, x: string, y: string): Thread | null {
    const [a, b] = x < y ? [x, y] : [y, x];
    const row = content.db.query("SELECT * FROM threads WHERE a_id = $a AND b_id = $b").get({ a, b }) as ThreadRow | null;
    return row ? toThread(row, content.workspaceId) : null;
  }

  private attachable(caller: Agent, attachments: unknown): { id: string }[] {
    if (attachments === undefined || attachments === null) return [];
    if (!this.files) throw new PorticoError("bad_request", "This Portico server doesn't take attachments.");
    return this.files.attachable(caller, attachments);
  }

  /**
   * The hourly limit counts the sender's messages in every workspace the sender is or was in. The loop guard counts the
   * messages between the two in the workspaces the two share now.
   */
  private requireBudget(caller: Agent, receiver: Agent, shared: Workspace[]): void {
    const since = this.iso(-HOUR_MS);
    let sent = 0;
    for (const { db } of this.content.of({ agent: caller.id })) {
      sent += (db.query("SELECT COUNT(*) AS n FROM messages WHERE from_id = $id AND created_at >= $since").get({ id: caller.id, since }) as { n: number }).n;
    }
    if (sent >= LIMITS.messagesPerHour) {
      throw new PorticoError("rate_limited", `The limit is ${LIMITS.messagesPerHour} messages an hour per sender.`);
    }
    const loopSince = this.iso(-LOOP_WINDOW_MS);
    const times: string[] = [];
    for (const workspace of shared) {
      const content = this.content.find(workspace.id);
      if (!content) continue;
      const rows = content.db
        .query(
          `SELECT created_at FROM messages
           WHERE ((from_id = $a AND to_id = $b) OR (from_id = $b AND to_id = $a)) AND created_at > $since
           ORDER BY created_at, rowid`,
        )
        .all({ a: caller.id, b: receiver.id, since: loopSince }) as { created_at: string }[];
      times.push(...rows.map((row) => row.created_at));
    }
    const retryAt = loopGuardRetryAt(shared.length > 1 ? times.sort() : times);
    if (retryAt) {
      // Rounded up to the minute, so a retry at the time named is never refused again.
      const retryMinute = new Date(Math.ceil(Date.parse(retryAt) / MINUTE_MS) * MINUTE_MS).toISOString();
      throw new PorticoError(
        "rate_limited",
        `Loop guard: ${LOOP_LIMIT} messages between ${this.agents.display(caller)} and ${this.agents.nameFor(receiver, caller.ownerId)} ` +
          `in 10 minutes. Try again after ${retryMinute.slice(0, 16).replace("T", " ")} UTC.`,
      );
    }
  }

  private startThread(content: ContentDb, x: string, y: string, at: string): Thread {
    const [a, b] = x < y ? [x, y] : [y, x];
    const thread: Thread = { id: this.newId(), aId: a, bId: b, startedBy: x, createdAt: at, lastMessageAt: at, workspaceId: content.workspaceId };
    content.db
      .query(
        `INSERT INTO threads (id, a_id, b_id, started_by, created_at, last_message_at)
         VALUES ($id, $aId, $bId, $startedBy, $createdAt, $lastMessageAt)`,
      )
      .run({ id: thread.id, aId: a, bId: b, startedBy: x, createdAt: at, lastMessageAt: at });
    return thread;
  }

  private insert(db: Database, m: Message): void {
    const { workspaceId: _workspace, noReplyNeeded: _flag, ...row } = m;
    // The `final` column holds two facts, final and no reply needed: see FINAL in types.ts.
    db.query(
      `INSERT INTO messages (id, thread_id, from_id, to_id, subject, text, reply_to, root_id, summary, final, send_key,
         status, held_at, held_for, decision, decided_by, decided_at, created_at, expires_at, delivered_at, withdrawn_at, sender_notified_at)
       VALUES ($id, $threadId, $fromId, $toId, $subject, $text, $replyTo, $rootId, $summary, $final, $sendKey,
         $status, $heldAt, $heldFor, $decision, $decidedBy, $decidedAt, $createdAt, $expiresAt, $deliveredAt, $withdrawnAt, $senderNotifiedAt)`,
    ).run({ ...row, final: finalValue(m) });
  }

  private pendingFor(content: ContentDb, agentId: string, now: string, limit: number): Message[] {
    const rows = content.db
      .query(`SELECT * FROM messages WHERE ${PENDING} ORDER BY created_at, rowid LIMIT $limit`)
      .all({ agent: agentId, now, limit }) as MessageRow[];
    return rows.map((row) => toMessage(row, content.workspaceId));
  }

  private updatesFor(content: ContentDb, agentId: string, limit: number): Message[] {
    const rows = content.db
      .query(`SELECT * FROM messages WHERE ${UPDATE} ORDER BY COALESCE(withdrawn_at, decided_at, created_at), rowid LIMIT $limit`)
      .all({ agent: agentId, limit }) as MessageRow[];
    return rows.map((row) => toMessage(row, content.workspaceId));
  }

  private markDelivered(db: Database, agentId: string, ids: string[], at: string): number {
    const mark = db.query(
      `UPDATE messages SET status = 'delivered', delivered_at = $at
       WHERE id = $id AND to_id = $agent AND status = 'pending' AND expires_at > $at`,
    );
    let marked = 0;
    for (const id of ids) marked += mark.run({ id, agent: agentId, at }).changes;
    return marked;
  }

  private markNotified(db: Database, agentId: string, ids: string[], at: string): number {
    const mark = db.query(`UPDATE messages SET sender_notified_at = $at WHERE id = $id AND ${UPDATE}`);
    let marked = 0;
    for (const id of ids) marked += mark.run({ id, agent: agentId, at }).changes;
    return marked;
  }

  private afterDelivery(delivered: Message[]): void {
    if (delivered.length === 0) return;
    for (const message of delivered) this.notify({ kind: "message_delivered", message });
    this.changes.about({ agents: delivered.flatMap((m) => [m.fromId, m.toId]) }, "threads");
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }
}

/**
 * What the sender of a message that needs no reply hears, in place of how to wait for one. Only a first message closes
 * its task at pickup: a reply's task follows the answers.
 */
function noReplyNote(m: Pick<Message, "id" | "rootId">, receiver: string): string {
  return m.rootId === m.id ? `No reply is expected. The task shows as done once \`${receiver}\` picks the message up.` : "No reply is expected.";
}

/** When a message was sent: what an inbox is ordered by. */
const sentAt = (m: Message) => m.createdAt;
/** When a sent message's outcome was reached: what updates are ordered by. */
const endedAt = (m: Message) => m.withdrawnAt ?? m.decidedAt ?? m.createdAt;
