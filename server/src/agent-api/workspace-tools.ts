import type { Agents } from "../core/agents";
import { PorticoError } from "../core/errors";
import { LIMITS } from "../core/limits";
import type { People } from "../core/people";
import type { ShareRequest, Shares, WorkspaceAsk } from "../core/shares";
import type { Agent, Workspace } from "../core/types";
import type { Workspaces } from "../core/workspaces";

const str = (description: string) => ({ type: "string", description });
const names = (description: string) => ({ type: "array", items: { type: "string" }, description });
const WORKSPACE = "Required. A workspace ID from list_workspaces.";

/**
 * The workspace tools. An agent does for the person who manages the agent what that person can
 * do on Portico's pages: only with that person's own workspaces and agents. Letting someone in and taking someone out
 * wait for the person's own yes. The plugin offers the same list.
 */
export function workspaceTools() {
  return [
    {
      name: "list_workspaces",
      description:
        "List the workspaces of the person who manages this agent: Personal, which holds only that person's agents, and " +
        "each shared workspace with the people and agents there. Two agents reach each other only while both are in one " +
        "workspace. Also lists requests: what that person's agents asked for that waits for the person, and each " +
        "confirmed share's link.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "create_workspace",
      description:
        "Make a shared workspace for the person who manages this agent, holding some of that person's agents: this " +
        "agent, unless agents says otherwise. Nobody else is in the workspace until share_workspace brings someone in.",
      inputSchema: {
        type: "object",
        properties: {
          name: str("Required. The workspace's name, such as Design team."),
          agents: names("Optional. The person's agents to put in, by the names list_agents shows. Default: this agent."),
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "set_workspace_agents",
      description:
        "Put agents of the person who manages this agent into a shared workspace, or take agents out. Everyone in the " +
        "workspace can then message the agents put in. Every agent stays in Personal.",
      inputSchema: {
        type: "object",
        properties: {
          workspace: str(WORKSPACE),
          add: names("Optional. Agents to put in, by the names list_agents shows."),
          remove: names("Optional. Agents to take out."),
        },
        required: ["workspace"],
        additionalProperties: false,
      },
    },
    {
      name: "share_workspace",
      description:
        "Ask to share a workspace with one more person. The person who manages this agent confirms first, signed in " +
        "on Portico's page. list_workspaces then shows the request approved, with a link that works for " +
        `${LIMITS.shareDays} days and for one person: that person hands the link to an agent. With email, Portico sends ` +
        "the link to that address, and only that address can use the link.",
      inputSchema: {
        type: "object",
        properties: {
          workspace: str(WORKSPACE),
          email: str("Optional. The address to email the link to."),
        },
        required: ["workspace"],
        additionalProperties: false,
      },
    },
    {
      name: "remove_from_workspace",
      description:
        "Ask to take a person out of a shared workspace, with every agent that person has there. Only the workspace's " +
        "owner removes someone else; anyone can leave. The person who manages this agent confirms first.",
      inputSchema: {
        type: "object",
        properties: {
          workspace: str(WORKSPACE),
          person: str("Required. The handle of the person to take out, from list_workspaces."),
        },
        required: ["workspace", "person"],
        additionalProperties: false,
      },
    },
    {
      name: "join_workspace",
      description:
        "Come into a workspace with a share link that someone sent to the person who manages this agent. Answers with " +
        "a 4-digit code: show the code to the person, who confirms on Portico. The link alone lets no agent in. The same " +
        "link works for more of that person's agents until the link expires.",
      inputSchema: {
        type: "object",
        properties: { link: str("Required. The whole share link, such as https://portico.example/share#….") },
        required: ["link"],
        additionalProperties: false,
      },
    },
  ];
}

export const WORKSPACE_TOOL_NAMES = workspaceTools().map((tool) => tool.name);

export interface WorkspaceToolDeps {
  agents: Agents;
  people: People;
  workspaces: Workspaces;
  shares: Shares;
  publicUrl: () => string;
}

/** Runs one workspace tool for the agent, as the person who manages it. Answers plain data. */
export function runWorkspaceTool(deps: WorkspaceToolDeps, agent: Agent, name: string, args: Record<string, unknown>): unknown {
  const { agents, people, workspaces, shares } = deps;
  const ownerId = agent.ownerId;
  const owner = people.require(ownerId);
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
  const list = (key: string) => (Array.isArray(args[key]) ? (args[key] as unknown[]).filter((item): item is string => typeof item === "string") : []);
  const where = `${deps.publicUrl()}/`;

  /** One of the owner's own agents, by any name list_agents shows it under. */
  const own = (named: string): Agent => {
    const wanted = named.trim();
    const mine = agents.ownedBy(ownerId);
    const found = mine.filter((a) => a.id === wanted || a.name === wanted || agents.addressFor(a, ownerId) === wanted || agents.nameFor(a, ownerId) === wanted);
    if (found.length !== 1) throw new PorticoError("unknown_agent", `"${wanted}" isn't one agent of ${owner.name}'s. Use a name from list_agents.`);
    return found[0]!;
  };
  const person = (id: string) => {
    const p = people.get(id);
    return { name: p?.name ?? "", handle: p?.handle ?? null };
  };
  const view = (w: Workspace) => ({
    id: w.id,
    name: w.name,
    kind: w.kind,
    owner: person(w.ownerId),
    owned_by_this_person: w.ownerId === ownerId,
    this_agent_is_in: workspaces.hasAgent(w.id, agent.id),
    people: workspaces.peopleIn(w.id).map(person),
    agents: workspaces
      .agentsIn(w.id)
      .map((id) => agents.get(id))
      .filter((a): a is Agent => a !== null)
      .map((a) => agents.addressFor(a, ownerId)),
  });
  const askView = (ask: WorkspaceAsk) => {
    const share = ask.result?.shareId ? shares.get(ask.result.shareId) : null;
    const secret = share ? shares.secretFor(ownerId, share.id) : null;
    return {
      id: ask.id,
      kind: ask.kind,
      status: ask.status,
      workspace: ask.workspaceId,
      ...(ask.detail.email ? { email: ask.detail.email } : {}),
      ...(ask.detail.personId ? { person: person(ask.detail.personId).handle } : {}),
      ...(secret ? { link: `${deps.publicUrl()}/share#${secret}`, link_expires_at: share!.expiresAt } : {}),
      expires_at: ask.expiresAt,
    };
  };
  const joinView = (request: ShareRequest) => ({
    id: request.id,
    kind: "join",
    status: request.status,
    ...(request.status === "pending" ? { code: request.code } : {}),
    expires_at: request.expiresAt,
  });
  const waiting = `Waiting for ${owner.name} to confirm at ${where}, under what needs a decision. list_workspaces shows the outcome.`;

  switch (name) {
    case "list_workspaces": {
      workspaces.personal(ownerId);
      return {
        handle: owner.handle,
        workspaces: workspaces.forPerson(ownerId).map(view),
        requests: [...shares.asksBy(ownerId).map(askView), ...shares.requestsBy(ownerId).map(joinView)],
      };
    }
    case "create_workspace": {
      const chosen = args.agents === undefined || args.agents === null ? [agent] : list("agents").map(own);
      const made = workspaces.create(ownerId, args.name);
      for (const a of chosen) workspaces.addAgent(ownerId, made.id, a.id);
      return { workspace: view(made) };
    }
    case "set_workspace_agents": {
      const workspace = workspaces.requireFor(ownerId, text("workspace"));
      const add = list("add").map(own);
      const remove = list("remove").map(own);
      for (const a of add) workspaces.addAgent(ownerId, workspace.id, a.id);
      for (const a of remove) workspaces.removeAgent(ownerId, workspace.id, a.id);
      return { workspace: view(workspace) };
    }
    case "share_workspace": {
      const ask = shares.ask(agent, "share", text("workspace"), { email: args.email });
      return { request: askView(ask), note: waiting };
    }
    case "remove_from_workspace": {
      const ask = shares.ask(agent, "remove_person", text("workspace"), { person: args.person });
      return { request: askView(ask), note: waiting };
    }
    case "join_workspace": {
      const request = shares.requestForAgent(agent, args.link);
      return {
        request: joinView(request),
        note: `Show ${owner.name} this code: ${request.code}. ${owner.name} confirms at ${where}, under what needs a decision. Nothing changes until then.`,
      };
    }
    default:
      throw new PorticoError("bad_request", "Unknown tool.");
  }
}
