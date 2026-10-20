import { describe, expect, test } from "bun:test";
import { BASE_YAML, makeApp, testConfig } from "./helpers";

describe("web API", () => {
  test("rejects requests without a valid token", async () => {
    const { app, call } = makeApp();
    const res = await call(null, "GET", "/api/agents");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toEqual({ error: "unauthorized", message: "Missing or invalid bearer token." });
    const wrong = await app.request("/api/agents", { headers: { authorization: "Bearer not-a-real-token-123456789" } });
    expect(wrong.status).toBe(401);
  });

  test("lists the other agents", async () => {
    const { call } = makeApp();
    const body = await (await call("muse", "GET", "/api/agents")).json();
    expect(body.agents.map((a: { name: string }) => a.name)).toEqual(["grok-bot", "claude-code", "codex"]);
    expect(body.agents[0]).toEqual({ name: "grok-bot", description: "Grok Bot", delivery: "pull" });
  });

  test("hands a task from sender to receiver and the result back", async () => {
    const { call } = makeApp();
    const sent = await call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "Add rate limiting" });
    expect(sent.status).toBe(201);
    const { task } = await sent.json();
    expect(task).toMatchObject({ from_agent: "grok-bot", to_agent: "claude-code", status: "queued", chain_length: 1 });
    expect(task.sender_notified_at).toBeUndefined();

    const inbox = await (await call("claude-code", "GET", "/api/inbox")).json();
    expect(inbox.tasks).toHaveLength(1);
    expect(inbox.tasks[0].status).toBe("working");
    expect(inbox.tasks[0].framed_message).toStartWith(`**Task \`${task.id}\` from agent \`grok-bot\` via the bridge.**`);
    expect(inbox.tasks[0].framed_message).toEndWith("Add rate limiting");

    const finished = await call("claude-code", "POST", `/api/tasks/${task.id}/finish`, { result: "Done." });
    expect(finished.status).toBe(200);
    expect((await finished.json()).task).toMatchObject({ status: "done", result: "Done." });

    const back = await (await call("grok-bot", "GET", "/api/inbox")).json();
    expect(back.results.map((t: { id: string; result: string }) => [t.id, t.result])).toEqual([[task.id, "Done."]]);
  });

  test("ignores a from_agent in the body: the sender always comes from the token", async () => {
    const { call } = makeApp();
    const res = await call("grok-bot", "POST", "/api/tasks", {
      from_agent: "muse",
      to: "claude-code",
      instructions: "x",
    });
    expect((await res.json()).task.from_agent).toBe("grok-bot");
  });

  test("maps service errors to status codes", async () => {
    const { call } = makeApp();
    const unknown = await call("grok-bot", "POST", "/api/tasks", { to: "nobody", instructions: "x" });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("unknown_agent");

    expect((await call("grok-bot", "GET", "/api/tasks/nope")).status).toBe(404);

    const { task } = await (await call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "x" })).json();
    expect((await call("muse", "GET", `/api/tasks/${task.id}`)).status).toBe(403);
    const early = await call("claude-code", "POST", `/api/tasks/${task.id}/finish`, { result: "x" });
    expect(early.status).toBe(409);
    expect((await early.json()).error).toBe("wrong_status");
  });

  test("reports events and returns the tasks they create", async () => {
    const { call } = makeApp();
    const res = await call("muse", "POST", "/api/events", { name: "bug_report_received", details: "Login 500s" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.event).toMatchObject({ agent: "muse", name: "bug_report_received", details: "Login 500s" });
    expect(body.tasks.map((t: { to_agent: string; status: string }) => [t.to_agent, t.status])).toEqual([
      ["claude-code", "queued"],
      ["grok-bot", "denied"],
    ]);
  });

  test("rejects bad JSON and missing fields", async () => {
    const { call } = makeApp();
    const notJson = await call("grok-bot", "POST", "/api/tasks", "not json");
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).error).toBe("bad_request");
    const missing = await call("grok-bot", "POST", "/api/tasks", { to: "claude-code" });
    expect(missing.status).toBe(400);
    expect((await missing.json()).message).toContain("instructions");
  });

  test("rejects oversized requests", async () => {
    const { call } = makeApp();
    const tooBigBody = await call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "x".repeat(61 * 1024) });
    expect(tooBigBody.status).toBe(413);
    const tooBigText = await call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "x".repeat(21 * 1024) });
    expect(tooBigText.status).toBe(413);
    expect((await tooBigText.json()).error).toBe("too_large");
  });

  test("rate-limits senders with 429", async () => {
    const { call } = makeApp(testConfig(`${BASE_YAML}\nlimits:\n  tasks_per_hour_per_agent: 1\n`));
    expect((await call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "a" })).status).toBe(201);
    const second = await call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "b" });
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe("rate_limited");
  });

  test("unknown endpoints return a JSON 404, and /healthz needs no token", async () => {
    const { app, call } = makeApp();
    const missing = await call("grok-bot", "GET", "/nowhere");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("not_found");
    expect((await app.request("/healthz")).status).toBe(200);
  });

  test("an idempotency key makes a retried send harmless", async () => {
    const { call } = makeApp();
    const body = { to: "claude-code", instructions: "Add rate limiting", idempotency_key: "retry-1" };
    const first = await (await call("grok-bot", "POST", "/api/tasks", body)).json();
    const second = await call("grok-bot", "POST", "/api/tasks", body);
    expect(second.status).toBe(201);
    expect((await second.json()).task.id).toBe(first.task.id);
    const inbox = await (await call("claude-code", "GET", "/api/inbox")).json();
    expect(inbox.tasks).toHaveLength(1);
  });
});
