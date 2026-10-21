import type { AssistantKind } from "../core/types";

/** One paste-ready block on the assistant-created page. */
export interface ConnectBlock {
  /** UI copy. */
  label: string;
  /** Paste-ready: the owner's words to an assistant, a command or a config snippet. */
  text: string;
}

export interface ConnectGuide {
  /** UI copy. */
  intro: string;
  blocks: ConnectBlock[];
}

export const KIND_LABELS: Record<AssistantKind, string> = {
  muse: "Muse",
  "grok-bot": "Grok Bot",
  chatgpt: "ChatGPT",
  codex: "Codex",
  other: "Other MCP client",
};

/** How to connect a new assistant of this kind. The token is in the blocks, so the guide is shown once. */
export function connectGuide(
  kind: AssistantKind,
  { publicUrl, name, token }: { publicUrl: string; name: string; token: string },
): ConnectGuide {
  const mcp = `${publicUrl}/mcp`;
  const header = `Authorization: Bearer ${token}`;
  switch (kind) {
    case "muse":
      return {
        intro:
          "Send the first prompt to Muse in a chat. When Muse shows the Add custom connector dialog, paste the token into the API key field, not into the chat. The second prompt sets up a check every 10 minutes.",
        blocks: [
          {
            label: "Prompt for Muse",
            text: `Build a custom connector for my agent bridge. Its API is described at ${publicUrl}/api/openapi.json, and the base URL is ${publicUrl}. It authenticates with an API key sent as \`Authorization: Bearer <key>\`. I'll use it to send tasks and messages to my other agents, check my inbox, and finish tasks.`,
          },
          { label: "Token for the API key field", text: token },
          {
            label: "Prompt for a scheduled check",
            text: "Every 10 minutes, check my agent bridge inbox. For each new task, do it if it's something you can do safely, then finish it with the result. Otherwise finish it with a failed_reason and tell me. Read new messages too, and answer with send_message when an answer is useful.",
          },
        ],
      };
    case "grok-bot":
      return {
        intro: "Send this prompt to Grok Bot in a chat. The prompt carries the token, so send the prompt only to Grok Bot.",
        blocks: [
          {
            label: "Prompt for Grok Bot",
            text: `Please connect to a remote MCP server at ${mcp}. Every request needs the HTTP header \`${header}\`. Save the token as a secret, not in a skill or routine text, because skills are shared with all my assistants. Then list the tools the server offers.`,
          },
        ],
      };
    case "chatgpt":
      return {
        intro:
          "In ChatGPT, add a custom MCP connector with this server address and header. If the connector settings have no field for a header, connect Codex instead.",
        blocks: [
          { label: "Server address", text: mcp },
          { label: "Header", text: header },
        ],
      };
    case "codex": {
      const envName = `BRIDGE_TOKEN_${name.toUpperCase().replace(/-/g, "_")}`;
      return {
        intro:
          "Paste the first block into ~/.codex/config.toml by hand, because codex mcp add rewrites the whole file. Put the second line in the environment Codex starts from, such as a shell profile.",
        blocks: [
          { label: "config.toml", text: `[mcp_servers.agent_bridge]\nurl = "${mcp}"\nbearer_token_env_var = "${envName}"` },
          { label: "Environment", text: `export ${envName}='${token}'` },
        ],
      };
    }
    case "other":
      return {
        intro: "Any MCP client that supports Streamable HTTP and a bearer header can connect with these.",
        blocks: [
          { label: "Server address", text: mcp },
          { label: "Header", text: header },
        ],
      };
  }
}
