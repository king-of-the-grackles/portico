import type { Agents } from "../core/agents";
import { quote } from "../core/framing";
import { PorticoError } from "../core/errors";
import { LIMITS } from "../core/limits";
import type { People } from "../core/people";
import type { ConsentRequest, Consents } from "../core/consents";
import type { Shares } from "../core/shares";
import type { Agent, Workspace } from "../core/types";
import type { Workspaces } from "../core/workspaces";

const str = (description: string) => ({ type: "string", description });
const PORTICO = "Required. A Portico's ID or name, from list_porticos.";
const AGENT = "Required. One agent of the person who manages this agent, by the name list_agents shows.";

/**
 * The Portico tools. "A Portico" is the place: a named list of people and agents (a workspace, in this code). An agent
 * does for the person who manages the agent what that person can do on Portico's pages, only with that person's own
 * Porticos and agents. Letting someone in, taking someone out, deleting a Portico and coming into one with a share
 * link wait for the person's own Allow on the consent page: the tool answers `waiting_for_person` with the exact
 * sentence to show, which carries the link and when the request runs out. Only that person, signed in, can open the
 * page, so there is no code to pass. The plugin offers the same list.
 */
export function porticoTools() {
  return [
    {
      name: "list_porticos",
      description:
        "List the Porticos of the person who manages this agent. A Portico is a place holding agents from one person or " +
        "several: two agents can message each other only while both are in one. Each Portico comes with the people and " +
        "agents there. One is that person's own, holding that person's agents and nobody else's. Also lists what this " +
        "person's agents asked in the last day that needs the person's Allow: what still waits, with the link and the " +
        "code to show, what was allowed or turned down, and each allowed share's link.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "create_portico",
      description:
        "Make a Portico for the person who manages this agent, holding some of that person's agents: this agent, unless " +
        "agents says otherwise. Nobody else is in the Portico until share_portico brings someone in. Without a name, the " +
        "Portico is named after the people there. An agent that joined Portico lately, before that person vouched for the agent, gets waiting_for_person instead: that person allows the change on Portico's page.",
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
        "then message the agent. In a Portico that person made, the agent is in at once. In a Portico someone else made, " +
        "the answer is waiting_for_person: that person allows the request on Portico's page, or, " +
        "where the Portico's owner asked to allow each agent, the owner does (waiting_for_owner). " +
        "An agent that person took out of that person's own Portico stays out: only the person " +
        "puts such an agent anywhere, on Portico's pages. An agent that joined Portico lately, before that person vouched for the agent, gets waiting_for_person instead: that person allows the change on Portico's page.",
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
        "person leaves with every agent that person has there, once the person who manages this agent allows that on " +
        "Portico's page: the answer is waiting_for_person, with a sentence to show that carries the link, which only " +
        "that person can open. Only a Portico's owner removes someone else; anyone can leave. Give agent or person, not both. An agent that joined Portico lately, before that person vouched for the agent, gets waiting_for_person instead: that person allows the change on Portico's page.",
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
        "after the people there. An agent that joined Portico lately, before that person vouched for the agent, gets waiting_for_person instead: that person allows the change on Portico's page.",
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
        "Ask to delete a Portico. Only the Portico's owner can, and the person who manages this agent allows the request " +
        "first on Portico's page: the answer is waiting_for_person, with a sentence to show that carries the link, " +
        "which only that person can open. Agents that reach each other only through that Portico then stop reaching each other, and the " +
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
        "Ask to share a Portico with one more person. Only the Portico's owner can, and the person who manages this " +
        "agent allows the request first on " +
        "Portico's page: the answer is waiting_for_person, with a sentence to show that carries the link, which only " +
        "that person can open. Calling again after the request ran out gives a fresh one. list_porticos then shows the request approved, with a share link that works once, within " +
        `${LIMITS.shareDays} days, for one person: that person hands the link to an agent. With email, Portico sends ` +
        "the link to that address, and only that address can use the link; on a Portico server where people sign in with a " +
        "password, no address is verified, so email is left out and the link is for whoever uses the link first. Only the " +
        "agent that asked reads the share link in list_porticos. The owner is told who came in.",
      inputSchema: {
        type: "object",
        properties: {
          portico: str(PORTICO),
          email: str("Optional. The address to email the link to."),
          agents: {
            type: "string",
            enum: ["self", "ask"],
            description:
              "Optional. What the person coming in may do afterwards. self (the default): add more of that person's own " +
              "agents with no further question. ask: each agent that person adds later waits for the owner's Allow.",
          },
        },
        required: ["portico"],
        additionalProperties: false,
      },
    },
    {
      name: "join_portico",
      description:
        "Come into a Portico with a share link that someone sent to the person who manages this agent. The answer is " +
        "waiting_for_person, with a sentence to show that carries the link to Portico's page: only that person can " +
        "open the page, and can tick more of that person's agents to bring in under the one Allow. " +
        "Calling again after the request ran out gives a fresh one. The share link alone lets no agent in, and works once: " +
        "afterwards add_to_portico puts more agents in.",
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
  consents: Consents;
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
  // What the person reads on the pages names the same Portico: "Personal Portico", and "Shared Portico" for the one the person started with.
  const onPages = (w: Workspace) => (w.ownerId !== personId ? [] : w.kind === "personal" ? ["Personal Portico"] : w.starter ? ["Shared Portico"] : []);
  const found = mine.filter((w) => [w.name, w.phrase.replace(/^the\s+/i, ""), ...onPages(w)].some((name) => name.toLowerCase() === lower));
  if (found.length === 1) return found[0]!;
  if (found.length > 1) {
    throw new PorticoError("bad_request", `${found.length} Porticos are named "${wanted}". Use an ID from list_porticos: ${found.map((w) => w.id).join(", ")}.`);
  }
  throw new PorticoError("not_found", `No Portico "${wanted}". list_porticos shows each Portico's ID and name.`);
}

/** Runs one Portico tool for the agent, as the person who manages it. Answers plain data. */
export function runPorticoTool(deps: PorticoToolDeps, agent: Agent, name: string, args: Record<string, unknown>): unknown {
  const { agents, people, workspaces, shares, consents } = deps;
  const ownerId = agent.ownerId;
  const owner = people.require(ownerId);
  const me = quote(owner.name);
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
  const list = (key: string) => (Array.isArray(args[key]) ? (args[key] as unknown[]).filter((item): item is string => typeof item === "string") : []);
  const portico = () => findPortico(workspaces, ownerId, args.portico);
  const ref = (w: Workspace) => ({ id: w.id, name: w.name });
  const addr = (a: Agent) => agents.nameFor(a, ownerId);

  /** One of the owner's own agents, by any name list_agents shows it under. */
  const own = (named: string): Agent => {
    const wanted = named.trim();
    const mine = agents.ownedBy(ownerId);
    const found = mine.filter((a) => a.id === wanted || a.name === wanted || agents.addressFor(a, ownerId) === wanted || agents.nameFor(a, ownerId) === wanted);
    if (found.length !== 1) throw new PorticoError("unknown_agent", `"${wanted}" isn't one agent of ${me}'s. Use a name from list_agents.`);
    return found[0]!;
  };
  /** An agent its owner took out of the owner's own Portico is kept apart: no agent puts it anywhere. */
  const requireNotApart = (a: Agent, into: Workspace | null): void => {
    const home = workspaces.personal(ownerId);
    if (workspaces.hasAgent(home.id, a.id)) return;
    throw new PorticoError(
      "not_allowed",
      `${me} took \`${addr(a)}\` out of ${home.phrase}, so only ${me} can put \`${addr(a)}\` into ${into?.phrase ?? "a Portico"}: ` +
        `on Portico's pages, ${deps.publicUrl()}/${into ? `p/${into.id}` : "agents"}.`,
    );
  };
  /** A person's name as a sentence carries it: a quote, since a person typed it. */
  const nameOf = (id: string, fallback: string) => {
    const name = people.get(id)?.name ?? "";
    return name === "" ? fallback : quote(name);
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
    /** Paused by its owner: nothing moves through it, and a send through it is refused. */
    paused: w.pausedAt !== null,
    people: workspaces.peopleIn(w.id).map((id) => ({
      ...person(id),
      // The owner's choice for each other person: whether more of that person's agents wait for the owner.
      ...(w.kind === "shared" && id !== w.ownerId ? { more_agents: workspaces.policyOf(w.id, id) === "ask" ? "ask_owner" : "self" } : {}),
    })),
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
  const pageFor = (request: ConsentRequest) => `${deps.publicUrl()}/c/${request.id}`;
  /** A request as the agent that asked may see it. The page's link shows only while the request waits. */
  const requestView = (request: ConsentRequest) => {
    const share = request.result?.shareId ? shares.get(request.result.shareId) : null;
    // A share link lets a person in: only the agent that asked for the share reads it here, and never an agent nobody
    // vouched for. The person's other agents see that the share was made, without the link.
    const secret = share && !agent.unproven && request.agentId === agent.id ? shares.secretFor(ownerId, share.id) : null;
    const pending = request.status === "pending";
    // What waits for a Portico's owner has a page that is the owner's alone.
    const forOwner = request.kind === "admit_agent";
    const subject = request.detail.agentId ? agents.get(request.detail.agentId) : null;
    return {
      id: request.id,
      kind: request.kind === "enter" ? "join" : request.kind,
      status: request.status,
      ...(request.workspaceId ? { portico: named(request.workspaceId) } : {}),
      ...(request.detail.email ? { email: request.detail.email } : {}),
      ...(request.detail.agents ? { more_agents: request.detail.agents === "ask" ? "ask_owner" : "self" } : {}),
      ...(subject ? { agent: addr(subject) } : {}),
      ...(request.detail.name !== undefined ? { name: request.detail.name } : {}),
      ...(request.detail.personId && !forOwner ? { person: person(request.detail.personId).handle } : {}),
      ...(pending && !forOwner ? { link: pageFor(request) } : {}),
      ...(pending && forOwner ? { waiting_for: "the Portico's owner" } : {}),
      ...(secret ? { share_link: `${deps.publicUrl()}/share#${secret}`, share_link_expires_at: share!.expiresAt } : {}),
      expires_at: request.expiresAt,
    };
  };
  /**
   * What the agent shows its person while a request waits, word for word: what is asked, the link and when the
   * request runs out. No code: only that person, signed in, can open the page. The one place that builds the sentence.
   */
  const waiting = (what: string, request: ConsentRequest) => ({
    status: "waiting_for_person",
    show:
      `Waiting for ${me}: ${what} happens only once ${me} opens ${pageFor(request)} in a browser, signs in ` +
      `and presses Allow. Only ${me} can open that page. The request runs out at ${request.expiresAt}.`,
    request: requestView(request),
    note: "Nothing has changed yet. Show the sentence in show as it is: the link and the time. list_porticos shows the outcome; the same call again gives a fresh link once this one has run out.",
  });

  /** What the agent shows while a request waits for a Portico's owner: no link, since the answer is the owner's. */
  const waitingForOwner = (w: Workspace, a: Agent, request: ConsentRequest) => ({
    status: "waiting_for_owner",
    show:
      `Waiting for ${nameOf(w.ownerId, "the owner")}, who made ${w.phrase} and asked to allow each agent ${me} adds there: ` +
      `\`${addr(a)}\` comes in once ${nameOf(w.ownerId, "the owner")} allows the request on Portico's page. The request waits until ${request.expiresAt}.`,
    request: requestView(request),
    note: "Nothing has changed yet. Portico tells the owner. list_porticos shows the outcome.",
  });

  switch (name) {
    case "list_porticos": {
      workspaces.personal(ownerId);
      return {
        handle: owner.handle,
        porticos: workspaces.forPerson(ownerId).map(view),
        // What this person's agents asked: of this person, and of the owners of Porticos this person is in.
        waiting: [...consents.recentFor(ownerId), ...consents.recentAskedBy(ownerId)].map(requestView),
      };
    }
    case "create_portico": {
      const chosen = args.agents === undefined || args.agents === null ? [agent] : list("agents").map(own);
      for (const a of chosen) requireNotApart(a, null);
      if (agent.unproven) return waiting("making the Portico", consents.askChange(agent, { kind: "create", name: args.name, agents: chosen }));
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
      if (workspaces.hasAgent(w.id, a.id)) return { portico: view(w), note: `\`${addr(a)}\` is already in ${w.phrase}.` };
      // A Portico this person made, or this person's own: organising one's own agents needs no question. In someone
      // else's, the person confirms, or the owner does where the owner asked to.
      if (w.ownerId !== ownerId) {
        const ask = consents.askToAdd(agent, w.id, a);
        return ask.kind === "admit_agent"
          ? { portico: ref(w), ...waitingForOwner(w, a, ask) }
          : { portico: ref(w), ...waiting(`\`${addr(a)}\` coming into ${w.phrase}`, ask) };
      }
      if (agent.unproven) return { portico: ref(w), ...waiting(`\`${addr(a)}\` coming into ${w.phrase}`, consents.askChange(agent, { kind: "add_agent", workspaceId: w.id, subject: a })) };
      workspaces.addAgent(ownerId, w.id, a.id);
      return { portico: view(w), note: `\`${addr(a)}\` is in ${w.phrase}: everyone there can message \`${addr(a)}\`.` };
    }
    case "remove_from_portico": {
      const w = portico();
      const who = text("person");
      const which = text("agent");
      if ((who === "") === (which === "")) throw new PorticoError("bad_request", "Give agent or person: one of the two.");
      if (who !== "") {
        const ask = consents.ask(agent, "remove_person", w.id, { person: who });
        return { portico: ref(w), ...waiting(`taking ${nameOf(ask.detail.personId!, quote(who))} out of ${w.phrase}`, ask) };
      }
      if (which.includes("/") && !agents.ownedBy(ownerId).some((a) => addr(a) === which || agents.addressFor(a, ownerId) === which)) {
        throw new PorticoError(
          "not_allowed",
          `\`${which}\` is another person's agent. ${me} can take the agent out on the Portico's page, ${deps.publicUrl()}/p/${w.id}, ` +
            "or remove_from_portico with person takes that person out with every agent that person has there.",
        );
      }
      const a = own(which);
      if (agent.unproven) return { portico: ref(w), ...waiting(`taking \`${addr(a)}\` out of ${w.phrase}`, consents.askChange(agent, { kind: "remove_agent", workspaceId: w.id, subject: a })) };
      workspaces.removeAgent(ownerId, w.id, a.id);
      return { portico: view(w), note: `\`${addr(a)}\` is out of ${w.phrase}: nobody reaches \`${addr(a)}\` through ${w.phrase} any more.` };
    }
    case "rename_portico": {
      const w = portico();
      if (agent.unproven) return { portico: ref(w), ...waiting(`renaming ${w.phrase}`, consents.askChange(agent, { kind: "rename", workspaceId: w.id, name: args.name ?? "" })) };
      const renamed = workspaces.rename(ownerId, w.id, args.name ?? "");
      return { portico: view(renamed), note: cap(`${w.phrase} is now ${renamed.phrase}.`) };
    }
    case "delete_portico": {
      const w = portico();
      const ask = consents.ask(agent, "delete", w.id);
      return { portico: ref(w), ...waiting(`deleting ${w.phrase}`, ask) };
    }
    case "share_portico": {
      const w = portico();
      const ask = consents.ask(agent, "share", w.id, { email: args.email, agents: args.agents });
      return { portico: ref(w), ...waiting(`sharing ${w.phrase}${ask.detail.email ? ` with ${ask.detail.email}` : " with one more person"}`, ask) };
    }
    case "join_portico": {
      const request = consents.enter(agent, args.link);
      const w = request.workspaceId ? workspaces.get(request.workspaceId) : null;
      return { ...(w ? { portico: ref(w) } : {}), ...waiting(`this agent coming into ${w?.phrase ?? "the Portico"}`, request) };
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
