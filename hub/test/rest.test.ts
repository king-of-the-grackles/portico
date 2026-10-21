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

  test("lists the other agents as live directory entries, keeping name, description and delivery", async () => {
    const { call } = makeApp();
    const body = await (await call("muse", "GET", "/api/agents")).json();
    // Pull members first, then claude-code, a push agent with no open stream: offline.
    expect(body.agents.map((a: { name: string }) => a.name)).toEqual(["codex", "grok-bot", "claude-code"]);
    expect(body.agents[1]).toEqual({
      name: "grok-bot",
      address: "grok-bot",
      kind: "grok-bot",
      description: "Grok Bot",
      delivery: "pull",
      machine: null,
      repo: null,
      branch: null,
      status: null,
      doing: null,
      last_seen: null,
    });
    expect(body.agents[2]).toMatchObject({ name: "claude-code", description: "Claude Code", delivery: "push", status: "offline" });
  });

  test("sends a message: 201 with the message and its delivery tier", async () => {
    const { call } = makeApp();
    const res = await call("grok-bot", "POST", "/api/messages", { to: "muse", text: "Lunch at noon?" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      message: {
        id: expect.any(String),
        from_agent: "grok-bot",
        to_agent: "muse",
        text: "Lunch at noon?",
        reply_to: null,
        created_at: "2026-10-20T12:00:00.000Z",
        expires_at: "2026-10-21T12:00:00.000Z",
        delivered_at: null,
      },
      delivery: "queued",
    });
    const reply = await call("muse", "POST", "/api/messages", { reply_to: body.message.id, text: "Yes." });
    expect((await reply.json()).message).toMatchObject({ to_agent: "grok-bot", reply_to: body.message.id });
    const bad = await call("muse", "POST", "/api/messages", { to: "*", text: "all of you" });
    expect(bad.status).toBe(400);
  });

  test("a sent task says how it will arrive: offline for a push agent with no stream, null when not queued", async () => {
    const { call } = makeApp();
    const offline = await (await call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "x" })).json();
    expect(offline).toMatchObject({ task: { status: "queued" }, delivery: "offline" });
    const asks = await (await call("grok-bot", "POST", "/api/tasks", { to: "muse", instructions: "y" })).json();
    expect(asks).toMatchObject({ task: { status: "waiting_approval" }, delivery: null });
  });

  test("the inbox carries messages in their frames", async () => {
    const { call, service } = makeApp();
    const { message } = service.sendMessage("grok-bot", { to: "muse", text: "Lunch at noon?" });
    const inbox = await (await call("muse", "GET", "/api/inbox")).json();
    expect(inbox.messages.map((m: { id: string }) => m.id)).toEqual([message.id]);
    expect(inbox.messages[0].framed_message).toStartWith(`<bridge-message id="${message.id}" from="grok-bot">`);
    expect(inbox.messages[0].delivered_at).toBe("2026-10-20T12:00:00.000Z");
    expect((await (await call("muse", "GET", "/api/inbox")).json()).messages).toEqual([]);
  });

  test("deliveries carry messages, and an ack with messages marks them delivered", async () => {
    const { call, service, store } = makeApp();
    const { message } = service.sendMessage("muse", { to: "claude-code", text: "Heads up" });
    const d = await (await call("claude-code", "GET", "/api/deliveries")).json();
    expect(d.messages.map((m: { id: string }) => m.id)).toEqual([message.id]);
    expect(d.messages[0].framed_message).toStartWith(`<bridge-message id="${message.id}" from="muse">`);
    const ack = await call("claude-code", "POST", "/api/deliveries/ack", { messages: [message.id] });
    expect((await ack.json()).acked).toEqual({ tasks: 0, results: 0, messages: 1 });
    expect(store.getMessage(message.id)?.deliveredAt).toBe("2026-10-20T12:00:00.000Z");
    expect((await (await call("claude-code", "GET", "/api/deliveries")).json()).messages).toEqual([]);
  });

  test("the body limit fits a 64 KB message: 60 KB posts fine, a 300 KB body is 413", async () => {
    const { call } = makeApp();
    const fits = await call("grok-bot", "POST", "/api/messages", { to: "muse", text: "x".repeat(60 * 1024) });
    expect(fits.status).toBe(201);
    const tooBig = await call("grok-bot", "POST", "/api/messages", { to: "muse", text: "x".repeat(300 * 1024) });
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toBe("too_large");
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
    expect(inbox.tasks[0].framed_message).toStartWith(`<bridge-task id="${task.id}" from="grok-bot">`);
    expect(inbox.tasks[0].framed_message).toContain(`**Task \`${task.id}\` from agent \`grok-bot\` via the bridge.**`);
    expect(inbox.tasks[0].framed_message).toEndWith("Add rate limiting\n</bridge-task>");

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
    // Over three times the larger text limit (64 KB for messages), so the body limit refuses it before parsing.
    const tooBigBody = await call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "x".repeat(193 * 1024) });
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
