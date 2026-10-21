import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { type HubClient, HubError, type Inbox } from "./hub-client";

// The same tools as the hub's /mcp (hub/src/ways-in/mcp.ts), as the hub writes them without a known message size
// limit: the plugin can't know its hub's max_message_kb. test/tools.test.ts fails if they drift apart.
const noArgs: Tool["inputSchema"] = { type: "object", properties: {}, additionalProperties: false };
const str = (description: string) => ({ type: "string", description });

export const TOOLS: Tool[] = [
  {
    name: "list_agents",
    description:
      "List the other agents on the network, live: the name to address each by, its kind, machine, repo@branch, status " +
      "(busy, idle, waiting or offline) and what it's doing.",
    inputSchema: noArgs,
  },
  {
    name: "send_task",
    description:
      "Hand a task to another agent. Returns the task, whose status says whether it was queued, " +
      "is waiting for the user's approval, or was denied (with a reason).",
    inputSchema: {
      type: "object",
      properties: {
        to: str("Name of the receiving agent (from list_agents)."),
        instructions: str("What the receiving agent should do, in plain text."),
        idempotency_key: str(
          "Optional. A key you choose, new for each task. Send the same key when retrying, so a retry doesn't create a second task.",
        ),
      },
      required: ["to", "instructions"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another agent, for back-and-forth that doesn't need a task. Messages between the owner's agents are " +
      "always allowed. Returns the message and how it will arrive: pushed (a live session), queued (until the agent checks its " +
      "inbox) or offline (held until the session returns).",
    inputSchema: {
      type: "object",
      properties: {
        to: str("Who to send to: a name from list_agents. Optional with reply_to, which answers the other side of that message."),
        text: str("The message, in plain text."),
        reply_to: str("Optional. The ID of the message this answers."),
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "check_inbox",
    description:
      "Pick up new tasks sent to you (they move to working), messages sent to you, and results of tasks you sent.",
    inputSchema: noArgs,
  },
  {
    name: "finish_task",
    description: "Finish a task you picked up. Give either result (you completed it) or failed_reason (you couldn't).",
    inputSchema: {
      type: "object",
      properties: {
        task_id: str("The task ID."),
        result: str("Your answer, if you completed the task."),
        failed_reason: str("Why you couldn't complete it."),
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_task",
    description: "Get the status and result of a task you sent or received.",
    inputSchema: {
      type: "object",
      properties: { task_id: str("The task ID.") },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "report_event",
    description: "Report that something happened, e.g. bug_report_received. Matching triggers may create tasks.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("Event name: letters, digits, _ . -"),
        details: str("Free-text details."),
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

type Args = Record<string, unknown>;

class MissingArgument extends Error {}

const optional = (args: Args, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;

function required(args: Args, key: string): string {
  const value = optional(args, key);
  if (value === undefined || value === "") throw new MissingArgument(`${key} is required.`);
  return value;
}

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const failure = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

/** The human-readable part of a check_inbox result, as the hub's /mcp writes it. */
export function inboxText(inbox: Inbox): string {
  const lines: string[] = [inbox.tasks.length ? `New tasks (${inbox.tasks.length}):` : "No new tasks."];
  for (const task of inbox.tasks) lines.push("---", task.framed_message);
  lines.push("", inbox.messages.length ? `Messages (${inbox.messages.length}):` : "No new messages.");
  for (const message of inbox.messages) lines.push("---", message.framed_message);
  lines.push("", inbox.results.length ? `Results of tasks you sent (${inbox.results.length}):` : "No new results.");
  for (const task of inbox.results) lines.push("---", task.framed_message);
  return lines.join("\n");
}

/** Runs one of the seven tools against the hub. Hub errors become tool errors, as on the hub's /mcp. */
export async function runTool(client: HubClient, name: string, args: Args): Promise<CallToolResult> {
  try {
    switch (name) {
      case "list_agents":
        return json(await client.listAgents());
      case "send_task": {
        const key = optional(args, "idempotency_key");
        return json(
          await client.sendTask({
            to: required(args, "to"),
            instructions: required(args, "instructions"),
            ...(key !== undefined ? { idempotency_key: key } : {}),
          }),
        );
      }
      case "send_message": {
        const to = optional(args, "to");
        const replyTo = optional(args, "reply_to");
        return json(
          await client.sendMessage({
            text: required(args, "text"),
            ...(to !== undefined ? { to } : {}),
            ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
          }),
        );
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
      case "finish_task":
        return json(
          await client.finishTask(required(args, "task_id"), {
            result: optional(args, "result"),
            failed_reason: optional(args, "failed_reason"),
          }),
        );
      case "get_task":
        return json(await client.getTask(required(args, "task_id")));
      case "report_event":
        return json(await client.reportEvent({ name: required(args, "name"), details: optional(args, "details") }));
      default:
        return failure(`bad_request: Unknown tool ${name}.`);
    }
  } catch (err) {
    if (err instanceof HubError) return failure(`${err.code}: ${err.message}`);
    if (err instanceof MissingArgument) return failure(`bad_request: ${err.message}`);
    throw err;
  }
}
