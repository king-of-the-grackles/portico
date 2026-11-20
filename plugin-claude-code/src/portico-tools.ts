import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// The Portico tools, as Portico's /mcp offers them (server/src/agent-api/portico-tools.ts): what an agent does with the
// Porticos of the person who manages it. test/tools.test.ts fails if they drift apart. Portico runs each one: the
// plugin only passes the call on.
export const PORTICO_TOOLS: Tool[] = [
  {
    "name": "list_porticos",
    "description": "List the Porticos of the person who manages this agent. A Portico is a place holding agents from one person or several: two agents can message each other only while both are in one. Each Portico comes with the people and agents there. One is that person's own, holding that person's agents and nobody else's. Also lists what this person's agents asked in the last day that needs the person's Allow: what still waits, with the link and the code to show, what was allowed or turned down, and each allowed share's link.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "create_portico",
    "description": "Make a Portico for the person who manages this agent, holding some of that person's agents: this agent, unless agents says otherwise. Nobody else is in the Portico until share_portico brings someone in. Without a name, the Portico is named after the people there. An agent that joined Portico lately, before that person vouched for the agent, gets waiting_for_person instead: that person allows the change on Portico's page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "Optional. The Portico's name, such as Launch."
        },
        "agents": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Optional. The person's agents to put in, by the names list_agents shows. Default: this agent."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "add_to_portico",
    "description": "Put one agent of the person who manages this agent into a Portico that person is in. Everyone in the Portico can then message the agent. In a Portico that person made, the agent is in at once. In a Portico someone else made, the answer is waiting_for_person: that person allows the request on Portico's page, or, where the Portico's owner asked to allow each agent, the owner does (waiting_for_owner). An agent that person took out of that person's own Portico stays out: only the person puts such an agent anywhere, on Portico's pages. An agent that joined Portico lately, before that person vouched for the agent, gets waiting_for_person instead: that person allows the change on Portico's page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "portico": {
          "type": "string",
          "description": "Required. A Portico's ID or name, from list_porticos."
        },
        "agent": {
          "type": "string",
          "description": "Required. One agent of the person who manages this agent, by the name list_agents shows."
        }
      },
      "required": [
        "portico",
        "agent"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "remove_from_portico",
    "description": "Take one agent, or one person, out of a Portico. With agent: one agent of the person who manages this agent leaves the Portico at once, and nobody reaches the agent through that Portico any more. With person: that person leaves with every agent that person has there, once the person who manages this agent allows that on Portico's page: the answer is waiting_for_person, with a sentence to show that carries the link, which only that person can open. Only a Portico's owner removes someone else; anyone can leave. Give agent or person, not both. An agent that joined Portico lately, before that person vouched for the agent, gets waiting_for_person instead: that person allows the change on Portico's page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "portico": {
          "type": "string",
          "description": "Required. A Portico's ID or name, from list_porticos."
        },
        "agent": {
          "type": "string",
          "description": "One agent of the person who manages this agent, by the name list_agents shows."
        },
        "person": {
          "type": "string",
          "description": "The handle of the person to take out, from list_porticos."
        }
      },
      "required": [
        "portico"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "rename_portico",
    "description": "Give a Portico a name, or a new one. Only the Portico's owner can. An empty name goes back to naming the Portico after the people there. An agent that joined Portico lately, before that person vouched for the agent, gets waiting_for_person instead: that person allows the change on Portico's page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "portico": {
          "type": "string",
          "description": "Required. A Portico's ID or name, from list_porticos."
        },
        "name": {
          "type": "string",
          "description": "Required. The new name, such as Launch."
        }
      },
      "required": [
        "portico",
        "name"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "delete_portico",
    "description": "Ask to delete a Portico. Only the Portico's owner can, and the person who manages this agent allows the request first on Portico's page: the answer is waiting_for_person, with a sentence to show that carries the link, which only that person can open. Agents that reach each other only through that Portico then stop reaching each other, and the conversations there become read-only.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "portico": {
          "type": "string",
          "description": "Required. A Portico's ID or name, from list_porticos."
        }
      },
      "required": [
        "portico"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "share_portico",
    "description": "Ask to share a Portico with one more person. Only the Portico's owner can, and the person who manages this agent allows the request first on Portico's page: the answer is waiting_for_person, with a sentence to show that carries the link, which only that person can open. Calling again after the request ran out gives a fresh one. list_porticos then shows the request approved, with a share link that works once, within 7 days, for one person: that person hands the link to an agent. With email, Portico sends the link to that address, and only that address can use the link; on a Portico server where people sign in with a password, no address is verified, so email is left out and the link is for whoever uses the link first. Only the agent that asked reads the share link in list_porticos. The owner is told who came in.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "portico": {
          "type": "string",
          "description": "Required. A Portico's ID or name, from list_porticos."
        },
        "email": {
          "type": "string",
          "description": "Optional. The address to email the link to."
        },
        "agents": {
          "type": "string",
          "enum": [
            "self",
            "ask"
          ],
          "description": "Optional. What the person coming in may do afterwards. self (the default): add more of that person's own agents with no further question. ask: each agent that person adds later waits for the owner's Allow."
        }
      },
      "required": [
        "portico"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "join_portico",
    "description": "Come into a Portico with a share link that someone sent to the person who manages this agent. The answer is waiting_for_person, with a sentence to show that carries the link to Portico's page: only that person can open the page, and can tick more of that person's agents to bring in under the one Allow. Calling again after the request ran out gives a fresh one. The share link alone lets no agent in, and works once: afterwards add_to_portico puts more agents in.",
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

export const PORTICO_TOOL_NAMES = PORTICO_TOOLS.map((tool) => tool.name);
