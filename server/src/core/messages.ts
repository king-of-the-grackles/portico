import type { Database } from "bun:sqlite";
import type { Agents } from "./agents";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import { LOOP_LIMIT, LOOP_WINDOW_MS, loopGuardRetryAt } from "./guards";
import type { InboxWaits } from "./inbox-waits";
import { DAY_MS, HOUR_MS, LIMITS, MINUTE_MS } from "./limits";
import type { Agent, Decision, DeliveryTier, Message, MessageStatus, Notice, Thread } from "./types";

interface MessageRow {
  id: string;
  thread_id: string;
  from_id: string;
  to_id: string;
  subject: string;
  text: string;
  reply_to: string | null;
  status: string;
  held_at: string | null;
  decision: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  expires_at: string;
  delivered_at: string | null;
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

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    fromId: row.from_id,
    toId: row.to_id,
    subject: row.subject,
    text: row.text,
    replyTo: row.reply_to,
    status: row.status as MessageStatus,
    heldAt: row.held_at,
    decision: row.decision as Decision | null,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deliveredAt: row.delivered_at,
    senderNotifiedAt: row.sender_notified_at,
  };
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    aId: row.a_id,
    bId: row.b_id,
    startedBy: row.started_by,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
  };
}

/** The most of each kind one deliveries list holds, and one ack may name, so a single ack always covers a list. */
export const DELIVERY_BATCH_MAX = 500;

/** How many messages one page of a thread holds by default, and at most. */
export const THREAD_PAGE = 200;
export const THREAD_PAGE_MAX = 2000;

/** A held message that ended: the sender hears about it once. */
const UPDATE = "from_id = $agent AND held_at IS NOT NULL AND status IN ('delivered', 'declined', 'expired') AND sender_notified_at IS NULL";
/** A message the agent can pick up now. */
const PENDING = "to_id = $agent AND status = 'pending' AND expires_at > $now";

/** A subject as given: trimmed, one line, 1 to 120 characters. */
export function checkSubject(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PorticoError("bad_request", "subject is required: one line saying what the message asks for.");
  }
  if (/[\r\n]/.test(value.trim())) throw new PorticoError("bad_request", "subject must be one line.");
  const subject = value.trim();
  if (Array.from(subject).length > LIMITS.maxSubjectChars) {
    throw new PorticoError("bad_request", `subject can be at most ${LIMITS.maxSubjectChars} characters.`);
  }
  return subject;
}

function checkText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new PorticoError("bad_request", "text must be a non-empty string.");
  if (new TextEncoder().encode(value).length > LIMITS.maxMessageKb * 1024) {
    throw new PorticoError("too_large", `text is larger than ${LIMITS.maxMessageKb} KB.`);
  }
  return value;
}

export interface MessagesDeps {
  db: Database;
  agents: Agents;
  /** Whether the receiver always allows messages from the sender. */
  alwaysAllows: (agentId: string, senderId: string) => boolean;
  changes: Changes;
  /** Where check_inbox calls wait; Portico wakes them as it nudges sessions. */
  waits: InboxWaits;
  now?: () => Date;
  newId?: () => string;
  notify?: (notice: Notice) => void;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/** Messages between agents, the threads they form, holds for approval, and what each agent picks up. */
export class Messages {
  private readonly db: Database;
  private readonly agents: Agents;
  private readonly alwaysAllows: (agentId: string, senderId: string) => boolean;
  private readonly changes: Changes;
  private readonly waits: InboxWaits;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly notify: (notice: Notice) => void;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;
  /** check_inbox calls waiting now, by slot (a session's run, or the agent). */
  private readonly waitingSlots = new Map<string, number>();

  constructor(deps: MessagesDeps) {
    this.db = deps.db;
    this.agents = deps.agents;
    this.alwaysAllows = deps.alwaysAllows;
    this.changes = deps.changes;
    this.waits = deps.waits;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.notify = deps.notify ?? (() => {});
    this.log = deps.log ?? (() => {});
  }

