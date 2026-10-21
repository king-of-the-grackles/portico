import { expect, test } from "bun:test";
import { BridgeError } from "../src/core/errors";
import { BASE_YAML, HOUR, T0, errorCode, makeService, testConfig } from "./helpers";

// BASE_YAML blocks codex → claude-code by rule, has no rule at all for muse → codex, and asks for anything → muse.

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof BridgeError) return err.message;
    throw err;
  }
  throw new Error("expected a BridgeError");
}

test("a message reaches the receiver's check_inbox once, marked delivered", () => {
  const { service } = makeService();
  const { message, delivery } = service.sendMessage("grok-bot", { to: "muse", text: "Lunch at noon?" });
  expect(message).toMatchObject({ fromAgent: "grok-bot", toAgent: "muse", text: "Lunch at noon?", replyTo: null, deliveredAt: null });
  expect(delivery).toBe("queued");
  expect(service.checkInbox("muse").messages.map((m) => m.id)).toEqual([message.id]);
  expect(service.checkInbox("muse").messages).toEqual([]);
});

test("rules don't apply to messages: a pair blocked for tasks can still message", () => {
  const { service } = makeService();
  expect(service.sendMessage("codex", { to: "claude-code", text: "hi" }).message.toAgent).toBe("claude-code");
});

test("a message goes through between two agents that no rule connects, and an ask pair needs no approval", () => {
  const { service, notices } = makeService();
  // A task between the same pair is blocked, since no rule allows it.
  expect(service.sendTask("muse", { to: "codex", instructions: "x" })).toMatchObject({
    status: "denied",
    reason: "no rule allows muse → codex",
  });
  const { message, delivery } = service.sendMessage("muse", { to: "codex", text: "Are you there?" });
  expect(message).toMatchObject({ fromAgent: "muse", toAgent: "codex", deliveredAt: null });
  expect(delivery).toBe("queued");
  expect(service.checkInbox("codex").messages.map((m) => m.id)).toEqual([message.id]);
  // grok-bot → muse is an ask pair for tasks; a message neither waits nor asks the owner.
  notices.length = 0;
  service.sendMessage("grok-bot", { to: "muse", text: "FYI" });
  expect(notices.map((n) => n.kind)).toEqual(["message_queued"]);
});

test("a reply goes to the other side by default, and must name a message the caller sent or received", () => {
  const { service } = makeService();
  const first = service.sendMessage("grok-bot", { to: "muse", text: "Q?" }).message;
  expect(service.sendMessage("muse", { replyTo: first.id, text: "A." }).message).toMatchObject({ toAgent: "grok-bot", replyTo: first.id });
  expect(errorCode(() => service.sendMessage("codex", { replyTo: first.id, text: "x" }))).toBe("bad_request");
  expect(errorCode(() => service.sendMessage("muse", { text: "x" }))).toBe("bad_request");
});

test("broadcasts, self-messages, unknown receivers and empty text are refused", () => {
  const { service } = makeService();
  expect(errorCode(() => service.sendMessage("muse", { to: "*", text: "x" }))).toBe("bad_request");
  expect(errorCode(() => service.sendMessage("muse", { to: "kind:claude-code", text: "x" }))).toBe("bad_request");
  expect(errorCode(() => service.sendMessage("muse", { to: "muse", text: "x" }))).toBe("bad_request");
  expect(errorCode(() => service.sendMessage("muse", { to: "nobody", text: "x" }))).toBe("unknown_agent");
  expect(errorCode(() => service.sendMessage("muse", { to: "codex", text: "  " }))).toBe("bad_request");
});

test("text up to 64 KB is fine; more is too_large", () => {
  const { service } = makeService();
  expect(service.sendMessage("muse", { to: "codex", text: "x".repeat(64 * 1024) }).message).toBeDefined();
  expect(errorCode(() => service.sendMessage("muse", { to: "codex", text: "x".repeat(64 * 1024 + 1) }))).toBe("too_large");
});

test("the loop guard refuses the 13th message between a pair within 10 minutes, counting both directions", () => {
  const { service, clock } = makeService();
  for (let i = 0; i < 12; i++) {
    const [from, to] = (i % 2 ? ["grok-bot", "muse"] : ["muse", "grok-bot"]) as [string, string];
    service.sendMessage(from, { to, text: `m${i}` });
  }
  expect(errorCode(() => service.sendMessage("muse", { to: "grok-bot", text: "13th" }))).toBe("rate_limited");
  expect(service.sendMessage("muse", { to: "codex", text: "another pair" }).message).toBeDefined();
  clock.advance(10 * 60_000 + 1);
  expect(service.sendMessage("muse", { to: "grok-bot", text: "later" }).message).toBeDefined();
});

test("the loop guard's refusal says when the window frees up", () => {
  const { service, clock } = makeService();
  service.sendMessage("muse", { to: "grok-bot", text: "first" }); // at 12:00
  clock.advance(3 * 60_000);
  for (let i = 0; i < 11; i++) service.sendMessage("grok-bot", { to: "muse", text: `m${i}` }); // at 12:03
  // The window frees up when the oldest of the last 12 leaves it: 12:00 plus 10 minutes.
  expect(errorMessage(() => service.sendMessage("muse", { to: "grok-bot", text: "13th" }))).toMatch(
    /try again after 2026-10-20 12:10 UTC/i,
  );
});

