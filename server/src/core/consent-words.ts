import { computerSlug } from "./computers";
import type { ConsentView } from "./consents";
import { quote } from "./framing";

export { quote };
import { LIMITS } from "./limits";
import type { Agent } from "./types";

/** Why an agent that could act at once asks first. */
const NEW_ASKER = (me: string) => `Portico asks because the agent joined lately and ${me} hasn't vouched for the agent yet. Not an agent ${me} started? Choose Don't allow and revoke the agent on the agent's page.`;

const KIND_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  muse: "Muse",
  "grok-bot": "Grok Bot",
  dots: "Dots",
  "claude-duet": "Claude Duet",
};

/** What a consent request means, in Portico's own words. Plain text: the page and the email escape it. */
export interface ConsentWords {
  /** The page's heading. */
  title: string;
  /** Who asks for what. The only sentence that carries quotes. */
  asks: string;
  /** What happens once allowed. */
  then: string[];
  /** The Allow button. */
  allow: string;
}

/**
 * The words for one request, as the person deciding reads them. `me` is that person's name; `agentName` is how the
 * person knows the asking agent, for the kinds an agent of the person's asks.
 */
export function consentWords(view: ConsentView, me: string, agentName: (agent: Agent) => string): ConsentWords {
  const words = wordsFor(view, me, agentName);
  // An agent nobody vouched for asks: the page says so, whatever is asked.
  const asks = view.agent?.unproven && view.request.agentId === view.agent.id && view.request.personId === view.agent.ownerId;
  return asks ? { ...words, then: [...words.then, NEW_ASKER(me)] } : words;
}

function wordsFor(view: ConsentView, me: string, agentName: (agent: Agent) => string): ConsentWords {
  const { request, workspace, sharedBy, target } = view;
  const asker = view.agent && request.kind !== "agent" ? `The agent ${quote(agentName(view.agent))}` : "An agent";
  const place = workspace ? `the Portico ${quote(workspace.name)}` : "a Portico";
  const by = sharedBy ? `${sharedBy.name}${sharedBy.handle ? ` (${sharedBy.handle})` : ""}` : "someone";
  switch (request.kind) {
    case "computer": {
      const app = request.agentKind ? KIND_LABELS[request.agentKind] : null;
      return {
        title: "Let a computer join Portico",
        asks: `A computer asks to join Portico as ${quote(computerSlug(request.name ?? "computer"))}${app ? `, from ${app}` : ""}.`,
        then: [
          `Once the computer has joined, the computer belongs to ${me}. Each Claude Code or Codex session started there joins your Portico as an agent, and ${me}'s other agents can message that session.`,
        ],
        allow: "Allow",
      };
    }
    case "agent": {
      const app = request.agentKind && request.agentKind !== "other" ? KIND_LABELS[request.agentKind] : null;
      const into = view.share
        ? `Once the agent has joined, the agent belongs to ${me}, joins your Portico, and comes into ${place}, shared by ${by}. Everyone in that Portico can message the agent.`
        : `Once the agent has joined, the agent belongs to ${me} and joins your Portico, where ${me}'s other agents can message the agent.`;
      return {
        title: "Let an agent join Portico",
        asks: `An agent asks to join Portico as ${quote(request.name ?? "agent")}${app ? `, and says the app is ${app}` : ""}.`,
        then: [into],
        allow: "Allow",
      };
    }
    case "enter":
      return {
        title: "Come into a Portico",
        asks: `${asker} asks to come into ${place}, shared by ${by}.`,
        then: [
          `Once allowed, ${me} comes into that Portico with the agents ticked below. Everyone in that Portico can message those agents, and those agents can message the agents there.`,
          view.share?.agentsPolicy === "ask"
            ? `${by} asked to allow each agent ${me} adds there later.`
            : `${me} can add more agents there later, with no further question.`,
          "The share link works once: afterwards the link lets nobody else in.",
        ],
        allow: "Allow",
      };
    case "add_agent": {
      const subject = view.subject ? quote(agentName(view.subject)) : "an agent";
      return {
        title: "Put an agent in a Portico",
        asks: `${asker} asks to put the agent ${subject} into ${place}.`,
        then: ["Once allowed, everyone in that Portico can message the agent, and the agent can message the agents there."],
        allow: "Allow",
      };
    }
    case "admit_agent": {
      const who = target ? `${target.name}${target.handle ? ` (${target.handle})` : ""}` : "A person in the Portico";
      const subject = view.subject ? quote(agentName(view.subject)) : "an agent";
      return {
        title: "Let one more agent into a Portico",
        asks: `${who} asks to put the agent ${subject} into ${place}.`,
        then: [
          `${me} chose to be asked for each agent ${target?.name ?? "that person"} adds there. Once allowed, everyone in that Portico can message the agent, and the agent can message the agents there.`,
          "Only the owner of the Portico, signed in, can answer here.",
        ],
        allow: "Allow",
      };
    }
    case "share": {
      const email = request.detail.email;
      return {
        title: "Share a Portico",
        asks: `${asker} asks to share ${place} with ${email ? quote(email) : "one more person"}.`,
        then: [
          `Once allowed, Portico makes a link that lets one person into that Portico, once, within ${LIMITS.shareDays} days, with the agents that person chooses. Those agents and the agents already there can then message each other.`,
          request.detail.agents === "ask"
            ? `That person asks ${me} for each agent added there afterwards.`
            : `That person can add more of that person's own agents there afterwards, with no further question.`,
          email ? "Portico emails the link to that address, and only an account with that address can use the link." : "The link shows here next, to hand to that person.",
          `${me} is told who came in, and can take that person out in one step.`,
        ],
        allow: "Allow",
      };
    }
    case "remove_person": {
      const who = target ? `${target.name}${target.handle ? ` (${target.handle})` : ""}` : "a person";
      return {
        title: "Take a person out of a Portico",
        asks: `${asker} asks to take ${who} out of ${place}.`,
        then: [`Once allowed, ${target?.name ?? "that person"} leaves with every agent ${target?.name ?? "that person"} has there, and the conversations with those agents become read-only.`],
        allow: "Allow",
      };
    }
    case "create": {
      const count = request.detail.agentIds?.length ?? 0;
      return {
        title: "Make a Portico",
        asks: `${asker} asks to make a Portico named ${quote(request.detail.name || "after the people there")}, with ${count === 1 ? "1 agent" : `${count} agents`} of ${me}'s inside.`,
        then: [`Once allowed, the Portico is ${me}'s, and nobody else is in that Portico until ${me} shares the Portico.`],
        allow: "Allow",
      };
    }
    case "remove_agent": {
      const subject = view.subject ? quote(agentName(view.subject)) : "an agent";
      return {
        title: "Take an agent out of a Portico",
        asks: `${asker} asks to take the agent ${subject} out of ${place}.`,
        then: ["Once allowed, nobody reaches the agent through that Portico any more."],
        allow: "Allow",
      };
    }
    case "rename":
      return {
        title: "Rename a Portico",
        asks: `${asker} asks to rename ${place} to ${quote(request.detail.name || "the names of the people there")}.`,
        then: ["Once allowed, everyone in that Portico sees the new name."],
        allow: "Allow",
      };
    case "delete":
      return {
        title: "Delete a Portico",
        asks: `${asker} asks to delete ${place}.`,
        then: ["Once allowed, nobody reaches anyone through that Portico any more, and the conversations there become read-only. Deleting can't be undone."],
        allow: "Allow",
      };
  }
}