  /**
   * Sends a message. It's held for the receiver's owner when the receiver requires approval, doesn't always allow the
   * sender, and hasn't itself written in the message's conversation in the last 24 hours. Every message obeys the size
   * limit, the hourly limit and the loop guard.
   */
  send(
    caller: Agent,
    input: { to?: unknown; subject: unknown; text: unknown; replyTo?: unknown },
  ): { message: Message; delivery: DeliveryTier; note: string | null } {
    const subject = checkSubject(input.subject);
    const text = checkText(input.text);
    let receiver: Agent | null =
      typeof input.to === "string" && input.to.trim() !== "" ? this.agents.resolve(input.to, caller.id) : null;
    let replyTo: string | null = null;
    if (input.replyTo !== undefined && input.replyTo !== null && input.replyTo !== "") {
      const original = typeof input.replyTo === "string" ? this.get(input.replyTo) : null;
      if (!original || (original.toId !== caller.id && original.fromId !== caller.id)) {
        throw new PorticoError("bad_request", "reply_to must be the ID of a message sent to or by this agent.");
      }
      const other = original.toId === caller.id ? original.fromId : original.toId;
      if (receiver && receiver.id !== other) {
        throw new PorticoError("bad_request", "reply_to names a message from a different thread. Leave out to, or fix reply_to.");
      }
      receiver ??= this.agents.require(other);
      replyTo = original.id;
    }
    if (!receiver) throw new PorticoError("bad_request", "to is required unless reply_to is given.");
    if (receiver.id === caller.id) throw new PorticoError("bad_request", "An agent can't send a message to itself.");
    this.requireBudget(caller, receiver);

    const at = this.iso();
    const message = this.db.transaction(() => {
      const thread = this.threadBetween(caller.id, receiver.id) ?? this.startThread(caller.id, receiver.id, at);
      const held =
        receiver.approvalRequired &&
        !this.alwaysAllows(receiver.id, caller.id) &&
        !(replyTo !== null && this.receiverInConversation(replyTo, receiver.id));
      const m: Message = {
        id: this.newId(),
        threadId: thread.id,
        fromId: caller.id,
        toId: receiver.id,
        subject,
        text,
        replyTo,
        status: held ? "held" : "pending",
        heldAt: held ? at : null,
        decision: null,
        decidedBy: null,
        decidedAt: null,
        createdAt: at,
        expiresAt: this.iso(LIMITS.messageExpiryHours * HOUR_MS),
        deliveredAt: null,
        senderNotifiedAt: null,
      };
      this.insert(m);
      this.db.query("UPDATE threads SET last_message_at = $at WHERE id = $id").run({ id: thread.id, at });
      return m;
    })();

    const delivery: DeliveryTier = message.status === "held" ? "held" : this.agents.tier(receiver);
    this.log("message_sent", { message_id: message.id, from: caller.id, to: receiver.id, delivery });
    this.notify({ kind: "message_sent", message });
    this.changes.emit(...(message.status === "held" ? (["threads", "approvals"] as const) : (["threads"] as const)));
    const note =
      delivery === "held"
        ? `Held: ${this.agents.display(receiver)} requires approval for new conversations. Replies (reply_to) in a ` +
          `conversation ${this.agents.display(receiver)} wrote in during the last 24 hours aren't held. A person decides ` +
          "within 24 hours; check_inbox reports whether the message was delivered, declined or expired."
        : null;
    return { message, delivery, note };
  }

  /**
   * Picks up the caller's pending messages (they become delivered) and the outcomes of its held messages (marked
   * reported). Marks the caller checked in.
   */
  inbox(caller: Agent): { messages: Message[]; updates: Message[] } {
    const at = this.iso();
    const outcome = this.db.transaction(() => {
      const messages = this.pendingFor(caller.id, at, -1);
      const updates = this.updatesFor(caller.id, -1);
      this.markDelivered(caller.id, messages.map((m) => m.id), at);
      this.markNotified(caller.id, updates.map((m) => m.id), at);
      return {
        messages: messages.map((m) => ({ ...m, status: "delivered" as const, deliveredAt: at })),
        updates: updates.map((m) => ({ ...m, senderNotifiedAt: at })),
      };
    })();
    this.agents.checkedIn(caller);
    this.afterDelivery(outcome.messages);
    return outcome;
  }

  /** What a session's plugin has to deliver, oldest first, at most DELIVERY_BATCH_MAX of each. Changes nothing. */
  pending(caller: Agent): { messages: Message[]; updates: Message[] } {
    const pending = {
      messages: this.pendingFor(caller.id, this.iso(), DELIVERY_BATCH_MAX),
      updates: this.updatesFor(caller.id, DELIVERY_BATCH_MAX),
    };
    this.agents.checkedIn(caller);
    return pending;
  }

  /** Marks delivered messages delivered and reported updates reported: only the caller's own, only those still waiting. */
  ack(caller: Agent, ack: { messages: string[]; updates: string[] }): { messages: number; updates: number } {
    const at = this.iso();
    const { delivered, notified } = this.db.transaction(() => {
      const ids = [...new Set(ack.messages)];
      // Marked first, then read back: only the ones this ack delivered carry this delivered_at.
      this.markDelivered(caller.id, ids, at);
      const delivered = ids
        .map((id) => this.get(id))
        .filter((m): m is Message => m !== null && m.toId === caller.id && m.deliveredAt === at);
      const notified = this.markNotified(caller.id, [...new Set(ack.updates)], at);
      return { delivered, notified };
    })();
    this.afterDelivery(delivered);
    return { messages: delivered.length, updates: notified };
  }

