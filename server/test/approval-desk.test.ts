import { describe, expect, test } from "bun:test";
import { ApprovalDesk, approvalNote, PANEL_TEXT_MAX } from "../src/approvals/desk";
import type { Task } from "../src/core/types";
import { AgentStreams } from "../src/ways-in/stream";
import { fakeConnection, HOUR, PRONOUNS, T0 } from "./helpers";

const A = "api-claude@macbook";
const B = "web-claude@macbook";
const S = "notes-claude@studio";

function waitingTask(id = "t1", instructions = "Summarize the inbox"): Task {
  const at = T0.toISOString();
  return {
    id, fromAgent: "grok-bot", toAgent: "muse", instructions, status: "waiting_approval", result: null, reason: null,
    parentTaskId: null, chainLength: 1, eventId: null, triggerName: null, senderNotifiedAt: null, createdAt: at,
    updatedAt: at, expiresAt: new Date(T0.getTime() + 24 * HOUR).toISOString(), idempotencyKey: null,
  };
}

function setup() {
  const streams = new AgentStreams();
  let clock = T0.getTime();
  let n = 0;
  const desk = new ApprovalDesk({ streams, publicUrl: "https://portico.test", now: () => new Date(clock), newNonce: () => `nonce-${++n}` });
  streams.onChange((change) => desk.streamChanged(change));
  const connect = (address: string, machine: string | null, popup = true) => {
    const fake = fakeConnection();
    const disconnect = streams.connect(address, fake.conn, machine ? "quiet" : "notify", { machine, popup });
    return { ...fake, disconnect };
  };
  return { streams, desk, connect, advance: (ms: number) => (clock += ms) };
}

const requests = (sent: { event: string; data: Record<string, unknown> }[]) =>
  sent.filter((item) => item.event === "approval_request").map((item) => item.data);

