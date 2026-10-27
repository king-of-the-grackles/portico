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