  /** Pending messages and unreported outcomes: what the caller's next check_inbox would pick up. */
  unreadCount(agentId: string): number {
    const now = this.iso();
    const row = this.db
      .query(
        `SELECT (SELECT COUNT(*) FROM messages WHERE ${PENDING})
              + (SELECT COUNT(*) FROM messages WHERE ${UPDATE}) AS n`,
      )
      .get({ agent: agentId, now }) as { n: number };
    return row.n;
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

  get(id: string): Message | null {
    const row = this.db.query("SELECT * FROM messages WHERE id = $id").get({ id }) as MessageRow | null;
    return row ? toMessage(row) : null;
  }

  require(id: string): Message {
    const message = this.get(id);
    if (!message) throw new PorticoError("not_found", "No such message.");
    return message;
  }

  // ---- threads ----

  thread(id: string): Thread | null {
    const row = this.db.query("SELECT * FROM threads WHERE id = $id").get({ id }) as ThreadRow | null;
    return row ? toThread(row) : null;
  }

  threadBetween(x: string, y: string): Thread | null {
    const [a, b] = x < y ? [x, y] : [y, x];
    const row = this.db.query("SELECT * FROM threads WHERE a_id = $a AND b_id = $b").get({ a, b }) as ThreadRow | null;
    return row ? toThread(row) : null;
  }

  /**
   * Threads, most recent first. With `involving`, only threads with at least one of those agents; with `agentId`, only
   * that agent's threads.
   */
  threads(filter: { involving?: string[]; agentId?: string; limit?: number } = {}): Thread[] {
    // Filtered before the limit, so a member's or an agent's threads never fall behind everyone else's.
    const clauses: string[] = [];
    const bindings: Record<string, string | number> = { limit: filter.limit ?? 500 };
    if (filter.involving) {
      if (filter.involving.length === 0) return [];
      const names = filter.involving.map((id, i) => {
        bindings[`i${i}`] = id;
        return `$i${i}`;
      });
      clauses.push(`(a_id IN (${names.join(", ")}) OR b_id IN (${names.join(", ")}))`);
    }
    if (filter.agentId) {
      clauses.push("(a_id = $agentId OR b_id = $agentId)");
      bindings.agentId = filter.agentId;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query(`SELECT * FROM threads ${where} ORDER BY last_message_at DESC, id LIMIT $limit`)
      .all(bindings) as ThreadRow[];
    return rows.map(toThread);
  }

  /**
   * A page of the thread, oldest first: the newest `limit` messages, or with `before`, the newest `limit` sent before
   * that message. `more` says whether older messages remain.
   */
  inThread(threadId: string, page: { before?: string; limit?: number } = {}): { messages: Message[]; more: boolean } {
    const limit = Math.min(Math.max(1, Math.floor(page.limit ?? THREAD_PAGE)), THREAD_PAGE_MAX);
    const cursor = page.before
      ? (this.db
          .query("SELECT created_at AS at, rowid AS n FROM messages WHERE id = $id AND thread_id = $threadId")
          .get({ id: page.before, threadId }) as { at: string; n: number } | null)
      : null;
    // Pruning deletes the oldest messages first, so when the cursor is gone, so is everything older.
    if (page.before && !cursor) return { messages: [], more: false };
    const rows = this.db
      .query(
        `SELECT * FROM messages WHERE thread_id = $threadId
           ${cursor ? "AND (created_at < $at OR (created_at = $at AND rowid < $n))" : ""}
         ORDER BY created_at DESC, rowid DESC LIMIT $limit`,
      )
      .all({ threadId, limit: limit + 1, ...(cursor ? { at: cursor.at, n: cursor.n } : {}) }) as MessageRow[];
    return { messages: rows.slice(0, limit).reverse().map(toMessage), more: rows.length > limit };
  }

  /** The thread's newest message, its count, and how many are held. */
  threadSummary(threadId: string): { last: Message | null; count: number; held: number } {
    const last = this.db
      .query("SELECT * FROM messages WHERE thread_id = $threadId ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get({ threadId }) as MessageRow | null;
    const counts = this.db
      .query("SELECT COUNT(*) AS n, SUM(status = 'held') AS held FROM messages WHERE thread_id = $threadId")
      .get({ threadId }) as { n: number; held: number | null };
    return { last: last ? toMessage(last) : null, count: counts.n, held: counts.held ?? 0 };
  }

  /** The message sent just before this one in its thread. */
  previous(message: Message): Message | null {
    const row = this.db
      .query(
        `SELECT * FROM messages WHERE thread_id = $threadId
           AND (created_at < $at OR (created_at = $at AND rowid < (SELECT rowid FROM messages WHERE id = $id)))
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get({ threadId: message.threadId, at: message.createdAt, id: message.id }) as MessageRow | null;
    return row ? toMessage(row) : null;
  }

  // ---- holds ----

  /**
   * Whether the receiver itself wrote in the conversation `messageId` belongs to (its reply_to chain) during the last 24
   * hours. Only the receiver's own messages count: a sender chooses reply_to, so its own earlier messages can't open the
   * way. Answers to the protected agent, and the back-and-forth once it has replied, are never held.
   */
  private receiverInConversation(messageId: string, receiverId: string): boolean {
    const row = this.db
      .query(
        `WITH RECURSIVE chain(id, reply_to, from_id, created_at) AS (
           SELECT id, reply_to, from_id, created_at FROM messages WHERE id = $id
           UNION
           SELECT m.id, m.reply_to, m.from_id, m.created_at FROM messages m JOIN chain c ON m.id = c.reply_to
         )
         SELECT 1 AS ok FROM chain WHERE from_id = $receiver AND created_at > $since LIMIT 1`,
      )
      .get({ id: messageId, receiver: receiverId, since: this.iso(-LIMITS.messageExpiryHours * HOUR_MS) }) as { ok: number } | null;
    return row !== null;
  }

  /** Held messages to agents the person manages, oldest first. */
  heldFor(personId: string): Message[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM messages m JOIN agents a ON a.id = m.to_id
         WHERE m.status = 'held' AND a.owner_id = $personId ORDER BY m.created_at, m.rowid`,
      )
      .all({ personId }) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Held messages from the sender to the receiver, oldest first. */
  heldBetween(fromId: string, toId: string): Message[] {
    const rows = this.db
      .query("SELECT * FROM messages WHERE from_id = $fromId AND to_id = $toId AND status = 'held' ORDER BY created_at, rowid")
      .all({ fromId, toId }) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Earlier decisions on messages from the sender to the receiver, newest first. */
  decisionsBetween(fromId: string, toId: string, exceptId: string, limit = 3): { decision: Decision; at: string }[] {
    const rows = this.db
      .query(
        `SELECT decision, decided_at FROM messages
         WHERE from_id = $fromId AND to_id = $toId AND decision IS NOT NULL AND id != $exceptId
         ORDER BY decided_at DESC LIMIT $limit`,
      )
      .all({ fromId, toId, exceptId, limit }) as { decision: Decision; decided_at: string }[];
    return rows.map((row) => ({ decision: row.decision, at: row.decided_at }));
  }

  /**
   * Records a person's decision on a held message: Allow once and Always allow make it pending, Deny declines it.
   * Returns null when the message isn't held any more. Run inside the caller's transaction.
   */
  decideHeld(messageId: string, decision: Decision, personId: string, at: string): Message | null {
    const status: MessageStatus = decision === "deny" ? "declined" : "pending";
    const changed = this.db
      .query(
        `UPDATE messages SET status = $status, decision = $decision, decided_by = $personId, decided_at = $at
         WHERE id = $id AND status = 'held'`,
      )
      .run({ id: messageId, status, decision, personId, at }).changes;
    return changed === 1 ? this.get(messageId) : null;
  }

  /** Expires held and pending messages past their time. */
  expireDue(): Message[] {
    const at = this.iso();
    const expired = this.db.transaction(() => {
      const rows = this.db
        .query("SELECT * FROM messages WHERE status IN ('held', 'pending') AND expires_at <= $at ORDER BY expires_at, rowid")
        .all({ at }) as MessageRow[];
      this.db.query("UPDATE messages SET status = 'expired' WHERE status IN ('held', 'pending') AND expires_at <= $at").run({ at });
      return rows.map((row) => ({ ...toMessage(row), status: "expired" as const }));
    })();
    for (const message of expired) {
      this.log("message_expired", { message_id: message.id, held: message.heldAt !== null });
      this.notify({ kind: "message_expired", message });
    }
    if (expired.length > 0) this.changes.emit("threads", "approvals");
    return expired;
  }

  /** Deletes messages older than the history limit, and threads left empty. */
  prune(): { messages: number; threads: number } {
    const cutoff = this.iso(-LIMITS.historyDays * DAY_MS);
    return this.db.transaction(() => {
      const messages = this.db
        .query("DELETE FROM messages WHERE created_at < $cutoff AND status NOT IN ('held', 'pending')")
        .run({ cutoff }).changes;
      const threads = this.db
        .query("DELETE FROM threads WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id)")
        .run().changes;
      return { messages, threads };
    })();
  }

  // ---- helpers ----

  private requireBudget(caller: Agent, receiver: Agent): void {
    const since = this.iso(-HOUR_MS);
    const sent = (
      this.db.query("SELECT COUNT(*) AS n FROM messages WHERE from_id = $id AND created_at >= $since").get({
        id: caller.id,
        since,
      }) as { n: number }
    ).n;
    if (sent >= LIMITS.messagesPerHour) {
      throw new PorticoError("rate_limited", `The limit is ${LIMITS.messagesPerHour} messages an hour per sender.`);
    }
    const times = (
      this.db
        .query(
          `SELECT created_at FROM messages
           WHERE ((from_id = $a AND to_id = $b) OR (from_id = $b AND to_id = $a)) AND created_at > $since
           ORDER BY created_at, rowid`,
        )
        .all({ a: caller.id, b: receiver.id, since: this.iso(-LOOP_WINDOW_MS) }) as { created_at: string }[]
    ).map((row) => row.created_at);
    const retryAt = loopGuardRetryAt(times);
    if (retryAt) {
      // Rounded up to the minute, so a retry at the time named is never refused again.
      const retryMinute = new Date(Math.ceil(Date.parse(retryAt) / MINUTE_MS) * MINUTE_MS).toISOString();
      throw new PorticoError(
        "rate_limited",
        `Loop guard: ${LOOP_LIMIT} messages between ${this.agents.display(caller)} and ${this.agents.display(receiver)} ` +
          `in 10 minutes. Try again after ${retryMinute.slice(0, 16).replace("T", " ")} UTC.`,
      );
    }
  }

  private startThread(x: string, y: string, at: string): Thread {
    const [a, b] = x < y ? [x, y] : [y, x];
    const thread: Thread = { id: this.newId(), aId: a, bId: b, startedBy: x, createdAt: at, lastMessageAt: at };
    this.db
      .query(
        `INSERT INTO threads (id, a_id, b_id, started_by, created_at, last_message_at)
         VALUES ($id, $aId, $bId, $startedBy, $createdAt, $lastMessageAt)`,
      )
      .run({ ...thread });
    return thread;
  }

  private insert(m: Message): void {
    this.db
      .query(
        `INSERT INTO messages (id, thread_id, from_id, to_id, subject, text, reply_to, status, held_at, decision,
           decided_by, decided_at, created_at, expires_at, delivered_at, sender_notified_at)
         VALUES ($id, $threadId, $fromId, $toId, $subject, $text, $replyTo, $status, $heldAt, $decision,
           $decidedBy, $decidedAt, $createdAt, $expiresAt, $deliveredAt, $senderNotifiedAt)`,
      )
      .run({ ...m });
  }

  private pendingFor(agentId: string, now: string, limit: number): Message[] {
    const rows = this.db
      .query(`SELECT * FROM messages WHERE ${PENDING} ORDER BY created_at, rowid LIMIT $limit`)
      .all({ agent: agentId, now, limit }) as MessageRow[];
    return rows.map(toMessage);
  }

  private updatesFor(agentId: string, limit: number): Message[] {
    const rows = this.db
      .query(`SELECT * FROM messages WHERE ${UPDATE} ORDER BY COALESCE(decided_at, created_at), rowid LIMIT $limit`)
      .all({ agent: agentId, limit }) as MessageRow[];
    return rows.map(toMessage);
  }

  private markDelivered(agentId: string, ids: string[], at: string): number {
    const mark = this.db.query(
      `UPDATE messages SET status = 'delivered', delivered_at = $at
       WHERE id = $id AND to_id = $agent AND status = 'pending' AND expires_at > $at`,
    );
    let marked = 0;
    for (const id of ids) marked += mark.run({ id, agent: agentId, at }).changes;
    return marked;
  }

  private markNotified(agentId: string, ids: string[], at: string): number {
    const mark = this.db.query(`UPDATE messages SET sender_notified_at = $at WHERE id = $id AND ${UPDATE}`);
    let marked = 0;
    for (const id of ids) marked += mark.run({ id, agent: agentId, at }).changes;
    return marked;
  }

  private afterDelivery(delivered: Message[]): void {
    if (delivered.length === 0) return;
    for (const message of delivered) this.notify({ kind: "message_delivered", message });
    this.changes.emit("threads");
  }

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }
}
