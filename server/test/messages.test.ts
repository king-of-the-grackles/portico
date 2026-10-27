import { describe, expect, test } from "bun:test";
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

  test("a session gets a nudge; deliveries peek and an ack marks them delivered", async () => {
    const { p, chris, grok } = await setup();
    const { agent: session } = addSession(p, addComputer(p, chris).computer);
    const sent: string[] = [];
    p.agentStreams.connect(session.id, { send: (event) => sent.push(event), close() {} });
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
  test("a message to an agent requiring approval is held when the agent didn't start the thread", async () => {
    const { p, chris, grok, muse } = await setup();
    p.agents.update(chris.id, muse.id, { approvalRequired: true });
    const sent = p.messages.send(grok, { to: "muse", subject: "Add the doc link", text: "Please add it." });
    expect(sent.delivery).toBe("held");
    expect(sent.note).toContain("Held: muse requires approval");
    expect(sent.message.heldAt).not.toBeNull();
    expect(p.messages.inbox(p.agents.require(muse.id)).messages).toEqual([]);
    expect(p.approvals.heldFor(chris.id).map((m) => m.id)).toEqual([sent.message.id]);
  });

  test("messages in a thread the protected agent started are never held", async () => {
    const { p, chris, grok, muse } = await setup();
    p.messages.send(muse, { to: "grok", subject: "Question", text: "?" });
    p.agents.update(chris.id, muse.id, { approvalRequired: true });
    expect(p.messages.send(grok, { to: "muse", subject: "Answer", text: "!" }).delivery).toBe("queued");
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
    p.clock.advance(25 * HOUR);
    p.messages.expireDue();
    expect(p.messages.inbox(grok).updates.map((m) => [m.subject, m.status])).toEqual([
      ["A", "delivered"],
      ["C", "expired"],
    ]);
    expect(p.messages.inbox(grok).updates).toEqual([]);
    expect(c.id).toBeDefined();
  });

  test("pending messages expire after 24 hours too", async () => {
    const { p, grok, muse } = await setup();
    p.messages.send(grok, { to: "muse", subject: "s", text: "t" });
    p.clock.advance(24 * HOUR);
    expect(p.messages.expireDue().map((m) => m.status)).toEqual(["expired"]);
    expect(p.messages.inbox(muse).messages).toEqual([]);
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

  test("members see threads only with their own agents, through the thread filter", async () => {
    const { p, grok, muse } = await setup();
    p.messages.send(grok, { to: "muse", subject: "s", text: "t" });
    expect(p.messages.threads({ involving: [grok.id] })).toHaveLength(1);
    expect(p.messages.threads({ involving: ["someone-else"] })).toHaveLength(0);
    expect(p.messages.threads({ agentId: muse.id })).toHaveLength(1);
  });
});