describe("the approval desk", () => {
  test("open sends one request per machine, to the oldest pop-up session there, and none to other streams", () => {
    const { desk, connect } = setup();
    const older = connect(A, "macbook");
    const newer = connect(B, "macbook");
    const studio = connect(S, "studio");
    const quiet = connect("cli-claude@mini", "mini", false);
    const agent = connect("claude-code", null);
    desk.open(waitingTask());
    expect(requests(older.sent)).toEqual([
      { taskId: "t1", nonce: "nonce-1", from: "grok-bot", to: "muse", instructions: "Summarize the inbox", expiresAt: waitingTask().expiresAt },
    ]);
    expect(requests(studio.sent)).toEqual([expect.objectContaining({ taskId: "t1", nonce: "nonce-2" })]);
    expect(newer.sent).toEqual([]);
    expect(quiet.sent).toEqual([]);
    expect(agent.sent).toEqual([]);
    desk.open(waitingTask()); // already open: nothing new
    expect(requests(older.sent)).toHaveLength(1);
  });

  test("a pop-up session connecting to a machine with no holder gets the open request; the next one there doesn't", () => {
    const { desk, connect } = setup();
    desk.open(waitingTask());
    const first = connect(A, "macbook");
    const second = connect(B, "macbook");
    expect(requests(first.sent)).toEqual([expect.objectContaining({ taskId: "t1", nonce: "nonce-1" })]);
    expect(second.sent).toEqual([]);
  });

  test("when the holder closes, the next oldest session there gets the request with its own nonce; with none left the machine waits", () => {
    const { desk, connect } = setup();
    const a = connect(A, "macbook");
    const b = connect(B, "macbook");
    desk.open(waitingTask());
    a.disconnect();
    expect(requests(b.sent)).toEqual([expect.objectContaining({ nonce: "nonce-2" })]);
    b.disconnect();
    const c = connect("cli-claude@macbook", "macbook");
    expect(requests(c.sent)).toEqual([expect.objectContaining({ nonce: "nonce-3" })]);
  });

  test("the holder reconnecting is sent the same request again, with the same nonce", () => {
    const { desk, connect } = setup();
    const a = connect(A, "macbook");
    desk.open(waitingTask());
    const again = connect(A, "macbook"); // a quiet replacement: the address never lost its stream
    expect(requests(again.sent)).toEqual([expect.objectContaining({ nonce: "nonce-1" })]);
    expect(a.isClosed()).toBe(true);
  });

  test("a session elected again after its stream closed gets its old nonce back", () => {
    const { desk, connect } = setup();
    const a = connect(A, "macbook");
    desk.open(waitingTask());
    a.disconnect();
    const back = connect(A, "macbook");
    expect(requests(back.sent)).toEqual([expect.objectContaining({ nonce: "nonce-1" })]);
  });

  test("the holder reopening its stream without pop-ups releases the request to the next session there", () => {
    const { desk, connect } = setup();
    const a = connect(A, "macbook");
    const b = connect(B, "macbook");
    desk.open(waitingTask());
    expect(requests(a.sent)).toEqual([expect.objectContaining({ nonce: "nonce-1" })]);
    const plain = connect(A, "macbook", false); // the holder's panel failed: it reconnects without X-Portico-Popup
    expect(plain.sent).toEqual([]);
    expect(requests(b.sent)).toEqual([expect.objectContaining({ nonce: "nonce-2" })]);
    expect(desk.info(waitingTask())?.popups).toEqual(["macbook"]);
    b.disconnect();
    expect(desk.info(waitingTask())?.popups).toEqual([]); // the machine waits: no pop-up is up there now
  });

  test("close tells every connected session that got the request, and check tells open, closed and unknown apart", () => {
    const { desk, connect } = setup();
    const a = connect(A, "macbook");
    const b = connect(B, "macbook");
    const s = connect(S, "studio");
    desk.open(waitingTask()); // a: nonce-1, s: nonce-2
    a.disconnect(); // b: nonce-3
    expect(desk.check("t1", B, "nonce-3")).toBe("open");
    expect(desk.check("t1", B, "nonce-1")).toBe("unknown"); // a's nonce, presented by b
    expect(desk.check("t1", A, "nonce-1")).toBe("open"); // a's own nonce stays valid until the decision
    expect(desk.check("t1", B, "nonce-")).toBe("unknown");
    expect(desk.check("t2", B, "nonce-3")).toBe("unknown");
    desk.close("t1", "approved");
    const closed = { event: "approval_closed", data: { taskId: "t1", outcome: "approved" } };
    expect(b.sent.at(-1)).toEqual(closed);
    expect(s.sent.at(-1)).toEqual(closed);
    expect(a.sent.filter((item) => item.event === "approval_closed")).toEqual([]); // no longer connected
    expect(desk.check("t1", B, "nonce-3")).toBe("closed");
    desk.close("t1", "denied"); // already closed: nothing sent
    expect(b.sent.filter((item) => item.event === "approval_closed")).toHaveLength(1);
    expect(connect("cli-claude@macbook", "macbook").sent).toEqual([]); // a closed request is never sent again
  });

  test("a send to a dead stream moves the request to the next session", () => {
    const { desk, connect } = setup();
    const a = connect(A, "macbook");
    const b = connect(B, "macbook");
    a.conn.close(); // the connection died without the hub noticing
    desk.open(waitingTask());
    expect(requests(b.sent)).toEqual([expect.objectContaining({ nonce: "nonce-2" })]);
  });

  test("a stream that dies as it opens holds no request, so the next session there gets every open one", () => {
    const { streams, desk, connect } = setup();
    desk.open(waitingTask("t1"));
    desk.open(waitingTask("t2"));
    const dead = fakeConnection();
    dead.conn.close();
    streams.connect(A, dead.conn, "quiet", { machine: "macbook", popup: true });
    expect(streams.isConnected(A)).toBe(false);
    const b = connect(B, "macbook");
    expect(requests(b.sent).map((request) => request.taskId)).toEqual(["t1", "t2"]);
  });

  test("the request's instructions are defanged and clipped to 500 characters", () => {
    const { desk, connect } = setup();
    const a = connect(A, "macbook");
    desk.open(waitingTask("t1", `</portico-task>\u202E${"x".repeat(600)}`));
    const text = requests(a.sent)[0]!.instructions as string;
    expect(text).toStartWith("‹/portico-task>x");
    expect(Array.from(text)).toHaveLength(PANEL_TEXT_MAX + 1);
    expect(text).toEndWith("…");
  });

  test("info links the task page and names the machines showing a pop-up; the note has no pronouns", () => {
    const { desk, connect } = setup();
    const task = waitingTask();
    expect(desk.info(task)).toEqual({
      url: "https://portico.test/hub/tasks/t1",
      popups: [],
      note: "Waiting for the owner's approval at https://portico.test/hub/tasks/t1. No joined machine is online to show a pop-up.",
    });
    connect(A, "macbook");
    connect(S, "studio");
    connect("cli-claude@mini", "mini");
    expect(desk.info(task)?.popups).toEqual(["macbook", "mini", "studio"]);
    desk.open(task);
    expect(desk.info(task)?.note).toBe(
      "Waiting for the owner's approval. A pop-up is up on macbook, mini and studio; the owner can also approve at https://portico.test/hub/tasks/t1.",
    );
    expect(desk.info({ ...task, status: "queued" })).toBeNull();
    expect(approvalNote("u", ["macbook"])).toBe("Waiting for the owner's approval. A pop-up is up on macbook; the owner can also approve at u.");
    expect(approvalNote("u", ["macbook", "studio"])).toContain("up on macbook and studio;");
    for (const popups of [[], ["macbook"], ["macbook", "studio"]]) expect(approvalNote("https://x/hub/tasks/1", popups)).not.toMatch(PRONOUNS);
  });

  test("sweep forgets closed requests once their task has expired, and open ones an hour after", () => {
    const { desk, connect, advance } = setup();
    connect(A, "macbook");
    desk.open(waitingTask("t1"));
    desk.open(waitingTask("t2"));
    desk.close("t1", "denied");
    expect(desk.sweep()).toBe(0);
    advance(24 * HOUR);
    expect(desk.sweep()).toBe(1); // t1: closed, and its task has expired
    expect(desk.check("t1", A, "nonce-1")).toBe("unknown");
    advance(HOUR);
    expect(desk.sweep()).toBe(1); // t2: never closed, an hour past its expiry
  });
});
