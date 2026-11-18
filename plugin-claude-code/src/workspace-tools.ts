import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// The workspace tools, as Portico's /mcp offers them on a Portico with workspaces
// (server/src/agent-api/workspace-tools.ts). test/tools.test.ts fails if they drift apart. Portico runs each one:
// the plugin only passes the call on.
export const WORKSPACE_TOOLS: Tool[] = [
  {
    "name": "list_workspaces",
    "description": "List the workspaces of the person who manages this agent: Personal, which holds only that person's agents, and each shared workspace with the people and agents there. Two agents reach each other only while both are in one workspace. Also lists requests: what that person's agents asked for that waits for the person, and each confirmed share's link.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "create_workspace",
    "description": "Make a shared workspace for the person who manages this agent, holding some of that person's agents: this agent, unless agents says otherwise. Nobody else is in the workspace until share_workspace brings someone in.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Required. The workspace's name, such as Design team."
        },
        "agents": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional. The person's agents to put in, by the names list_agents shows. Default: this agent."
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "set_workspace_agents",
    "description": "Put agents of the person who manages this agent into a shared workspace, or take agents out. Everyone in the workspace can then message the agents put in. Every agent stays in Personal.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "workspace": {
          "type": "string",
          "description": "Required. A workspace ID from list_workspaces."
        },
        "add": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional. Agents to put in, by the names list_agents shows."
        },
        "remove": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional. Agents to take out."
        }
      },
      "required": [
        "workspace"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "share_workspace",
    "description": "Ask to share a workspace with one more person. The person who manages this agent confirms first, signed in on Portico's page. list_workspaces then shows the request approved, with a link that works for 7 days and for one person: that person hands the link to an agent. With email, Portico sends the link to that address, and only that address can use the link.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "workspace": {
          "type": "string",
          "description": "Required. A workspace ID from list_workspaces."
        },
        "email": {
          "type": "string",
          "description": "Optional. The address to email the link to."
        }
      },
      "required": [
        "workspace"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "remove_from_workspace",
    "description": "Ask to take a person out of a shared workspace, with every agent that person has there. Only the workspace's owner removes someone else; anyone can leave. The person who manages this agent confirms first.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "workspace": {
          "type": "string",
          "description": "Required. A workspace ID from list_workspaces."
        },
        "person": {
          "type": "string",
          "description": "Required. The handle of the person to take out, from list_workspaces."
        }
      },
      "required": [
        "workspace",
        "person"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "join_workspace",
    "description": "Come into a workspace with a share link that someone sent to the person who manages this agent. Answers with a 4-digit code: show the code to the person, who confirms on Portico. The link alone lets no agent in. The same link works for more of that person's agents until the link expires.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "link": {
          "type": "string",
          "description": "Required. The whole share link, such as https://portico.example/share#…."
        }
      },
      "required": [
        "link"
      ],
      "additionalProperties": false
    }
  }
];

export const WORKSPACE_TOOL_NAMES = WORKSPACE_TOOLS.map((tool) => tool.name);
