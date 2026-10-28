import { describe, expect, test } from "bun:test";
import { addAppAgent, addComputer, addOwner, callAs, flush, makePortico, openSessionStream } from "./helpers";

async function setup() {
  const p = makePortico({ newNonce: () => "nonce-1" });
  const chris = await addOwner(p);
  const { computer, token } = addComputer(p, chris);
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  return { p, chris, computer, token, grok };
}

describe("a session's live stream", () => {
  test("registers the session, says hello first, and nudges when a message arrives", async () => {
    const { p, token, grok } = await setup();
    const { hello, events } = await openSessionStream(p, token, { key: "key-000001", repo: "api" });
    expect(hello).toEqual({ address: "api-claude@macbook", name: "api-claude", computer: "macbook" });
    expect(p.agents.entries().find((e) => e.display === "api-claude")?.status).toBe("idle");
    await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "api-claude", subject: "s", text: "t" });
    expect((await events.next()).event).toBe("nudge");
    await events.cancel();
  });

  test("only a computer token opens it, and a folder switched off answers folder_off", async () => {
    const { p, chris, token, grok } = await setup();
    expect((await callAs(p, { token: grok.token }, "GET", "/api/agent/stream")).status).toBe(403);
    const { events } = await openSessionStream(p, token, { key: "key-000001", repo: "api", folderId: "d".repeat(64) });
    const agent = p.agents.resolve("api-claude", "x");
    p.agents.update(chris.id, agent.id, { joinFromFolder: false });
    const res = await p.app.request("/api/agent/stream?repo=api", {
      headers: { authorization: `Bearer ${token}`, "x-portico-session": "key-000002", "x-portico-folder": "d".repeat(64) },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "folder_off" });
    await events.cancel();
  });

  test("two terminals in one folder are one agent: the newest gets nudges, both get renames, it stays online until both close", async () => {
    const { p, chris, token, grok } = await setup();
    const older = await openSessionStream(p, token, { key: "key-000001", repo: "api" });
    const newer = await openSessionStream(p, token, { key: "key-000002", repo: "api" });
    expect(newer.hello).toEqual(older.hello);
    const agent = p.agents.resolve("api-claude", "x");
    expect(p.agents.all().filter((a) => a.type === "session")).toHaveLength(1);
    expect(p.agentStreams.liveRuns(agent.id)).toBe(2);
    await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "api-claude", subject: "s", text: "t" });
    expect((await newer.events.next()).event).toBe("nudge");
    p.agents.update(chris.id, agent.id, { name: "billing-claude" });
    expect((await older.events.next()).event).toBe("renamed");
    expect((await newer.events.next()).event).toBe("renamed");
    await newer.events.cancel();
    await flush();
    expect(p.agents.entry(p.agents.require(agent.id)).status).toBe("idle");
    // The older terminal takes deliveries now.
    await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "billing-claude", subject: "s2", text: "t" });
    expect((await older.events.next()).event).toBe("nudge");
    await older.events.cancel();
    await flush();
    expect(p.agents.entry(p.agents.require(agent.id)).status).toBe("offline");
    expect(p.agents.runs(agent.id).every((run) => run.endedAt !== null)).toBe(true);
  });

  test("a Codex conversation is nudged only when its bridge can wake it, and a message to it then counts as pushed", async () => {
    const { p, token, grok } = await setup();
    const send = async (subject: string) => {
      const res = await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "api-codex", subject, text: "t" });
      return ((await res.json()) as { delivery: string }).delivery;
    };
    const plain = await openSessionStream(p, token, { key: "key-000001", repo: "api", client: "codex" });
    const agent = p.agents.resolve("api-codex", "x");
    expect(await send("first")).toBe("queued");
    expect(p.agentStreams.canWake(agent.id)).toBe(false);
    // The first message still waits, so each new stream starts with a nudge.
    const waking = await openSessionStream(p, token, { key: "key-000002", repo: "api", client: "codex", wake: true });
    expect((await waking.events.next()).event).toBe("nudge");
    const newest = await openSessionStream(p, token, { key: "key-000003", repo: "api", client: "codex" });
    expect((await newest.events.next()).event).toBe("nudge");
    expect(p.agentStreams.canWake(agent.id)).toBe(true);
    expect(await send("second")).toBe("pushed");
    // The newest conversation can't wake, so the one that can gets the nudge.
    expect((await waking.events.next()).event).toBe("nudge");
    await waking.events.cancel();
    await flush();
    expect(p.agentStreams.canWake(agent.id)).toBe(false);
    expect(await send("third")).toBe("queued");
    await plain.events.cancel();
    await newest.events.cancel();
  });

  test("each terminal reports its own status; the agent shows the busiest", async () => {
    const { p, token } = await setup();
    const one = await openSessionStream(p, token, { key: "key-000001", repo: "api" });
    const two = await openSessionStream(p, token, { key: "key-000002", repo: "api" });
    await callAs(p, { token, key: "key-000001" }, "POST", "/api/agent/status", { status: "busy", doing: "Running tests" });
    await callAs(p, { token, key: "key-000002" }, "POST", "/api/agent/status", { status: "idle" });
    const agent = p.agents.resolve("api-claude", "x");
    expect(p.agents.entry(agent)).toMatchObject({ status: "busy", doing: "Running tests" });
    await one.events.cancel();
    await flush();
    expect(p.agents.entry(agent)).toMatchObject({ status: "idle", doing: null });
    await two.events.cancel();
  });

  test("a heartbeat that changes nothing shown refetches nothing, and a report after a terminal closed is ignored", async () => {
    const { p, token } = await setup();
    const one = await openSessionStream(p, token, { key: "key-000001", repo: "api" });
    const two = await openSessionStream(p, token, { key: "key-000002", repo: "api" });
    await callAs(p, { token, key: "key-000001" }, "POST", "/api/agent/status", { status: "busy", doing: "Tests" });
    await callAs(p, { token, key: "key-000002" }, "POST", "/api/agent/status", { status: "idle" });
    await flush();
    const changes: string[][] = [];
    p.changes.on((topics) => changes.push(topics));
    // The idle terminal's heartbeat: the agent still shows the busy one's report.
    await callAs(p, { token, key: "key-000002" }, "POST", "/api/agent/status", { status: "idle" });
    await flush();
    expect(changes.filter((t) => t.includes("agents"))).toEqual([]);
    await one.events.cancel();
    await flush();
    // The closed terminal's last heartbeat arrives late: it doesn't bring Working back.
    await callAs(p, { token, key: "key-000001" }, "POST", "/api/agent/status", { status: "busy", doing: "Tests" });
    expect(p.agents.entry(p.agents.resolve("api-claude", "x")).status).toBe("idle");
    await two.events.cancel();
  });

  test("each terminal in a folder gets its own allowance of waiting check_inbox calls", async () => {
    const { p, token } = await setup();
    const streams = [];
    for (let i = 1; i <= 4; i++) streams.push(await openSessionStream(p, token, { key: `key-00000${i}`, repo: "api" }));
    const waits = [1, 2, 3, 4].map((i) => callAs(p, { token, key: `key-00000${i}` }, "GET", "/api/agent/inbox?wait=0.2"));
    expect((await Promise.all(waits)).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    for (const s of streams) await s.events.cancel();
  });

  test("a rename reaches the open stream", async () => {
    const { p, chris, token } = await setup();
    const { events } = await openSessionStream(p, token, { key: "key-000001", repo: "api" });
    p.agents.update(chris.id, p.agents.resolve("api-claude", "x").id, { name: "billing-claude" });
    expect(await events.next()).toEqual({
      event: "renamed",
      data: { address: "billing-claude@macbook", name: "billing-claude", computer: "macbook" },
    });
    await events.cancel();
  });

  test("a pop-up session gets held messages for its owner, and its answer decides them", async () => {
    const { p, chris, token, grok } = await setup();
    const muse = addAppAgent(p, chris, "muse", { approvalRequired: true });
    const { events } = await openSessionStream(p, token, { key: "key-000001", repo: "api", popup: true });
    const sent = (await (
      await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "muse", subject: "Add the doc link", text: "t" })
    ).json()) as { message: { id: string } };
    const request = await events.next();
    expect(request).toMatchObject({ event: "approval_request", data: { messageId: sent.message.id, from: "grok", to: "muse", nonce: "nonce-1" } });
    const auth = { token, key: "key-000001" };
    expect((await callAs(p, auth, "POST", `/api/agent/approvals/${sent.message.id}`, { nonce: "wrong", decision: "allow_once" })).status).toBe(403);
    const ok = await callAs(p, auth, "POST", `/api/agent/approvals/${sent.message.id}`, { nonce: "nonce-1", decision: "always_allow" });
    expect(ok.status).toBe(200);
    expect(p.approvals.allowListFor(chris.id, muse.agent.id)).toHaveLength(1);
    await flush();
    expect(await events.next()).toEqual({ event: "approval_closed", data: { messageId: sent.message.id, outcome: "allowed" } });
    expect((await callAs(p, auth, "POST", `/api/agent/approvals/${sent.message.id}`, { nonce: "nonce-1", decision: "deny" })).status).toBe(409);
    await events.cancel();
  });

  test("removing the computer closes its sessions' streams and its token fails", async () => {
    const { p, computer, token } = await setup();
    const { events } = await openSessionStream(p, token, { key: "key-000001", repo: "api" });
    p.agents.forget(p.computers.remove(computer.id));
    await expect(events.next(500)).rejects.toThrow();
    expect((await callAs(p, { token, key: "key-000001" }, "GET", "/api/agent/agents")).status).toBe(401);
  });
});
