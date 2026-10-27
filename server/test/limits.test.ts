import { describe, expect, test } from "bun:test";
import { BASE_YAML, makeApp, testConfig } from "./helpers";

// Three times the larger text limit (64 KB for messages) is 192 KB.
const BIG = "x".repeat(193 * 1024);
const UNKNOWN = "zzz-unknown-method-xyz";

describe("body limits on /mcp and /a2a", () => {
  test("an oversized /mcp body gets 413 too_large", async () => {
    const ctx = makeApp();
    const res = await ctx.call("grok-bot", "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "ping", params: { pad: BIG } });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("too_large");
  });

  test("an oversized /a2a body gets 413 too_large", async () => {
    const ctx = makeApp();
    const res = await ctx.call("grok-bot", "POST", "/a2a/claude-code", {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { pad: BIG },
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("too_large");
  });
});

describe("the body limit", () => {
  const ping = (pad: string) => ({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad } });

  test("is three times the larger of max_text_kb and max_message_kb", async () => {
    const ctx = makeApp();
    expect((await ctx.call("grok-bot", "POST", "/mcp", ping("x".repeat(150 * 1024)))).status).toBe(200);
    const small = makeApp(testConfig(BASE_YAML.replace("triggers:", "limits:\n  max_message_kb: 8\ntriggers:")));
    // max_text_kb (20) is now the larger: 60 KB.
    expect((await small.call("grok-bot", "POST", "/mcp", ping("x".repeat(59 * 1024)))).status).toBe(200);
    const res = await small.call("grok-bot", "POST", "/mcp", ping("x".repeat(61 * 1024)));
    expect(res.status).toBe(413);
    expect((await res.json()).message).toBe("Request body is larger than 60 KB.");
  });
});

describe("caller strings are not echoed", () => {
  test("an unknown /mcp method returns -32601 without the method name", async () => {
    const ctx = makeApp();
    const res = await ctx.call("grok-bot", "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: UNKNOWN });
    const raw = await res.text();
    expect(JSON.parse(raw).error.code).toBe(-32601);
    expect(raw).not.toContain(UNKNOWN);
  });

  test("an unknown /mcp tool returns an error without the tool name", async () => {
    const ctx = makeApp();
    const res = await ctx.call("grok-bot", "POST", "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: UNKNOWN, arguments: {} },
    });
    const raw = await res.text();
    expect(JSON.parse(raw).error.message).toBe("Unknown tool.");
    expect(raw).not.toContain(UNKNOWN);
  });

  test("an unknown /a2a method returns -32601 without the method name", async () => {
    const ctx = makeApp();
    const res = await ctx.call("grok-bot", "POST", "/a2a/claude-code", { jsonrpc: "2.0", id: 1, method: UNKNOWN });
    const raw = await res.text();
    expect(JSON.parse(raw).error.code).toBe(-32601);
    expect(raw).not.toContain(UNKNOWN);
  });
});
