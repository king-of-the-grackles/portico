import { describe, expect, test } from "bun:test";
import { TOKENS, type TestAgent, makeApp } from "./helpers";

type Ctx = ReturnType<typeof makeApp>;

function rpc(ctx: Ctx, agent: TestAgent | null, target: string, method: string, params: unknown, id: number = 1) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (agent) headers.authorization = `Bearer ${TOKENS[agent]}`;
  return Promise.resolve(
    ctx.app.request(`/a2a/${target}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
}

function message(...texts: string[]) {
  return {
    message: {
      kind: "message",
      role: "user",
      messageId: crypto.randomUUID(),
      parts: texts.map((text) => ({ kind: "text", text })),
    },
  };
}

describe("A2A agent cards", () => {
  test("each agent has a 0.3 card pointing at its JSON-RPC endpoint", async () => {
    const { app } = makeApp();
    const res = await app.request("/a2a/claude-code/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card).toMatchObject({
      protocolVersion: "0.3.0",
      name: "claude-code",
      description: "Claude Code",
      url: "https://bridge.test/a2a/claude-code",
      preferredTransport: "JSONRPC",
      capabilities: { streaming: false, pushNotifications: false },
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      security: [{ bearer: [] }],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
    });
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]).toMatchObject({ id: "handoff", description: "Claude Code" });
    expect("supportedInterfaces" in card).toBe(false);
  });

  test("the older agent.json path works too, and unknown agents get a 404", async () => {
    const { app } = makeApp();
    expect((await app.request("/a2a/muse/.well-known/agent.json")).status).toBe(200);
    expect((await app.request("/a2a/nobody/.well-known/agent-card.json")).status).toBe(404);
  });
});

describe("A2A JSON-RPC", () => {
  test("requires a token", async () => {
    const ctx = makeApp();
    const res = await rpc(ctx, null, "claude-code", "message/send", message("x"));
    expect(res.status).toBe(401);
  });

  test("message/send hands a task to the agent in the URL", async () => {
    const ctx = makeApp();
    const body = await (await rpc(ctx, "grok-bot", "claude-code", "message/send", message("Fix the build"))).json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result).toMatchObject({
      kind: "task",
      status: { state: "submitted" },
      metadata: { from_agent: "grok-bot", to_agent: "claude-code", bridge_status: "queued" },
    });
    expect(ctx.store.getTask(body.result.id)?.instructions).toBe("Fix the build");
  });

  test("tasks/get reports completion with the result as an artifact, and marks it seen", async () => {
    const ctx = makeApp();
    const sent = await (await rpc(ctx, "grok-bot", "claude-code", "message/send", message("Fix the build"))).json();
    const id = sent.result.id as string;
    ctx.service.checkInbox("claude-code");
    ctx.service.finishTask("claude-code", { taskId: id, result: "Build fixed." });
    const got = await (await rpc(ctx, "grok-bot", "claude-code", "tasks/get", { id }, 2)).json();
    expect(got.id).toBe(2);
    expect(got.result.status.state).toBe("completed");
    expect(got.result.artifacts).toEqual([
      { artifactId: `${id}-result`, name: "result", parts: [{ kind: "text", text: "Build fixed." }] },
    ]);
    expect(ctx.service.checkInbox("grok-bot").results).toEqual([]);
  });

  test("waiting and denied tasks explain themselves in the status message", async () => {
    const ctx = makeApp();
    const waiting = await (await rpc(ctx, "grok-bot", "muse", "message/send", message("Summarize my inbox"))).json();
    expect(waiting.result.status.state).toBe("submitted");
    expect(waiting.result.status.message.parts[0].text).toBe("Waiting for the user's approval.");
    const denied = await (await rpc(ctx, "grok-bot", "codex", "message/send", message("x"))).json();
    expect(denied.result.status.state).toBe("rejected");
    expect(denied.result.status.message.parts[0].text).toBe("no rule allows grok-bot → codex");
  });

  test("joins text parts and ignores other part kinds", async () => {
    const ctx = makeApp();
    const params = {
      message: {
        kind: "message",
        role: "user",
        messageId: "m1",
        parts: [
          { kind: "text", text: "First" },
          { kind: "data", data: { x: 1 } },
          { kind: "text", text: "Second" },
        ],
      },
    };
    const body = await (await rpc(ctx, "grok-bot", "claude-code", "message/send", params)).json();
    expect(ctx.store.getTask(body.result.id)?.instructions).toBe("First\n\nSecond");
  });

  test("returns JSON-RPC errors for unsupported or bad requests", async () => {
    const ctx = makeApp();
    const noText = await (
      await rpc(ctx, "grok-bot", "claude-code", "message/send", {
        message: { kind: "message", role: "user", messageId: "m", parts: [{ kind: "data", data: {} }] },
      })
    ).json();
    expect(noText.error.code).toBe(-32602);

    const followUp = await (
      await rpc(ctx, "grok-bot", "claude-code", "message/send", {
        message: { ...message("x").message, taskId: "t-1" },
      })
    ).json();
    expect(followUp.error.code).toBe(-32004);

    expect((await (await rpc(ctx, "grok-bot", "claude-code", "tasks/get", { id: "nope" })).json()).error.code).toBe(
      -32001,
    );
    expect((await (await rpc(ctx, "grok-bot", "claude-code", "tasks/cancel", { id: "x" })).json()).error.code).toBe(
      -32004,
    );
    expect((await (await rpc(ctx, "grok-bot", "claude-code", "SendMessage", {})).json()).error.code).toBe(-32601);
  });

  test("a task can only be read through the endpoint of the agent it was sent to", async () => {
    const ctx = makeApp();
    const sent = await (await rpc(ctx, "grok-bot", "claude-code", "message/send", message("x"))).json();
    const wrongDoor = await (await rpc(ctx, "grok-bot", "muse", "tasks/get", { id: sent.result.id })).json();
    expect(wrongDoor.error.code).toBe(-32001);
  });

  test("reading a finished task through the wrong endpoint doesn't mark the sender's result seen", async () => {
    const ctx = makeApp();
    const sent = await (await rpc(ctx, "grok-bot", "claude-code", "message/send", message("x"))).json();
    ctx.service.checkInbox("claude-code");
    ctx.service.finishTask("claude-code", { taskId: sent.result.id, result: "ok" });
    const wrongDoor = await (await rpc(ctx, "grok-bot", "muse", "tasks/get", { id: sent.result.id })).json();
    expect(wrongDoor.error.code).toBe(-32001);
    expect(ctx.service.checkInbox("grok-bot").results.map((t) => t.id)).toEqual([sent.result.id]);
  });
});