test("the loop guard's retry time rounds up to the next minute, never down", () => {
  const { service, clock } = makeService();
  clock.advance(30_000);
  service.sendMessage("muse", { to: "grok-bot", text: "first" }); // at 12:00:30
  clock.advance(3 * 60_000);
  for (let i = 0; i < 11; i++) service.sendMessage("grok-bot", { to: "muse", text: `m${i}` }); // at 12:03:30
  // The window frees up at 12:10:30, so the advice names 12:11, not 12:10.
  expect(errorMessage(() => service.sendMessage("muse", { to: "grok-bot", text: "13th" }))).toMatch(
    /try again after 2026-10-20 12:11 UTC/i,
  );
  clock.advance(Date.parse("2026-10-20T12:11:00.000Z") - clock.now().getTime());
  expect(service.sendMessage("muse", { to: "grok-bot", text: "at 12:11" }).message).toBeDefined();
});

test("the per-sender hourly limit applies", () => {
  const { service } = makeService(testConfig(BASE_YAML.replace("triggers:", "limits:\n  messages_per_hour_per_agent: 3\ntriggers:")));
  for (const to of ["codex", "grok-bot", "claude-code"]) service.sendMessage("muse", { to, text: "x" });
  expect(errorCode(() => service.sendMessage("muse", { to: "codex", text: "4th" }))).toBe("rate_limited");
});

test("an undelivered message expires after 24 hours, leaving the inbox and the unread count", () => {
  const { service, clock } = makeService();
  const { message } = service.sendMessage("muse", { to: "grok-bot", text: "Still there?" });
  expect(message.expiresAt).toBe(new Date(T0.getTime() + 24 * HOUR).toISOString());
  clock.advance(24 * HOUR - 1);
  expect(service.unreadCount("grok-bot")).toBe(1);
  clock.advance(1);
  expect(service.unreadCount("grok-bot")).toBe(0);
  expect(service.checkInbox("grok-bot").messages).toEqual([]);
  // A push member's deliveries leave it out too, and an ack for it changes nothing.
  const late = service.sendMessage("muse", { to: "claude-code", text: "Late" }).message;
  clock.advance(24 * HOUR);
  expect(service.pendingDeliveries("claude-code").messages).toEqual([]);
  expect(service.ackDeliveries("claude-code", { tasks: [], results: [], messages: [late.id] }).messages).toBe(0);
});

test("push members get messages through pending deliveries, and an ack marks them delivered", () => {
  const { service, store, clock } = makeService();
  const { message } = service.sendMessage("muse", { to: "claude-code", text: "Heads up" });
  // A peek changes nothing.
  expect(service.pendingDeliveries("claude-code").messages.map((m) => m.id)).toEqual([message.id]);
  expect(service.pendingDeliveries("claude-code").messages.map((m) => m.id)).toEqual([message.id]);
  expect(store.getMessage(message.id)?.deliveredAt).toBeNull();
  // Only the receiver can ack it.
  expect(service.ackDeliveries("grok-bot", { tasks: [], results: [], messages: [message.id] }).messages).toBe(0);
  clock.advance(5_000);
  expect(service.ackDeliveries("claude-code", { tasks: [], results: [], messages: [message.id, message.id, "missing"] })).toEqual({
    tasks: 0,
    results: 0,
    messages: 1,
  });
  expect(store.getMessage(message.id)?.deliveredAt).toBe(clock.now().toISOString());
  expect(service.pendingDeliveries("claude-code").messages).toEqual([]);
  // A repeat ack is harmless.
  expect(service.ackDeliveries("claude-code", { tasks: [], results: [], messages: [message.id] }).messages).toBe(0);
});

test("unreadCount counts queued tasks, unseen results and pending messages", () => {
  const { service } = makeService();
  expect(service.unreadCount("grok-bot")).toBe(0);
  // An unseen result: grok-bot's task to claude-code, finished.
  const sent = service.sendTask("grok-bot", { to: "claude-code", instructions: "Look it up" });
  expect(service.unreadCount("grok-bot")).toBe(0); // queued for claude-code, not for grok-bot
  service.checkInbox("claude-code");
  service.finishTask("claude-code", { taskId: sent.id, result: "Friday" });
  expect(service.unreadCount("grok-bot")).toBe(1);
  // A queued task.
  service.sendTask("claude-code", { to: "grok-bot", instructions: "Research this" });
  expect(service.unreadCount("grok-bot")).toBe(2);
  // A pending message.
  service.sendMessage("muse", { to: "grok-bot", text: "Ping" });
  expect(service.unreadCount("grok-bot")).toBe(3);
  service.checkInbox("grok-bot");
  expect(service.unreadCount("grok-bot")).toBe(0);
});

test("the tier is pushed for a connected push member, offline for a disconnected one, and queued for pull members", () => {
  const { service, connected } = makeService();
  expect(service.sendMessage("muse", { to: "claude-code", text: "x" }).delivery).toBe("offline");
  connected.add("claude-code");
  expect(service.sendMessage("muse", { to: "claude-code", text: "y" }).delivery).toBe("pushed");
  expect(service.sendMessage("claude-code", { to: "muse", text: "z" }).delivery).toBe("queued");
});

test("deliveryFor gives a queued task its tier, and every other task none", () => {
  const { service, connected } = makeService();
  const queued = service.sendTask("grok-bot", { to: "claude-code", instructions: "x" });
  expect(service.deliveryFor(queued)).toBe("offline");
  connected.add("claude-code");
  expect(service.deliveryFor(queued)).toBe("pushed");
  expect(service.deliveryFor(service.sendTask("claude-code", { to: "grok-bot", instructions: "y" }))).toBe("queued");
  expect(service.deliveryFor(service.sendTask("grok-bot", { to: "muse", instructions: "asks" }))).toBeNull();
  expect(service.deliveryFor(service.sendTask("codex", { to: "claude-code", instructions: "blocked" }))).toBeNull();
});

test("a message raises a message_queued notice", () => {
  const { service, notices } = makeService();
  const { message } = service.sendMessage("grok-bot", { to: "claude-code", text: "Ready when you are" });
  expect(notices).toEqual([{ kind: "message_queued", message }]);
});
