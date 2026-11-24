import { afterEach, describe, expect, test } from "bun:test";
import { appTools, mcpTools } from "../src/agent-api/mcp";
import { openApiDocument } from "../src/agent-api/openapi";
import { porticoTools } from "../src/agent-api/portico-tools";
import { charCount, trimToLimit } from "../src/core/lengths";
import { LIMITS } from "../src/core/limits";
import { captureLogs } from "../src/log";
import { addAppAgent, addOwner, callAs, makePortico, PUBLIC_URL } from "./helpers";

afterEach(() => captureLogs(null));

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  const muse = addAppAgent(p, chris, "muse");
  return { p, chris, grok, muse };
}

const rpc = (name: string, args: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
type McpAnswer = { result: { isError: boolean; content: { text: string }[] } };
type Sent = { message: { id: string; subject: string; summary?: string | null }; note?: string };

/** Twelve-character words: 163 characters in all, with a word boundary at 116 and the next at 129. */
const LONG = Array.from({ length: 13 }, (_, i) => `word${String(i).padStart(2, "0")}abcdef`).join(" ").slice(0, 163);

describe("trimToLimit", () => {
  test("a text at or under the limit comes back as given", () => {
    expect(trimToLimit("Find a time with Sam", 120)).toEqual({ text: "Find a time with Sam", originalLength: null });
    const exact = "x".repeat(120);
    expect(trimToLimit(exact, 120)).toEqual({ text: exact, originalLength: null });
  });

  test("a longer text is cut after the last whole word that fits, ellipsis included", () => {
    expect(charCount(LONG)).toBe(163);
    const trimmed = trimToLimit(LONG, 120);
    expect(trimmed.originalLength).toBe(163);
    expect(trimmed.text).toBe(`${LONG.slice(0, 116)}…`);
    expect(trimmed.text.endsWith("abcdef…")).toBe(true);
    expect(charCount(trimmed.text)).toBeLessThanOrEqual(120);
  });

  test("a word that ends exactly where the room ends is kept whole", () => {
    const text = `${"a".repeat(59)} ${"b".repeat(59)} more words follow here`;
    expect(trimToLimit(text, 120).text).toBe(`${"a".repeat(59)} ${"b".repeat(59)}…`);
  });

  test("with no word boundary in range, the cut is hard", () => {
    expect(trimToLimit("x".repeat(200), 120)).toEqual({ text: `${"x".repeat(119)}…`, originalLength: 200 });
    // A boundary in the first half of the room would throw away most of the text: the cut is hard there too.
    const early = `Re ${"y".repeat(200)}`;
    expect(trimToLimit(early, 120).text).toBe(`Re ${"y".repeat(116)}…`);
  });

  test("characters are counted as code points, and none is split", () => {
    const accented = "é".repeat(121);
    expect(trimToLimit(accented, 120)).toEqual({ text: `${"é".repeat(119)}…`, originalLength: 121 });
    // 120 emoji are 240 UTF-16 units, and still fit.
    expect(trimToLimit("😀".repeat(120), 120).originalLength).toBeNull();
    const emoji = trimToLimit("😀".repeat(130), 120);
    expect(emoji).toEqual({ text: `${"😀".repeat(119)}…`, originalLength: 130 });
    // A family emoji is 7 code points that read as one character: the cut never falls inside one.
    const family = "👨‍👩‍👧‍👦";
    const families = trimToLimit(family.repeat(20), 120);
    expect(families.text).toBe(`${family.repeat(17)}…`);
    expect(charCount(families.text)).toBe(120);
  });
});

describe("a subject or summary over the limit is trimmed and saved", () => {
  test("POST /api/agent/messages saves the trimmed subject and says so in note, with the length as sent", async () => {
    const { p, grok } = await setup();
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    const res = await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "muse", subject: LONG, text: "t" });
    expect(res.status).toBe(201);
    const sent = (await res.json()) as Sent;
    expect(sent.message.subject).toBe(`${LONG.slice(0, 116)}…`);
    expect(sent.note).toBe("The subject was 163 characters and the limit is 120, so Portico saved the subject trimmed to 117 characters.");
    expect(p.messages.get({ agent: grok.agent.id }, sent.message.id)!.subject).toBe(sent.message.subject);
    const hits = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === "limit_hit");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ level: "info", field: "subject", limit: 120, length: 163, action: "trimmed" });
    expect(lines.join("\n")).not.toContain("word00");
  });

  test("a subject of exactly 120 characters is saved as given, with no note", async () => {
    const { p, grok } = await setup();
    const exact = "x".repeat(120);
    const sent = (await (await callAs(p, { token: grok.token }, "POST", "/api/agent/messages", { to: "muse", subject: exact, text: "t" })).json()) as Sent;
    expect(sent.message.subject).toBe(exact);
    expect(sent.note).toBeUndefined();
  });

  test("send_message over MCP trims too, and the note is the answer's second line", async () => {
    const { p, grok } = await setup();
    const res = await callAs(p, { token: grok.token }, "POST", "/mcp", rpc("send_message", { to: "muse", subject: LONG, text: "t", summary: "s".repeat(130) }));
    const body = (await res.json()) as McpAnswer;
    expect(body.result.isError).toBe(false);
    const sent = JSON.parse(body.result.content[0]!.text) as Sent;
    expect(sent.message.subject).toBe(`${LONG.slice(0, 116)}…`);
    expect(body.result.content[1]!.text).toBe(
      "The subject was 163 characters and the limit is 120, so Portico saved the subject trimmed to 117 characters. " +
        "The summary was 130 characters and the limit is 120, so Portico saved the summary trimmed to 120 characters.",
    );
  });

  test("a reply is trimmed the same way, summary included", async () => {
    const { p, grok, muse } = await setup();
    const ask = p.messages.send(grok.agent, { to: "muse", subject: "Q", text: "?" }).message;
    const reply = p.messages.send(muse.agent, { replyTo: ask.id, subject: LONG, text: "!", summary: `${LONG} and more` });
    expect(reply.message.replyTo).toBe(ask.id);
    expect(charCount(reply.message.subject)).toBe(117);
    expect(reply.message.summary).toBe(`${LONG.slice(0, 116)}…`);
    expect(reply.note).toContain("The subject was 163 characters");
    expect(reply.note).toContain("The summary was 172 characters");
  });

  test("a retry with the same key and the same long subject returns the first message, and still says trimmed", async () => {
    const { p, grok } = await setup();
    const first = p.messages.send(grok.agent, { to: "muse", subject: LONG, text: "t", key: "job-42-ask" });
    const again = p.messages.send(grok.agent, { to: "muse", subject: LONG, text: "t", key: "job-42-ask" });
    expect(again.message.id).toBe(first.message.id);
    expect(again.note).toStartWith("The subject was 163 characters");
    expect(again.note).toContain("Already sent with this key");
  });
});

