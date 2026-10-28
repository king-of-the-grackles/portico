import { describe, expect, test } from "bun:test";
import { InboxWaits, inboxWaitMs } from "../src/core/inbox-waits";
import { addAppAgent, addComputer, addOwner, addSession, callAs, errorCode, makePortico } from "./helpers";

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  const codex = addAppAgent(p, chris, "codex", { kind: "codex" });
  const muse = addAppAgent(p, chris, "muse", { approvalRequired: true });
  return { p, chris, grok, codex, muse };
}

type Inbox = { messages: { id: string; subject: string }[]; updates: { message_id: string; status: string }[] };
type ToolResult = { result: { isError: boolean; content: { text: string }[] } };

const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

/** Resolves with the response and how long it took, in ms. */
async function timed(res: Promise<Response>): Promise<{ res: Response; ms: number }> {
  const start = performance.now();
  const done = await res;
  return { res: done, ms: performance.now() - start };
}

describe("InboxWaits", () => {
  test("a wake ends every wait for that agent, and only for that agent", async () => {
    const waits = new InboxWaits();
    let woke = 0;
    const a1 = waits.sleep("a", 5_000).then(() => woke++);
    const a2 = waits.sleep("a", 5_000).then(() => woke++);
    void waits.sleep("b", 30);
    expect(waits.count("a")).toBe(2);
    waits.wake("a");
    await Promise.all([a1, a2]);
    expect(woke).toBe(2);
    expect(waits.count("a")).toBe(0);
    expect(waits.count("b")).toBe(1);
  });

  test("a wait ends on its own after the time, or when its signal aborts, and leaves nothing behind", async () => {
    const waits = new InboxWaits();
    await waits.sleep("a", 10);
    const abort = new AbortController();
    const aborted = waits.sleep("a", 5_000, abort.signal);
    abort.abort();
    await aborted;
    expect(waits.count("a")).toBe(0);
  });

  test("wait is seconds, as a number or a numeric string, capped at 40", () => {
    expect(inboxWaitMs(undefined)).toBe(0);
    expect(inboxWaitMs("")).toBe(0);
    expect(inboxWaitMs(0)).toBe(0);
    expect(inboxWaitMs(2.5)).toBe(2500);
    expect(inboxWaitMs("30")).toBe(30_000);
    expect(inboxWaitMs(600)).toBe(40_000);
    expect(errorCode(() => inboxWaitMs(-1))).toBe("bad_request");
    expect(errorCode(() => inboxWaitMs("soon"))).toBe("bad_request");
    expect(errorCode(() => inboxWaitMs(true))).toBe("bad_request");
  });
});

