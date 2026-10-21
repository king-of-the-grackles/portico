import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { addSession, makeApp, TOKENS } from "./helpers";

// The official A2A 0.3.0 JSON schema (spec §16: "the A2A agent cards validate against the A2A schema").
const schema = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/a2a-v0.3.0.json"), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(schema, "a2a");

/** Returns the schema violations, or [] when the value matches the definition. */
function violations(definition: string, value: unknown): string[] {
  const validate = ajv.getSchema(`a2a#/definitions/${definition}`);
  if (!validate) throw new Error(`the schema has no definition ${definition}`);
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`);
}

const userMessage = (text: string) => ({
  message: { kind: "message", role: "user", messageId: crypto.randomUUID(), parts: [{ kind: "text", text }] },
});

describe("A2A 0.3.0 contract", () => {
  test("every agent card matches AgentCard", async () => {
    const { call, config } = makeApp();
    for (const agent of config.agents) {
      const res = await call(null, "GET", `/a2a/${agent.name}/.well-known/agent-card.json`);
      expect(res.status).toBe(200);
      expect(violations("AgentCard", await res.json())).toEqual([]);
    }
  });

  test("a session's card matches AgentCard", async () => {
    const ctx = makeApp();
    addSession(ctx, { name: "dialog-claude", machine: "macbook" });
    const res = await ctx.app.request("/a2a/dialog-claude@macbook/.well-known/agent-card.json", {
      headers: { authorization: `Bearer ${TOKENS["grok-bot"]}` },
    });
    expect(res.status).toBe(200);
    expect(violations("AgentCard", await res.json())).toEqual([]);
  });

  test("message/send and tasks/get answers match their success responses", async () => {
    const { call, service } = makeApp();
    const sent = await (
      await call("grok-bot", "POST", "/a2a/claude-code", {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: userMessage("Write the changelog"),
      })
    ).json();
    expect(violations("SendMessageSuccessResponse", sent)).toEqual([]);

    const taskId = sent.result.id as string;
    service.checkInbox("claude-code");
    service.finishTask("claude-code", { taskId, result: "Done" });
    const got = await (
      await call("grok-bot", "POST", "/a2a/claude-code", { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: taskId } })
    ).json();
    expect(violations("GetTaskSuccessResponse", got)).toEqual([]);
    expect(got.result.status.state).toBe("completed");
  });

  test("a denied task and an unsupported method match the schema too", async () => {
    const { call } = makeApp();
    const denied = await (
      await call("codex", "POST", "/a2a/claude-code", { jsonrpc: "2.0", id: 3, method: "message/send", params: userMessage("x") })
    ).json();
    expect(violations("SendMessageSuccessResponse", denied)).toEqual([]);
    expect(denied.result.status.state).toBe("rejected");

    const unsupported = await (
      await call("grok-bot", "POST", "/a2a/claude-code", { jsonrpc: "2.0", id: 4, method: "tasks/cancel", params: { id: "x" } })
    ).json();
    expect(violations("JSONRPCErrorResponse", unsupported)).toEqual([]);
  });
});
