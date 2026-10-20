import { describe, expect, test } from "bun:test";
import { verifyLink } from "../src/approvals/links";
import { permissionPush } from "../src/approvals/messages";
import { MAX_PENDING_PER_AGENT, PermissionRelay } from "../src/core/permissions";
import { HOUR, errorCode, flush, makeApp, sseReader, testClock, testConfig } from "./helpers";

function makeRelay() {
  const clock = testClock();
  const delivered: { agent: string; requestId: string; behavior: string }[] = [];
  let connected = true;
  const relay = new PermissionRelay({
    maxTextKb: 20,
    now: clock.now,
    deliver: (agent, requestId, behavior) => {
      if (!connected) return false;
      delivered.push({ agent, requestId, behavior });
      return true;
    },
  });
  return { relay, clock, delivered, setConnected: (value: boolean) => void (connected = value) };
}

const PROMPT = { requestId: "abcde", toolName: "Bash", description: "Run the tests", inputPreview: "bun test" };

describe("PermissionRelay", () => {
  test("stores a prompt once per agent and request ID", () => {
    const { relay } = makeRelay();
    const first = relay.add("claude-code", PROMPT);
    expect(first.created).toBe(true);
    expect(first.request).toMatchObject({
      agent: "claude-code",
      requestId: "abcde",
      toolName: "Bash",
      answer: null,
      delivered: false,
      createdAt: "2026-10-20T12:00:00.000Z",
      expiresAt: "2026-10-20T13:00:00.000Z",
    });
    expect(relay.add("claude-code", PROMPT).created).toBe(false);
    expect(relay.add("claude-code-dialog", PROMPT).created).toBe(true);
    expect(relay.pending()).toHaveLength(2);
  });

  test("validates the prompt", () => {
    const { relay } = makeRelay();
    expect(errorCode(() => relay.add("claude-code", { ...PROMPT, requestId: "has space" }))).toBe("bad_request");
    expect(errorCode(() => relay.add("claude-code", { ...PROMPT, requestId: 12 }))).toBe("bad_request");
    expect(errorCode(() => relay.add("claude-code", { ...PROMPT, toolName: "" }))).toBe("bad_request");
    expect(errorCode(() => relay.add("claude-code", { ...PROMPT, inputPreview: "x".repeat(20 * 1024 + 1) }))).toBe(
      "too_large",
    );
    expect(relay.add("claude-code", { requestId: "fghij", toolName: "Edit" }).request.description).toBe("");
  });

  test("an answer is delivered once, and a second answer is refused", () => {
    const { relay, delivered } = makeRelay();
    relay.add("claude-code", PROMPT);
    expect(relay.answer("claude-code", "abcde", "allow")).toMatchObject({
      answer: "allow",
      answeredAt: "2026-10-20T12:00:00.000Z",
      delivered: true,
    });
    expect(delivered).toEqual([{ agent: "claude-code", requestId: "abcde", behavior: "allow" }]);
    expect(errorCode(() => relay.answer("claude-code", "abcde", "deny"))).toBe("wrong_status");
    expect(relay.pending()).toEqual([]);
    expect(relay.get("claude-code", "abcde")?.answer).toBe("allow");
  });

  test("an answer given while disconnected is sent when the agent reconnects", () => {
    const { relay, delivered, setConnected } = makeRelay();
    relay.add("claude-code", PROMPT);
    setConnected(false);
    expect(relay.answer("claude-code", "abcde", "deny").delivered).toBe(false);
    setConnected(true);
    expect(relay.redeliver("claude-code")).toBe(1);
    expect(relay.redeliver("claude-code")).toBe(0);
    expect(delivered).toEqual([{ agent: "claude-code", requestId: "abcde", behavior: "deny" }]);
  });

  test("prompts are forgotten after an hour", () => {
    const { relay, clock } = makeRelay();
    relay.add("claude-code", PROMPT);
    clock.advance(HOUR);
    expect(relay.pending()).toEqual([]);
    expect(errorCode(() => relay.answer("claude-code", "abcde", "allow"))).toBe("not_found");
    expect(relay.get("claude-code", "abcde")).toBeNull();
  });

  test("caps unanswered prompts per agent", () => {
    const { relay } = makeRelay();
    for (let i = 0; i < MAX_PENDING_PER_AGENT; i++) relay.add("claude-code", { ...PROMPT, requestId: `r${i}` });
    expect(errorCode(() => relay.add("claude-code", { ...PROMPT, requestId: "one-more" }))).toBe("rate_limited");
    relay.answer("claude-code", "r0", "allow");
    expect(relay.add("claude-code", { ...PROMPT, requestId: "one-more" }).created).toBe(true);
  });
});

