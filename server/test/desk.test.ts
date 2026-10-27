import { describe, expect, test } from "bun:test";
import { Desk, panelText } from "../src/desk";
import { AgentStreams } from "../src/agent-api/stream";
import { fakeConnection, HOUR, T0, testClock } from "./helpers";

function setup() {
  const streams = new AgentStreams();
  const clock = testClock();
  let n = 0;
  const desk = new Desk({ streams, now: clock.now, newNonce: () => `nonce-${++n}` });
  streams.onChange((change) => desk.streamChanged(change));
  const connect = (agentId: string, computerId: string, ownerId: string, popup = true) => {
    const fake = fakeConnection();
    const disconnect = streams.connect(agentId, fake.conn, "quiet", { computerId, ownerId, popup });
    return { ...fake, disconnect };
  };
  const held = (messageId: string, ownerId = "chris") => ({
    messageId,
    ownerId,
    from: "grok",
    to: "muse",
    subject: "Add the doc link",
    text: "docs/billing-v2.md",
    expiresAt: new Date(T0.getTime() + 24 * HOUR).toISOString(),
  });
  return { streams, desk, clock, connect, held };
}

describe("pop-up requests for held messages", () => {
  test("go to the oldest pop-up session on each of the owner's computers, and nobody else's", () => {
    const { desk, connect, held } = setup();
    const a1 = connect("a1", "macbook", "chris");
    const a2 = connect("a2", "macbook", "chris");
    const b1 = connect("b1", "studio", "chris");
    const m1 = connect("m1", "maya-linux", "maya");
    const quiet = connect("q1", "imac", "chris", false);
    desk.open(held("msg-1"));
    expect(a1.sent.map((s) => s.event)).toEqual(["approval_request"]);
    expect(a1.sent[0]!.data).toMatchObject({ messageId: "msg-1", subject: "Add the doc link", nonce: "nonce-1" });
    expect(b1.sent).toHaveLength(1);
    expect(a2.sent).toEqual([]);
    expect(m1.sent).toEqual([]);
    expect(quiet.sent).toEqual([]);
  });

  test("move to the next session when the holder's stream closes, and close everywhere on a decision", () => {
    const { desk, connect, held } = setup();
    const a1 = connect("a1", "macbook", "chris");
    const a2 = connect("a2", "macbook", "chris");
    desk.open(held("msg-1"));
    a1.disconnect();
    expect(a2.sent.map((s) => s.event)).toEqual(["approval_request"]);
    expect(desk.check("msg-1", "a2", "nonce-2")).toBe("open");
    expect(desk.check("msg-1", "a2", "nonce-1")).toBe("unknown");
    desk.close("msg-1", "allowed");
    expect(a2.sent.at(-1)).toEqual({ event: "approval_closed", data: { messageId: "msg-1", outcome: "allowed" } });
    expect(desk.check("msg-1", "a2", "nonce-2")).toBe("closed");
  });

  test("a session that connects later gets the open request; closed ones are forgotten after expiry", () => {
    const { desk, connect, held, clock } = setup();
    desk.open(held("msg-1"));
    const late = connect("late", "macbook", "chris");
    expect(late.sent.map((s) => s.event)).toEqual(["approval_request"]);
    desk.close("msg-1", "expired");
    clock.advance(25 * HOUR);
    expect(desk.sweep()).toBe(1);
  });

  test("the text is defanged and clipped", () => {
    expect(panelText(`${"x".repeat(600)}`)).toHaveLength(501);
    expect(panelText("\u001b[31mred\u001b[0m")).toBe("red");
  });
});
