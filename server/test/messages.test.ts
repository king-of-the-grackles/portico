import { describe, expect, test } from "bun:test";
import { agentViews } from "../src/agent-api/views";
import { checkSubject } from "../src/core/messages";
import { addAppAgent, addComputer, addOwner, addSession, DAY, errorCode, flush, HOUR, makePortico, MINUTE } from "./helpers";

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" }).agent;
  const muse = addAppAgent(p, chris, "muse").agent;
  return { p, chris, grok, muse };
}

describe("sending", () => {
  test("a subject is required, one line, at most 120 characters", () => {
    expect(errorCode(() => checkSubject(""))).toBe("bad_request");
    expect(errorCode(() => checkSubject("two\nlines"))).toBe("bad_request");
    expect(errorCode(() => checkSubject("x".repeat(121)))).toBe("bad_request");
    expect(checkSubject("  Find a time with Sam  ")).toBe("Find a time with Sam");
  });

  test("a message starts a thread, is pending, and reaches an app at its next inbox check", async () => {
    const { p, grok, muse } = await setup();
    const sent = p.messages.send(grok, { to: "muse", subject: "Flights to Denver", text: "Under $400 if possible." });
    expect(sent).toMatchObject({ delivery: "queued", note: null });
    expect(sent.message).toMatchObject({ status: "pending", heldAt: null, fromId: grok.id, toId: muse.id });
    const thread = p.messages.thread(sent.message.threadId)!;
    expect(thread.startedBy).toBe(grok.id);
    expect(p.messages.unreadCount(muse.id)).toBe(1);
    const inbox = p.messages.inbox(muse);
    expect(inbox.messages.map((m) => m.status)).toEqual(["delivered"]);
    expect(p.messages.inbox(muse).messages).toEqual([]);
  });

  test("replies thread back: reply_to fills in the receiver and must belong to the caller", async () => {
    const { p, chris, grok, muse } = await setup();
    const first = p.messages.send(grok, { to: "muse", subject: "Q", text: "?" }).message;
    const reply = p.messages.send(muse, { replyTo: first.id, subject: "A", text: "!" }).message;
    expect(reply).toMatchObject({ toId: grok.id, replyTo: first.id, threadId: first.threadId });
    const outsider = addAppAgent(p, chris, "duet", { kind: "claude-duet" }).agent;
    expect(errorCode(() => p.messages.send(outsider, { replyTo: first.id, subject: "x", text: "y" }))).toBe("bad_request");
    expect(errorCode(() => p.messages.send(muse, { to: "duet", replyTo: first.id, subject: "x", text: "y" }))).toBe("bad_request");
  });

  test("no messages to self, over 64 KB, or past 120 an hour", async () => {
    const { p, grok } = await setup();
    expect(errorCode(() => p.messages.send(grok, { to: "grok", subject: "s", text: "t" }))).toBe("bad_request");
    expect(errorCode(() => p.messages.send(grok, { to: "muse", subject: "s", text: "x".repeat(64 * 1024 + 1) }))).toBe("too_large");
    // Spread across agents and time, so the loop guard doesn't trip first.
    const targets = Array.from({ length: 12 }, (_, i) => addAppAgent(p, p.people.owner()!, `agent-${i}`).agent);
    for (let i = 0; i < 120; i++) {
      p.messages.send(grok, { to: targets[i % 12]!.name, subject: "s", text: "t" });
      p.clock.advance(20_000);
    }
    expect(errorCode(() => p.messages.send(grok, { to: "muse", subject: "s", text: "t" }))).toBe("rate_limited");
  });

  test("the loop guard stops a 13th message between two agents in 10 minutes", async () => {
    const { p, grok, muse } = await setup();
    for (let i = 0; i < 12; i++) p.messages.send(i % 2 ? muse : grok, { to: i % 2 ? "grok" : "muse", subject: "s", text: "t" });
    expect(() => p.messages.send(grok, { to: "muse", subject: "s", text: "t" })).toThrow(/^Loop guard: 12 messages between grok and muse/);
    p.clock.advance(10 * MINUTE + 1);
    expect(errorCode(() => p.messages.send(grok, { to: "muse", subject: "s", text: "t" }))).toBeNull();
  });

  test("a reply with done: false is an update with more to come, framed so; it needs reply_to", async () => {
    const { p, grok, muse } = await setup();
    const ask = p.messages.send(grok, { to: "muse", subject: "Book flights", text: "Denver, Friday" }).message;
    expect(errorCode(() => p.messages.send(muse, { to: "grok", subject: "On it", text: "x", done: false }))).toBe("bad_request");
    expect(errorCode(() => p.messages.send(muse, { replyTo: ask.id, subject: "On it", text: "x", done: "no" }))).toBe("bad_request");
    const update = p.messages.send(muse, { replyTo: ask.id, subject: "On it", text: "Checking fares.", done: false }).message;
    expect(update.final).toBe(false);
    const framed = agentViews(p.agents, p.people).delivery(p.messages.inbox(grok).messages[0]!).framed_message;
    expect(framed).toContain('done="false"');
    expect(framed).toContain("still working, and the final answer comes later");
    expect(p.messages.send(muse, { replyTo: ask.id, subject: "Booked", text: "UA 1234" }).message.final).toBe(true);
  });

  test("a key makes sending again safe: the same key returns the first message and sends nothing", async () => {
    const { p, grok, muse } = await setup();
    const first = p.messages.send(grok, { to: "muse", subject: "Job 7", text: "Run it", key: "job-7" });
    const again = p.messages.send(grok, { to: "muse", subject: "Job 7", text: "Run it", key: " job-7 " });
    expect(again.message.id).toBe(first.message.id);
    expect(again.note).toContain("Already sent with this key");
    expect(p.messages.inbox(muse).messages.map((m) => m.subject)).toEqual(["Job 7"]);
    // A different message under the same key is refused, not dropped: an update and its final answer need two keys.
    expect(errorCode(() => p.messages.send(grok, { to: "muse", subject: "Job 7 (retry)", text: "Run it", key: "job-7" }))).toBe("conflict");
    const update = p.messages.send(muse, { replyTo: first.message.id, subject: "Running", text: "…", done: false, key: "r-7" });
    expect(
      errorCode(() => p.messages.send(muse, { replyTo: first.message.id, subject: "Running", text: "…", key: "r-7" })),
    ).toBe("conflict");
    expect(update.message.final).toBe(false);
    // Keys are per sender, and a new key sends.
    expect(p.messages.send(muse, { to: "grok", subject: "Mine", text: "x", key: "job-7" }).message.id).not.toBe(first.message.id);
    expect(p.messages.send(grok, { to: "muse", subject: "Job 8", text: "Run it", key: "job-8" }).message.id).not.toBe(first.message.id);
    expect(errorCode(() => p.messages.send(grok, { to: "muse", subject: "s", text: "t", key: "x".repeat(201) }))).toBe("bad_request");
  });

  test("a session gets a nudge; deliveries peek and an ack marks them delivered", async () => {
    const { p, chris, grok } = await setup();
    const { agent: session } = addSession(p, addComputer(p, chris).computer);
    const sent: string[] = [];
    p.agentStreams.connect(session.id, session.id, { send: (event) => sent.push(event), close() {} });
    const { message, delivery } = p.messages.send(grok, { to: session.name, subject: "s", text: "t" });
    expect(delivery).toBe("pushed");
    await flush();
    expect(sent).toEqual(["nudge"]);
    expect(p.messages.pending(session).messages.map((m) => m.id)).toEqual([message.id]);
    expect(p.messages.ack(session, { messages: [message.id, "other"], updates: [] })).toEqual({ messages: 1, updates: 0 });
    expect(p.messages.pending(session).messages).toEqual([]);
  });
});

