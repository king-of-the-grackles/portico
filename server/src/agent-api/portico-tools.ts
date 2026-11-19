import type { Agents } from "../core/agents";
import { PorticoError } from "../core/errors";
import { LIMITS } from "../core/limits";
import type { People } from "../core/people";
import type { ShareRequest, Shares, WorkspaceAsk } from "../core/shares";
import type { Agent, Workspace } from "../core/types";
import type { Workspaces } from "../core/workspaces";

const str = (description: string) => ({ type: "string", description });
const PORTICO = "Required. A Portico's ID or name, from list_porticos.";
const AGENT = "Required. One agent of the person who manages this agent, by the name list_agents shows.";

/**
 * The Portico tools. "A Portico" is the place: a named list of people and agents (a workspace, in this code). An agent
 * does for the person who manages the agent what that person can do on Portico's pages, only with that person's own
 * Porticos and agents. Letting someone in, taking someone out and deleting a Portico wait for the person's own yes.
 * The plugin offers the same list.
 */
export function porticoTools() {
  return [
    {
      name: "list_porticos",
      description:
        "List the Porticos of the person who manages this agent. A Portico is a place holding agents from one person or " +
        "several: two agents can message each other only while both are in one. Each Portico comes with the people and " +
        "agents there. One is that person's own, holding that person's agents and nobody else's. Also lists what still " +
        "waits: shares and removals the person has to confirm, each confirmed share's link, and agents asking to come in.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "create_portico",
      description:
        "Make a Portico for the person who manages this agent, holding some of that person's agents: this agent, unless " +
        "agents says otherwise. Nobody else is in the Portico until share_portico brings someone in. Without a name, the " +
        "Portico is named after the people there.",
      inputSchema: {
        type: "object",
        properties: {
          name: str("Optional. The Portico's name, such as Launch."),
          agents: {
            type: "array",
            items: { type: "string" },
            description: "Optional. The person's agents to put in, by the names list_agents shows. Default: this agent.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "add_to_portico",
      description:
        "Put one agent of the person who manages this agent into a Portico that person is in. Everyone in the Portico can " +
        "then message the agent. An agent that person took out of that person's own Portico stays out: only the person " +
        "puts such an agent anywhere, on Portico's pages.",
      inputSchema: {
        type: "object",
        properties: { portico: str(PORTICO), agent: str(AGENT) },
        required: ["portico", "agent"],
        additionalProperties: false,
      },
    },
    {
      name: "remove_from_portico",
      description:
        "Take one agent, or one person, out of a Portico. With agent: one agent of the person who manages this agent " +
        "leaves the Portico at once, and nobody reaches the agent through that Portico any more. With person: that " +
        "person leaves with every agent that person has there, once the person who manages this agent confirms. Only a " +
        "Portico's owner removes someone else; anyone can leave. Give agent or person, not both.",
      inputSchema: {
        type: "object",
        properties: {
          portico: str(PORTICO),
          agent: str("One agent of the person who manages this agent, by the name list_agents shows."),
          person: str("The handle of the person to take out, from list_porticos."),
        },
        required: ["portico"],
        additionalProperties: false,
      },
    },
    {
      name: "rename_portico",
      description:
        "Give a Portico a name, or a new one. Only the Portico's owner can. An empty name goes back to naming the Portico " +
        "after the people there.",
      inputSchema: {
        type: "object",
        properties: { portico: str(PORTICO), name: str("Required. The new name, such as Launch.") },
        required: ["portico", "name"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_portico",
      description:
        "Ask to delete a Portico. Only the Portico's owner can, and the person who manages this agent confirms first, signed in on " +
        "Portico's page. Agents that reach each other only through that Portico then stop reaching each other, and the " +
        "conversations there become read-only.",
      inputSchema: {
        type: "object",
        properties: { portico: str(PORTICO) },
        required: ["portico"],
        additionalProperties: false,
      },
    },
    {
      name: "share_portico",
      description:
        "Ask to share a Portico with one more person. The person who manages this agent confirms first, signed in " +
        "on Portico's page. list_porticos then shows the request approved, with a link that works for " +
        `${LIMITS.shareDays} days and for one person: that person hands the link to an agent. With email, Portico sends ` +
        "the link to that address, and only that address can use the link.",
      inputSchema: {
        type: "object",
        properties: {
          portico: str(PORTICO),
          email: str("Optional. The address to email the link to."),
        },
        required: ["portico"],
        additionalProperties: false,
      },
    },
    {
      name: "join_portico",
      description:
        "Come into a Portico with a share link that someone sent to the person who manages this agent. Answers with " +
        "a 4-digit code: show the code to the person, who confirms on Portico's page. The link alone lets no agent in. " +
        "The same link works for more of that person's agents until the link expires.",
      inputSchema: {
        type: "object",
        properties: { link: str("Required. The whole share link, such as https://portico.example/share#….") },
        required: ["link"],
        additionalProperties: false,
      },
    },
  ];
}

export const PORTICO_TOOL_NAMES = porticoTools().map((tool) => tool.name);

export interface PorticoToolDeps {
  agents: Agents;
  people: People;
  workspaces: Workspaces;
  shares: Shares;
  publicUrl: () => string;
}

/**
 * The one Portico of the person's that `named` means: an ID, or a name whatever its case. Any other answers the same as
 * one that doesn't exist.
 */
export function findPortico(workspaces: Workspaces, personId: string, named: unknown): Workspace {
  const wanted = typeof named === "string" ? named.trim() : "";
  if (wanted === "") throw new PorticoError("bad_request", "portico must be a Portico's ID or name, from list_porticos.");
  workspaces.personal(personId);
  const mine = workspaces.forPerson(personId);
  const byId = mine.find((w) => w.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase().replace(/^the\s+/, "");
  const found = mine.filter((w) => [w.name, w.phrase.replace(/^the\s+/i, "")].some((name) => name.toLowerCase() === lower));
  if (found.length === 1) return found[0]!;
  if (found.length > 1) {
    throw new PorticoError("bad_request", `${found.length} Porticos are named "${wanted}". Use an ID from list_porticos: ${found.map((w) => w.id).join(", ")}.`);
  }
  throw new PorticoError("not_found", `No Portico "${wanted}". list_porticos shows each Portico's ID and name.`);
}

/** Runs one Portico tool for the agent, as the person who manages it. Answers plain data. */
export function runPorticoTool(deps: PorticoToolDeps, agent: Agent, name: string, args: Record<string, unknown>): unknown {
  const { agents, people, workspaces, shares } = deps;
  const ownerId = agent.ownerId;
  const owner = people.require(ownerId);
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
  const list = (key: string) => (Array.isArray(args[key]) ? (args[key] as unknown[]).filter((item): item is string => typeof item === "string") : []);
  const where = `${deps.publicUrl()}/`;
  const portico = () => findPortico(workspaces, ownerId, args.portico);
  const ref = (w: Workspace) => ({ id: w.id, name: w.name });
  const addr = (a: Agent) => agents.nameFor(a, ownerId);

  /** One of the owner's own agents, by any name list_agents shows it under. */
  const own = (named: string): Agent => {
    const wanted = named.trim();
    const mine = agents.ownedBy(ownerId);
    const found = mine.filter((a) => a.id === wanted || a.name === wanted || agents.addressFor(a, ownerId) === wanted || agents.nameFor(a, ownerId) === wanted);
    if (found.length !== 1) throw new PorticoError("unknown_agent", `"${wanted}" isn't one agent of ${owner.name}'s. Use a name from list_agents.`);
    return found[0]!;
  };
  /** An agent its owner took out of the owner's own Portico is kept apart: no agent puts it anywhere. */
  const requireNotApart = (a: Agent, into: Workspace | null): void => {
    const home = workspaces.personal(ownerId);
    if (workspaces.hasAgent(home.id, a.id)) return;
    throw new PorticoError(
      "not_allowed",
      `${owner.name} took \`${addr(a)}\` out of ${home.name}, so only ${owner.name} can put \`${addr(a)}\` into ${into?.phrase ?? "a Portico"}: ` +
        `on Portico's pages, ${deps.publicUrl()}/${into ? `p/${into.id}` : "agents"}.`,
    );
  };
  const cap = (sentence: string) => sentence.charAt(0).toUpperCase() + sentence.slice(1);
  const person = (id: string) => {
    const p = people.get(id);
    return { name: p?.name ?? "", handle: p?.handle ?? null };
  };
  const view = (w: Workspace) => ({
    id: w.id,
    name: w.name,
    /** `own`: the one holding only this person's agents. `shared`: one made to bring other people's agents in. */
    kind: w.kind === "personal" ? "own" : "shared",
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
  const named = (id: string) => {
    const w = workspaces.known(id);
    return { id, name: w?.name ?? "" };
  };
  const askView = (ask: WorkspaceAsk) => {
    const share = ask.result?.shareId ? shares.get(ask.result.shareId) : null;
    const secret = share ? shares.secretFor(ownerId, share.id) : null;
    return {
      id: ask.id,
      kind: ask.kind,
      status: ask.status,
      portico: named(ask.workspaceId),
      ...(ask.detail.email ? { email: ask.detail.email } : {}),
      ...(ask.detail.personId ? { person: person(ask.detail.personId).handle } : {}),
      ...(secret ? { link: `${deps.publicUrl()}/share#${secret}`, link_expires_at: share!.expiresAt } : {}),
      expires_at: ask.expiresAt,
    };
  };
  const joinView = (request: ShareRequest) => {
    const share = shares.get(request.shareId);
    return {
      id: request.id,
      kind: "join",
      status: request.status,
      ...(share ? { portico: named(share.workspaceId) } : {}),
      ...(request.status === "pending" ? { code: request.code } : {}),
      expires_at: request.expiresAt,
    };
  };
  /** What the agent shows its person while a request waits: what, where, and until when. */
  const waiting = (what: string, ask: WorkspaceAsk) => ({
    status: "waiting_for_person",
    show:
      `Waiting for ${owner.name}: ${what} happens only once ${owner.name} confirms at ${where}, under what needs a decision. ` +
      `The request runs out at ${ask.expiresAt}; the same call asks again after that.`,
    request: askView(ask),
    note: "Nothing has changed yet. list_porticos shows the outcome.",
  });

  switch (name) {
    case "list_porticos": {
      workspaces.personal(ownerId);
      return {
        handle: owner.handle,
        porticos: workspaces.forPerson(ownerId).map(view),
        waiting: [...shares.asksBy(ownerId).map(askView), ...shares.requestsBy(ownerId).map(joinView)],
      };
    }
    case "create_portico": {
      const chosen = args.agents === undefined || args.agents === null ? [agent] : list("agents").map(own);
      for (const a of chosen) requireNotApart(a, null);
      const made = workspaces.create(ownerId, args.name);
      for (const a of chosen) workspaces.addAgent(ownerId, made.id, a.id);
      const inside = chosen.length === 0 ? "no agents" : chosen.map((a) => `\`${addr(a)}\``).join(", ");
      return {
        portico: view(made),
        note: `Made ${made.phrase} with ${inside} in it. Nobody else is in ${made.phrase} until share_portico brings someone in.`,
      };
    }
    case "add_to_portico": {
      const w = portico();
      const a = own(text("agent"));
      requireNotApart(a, w);
      workspaces.addAgent(ownerId, w.id, a.id);
      return { portico: view(w), note: `\`${addr(a)}\` is in ${w.phrase}: everyone there can message \`${addr(a)}\`.` };
    }
    case "remove_from_portico": {
      const w = portico();
      const who = text("person");
      const which = text("agent");
      if ((who === "") === (which === "")) throw new PorticoError("bad_request", "Give agent or person: one of the two.");
      if (who !== "") {
        const ask = shares.ask(agent, "remove_person", w.id, { person: who });
        return { portico: ref(w), ...waiting(`taking ${person(ask.detail.personId!).name || who} out of ${w.phrase}`, ask) };
      }
      if (which.includes("/") && !agents.ownedBy(ownerId).some((a) => addr(a) === which || agents.addressFor(a, ownerId) === which)) {
        throw new PorticoError(
          "not_allowed",
          `\`${which}\` is another person's agent. ${owner.name} can take the agent out on the Portico's page, ${deps.publicUrl()}/p/${w.id}, ` +
            "or remove_from_portico with person takes that person out with every agent that person has there.",
        );
      }
      const a = own(which);
      workspaces.removeAgent(ownerId, w.id, a.id);
      return { portico: view(w), note: `\`${addr(a)}\` is out of ${w.phrase}: nobody reaches \`${addr(a)}\` through ${w.phrase} any more.` };
    }
    case "rename_portico": {
      const w = portico();
      const renamed = workspaces.rename(ownerId, w.id, args.name ?? "");
      return { portico: view(renamed), note: cap(`${w.phrase} is now ${renamed.phrase}.`) };
    }
    case "delete_portico": {
      const w = portico();
      const ask = shares.ask(agent, "delete", w.id);
      return { portico: ref(w), ...waiting(`deleting ${w.phrase}`, ask) };
    }
    case "share_portico": {
      const w = portico();
      const ask = shares.ask(agent, "share", w.id, { email: args.email });
      return { portico: ref(w), ...waiting(`sharing ${w.phrase}${ask.detail.email ? ` with ${ask.detail.email}` : " with one more person"}`, ask) };
    }
    case "join_portico": {
      const request = shares.requestForAgent(agent, args.link);
      const share = shares.get(request.shareId);
      const w = share ? workspaces.get(share.workspaceId) : null;
      const into = w?.phrase ?? "the Portico";
      return {
        ...(w ? { portico: ref(w) } : {}),
        status: "waiting_for_person",
        show:
          `Waiting for ${owner.name}: this agent comes into ${into} only once ${owner.name} confirms at ${where}, under what needs a ` +
          `decision, with the code ${request.code}. The code runs out at ${request.expiresAt}; the same call gives a new one after that.`,
        request: joinView(request),
        note: "Nothing has changed yet. list_porticos shows the outcome.",
      };
    }
    default:
      throw new PorticoError("bad_request", "Unknown tool.");
  }
}

/** list_agents' `portico`: the one Portico of the caller's person to list, or null for every agent the caller reaches. */
export function porticoFilter(workspaces: Workspaces, agent: Agent, named: unknown): Workspace | null {
  if (named === undefined || named === null || named === "") return null;
  return findPortico(workspaces, agent.ownerId, named);
}
