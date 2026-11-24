import { expect, test } from "bun:test";
import { mcpTools } from "../../server/src/agent-api/mcp";
import { addAppAgent, addComputer, addOwner, addSession, makePortico, wordProblems } from "../../server/test/helpers";
import { INSTRUCTIONS } from "../src/instructions";
import { PorticoClient } from "../src/portico-client";
import { runTool, TOOLS, WAIT_HINT, WAKE_HINT } from "../src/tools";

/** A client whose requests go straight into a test Portico server. */
function clientFor(p: ReturnType<typeof makePortico>, token: string, sessionKey: string): PorticoClient {
  const local = (async (input: RequestInfo | URL, init?: RequestInit) => p.app.request(String(input).replace("http://portico.test", ""), init)) as typeof fetch;
  return new PorticoClient({ url: "http://portico.test", token, sessionKey, fetch: local });
}
const texts = (result: Awaited<ReturnType<typeof runTool>>) => result.content.map((c) => (c as { text: string }).text);

async function setup() {
  const p = makePortico();
  const owner = await addOwner(p);
  const { computer, token } = addComputer(p, owner);
  const session = addSession(p, computer);
  const builder = addAppAgent(p, owner, "builder");
  return { p, session, builder, client: clientFor(p, token, session.key) };
}

test("the plugin's send_message offers no_reply_needed in Portico's own words", () => {
  const schema = (tools: { name: string; inputSchema: unknown }[]) =>
    (tools.find((tool) => tool.name === "send_message")!.inputSchema as { properties: Record<string, unknown> }).properties.no_reply_needed;
  expect(schema(TOOLS)).toEqual({
    type: "boolean",
    description:
      "Optional. true says this message needs no reply: Portico tells the receiver not to reply only to acknowledge, confirm or thank. " +
      "On a message that starts a conversation, the task is done once the receiver picks the message up. Not with done: false.",
  });
  expect(schema(TOOLS)).toEqual(schema(mcpTools()));
  expect(TOOLS.find((tool) => tool.name === "list_tasks")!.description).toContain("done (a final answer, or a message that needed no reply and was picked up) or failed");
});

test("the plugin's instructions say one sentence about the flag", () => {
  expect(INSTRUCTIONS).toContain(
    "A message that needs no answer, such as a note, can set no_reply_needed: true: Portico tells the receiver not to reply only to acknowledge, and the task is done once the receiver picks the message up.",
  );
  expect(INSTRUCTIONS.match(/no_reply_needed/g)).toHaveLength(1);
  expect(wordProblems(INSTRUCTIONS)).toEqual([]);
});

test("a send that needs no reply goes to Portico with the flag, and ends with Portico's note in place of how the reply will come", async () => {
  const { p, session, builder, client } = await setup();
  const NOTE = "No reply is expected. The task shows as done once `builder` picks the message up.";
  for (const replyHint of [WAIT_HINT, WAKE_HINT]) {
    const plain = texts(await runTool(client, "send_message", { to: "builder", subject: "Which port?", text: "?" }, undefined, { replyHint }));
    expect(plain.at(-1)).toBe(replyHint);
    expect(JSON.parse(plain[0]!).message.no_reply_needed).toBe(false);
    const flagged = texts(await runTool(client, "send_message", { to: "builder", subject: "Port moved", text: "3001 now.", no_reply_needed: true }, undefined, { replyHint }));
    expect(flagged.slice(1)).toEqual([NOTE]);
    expect(JSON.parse(flagged[0]!)).toMatchObject({ message: { no_reply_needed: true, subject: "Port moved" }, delivery: "queued" });
  }
  // A Claude Code session, which has no hint to give, hears the note too.
  expect(texts(await runTool(client, "send_message", { to: "builder", subject: "CI is green", text: "On main.", no_reply_needed: true })).slice(1)).toEqual([NOTE]);
  // false and null are today's send.
  expect(texts(await runTool(client, "send_message", { to: "builder", subject: "s", text: "t", no_reply_needed: false }, undefined, { replyHint: WAIT_HINT })).at(-1)).toBe(WAIT_HINT);
  expect(texts(await runTool(client, "send_message", { to: "builder", subject: "s", text: "t", no_reply_needed: null }, undefined, { replyHint: WAIT_HINT })).at(-1)).toBe(WAIT_HINT);

  // The receiver's frame and both task lists carry the flag through the plugin unchanged.
  const inbox = p.messages.inbox(builder.agent).messages;
  expect(inbox.filter((m) => m.noReplyNeeded).map((m) => m.subject)).toEqual(["Port moved", "Port moved", "CI is green"]);
  const tasks = JSON.parse(texts(await runTool(client, "list_tasks", { outcome: "done" }))[0]!) as { tasks: { subject: string; outcome: string; no_reply_needed: boolean; answer: unknown }[] };
  expect(tasks.tasks.map((t) => [t.subject, t.outcome, t.no_reply_needed, t.answer])).toEqual([
    ["CI is green", "done", true, null],
    ["Port moved", "done", true, null],
    ["Port moved", "done", true, null],
  ]);

  // Portico checks the values: a wrong one, or the flag with done: false, comes back as Portico's own refusal.
  const ask = p.messages.send(builder.agent, { to: session.agent.name, subject: "Status?", text: "?" }).message;
  p.messages.ack(session.agent, { messages: [ask.id], updates: [] });
  const both = await runTool(client, "send_message", { reply_to: ask.id, subject: "On it", text: "…", done: false, no_reply_needed: true });
  expect(both.isError).toBe(true);
  expect(texts(both)[0]).toBe("bad_request: no_reply_needed can't go with done: false, which says more is coming. Leave one of the two out.");
  expect((await runTool(client, "send_message", { to: "builder", subject: "s", text: "t", no_reply_needed: "yes" })).isError).toBe(true);
  const detail = JSON.parse(texts(await runTool(client, "get_task", { task: ask.id }))[0]!) as { task: { no_reply_needed: boolean }; messages: { no_reply_needed: boolean; framed_message: string }[] };
  expect(detail.task.no_reply_needed).toBe(false);
  expect(detail.messages.map((m) => m.no_reply_needed)).toEqual([false]);
});
