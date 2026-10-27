import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ApiError, type Inbox, type PorticoClient } from "./portico-client";

/** Portico's built-in limits, as its /mcp tools name them. */
const MAX_SUBJECT_CHARS = 120;
const MAX_MESSAGE_KB = 64;

// The same tools as Portico's /mcp (server/src/agent-api/mcp.ts). test/tools.test.ts fails if they drift apart.
const noArgs: Tool["inputSchema"] = { type: "object", properties: {}, additionalProperties: false };
const str = (description: string) => ({ type: "string", description });

export const TOOLS: Tool[] = [
  {
    name: "list_agents",
    description:
      "List the other agents on Portico, live: the name to address each agent by, kind, the person who manages the agent, computer and " +
      "repo@branch, status (busy, idle, waiting or offline), current work, and whether approval is required.",
    inputSchema: noArgs,
  },
  {
    name: "send_message",
    description:
      "Send a message to another agent. Every agent can message every other. A message that starts a new conversation with " +
      "an agent that requires approval may be held until a person allows the message; replies (reply_to) in a conversation " +
      "that agent wrote in during the last 24 hours aren't held. check_inbox reports the outcome. Returns the message and how the " +
      "message will arrive: pushed (a live session), queued (until the agent checks the inbox), offline (held until the session " +
      "returns) or held (waiting for approval).",
    inputSchema: {
      type: "object",
      properties: {
        to: str("Who to send to: a name from list_agents. Optional with reply_to, which answers the other side of that message."),
        subject: str(
          `Required. One line, at most ${MAX_SUBJECT_CHARS} characters, saying what this message asks for or tells. ` +
            "A person reads the subject first when approving.",
        ),
        text: str(`The message, in plain text. Up to ${MAX_MESSAGE_KB} KB.`),
        reply_to: str("Optional. The ID of the message this answers."),
      },
      required: ["subject", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "check_inbox",
    description: "Pick up new messages for this agent, and the outcome of sent messages that were held for approval.",
    inputSchema: noArgs,
  },
];

type Args = Record<string, unknown>;

const optional = (args: Args, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failure = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

/** The human-readable part of a check_inbox result, as Portico's /mcp writes it. */
export function inboxText(inbox: Inbox): string {
  const lines: string[] = [inbox.messages.length ? `Messages (${inbox.messages.length}):` : "No new messages."];
  for (const message of inbox.messages) lines.push("---", message.framed_message);
  if (inbox.updates.length) {
    lines.push("", `Held messages with an outcome (${inbox.updates.length}):`);
    for (const update of inbox.updates) lines.push(update.framed_message);
  }
  return lines.join("\n");
}

/** Runs one of the three tools against Portico. Portico's errors become tool errors, as on its /mcp. */
export async function runTool(client: PorticoClient, name: string, args: Args): Promise<CallToolResult> {
  try {
    switch (name) {
      case "list_agents":
        return json(await client.listAgents());
      case "send_message": {
        const to = optional(args, "to");
        const replyTo = optional(args, "reply_to");
        // Missing fields go as empty strings, so Portico answers with its own plain error.
        const { message, delivery, note } = await client.sendMessage({
          subject: optional(args, "subject") ?? "",
          text: optional(args, "text") ?? "",
          ...(to !== undefined ? { to } : {}),
          ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
        });
        const result = json({ message, delivery });
        // A held message's note, as its own line, as on Portico's /mcp.
        if (note) result.content.push({ type: "text", text: note });
        return result;
      }
      case "check_inbox": {
        const inbox = await client.checkInbox();
        return {
          content: [
            { type: "text", text: inboxText(inbox) },
            { type: "text", text: JSON.stringify(inbox, null, 2) },
          ],
        };
      }
      default:
        return failure(`bad_request: Unknown tool ${name}.`);
    }
  } catch (err) {
    if (err instanceof ApiError) return failure(`${err.code}: ${err.message}`);
    throw err;
  }
}
