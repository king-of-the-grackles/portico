import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addSession } from "../../server/test/helpers";
import { ApiError, PorticoClient } from "../src/portico-client";
import { appAgent, joinTestComputer, startPortico, type TestPortico } from "./helpers";

let p: TestPortico;
let token: string;
let key: string;
beforeEach(async () => {
  p = await startPortico();
  token = joinTestComputer(p).token;
  key = addSession(p, p.computers.byName("macbook")!, { key: "key-client-0001", repo: "api" }).key;
});
afterEach(() => p.stop());

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected an ApiError");
}

const session = () => new PorticoClient({ url: p.url, token, sessionKey: key });

describe("PorticoClient", () => {
  test("lists the other agents", async () => {
    appAgent(p, "grok", { kind: "grok-bot" });
    appAgent(p, "muse", { approvalRequired: true });
    const { agents } = await session().listAgents();
    expect(agents.map((a) => [a.name, a.type, a.approval_required]).sort()).toEqual([
      ["grok", "app", false],
      ["muse", "app", true],
    ]);
  });

  test("a full exchange: send, the other agent checks the inbox and replies, the reply is waiting here", async () => {
    const grok = appAgent(p, "grok", { kind: "grok-bot" });
    const client = session();
    const { message, delivery } = await client.sendMessage({ to: "grok", subject: "Release date", text: "When is the release?" });
    expect(delivery).toBe("queued");
    expect(message).toMatchObject({ from: "api-claude", to: "grok", subject: "Release date", status: "pending" });

    const grokClient = new PorticoClient({ url: p.url, token: grok.token });
    const inbox = await grokClient.checkInbox();
    expect(inbox.messages.map((m) => m.id)).toEqual([message.id]);
    expect(inbox.messages[0]!.framed_message).toContain(`**Message \`${message.id}\` from agent \`api-claude\` via Portico: Release date**`);

    const reply = await grokClient.sendMessage({ reply_to: message.id, subject: "Friday", text: "Friday" });
    expect(reply.message.to).toBe("api-claude");
    const waiting = await client.pendingDeliveries();
    expect(waiting.messages.map((m) => m.id)).toEqual([reply.message.id]);
    expect(await client.ackDeliveries({ messages: [reply.message.id], updates: [] })).toEqual({ acked: { messages: 1, updates: 0 } });
    expect((await client.pendingDeliveries()).messages).toEqual([]);
  });

  test("checkInbox with wait holds until a message arrives, past the ordinary timeout", async () => {
    const grok = appAgent(p, "grok", { kind: "grok-bot" });
    const waiting = new PorticoClient({ url: p.url, token, sessionKey: key, timeoutMs: 200 }).checkInbox(3);
    await Bun.sleep(400);
    await new PorticoClient({ url: p.url, token: grok.token }).sendMessage({ to: "api-claude", subject: "Late", text: "t" });
    expect((await waiting).messages.map((m) => m.subject)).toEqual(["Late"]);
  });

  test("a cancelled checkInbox wait ends its request, so the next message waits for the next check", async () => {
    const grok = appAgent(p, "grok", { kind: "grok-bot" });
    const cancel = new AbortController();
    const waiting = session().checkInbox(3, cancel.signal);
    await Bun.sleep(100);
    cancel.abort();
    expect(await apiError(waiting)).toMatchObject({ code: "unreachable" });
    await Bun.sleep(50);
    const sessionId = p.agents.sessionByKey(p.computers.byName("macbook")!.id, key)!.id;
    expect(p.inboxWaits.count(sessionId)).toBe(0);
    await new PorticoClient({ url: p.url, token: grok.token }).sendMessage({ to: "api-claude", subject: "Later", text: "t" });
    expect(p.messages.unreadCount(sessionId)).toBe(1);
  });

  test("reports the session's status", async () => {
    expect(await session().reportStatus({ status: "busy", doing: "Tests", repo: "api", branch: "main" })).toEqual({ ok: true });
  });

  test("turns Portico's errors into ApiError with Portico's code and message", async () => {
    const wrongToken = new PorticoClient({ url: p.url, token: "pc_wrong-token-0123456789abcdef", sessionKey: key });
    expect(await apiError(wrongToken.listAgents())).toMatchObject({ status: 401, code: "unauthorized" });

    const err = await apiError(session().sendMessage({ to: "nobody", subject: "s", text: "x" }));
    expect(err).toMatchObject({ status: 400, code: "unknown_agent" });
  });

  test("reports an unreachable Portico as status 0, without the token", async () => {
    const err = await apiError(new PorticoClient({ url: "http://127.0.0.1:1", token }).listAgents());
    expect(err).toMatchObject({ status: 0, code: "unreachable" });
    expect(err.message).toStartWith("Portico at http://127.0.0.1:1 could not be reached (");
    expect(err.message).not.toContain(token);
  });

  test("reports an answer that isn't JSON", async () => {
    const plain = Bun.serve({ port: 0, fetch: () => new Response("oops") });
    try {
      const err = await apiError(new PorticoClient({ url: `http://127.0.0.1:${plain.port}`, token: "t" }).listAgents());
      expect(err).toMatchObject({ status: 200, code: "bad_response" });
    } finally {
      plain.stop(true);
    }
  });

  test("opens the live stream, registering the session", async () => {
    const controller = new AbortController();
    const res = await new PorticoClient({ url: p.url, token, sessionKey: "key-client-0002" }).openStream(controller.signal, {
      repo: "web",
      folderId: "b".repeat(64),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
    expect(p.agents.byAddress("web-claude@macbook")).not.toBeNull();
  });

  test("openStream sends the registration and declares pop-ups only when asked", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return new Response("", { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    const client = new PorticoClient({ url: "https://portico.example.com", token: "pc_x", sessionKey: "key-0001", fetch });
    await client.openStream(new AbortController().signal, { repo: "my repo", folderId: "f".repeat(64) });
    await client.openStream(new AbortController().signal, undefined, { popup: true });
    expect(seen[0]!.url).toBe("https://portico.example.com/api/agent/stream?repo=my%20repo");
    expect(seen[0]!.headers).toMatchObject({ authorization: "Bearer pc_x", "x-portico-session": "key-0001", "x-portico-folder": "f".repeat(64) });
    expect(seen[0]!.headers["x-portico-popup"]).toBeUndefined();
    expect(seen[1]!.headers["x-portico-popup"]).toBe("1");
  });

  test("answerApproval posts the answer as the session", async () => {
    const seen: { url: string; method: string | undefined; headers: Record<string, string>; body: unknown }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return Response.json({ message: { id: "m/1" } });
    }) as unknown as typeof globalThis.fetch;
    const client = new PorticoClient({ url: "https://portico.example.com", token: "pc_x", sessionKey: "key-0001", fetch });
    expect(await client.answerApproval("m/1", { nonce: "n".repeat(32), decision: "always_allow" })).toEqual({ message: { id: "m/1" } } as never);
    expect(seen).toEqual([
      {
        url: "https://portico.example.com/api/agent/approvals/m%2F1",
        method: "POST",
        headers: expect.objectContaining({ "x-portico-session": "key-0001", "content-type": "application/json" }),
        body: { nonce: "n".repeat(32), decision: "always_allow" },
      },
    ]);
  });
});