describe("holds", () => {
  test("a message that starts a conversation with an agent requiring approval is held", async () => {
    const { p, chris, grok, muse } = await setup();
    p.agents.update(chris.id, muse.id, { approvalRequired: true });
    const sent = p.messages.send(grok, { to: "muse", subject: "Add the doc link", text: "Please add it." });
    expect(sent.delivery).toBe("held");
    expect(sent.note).toContain("Held: muse requires approval");
    expect(sent.message.heldAt).not.toBeNull();
    expect(p.messages.inbox(p.agents.require(muse.id)).messages).toEqual([]);
    expect(p.approvals.heldFor(chris.id).map((m) => m.id)).toEqual([sent.message.id]);
  });

  test("a reply to the protected agent's own message isn't held; a new conversation is", async () => {
    const { p, chris, grok, muse } = await setup();
    p.agents.update(chris.id, muse.id, { approvalRequired: true });
    const question = p.messages.send(muse, { to: "grok", subject: "Question", text: "?" }).message;
    expect(p.messages.send(grok, { replyTo: question.id, subject: "Answer", text: "!" }).delivery).toBe("queued");
    expect(p.messages.send(grok, { to: "muse", subject: "Something new", text: "New ask" }).delivery).toBe("held");
  });

  test("after an allowed opening, the back-and-forth flows once the protected agent replies", async () => {
    const { p, chris, grok, muse } = await setup();
    p.agents.update(chris.id, muse.id, { approvalRequired: true });
    const opening = p.messages.send(grok, { to: "muse", subject: "Find a time", text: "With Sam" }).message;
    p.approvals.decide(chris.id, opening.id, "allow_once");
    // Until muse writes in the conversation, the sender's own follow-ups still wait.
    expect(p.messages.send(grok, { replyTo: opening.id, subject: "Also", text: "Thursday works best" }).delivery).toBe("held");
    const answer = p.messages.send(muse, { replyTo: opening.id, subject: "Booked", text: "Thursday 2pm" }).message;
    const thanks = p.messages.send(grok, { replyTo: answer.id, subject: "Thanks", text: "!" });
    expect(thanks.delivery).toBe("queued");
    expect(p.messages.send(grok, { replyTo: thanks.message.id, subject: "One more", text: "Room?" }).delivery).toBe("queued");
  });

  test("replies to an opening that is still held, or was declined, are held", async () => {
    const { p, chris, grok, muse } = await setup();
    p.agents.update(chris.id, muse.id, { approvalRequired: true });
    const opening = p.messages.send(grok, { to: "muse", subject: "Post this", text: "Now" }).message;
    expect(p.messages.send(grok, { replyTo: opening.id, subject: "Please", text: "Soon" }).delivery).toBe("held");
    p.approvals.decide(chris.id, opening.id, "deny");
    expect(p.messages.send(grok, { replyTo: opening.id, subject: "Again", text: "?" }).delivery).toBe("held");
  });

  test("a sender's own messages never open the way, even ones that once went through", async () => {
    const { p, chris, grok, muse } = await setup();
    const early = p.messages.send(grok, { to: "muse", subject: "Before approval", text: "Hi" }).message;
    p.agents.update(chris.id, muse.id, { approvalRequired: true });
    const first = p.messages.send(grok, { to: "muse", subject: "One", text: "1" }).message;
    p.approvals.decide(chris.id, first.id, "always_allow");
    const unheld = p.messages.send(grok, { to: "muse", subject: "Two", text: "2" }).message;
    p.approvals.removeAllowed(chris.id, muse.id, grok.id);
    for (const anchor of [early, first, unheld]) {
      expect(p.messages.send(grok, { replyTo: anchor.id, subject: "Brand new ask", text: "x" }).delivery).toBe("held");
    }
  });

  test("the protected agent's message opens the way for 24 hours", async () => {
    const { p, chris, grok, muse } = await setup();
    p.agents.update(chris.id, muse.id, { approvalRequired: true });
    const question = p.messages.send(muse, { to: "grok", subject: "Question", text: "?" }).message;
    p.clock.advance(25 * HOUR);
    expect(p.messages.send(grok, { replyTo: question.id, subject: "Late answer", text: "!" }).delivery).toBe("held");
  });

  test("an Always allow sender isn't held; removing the entry holds again", async () => {
    const { p, chris, grok, muse } = await setup();
    p.agents.update(chris.id, muse.id, { approvalRequired: true });
    const held = p.messages.send(grok, { to: "muse", subject: "One", text: "1" }).message;
    p.approvals.decide(chris.id, held.id, "always_allow");
    expect(p.messages.send(grok, { to: "muse", subject: "Two", text: "2" }).delivery).toBe("queued");
    p.approvals.removeAllowed(chris.id, muse.id, grok.id);
    expect(p.messages.send(grok, { to: "muse", subject: "Three", text: "3" }).delivery).toBe("held");
  });

  test("the sender hears the outcome once: delivered, declined or expired", async () => {
    const { p, chris, grok, muse } = await setup();
    p.agents.update(chris.id, muse.id, { approvalRequired: true });
    const a = p.messages.send(grok, { to: "muse", subject: "A", text: "a" }).message;
    const b = p.messages.send(grok, { to: "muse", subject: "B", text: "b" }).message;
    const c = p.messages.send(grok, { to: "muse", subject: "C", text: "c" }).message;
    expect(p.messages.inbox(grok).updates).toEqual([]);
    p.approvals.decide(chris.id, a.id, "allow_once");
    p.approvals.decide(chris.id, b.id, "deny");
    expect(p.messages.inbox(grok).updates.map((m) => [m.subject, m.status])).toEqual([["B", "declined"]]);
    p.messages.inbox(p.agents.require(muse.id));
    p.clock.advance(3 * DAY + HOUR);
    p.messages.expireDue();
    expect(p.messages.inbox(grok).updates.map((m) => [m.subject, m.status])).toEqual([
      ["A", "delivered"],
      ["C", "expired"],
    ]);
    expect(p.messages.inbox(grok).updates).toEqual([]);
    expect(c.id).toBeDefined();
  });

  test("unread messages expire after 3 days too, and the sender hears so once", async () => {
    const { p, grok, muse } = await setup();
    p.messages.send(grok, { to: "muse", subject: "s", text: "t" });
    p.clock.advance(3 * DAY - MINUTE);
    expect(p.messages.expireDue()).toEqual([]);
    p.clock.advance(MINUTE);
    expect(p.messages.expireDue().map((m) => m.status)).toEqual(["expired"]);
    expect(p.messages.inbox(muse).messages).toEqual([]);
    const { updates } = p.messages.inbox(grok);
    expect(updates.map((m) => [m.subject, m.status])).toEqual([["s", "expired"]]);
    expect(agentViews(p.agents, p.people).update(updates[0]!).framed_message).toContain("expired before `muse` picked the message up");
    expect(p.messages.inbox(grok).updates).toEqual([]);
  });
});

