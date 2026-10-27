import { describe, expect, test } from "bun:test";
import { addAppAgent, addMember, addOwner, errorCode, makePortico } from "./helpers";

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const maya = await addMember(p);
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" }).agent;
  const muse = addAppAgent(p, chris, "muse", { approvalRequired: true }).agent;
  return { p, chris, maya, grok, muse };
}

describe("decisions", () => {
  test("only the recipient's manager decides, once, with a known decision", async () => {
    const { p, chris, maya, grok } = await setup();
    const held = p.messages.send(grok, { to: "muse", subject: "s", text: "t" }).message;
    expect(errorCode(() => p.approvals.decide(maya.id, held.id, "allow_once"))).toBe("not_allowed");
    expect(errorCode(() => p.approvals.decide(chris.id, held.id, "maybe"))).toBe("bad_request");
    const allowed = p.approvals.decide(chris.id, held.id, "allow_once");
    expect(allowed).toMatchObject({ status: "pending", decision: "allow_once", decidedBy: chris.id });
    expect(errorCode(() => p.approvals.decide(chris.id, held.id, "deny"))).toBe("wrong_status");
  });

  test("Always allow releases every message held from that sender and lists the sender", async () => {
    const { p, chris, grok, muse } = await setup();
    const one = p.messages.send(grok, { to: "muse", subject: "One", text: "1" }).message;
    const two = p.messages.send(grok, { to: "muse", subject: "Two", text: "2" }).message;
    p.approvals.decide(chris.id, two.id, "always_allow");
    expect(p.messages.get(one.id)!.status).toBe("pending");
    expect(p.approvals.allowListFor(chris.id, muse.id).map((e) => e.senderId)).toEqual([grok.id]);
    expect(p.approvals.heldFor(chris.id)).toEqual([]);
  });

  test("Deny declines; the message never reaches the recipient", async () => {
    const { p, chris, grok, muse } = await setup();
    const held = p.messages.send(grok, { to: "muse", subject: "s", text: "t" }).message;
    expect(p.approvals.decide(chris.id, held.id, "deny").status).toBe("declined");
    expect(p.messages.inbox(muse).messages).toEqual([]);
  });

  test("the allow list is the manager's only", async () => {
    const { p, maya, muse, grok } = await setup();
    expect(errorCode(() => p.approvals.allowListFor(maya.id, muse.id))).toBe("not_allowed");
    expect(errorCode(() => p.approvals.removeAllowed(maya.id, muse.id, grok.id))).toBe("not_allowed");
  });
});

describe("card facts", () => {
  test("managed by, a reply to the recipient, and earlier decisions: all checked by Portico", async () => {
    const { p, chris, grok, muse } = await setup();
    const first = p.messages.send(grok, { to: "muse", subject: "Find a time", text: "With Sam" }).message;
    p.clock.advance(60_000);
    p.approvals.decide(chris.id, first.id, "allow_once");
    p.messages.inbox(muse);
    p.messages.send(muse, { replyTo: first.id, subject: "Thursday 2pm", text: "Booked" });
    const second = p.messages.send(grok, { to: "muse", subject: "Add the doc link", text: "docs/billing-v2.md" }).message;
    const facts = p.approvals.facts(second);
    expect(facts.managedBy.name).toBe("Chris");
    expect(facts.replyToRecipient).toBe(true);
    expect(facts.earlier).toEqual([{ decision: "allow_once", at: "2026-10-27T12:01:00.000Z" }]);
  });
});