describe("permissionPush", () => {
  test("names the tool, previews the prompt, and carries signed Allow and Deny links for this agent", () => {
    const { relay } = makeRelay();
    const config = testConfig();
    const { request } = relay.add("claude-code", { ...PROMPT, inputPreview: "y".repeat(300) });
    const push = permissionPush(config, request);
    expect(push.title).toBe("claude-code wants to use Bash");
    expect(push.message).toBe(`Run the tests\n\n${"y".repeat(200)}…`);
    const [allow, deny, open] = push.actions;
    expect(allow).toMatchObject({ action: "http", label: "Allow", method: "POST", clear: true });
    expect(deny).toMatchObject({ action: "http", label: "Deny", method: "POST", clear: true });
    expect(open).toEqual({ action: "view", label: "Open", url: "https://bridge.test/hub" });
    const token = allow!.url.slice("https://bridge.test/approve/".length);
    expect(verifyLink(config.signingSecret, token, new Date("2026-10-20T12:30:00.000Z"))).toEqual({
      subject: "permission",
      id: "abcde",
      agent: "claude-code",
      action: "approve",
      expiresAt: request.expiresAt,
    });
  });

  test("falls back to the tool name when there's no description or preview", () => {
    const { relay } = makeRelay();
    const { request } = relay.add("claude-code", { requestId: "abcde", toolName: "Bash" });
    expect(permissionPush(testConfig(), request).message).toBe("Bash");
  });
});

describe("POST /api/permission-requests", () => {
  const body = { request_id: "abcde", tool_name: "Bash", description: "Run the tests", input_preview: "bun test" };

  test("needs a token and is only for push agents", async () => {
    const { call } = makeApp();
    expect((await call(null, "POST", "/api/permission-requests", body)).status).toBe(401);
    expect((await call("muse", "POST", "/api/permission-requests", body)).status).toBe(403);
  });

  test("stores the prompt, pushes it once, and answers a repeat with the same prompt", async () => {
    const { call, pushes } = makeApp();
    const res = await call("claude-code", "POST", "/api/permission-requests", body);
    expect(res.status).toBe(201);
    expect((await res.json()).request).toEqual({
      agent: "claude-code",
      request_id: "abcde",
      tool_name: "Bash",
      description: "Run the tests",
      input_preview: "bun test",
      created_at: "2026-10-20T12:00:00.000Z",
      expires_at: "2026-10-20T13:00:00.000Z",
      answer: null,
    });
    expect((await call("claude-code", "POST", "/api/permission-requests", body)).status).toBe(200);
    await flush();
    expect(pushes.map((push) => push.title)).toEqual(["claude-code wants to use Bash"]);
  });

  test("rejects a malformed prompt", async () => {
    const { call } = makeApp();
    expect((await call("claude-code", "POST", "/api/permission-requests", { tool_name: "Bash" })).status).toBe(400);
    expect(
      (await call("claude-code", "POST", "/api/permission-requests", { ...body, request_id: "no spaces" })).status,
    ).toBe(400);
  });

  test("answers reach the agent's stream, including one given while it was disconnected", async () => {
    const { call, relay } = makeApp();
    await call("claude-code", "POST", "/api/permission-requests", body);
    relay.answer("claude-code", "abcde", "allow"); // no stream open yet
    const events = sseReader(await call("claude-code", "GET", "/api/stream"));
    try {
      expect(await events.next()).toEqual({ event: "permission", data: { request_id: "abcde", behavior: "allow" } });
      await call("claude-code", "POST", "/api/permission-requests", { ...body, request_id: "fghij" });
      relay.answer("claude-code", "fghij", "deny");
      expect(await events.next()).toEqual({ event: "permission", data: { request_id: "fghij", behavior: "deny" } });
    } finally {
      await events.cancel();
    }
  });
});