describe("a field that isn't trimmed is refused with the field, the length and the limit", () => {
  test("description and doing, over REST and MCP", async () => {
    const { p, grok } = await setup();
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    const rest = await callAs(p, { token: grok.token }, "PATCH", "/api/agent/profile", { description: "d".repeat(612) });
    expect(rest.status).toBe(400);
    expect(await rest.json()).toEqual({ error: "bad_request", message: "description is 612 characters; the limit is 500." });
    const doing = await callAs(p, { token: grok.token }, "PATCH", "/api/agent/profile", { doing: "é".repeat(121) });
    expect(((await doing.json()) as { message: string }).message).toBe("doing is 121 characters; the limit is 120.");
    const mcp = (await (await callAs(p, { token: grok.token }, "POST", "/mcp", rpc("update_profile", { description: "d".repeat(501) }))).json()) as McpAnswer;
    expect(mcp.result.isError).toBe(true);
    expect(mcp.result.content[0]!.text).toBe("bad_request: description is 501 characters; the limit is 500.");
    expect((await callAs(p, { token: grok.token }, "PATCH", "/api/agent/profile", { description: "😀".repeat(500), doing: "é".repeat(120) })).status).toBe(200);
    const hits = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === "limit_hit");
    expect(hits.map((hit) => [hit.field, hit.limit, hit.length, hit.action])).toEqual([
      ["description", 500, 612, "refused"],
      ["doing", 120, 121, "refused"],
      ["description", 500, 501, "refused"],
    ]);
  });

  test("a message key, a feedback title, a file's name and a Portico's name", async () => {
    const { p, grok } = await setup();
    const message = async (res: Promise<Response>) => ((await (await res).json()) as { message: string }).message;
    const as = { token: grok.token };
    expect(await message(callAs(p, as, "POST", "/api/agent/messages", { to: "muse", subject: "s", text: "t", key: "k".repeat(201) }))).toBe(
      "key is 201 characters; the limit is 200.",
    );
    expect(await message(callAs(p, as, "POST", "/api/agent/feedback", { kind: "bug", title: "t".repeat(121), details: "d" }))).toBe(
      "title is 121 characters; the limit is 120.",
    );
    expect(await message(callAs(p, as, "POST", "/api/agent/files", { name: `${"n".repeat(200)}.txt`, text: "x" }))).toBe("name is 204 characters; the limit is 200.");
    expect(await message(callAs(p, as, "POST", "/api/agent/portico-tools/create_portico", { name: "n".repeat(61) }))).toBe("name is 61 characters; the limit is 60.");
  });
});

