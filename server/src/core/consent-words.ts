import { computerSlug } from "./computers";
import type { ConsentView } from "./consents";
import { defang } from "./framing";
import { LIMITS } from "./limits";
import type { Agent } from "./types";

const MAX_QUOTE = 80;

/**
 * Text someone else supplied (a name an agent asked for, a Portico's name, an email address), made safe to show inside
 * Portico's own sentence: no control or format characters, no terminal escapes, no tag that poses as a frame, on one
 * line, cut to a length, and inside quotation marks so it reads as a quote and never as Portico speaking.
 */
export function quote(text: string): string {
  const clean = defang(text).replace(/\s+/g, " ").replace(/[“”"]/g, "'").trim();
  const chars = Array.from(clean);
  return `“${chars.length > MAX_QUOTE ? `${chars.slice(0, MAX_QUOTE).join("")}…` : clean}”`;
}

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
          `Once allowed, the computer belongs to ${me}. Each Claude Code or Codex session started there joins your Portico as an agent, and ${me}'s other agents can message that session.`,
        ],
        allow: "Allow",
      };
    }
    case "agent": {
      const app = request.agentKind && request.agentKind !== "other" ? KIND_LABELS[request.agentKind] : null;
      const into = view.share
        ? `Once allowed, the agent belongs to ${me}, joins your Portico, and comes into ${place}, shared by ${by}. Everyone in that Portico can message the agent.`
        : `Once allowed, the agent belongs to ${me} and joins your Portico, where ${me}'s other agents can message the agent.`;
      return {
        title: "Let an agent join Portico",
        asks: `An agent asks to join Portico as ${quote(request.name ?? "agent")}${app ? `, and says the app is ${app}` : ""}.`,
        then: [into],
        allow: "Allow",
      };
    }
    case "enter":
      return {
        title: "Let an agent into a Portico",
        asks: `${asker} asks to come into ${place}, shared by ${by}.`,
        then: [`Once allowed, everyone in that Portico can message the agent, and the agent can message the agents there. ${me} comes into the Portico too.`],
        allow: "Allow",
      };
    case "share": {
      const email = request.detail.email;
      return {
        title: "Share a Portico",
        asks: `${asker} asks to share ${place} with ${email ? quote(email) : "one more person"}.`,
        then: [
          `Once allowed, Portico makes a link that lets one person into that Portico for ${LIMITS.shareDays} days, with the agents that person chooses. Those agents and the agents already there can then message each other.`,
          email ? "Portico emails the link to that address, and only an account with that address can use the link." : "The link shows here next, to hand to that person.",
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
    case "delete":
      return {
        title: "Delete a Portico",
        asks: `${asker} asks to delete ${place}.`,
        then: ["Once allowed, nobody reaches anyone through that Portico any more, and the conversations there become read-only. Deleting can't be undone."],
        allow: "Allow",
      };
  }
}