describe("GET /api/agent/inbox?wait", () => {
  test("answers at once when a message is already waiting", async () => {
    const { p, grok, codex } = await setup();
    await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "codex", subject: "Review", text: "t" });
    const { res, ms } = await timed(callAs(p, { token: codex.token }, "GET", "/api/agent/inbox?wait=5"));
    expect(((await res.json()) as Inbox).messages.map((m) => m.subject)).toEqual(["Review"]);
    expect(ms).toBeLessThan(500);
  });

  test("answers as soon as a message arrives during the wait", async () => {
    const { p, grok, codex } = await setup();
    const waiting = timed(callAs(p, { token: codex.token }, "GET", "/api/agent/inbox?wait=5"));
    await Bun.sleep(20);
    expect(p.inboxWaits.count(codex.agent.id)).toBe(1);
    await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "codex", subject: "Ready?", text: "t" });
    const { res, ms } = await waiting;
    expect(((await res.json()) as Inbox).messages.map((m) => m.subject)).toEqual(["Ready?"]);
    expect(ms).toBeLessThan(1_000);
    expect(p.inboxWaits.count(codex.agent.id)).toBe(0);
  });

  test("answers empty when nothing arrives during the wait", async () => {
    const { p, codex } = await setup();
    const { res, ms } = await timed(callAs(p, { token: codex.token }, "GET", "/api/agent/inbox?wait=0.1"));
    expect(await res.json()).toEqual({ messages: [], updates: [] });
    expect(ms).toBeGreaterThanOrEqual(90);
  });

  test("wakes the sender when a person decides a held message", async () => {
    const { p, chris, grok } = await setup();
    const sent = (await (
      await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "muse", subject: "Calendar", text: "t" })
    ).json()) as { message: { id: string }; delivery: string };
    expect(sent.delivery).toBe("held");
    const waiting = callAs(p, { token: grok.token }, "GET", "/api/agent/inbox?wait=5");
    await Bun.sleep(20);
    p.approvals.decide(chris.id, sent.message.id, "deny");
    const inbox = (await (await waiting).json()) as Inbox;
    expect(inbox.updates.map((u) => [u.message_id, u.status])).toEqual([[sent.message.id, "declined"]]);
  });

  test("wakes the receiver when a person allows a held message", async () => {
    const { p, chris, grok, muse } = await setup();
    const sent = (await (
      await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "muse", subject: "Calendar", text: "t" })
    ).json()) as { message: { id: string } };
    const waiting = callAs(p, { token: muse.token }, "GET", "/api/agent/inbox?wait=5");
    await Bun.sleep(20);
    p.approvals.decide(chris.id, sent.message.id, "allow_once");
    expect(((await (await waiting).json()) as Inbox).messages.map((m) => m.id)).toEqual([sent.message.id]);
  });

  test("two waits for one agent: one picks up the message, the other keeps waiting", async () => {
    const { p, grok, codex } = await setup();
    const first = callAs(p, { token: codex.token }, "GET", "/api/agent/inbox?wait=0.3");
    const second = callAs(p, { token: codex.token }, "GET", "/api/agent/inbox?wait=0.3");
    await Bun.sleep(20);
    await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "codex", subject: "Once", text: "t" });
    const picked = await Promise.all([first, second].map(async (res) => ((await (await res).json()) as Inbox).messages.length));
    expect(picked.sort()).toEqual([0, 1]);
  });

  test("a caller that goes away picks up nothing: the message waits for the next check", async () => {
    const { p, grok, codex } = await setup();
    const abort = new AbortController();
    const waiting = p.app.request("/api/agent/inbox?wait=5", {
      headers: { authorization: `Bearer ${codex.token}` },
      signal: abort.signal,
    });
    await Bun.sleep(20);
    abort.abort();
    expect((await waiting).status).toBe(204);
    await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "codex", subject: "Still here", text: "t" });
    const inbox = (await (await callAs(p, { token: codex.token }, "GET", "/api/agent/inbox")).json()) as Inbox;
    expect(inbox.messages.map((m) => m.subject)).toEqual(["Still here"]);
  });

  test("a removed agent's wait ends at once with 401", async () => {
    const { p, chris, codex } = await setup();
    const waiting = timed(callAs(p, { token: codex.token }, "GET", "/api/agent/inbox?wait=5"));
    await Bun.sleep(20);
    p.agents.remove(chris.id, codex.agent.id);
    const { res, ms } = await waiting;
    expect(res.status).toBe(401);
    expect(ms).toBeLessThan(1_000);
  });

  test("a wait ends with 401 when the caller's token stops working, and picks up nothing", async () => {
    const { p, grok, codex } = await setup();
    const waiting = callAs(p, { token: codex.token }, "GET", "/api/agent/inbox?wait=5");
    await Bun.sleep(20);
    p.agents.revokeToken(codex.token);
    await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "codex", subject: "For the new token", text: "t" });
    expect((await waiting).status).toBe(401);
    expect(p.messages.unreadCount(codex.agent.id)).toBe(1);
  });

  test("at most 3 waits at once for one agent", async () => {
    const { p, grok, codex } = await setup();
    const waits = [1, 2, 3].map(() => callAs(p, { token: codex.token }, "GET", "/api/agent/inbox?wait=5"));
    await Bun.sleep(20);
    const fourth = await callAs(p, { token: codex.token }, "GET", "/api/agent/inbox?wait=5");
    expect(fourth.status).toBe(429);
    expect(((await fourth.json()) as { message: string }).message).toBe(
      "3 check_inbox calls are already waiting for this agent. Let one finish first.",
    );
    expect((await callAs(p, { token: codex.token }, "GET", "/api/agent/inbox")).status).toBe(200);
    await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "codex", subject: "s", text: "t" });
    await Promise.all(waits);
  });

  test("a wait counts as a check-in when it starts", async () => {
    const { p, codex } = await setup();
    const waiting = callAs(p, { token: codex.token }, "GET", "/api/agent/inbox?wait=0.1");
    await Bun.sleep(20);
    expect(p.presence.lastCheckIn(codex.agent.id)).not.toBeNull();
    await waiting;
  });

  test("a wait that isn't a number of seconds is a 400", async () => {
    const { p, codex } = await setup();
    const res = await callAs(p, { token: codex.token }, "GET", "/api/agent/inbox?wait=-3");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toBe("wait must be a number of seconds, from 0 to 40.");
  });
});