describe("every limit is shown before the call", () => {
  type Property = { type?: string; description?: string; maxLength?: number };
  const properties = (tools: { name: string; inputSchema: unknown }[], name: string) =>
    (tools.find((tool) => tool.name === name)!.inputSchema as { properties: Record<string, Property> }).properties;

  /** Each limited argument: the tool, the argument and the limit. */
  const LIMITED: [string, string, number][] = [
    ["send_message", "subject", LIMITS.maxSubjectChars],
    ["send_message", "summary", LIMITS.maxSubjectChars],
    ["send_message", "key", LIMITS.maxSendKeyChars],
    ["create_upload", "name", LIMITS.maxFileNameChars],
    ["update_profile", "description", LIMITS.maxDescriptionChars],
    ["update_profile", "doing", LIMITS.maxDoingChars],
    ["submit_feedback", "title", LIMITS.maxFeedbackTitleChars],
    ["create_portico", "name", LIMITS.maxWorkspaceNameChars],
    ["rename_portico", "name", LIMITS.maxWorkspaceNameChars],
  ];

  test("the MCP tools carry maxLength and name the limit in the description", () => {
    const tools = [...mcpTools(), ...porticoTools()];
    for (const [tool, argument, limit] of LIMITED) {
      const property = properties(tools, tool)[argument]!;
      expect([tool, argument, property.maxLength]).toEqual([tool, argument, limit]);
      expect(property.description!.toLowerCase()).toContain(`at most ${limit} characters`);
    }
    for (const argument of ["subject", "summary"]) expect(properties(tools, "send_message")[argument]!.description).toContain("Portico trims a longer one to fit");
    for (const argument of ["description", "doing"]) expect(properties(tools, "update_profile")[argument]!.description).toContain("A longer one is refused.");
  });

  test("the HTTP API's schema carries the same limits", () => {
    const paths = openApiDocument(PUBLIC_URL).paths as Record<string, Record<string, { requestBody: { content: { "application/json": { schema: { properties: Record<string, Property> } } } } }>>;
    const body = (path: string, method: string) => paths[path]![method]!.requestBody.content["application/json"].schema.properties;
    const send = body("/api/agent/messages", "post");
    expect([send.subject!.maxLength, send.summary!.maxLength, send.key!.maxLength]).toEqual([120, 120, 200]);
    expect(send.subject!.description).toContain("at most 120 characters");
    expect(send.subject!.description).toContain("trims a longer one");
    expect(send.summary!.description).toContain("trims a longer one");
    const profile = body("/api/agent/profile", "patch");
    expect([profile.description!.maxLength, profile.doing!.maxLength]).toEqual([500, 120]);
    expect(profile.description!.description).toContain("at most 500 characters");
    expect(body("/api/agent/files", "post").name!.maxLength).toBe(200);
    expect(body("/api/agent/feedback", "post").title!.maxLength).toBe(120);
    expect(body("/api/agent/portico-tools/create_portico", "post").name!.maxLength).toBe(60);
  });

  test("the instructions and the join page say what happens to a long subject and a long description", async () => {
    const { p, grok } = await setup();
    const init = (await (
      await callAs(p, { token: grok.token }, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    ).json()) as { result: { instructions: string } };
    expect(init.result.instructions).toContain("A subject or summary is one line of at most 120 characters: Portico trims a longer one to fit");
    expect(init.result.instructions).toContain("in at most 500 characters");
    expect(appTools().length).toBeGreaterThan(mcpTools().length);
    const page = await (await p.app.request("/join")).text();
    expect(page).toContain("one line of at most 120 characters");
    expect(page).toContain("at most 500 characters");
  });
});
