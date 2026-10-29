import { describe, expect, test } from "bun:test";
import { frameUpdate } from "../src/core/framing";
import { addAppAgent, addComputer, addMember, addOwner, addSession, callAs, callPerson, flush, makePortico, signIn } from "./helpers";

describe("fixes from the code review", () => {
  test("agents see a person's new name at once, not the name from when the server started", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const maya = await addMember(p);
    addAppAgent(p, maya, "maya-dot", { kind: "dots" });
    const { token } = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
    const owners = async () =>
      ((await (await callAs(p, { token }, "GET", "/api/agent/agents")).json()) as { agents: { name: string; owner: string }[] }).agents
        .find((a) => a.name === "maya-dot")!.owner;
    expect(await owners()).toBe("Maya");
    p.people.rename(maya.id, "Maya Chen");
    expect(await owners()).toBe("Maya Chen");
  });

  test("a member's threads show however many newer threads other agents have", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const maya = await addMember(p);
    const mayaDot = addAppAgent(p, maya, "maya-dot", { kind: "dots" }).agent;
    const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" }).agent;
    p.messages.send(grok, { to: "maya-dot", subject: "Old", text: "t" });
    const others = Array.from({ length: 6 }, (_, i) => addAppAgent(p, chris, `agent-${i}`).agent);
    for (const other of others) {
      p.clock.advance(60_000);
      p.messages.send(grok, { to: other.name, subject: "Newer", text: "t" });
    }
    expect(p.messages.threads({ involving: [mayaDot.id], limit: 3 })).toHaveLength(1);
    expect(p.messages.threads({ agentId: mayaDot.id, limit: 3 })).toHaveLength(1);
    expect(p.messages.threads({ involving: [], limit: 3 })).toEqual([]);
  });

  test("the 401's pointer to the OAuth metadata uses the public URL, not the request's own address", async () => {
    const p = makePortico();
    const res = await p.app.request("http://internal-host:8790/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://portico.example.com/.well-known/oauth-protected-resource"',
    );
  });

  test("a held message allowed but never picked up is reported as approved, then expired", () => {
    expect(frameUpdate({ messageId: "m", to: "muse", subject: "s", status: "expired", decision: "allow_once", held: true })).toContain(
      "was approved, but expired before the recipient picked the message up",
    );
    expect(frameUpdate({ messageId: "m", to: "muse", subject: "s", status: "expired", decision: null, held: true })).toContain(
      "expired before anyone approved the message",
    );
    expect(frameUpdate({ messageId: "m", to: "muse", subject: "s", status: "expired", decision: null, held: false })).toContain(
      "expired before `muse` picked the message up",
    );
  });

  test("an unchanged status report, the plugin's heartbeat, doesn't make every page refetch", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer, token } = addComputer(p, chris);
    const { key } = addSession(p, computer);
    await flush(); // registration's own change goes out first
    const topics: string[][] = [];
    p.changes.on((t) => topics.push(t));
    const report = { status: "busy", doing: "Billing", repo: "api", branch: "main" };
    await callAs(p, { token, key }, "POST", "/api/agent/status", report);
    await flush();
    await callAs(p, { token, key }, "POST", "/api/agent/status", report);
    await flush();
    expect(topics.filter((t) => t.includes("agents"))).toHaveLength(1);
    await callAs(p, { token, key }, "POST", "/api/agent/status", { ...report, status: "idle" });
    await flush();
    expect(topics.filter((t) => t.includes("agents"))).toHaveLength(2);
  });

  test("unreadable Basic client credentials get invalid_client, not a server error", async () => {
    const p = makePortico();
    await addOwner(p);
    const res = await p.app.request("https://portico.example.com/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from("%E0%A4%A:x").toString("base64")}`,
      },
      body: "grant_type=authorization_code&code=x&code_verifier=y&redirect_uri=https://x.example/cb",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
  });

  test("Settings' first data and GET /api/people agree", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const cookie = signIn(p, chris);
    await callPerson(p, cookie, "POST", "/api/invites", { name: "Priya" });
    const api = await (await callPerson(p, cookie, "GET", "/api/people")).json();
    const { settingsData } = await import("../src/web/settings");
    expect(settingsData(p, chris).people).toEqual(api as never);
  });
});