describe("check_inbox with wait over MCP", () => {
  const checkInbox = (p: Awaited<ReturnType<typeof setup>>["p"], token: string, args: Record<string, unknown>) =>
    callAs(p, { token }, "POST", "/mcp", rpc("tools/call", { name: "check_inbox", arguments: args }));

  test("answers as soon as a message arrives during the wait", async () => {
    const { p, grok, codex } = await setup();
    const waiting = checkInbox(p, codex.token, { wait: 5 });
    await Bun.sleep(20);
    await callAs(p, { token: grok.token }, "POST", "/mcp", rpc("tools/call", { name: "send_message", arguments: { to: "codex", subject: "Ready?", text: "t" } }));
    const body = (await (await waiting).json()) as ToolResult;
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0]!.text).toStartWith("Messages (1):");
  });

  test("after a wait with nothing, says how to keep waiting", async () => {
    const { p, codex } = await setup();
    const body = (await (await checkInbox(p, codex.token, { wait: 0.05 })).json()) as ToolResult;
    expect(body.result.content[0]!.text).toBe(
      "No new messages.\nNothing arrived during the wait. To keep waiting, call check_inbox with wait again.",
    );
    const plain = (await (await checkInbox(p, codex.token, {})).json()) as ToolResult;
    expect(plain.result.content[0]!.text).toBe("No new messages.");
  });

  test("notifications/cancelled ends the caller's waiting check_inbox, and the next message waits for the next check", async () => {
    const { p, grok, codex } = await setup();
    const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "check_inbox", arguments: { wait: 5 } } };
    const waiting = timed(callAs(p, { token: codex.token }, "POST", "/mcp", call));
    await Bun.sleep(20);
    // Another agent can't cancel the call.
    const cancel = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } };
    expect((await callAs(p, { token: grok.token }, "POST", "/mcp", cancel)).status).toBe(202);
    expect(p.inboxWaits.count(codex.agent.id)).toBe(1);
    expect((await callAs(p, { token: codex.token }, "POST", "/mcp", cancel)).status).toBe(202);
    const { res, ms } = await waiting;
    expect(ms).toBeLessThan(1_000);
    expect(((await res.json()) as ToolResult).result.content).toEqual([]);
    await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "codex", subject: "After cancel", text: "t" });
    expect(p.messages.unreadCount(codex.agent.id)).toBe(1);
  });

  test("a removed agent's wait ends with 401, as any call of a removed agent does", async () => {
    const { p, chris, codex } = await setup();
    const waiting = checkInbox(p, codex.token, { wait: 5 });
    await Bun.sleep(20);
    p.agents.remove(chris.id, codex.agent.id);
    const res = await waiting;
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });

  test("a bad wait is a tool error", async () => {
    const { p, codex } = await setup();
    const body = (await (await checkInbox(p, codex.token, { wait: "later" })).json()) as ToolResult;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe("bad_request: wait must be a number of seconds, from 0 to 40.");
  });

  test("send_message tells apps and connectors how to wait for the reply, and not sessions", async () => {
    const { p, chris, grok } = await setup();
    const send = (auth: { token: string; key?: string }) =>
      callAs(p, auth, "POST", "/mcp", rpc("tools/call", { name: "send_message", arguments: { to: "codex", subject: "s", text: "t" } }));
    const fromApp = (await (await send({ token: grok.token })).json()) as ToolResult;
    expect(fromApp.result.content.at(-1)!.text).toBe("If a reply is expected, call check_inbox with wait: 40 to wait for the reply.");
    // Not for a held message: a person decides within 24 hours.
    const held = (await (
      await callAs(p, { token: grok.token }, "POST", "/mcp", rpc("tools/call", { name: "send_message", arguments: { to: "muse", subject: "s", text: "t" } }))
    ).json()) as ToolResult;
    expect(held.result.content.at(-1)!.text).toStartWith("Held: muse requires approval");
    const { computer, token } = addComputer(p, chris);
    const session = addSession(p, computer);
    const fromSession = (await (await send({ token, key: session.key })).json()) as ToolResult;
    expect(fromSession.result.content.map((c) => c.text).join("\n")).not.toContain("wait");
  });

  test("the instructions tell agents to wait for replies with check_inbox", async () => {
    const { p, codex } = await setup();
    const init = (await (await callAs(p, { token: codex.token }, "POST", "/mcp", rpc("initialize", { protocolVersion: "2025-06-18" }))).json()) as {
      result: { instructions: string };
    };
    expect(init.result.instructions).toContain("call check_inbox with wait: 40");
  });
});

describe("over a real connection", () => {
  test("a client that hangs up mid-wait ends the wait, and the next message waits for the next check", async () => {
    const { p, grok, codex } = await setup();
    const server = Bun.serve({ port: 0, fetch: p.app.fetch, idleTimeout: 60 });
    try {
      const hungUp = fetch(`http://127.0.0.1:${server.port}/api/agent/inbox?wait=5`, {
        headers: { authorization: `Bearer ${codex.token}` },
        signal: AbortSignal.timeout(100),
      });
      expect(await hungUp.then(() => "answered", (err: Error) => err.name)).toBe("TimeoutError");
      await Bun.sleep(50);
      expect(p.inboxWaits.count(codex.agent.id)).toBe(0);
      await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "codex", subject: "Later", text: "t" });
      const inbox = (await (await callAs(p, { token: codex.token }, "GET", "/api/agent/inbox")).json()) as Inbox;
      expect(inbox.messages.map((m) => m.subject)).toEqual(["Later"]);
    } finally {
      server.stop(true);
    }
  });
});