describe("history", () => {
  test("messages older than 30 days go, with threads left empty", async () => {
    const { p, grok } = await setup();
    const { message } = p.messages.send(grok, { to: "muse", subject: "s", text: "t" });
    p.messages.inbox(p.agents.require(message.toId));
    p.clock.advance(31 * DAY);
    expect(p.messages.prune()).toEqual({ messages: 1, threads: 1 });
    expect(p.messages.threads()).toEqual([]);
  });

  test("a thread comes a page at a time: the newest first, then the page before a message", async () => {
    const { p, grok, muse } = await setup();
    const sent = ["a", "b", "c", "d", "e"].map((text, i) => p.messages.send(i % 2 ? muse : grok, { to: i % 2 ? "grok" : "muse", subject: text, text }).message);
    const threadId = sent[0]!.threadId;
    const newest = p.messages.inThread(threadId, { limit: 2 });
    expect([newest.messages.map((m) => m.text), newest.more]).toEqual([["d", "e"], true]);
    const earlier = p.messages.inThread(threadId, { before: newest.messages[0]!.id, limit: 2 });
    expect([earlier.messages.map((m) => m.text), earlier.more]).toEqual([["b", "c"], true]);
    const first = p.messages.inThread(threadId, { before: earlier.messages[0]!.id, limit: 2 });
    expect([first.messages.map((m) => m.text), first.more]).toEqual([["a"], false]);
    // A cursor that's gone means everything older is gone too.
    expect(p.messages.inThread(threadId, { before: "no-such-message" })).toEqual({ messages: [], more: false });
  });

  test("members see threads only with their own agents, through the thread filter", async () => {
    const { p, grok, muse } = await setup();
    p.messages.send(grok, { to: "muse", subject: "s", text: "t" });
    expect(p.messages.threads({ involving: [grok.id] })).toHaveLength(1);
    expect(p.messages.threads({ involving: ["someone-else"] })).toHaveLength(0);
    expect(p.messages.threads({ agentId: muse.id })).toHaveLength(1);
  });
});
