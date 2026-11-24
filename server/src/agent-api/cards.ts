import type { Agents } from "../core/agents";
import { type ConsentRequest, type Consents, isJoin } from "../core/consents";
import { PorticoError } from "../core/errors";
import { defangLine, quote } from "../core/framing";
import type { Messages } from "../core/messages";
import type { People } from "../core/people";
import type { Agent, Message } from "../core/types";
import type { Workspaces } from "../core/workspaces";
import type { AgentViews } from "./views";

/**
 * The status card: what portico_status answers, as data for the one page an MCP Apps host draws (card-page.ts) and as
 * the text every other client reads. The card shows, and links to Portico's own pages. Allowing happens on those pages,
 * with the person signed in: a card click reaches Portico as an ordinary tool call, so no tool here changes anything.
 *
 * Nothing secret goes on a card: no join code, no token, no share link. In ChatGPT the model reads the card's data too.
 */

/** The page's address. A cache key for hosts: a change that breaks the page gets a new version in the name. */
export const CARD_URI = "ui://portico/status-v1.html";
/** The media type MCP Apps gives a page a host may draw. */
export const CARD_MIME_TYPE = "text/html;profile=mcp-app";

/** What a card is about. A new kind of card is one more name here and one more builder below: the page draws any of them. */
export const CARD_STATES = ["joined", "message", "request"] as const;
export type CardState = (typeof CARD_STATES)[number];

type Tone = "ok" | "wait" | "no" | "quiet";

export interface StatusCard {
  state: CardState;
  /** Where the thing stands, in the words its own tool uses: a message's status, a request's status, or `joined`. */
  status: string;
  /** The message's or the request's ID. */
  id?: string;
  /** The short word in the corner. */
  pill: { text: string; tone: Tone };
  title: string;
  /** A message's subject, as its sender wrote the subject: shown as a quote, never as markup. */
  quote?: string;
  lines: string[];
  /** One-line checks under the text. */
  facts: { text: string; tone: "ok" | "warn" }[];
  /** A time the page shows in the reader's own time zone. */
  ends?: { label: string; at: string };
  /** The one button. Always on Portico's public URL, and only when this agent's own person is the one to open the page. */
  link?: { label: string; url: string; primary: boolean; help: string };
}

export interface CardDeps {
  agents: Agents;
  people: People;
  messages: Messages;
  consents: Consents;
  workspaces: Workspaces;
  views: AgentViews;
  publicUrl: () => string;
  now: () => Date;
}

const cap = (sentence: string) => sentence.charAt(0).toUpperCase() + sentence.slice(1);

/** portico_status: the card for a message this agent sent, a request this agent made, or this agent's own standing. */
export function statusCard(deps: CardDeps, agent: Agent, args: Record<string, unknown>): StatusCard {
  const id = (key: string): string | null => {
    const value = args[key];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") throw new PorticoError("bad_request", `${key} must be an ID.`);
    return value.trim();
  };
  const message = id("message");
  const request = id("request");
  if (message !== null && request !== null) throw new PorticoError("bad_request", "Give message or request, not both.");
  if (message !== null) return messageCard(deps, agent, message);
  if (request !== null) return requestCard(deps, agent, request);
  return joinedCard(deps, agent);
}

/** A person's name as a sentence carries it: a quote, since a person typed it. */
function named(deps: CardDeps, personId: string | null, fallback: string): string {
  const name = personId === null ? "" : (deps.people.get(personId)?.name ?? "");
  return name === "" ? fallback : quote(name);
}

const host = (deps: CardDeps) => new URL(deps.publicUrl()).host;
const MANAGER = "the person who manages this agent";

function joinedCard(deps: CardDeps, agent: Agent): StatusCard {
  const name = deps.views.nameOf(agent.id, agent);
  const me = named(deps, agent.ownerId, MANAGER);
  const wake = deps.views.wakeStatus(agent).wake;
  const held = deps.views.heldForPerson(agent).held_for_person;
  const facts: StatusCard["facts"] = [];
  if (wake) {
    if (wake.on) facts.push({ text: "New messages wake this agent right away", tone: "ok" });
    else if (wake.how === "schedule" && wake.schedule_minutes !== null) facts.push({ text: `This agent checks for new messages every ${wake.schedule_minutes} minutes`, tone: "warn" });
    else facts.push({ text: "Not getting new messages automatically yet", tone: "warn" });
  }
  facts.push(
    held === 0
      ? { text: `Nothing waits for a decision by ${me}`, tone: "ok" }
      : { text: `${held === 1 ? "1 message waits" : `${held} messages wait`} for a decision by ${me}`, tone: "warn" },
  );
  return {
    state: "joined",
    status: "joined",
    pill: { text: "Joined", tone: "ok" },
    title: `${name} is on Portico`,
    lines: [`Joined as ${name}, managed by ${me}. Agents that share a Portico with ${name} can message this agent.`],
    facts,
    link:
      held === 0
        ? { label: "Open Portico", url: `${deps.publicUrl()}/`, primary: false, help: `Opens ${host(deps)}.` }
        : { label: "Review on Portico", url: `${deps.publicUrl()}/`, primary: true, help: `Opens ${host(deps)}. Decisions happen there, after ${me} signs in.` },
  };
}

function messageCard(deps: CardDeps, agent: Agent, id: string): StatusCard {
  const m = deps.messages.get({ agent: agent.id }, id);
  // A message this agent received, another agent's message and no message at all answer the same.
  if (!m || m.fromId !== agent.id) throw new PorticoError("not_found", "No such message.");
  const to = deps.views.nameOf(m.toId, agent);
  const me = named(deps, agent.ownerId, MANAGER);
  const base = { state: "message" as const, id: m.id, quote: m.subject, facts: [] };
  const open = m.status === "held" || m.status === "pending";
  const status = open && m.expiresAt <= deps.now().toISOString() ? "expired" : m.status;
  const by = named(deps, m.decidedBy, "A person");
  switch (status) {
    case "held": {
      // The sender's own person for an outbound hold, otherwise the receiver's. Null once that agent is gone.
      const deciderId = deps.agents.get(m.heldFor === "outbound" ? m.fromId : m.toId)?.ownerId ?? null;
      const own = deciderId === agent.ownerId;
      const decider = own ? me : named(deps, deciderId, "that agent's person");
      return {
        ...base,
        status,
        pill: { text: "Held", tone: "wait" },
        title: `Message to ${to} is held`,
        lines: [
          heldWhy(m, agent, me, decider, to),
          own ? `Nothing is delivered until ${me} decides on Portico.` : `Nothing is delivered until ${decider} decides on Portico. Only ${decider} can open that page.`,
        ],
        ends: { label: "The message waits until", at: m.expiresAt },
        ...(own
          ? { link: { label: "Review on Portico", url: `${deps.publicUrl()}/held/${m.id}`, primary: true, help: `Opens ${host(deps)}. Allowing happens there, after ${me} signs in.` } }
          : {}),
      };
    }
    case "pending":
      return {
        ...base,
        status,
        pill: m.heldAt === null ? { text: "Sent", tone: "quiet" } : { text: "Allowed", tone: "ok" },
        title: `Message to ${to} is on the way`,
        lines: [`${m.heldAt === null ? "" : `${by} allowed the message. `}${to} hasn't picked the message up yet.`],
      };
    case "delivered":
      return {
        ...base,
        status,
        pill: m.heldAt === null ? { text: "Delivered", tone: "ok" } : { text: "Allowed", tone: "ok" },
        title: `Message to ${to} was delivered`,
        lines: [m.heldAt === null ? `${to} has the message now.` : `${by} allowed the message, and ${to} has the message now.`],
      };
    case "declined":
      return {
        ...base,
        status,
        pill: { text: "Not allowed", tone: "no" },
        title: `Message to ${to} was not delivered`,
        lines: [`${by} chose Don't allow on Portico. Nothing was delivered.`],
      };
    case "expired":
      return {
        ...base,
        status,
        pill: { text: "Expired", tone: "quiet" },
        title: `Message to ${to} expired`,
        lines: [m.heldAt !== null && m.decision === null ? "Nobody decided in time. Nothing was delivered." : `${to} didn't pick the message up in time.`],
      };
    default:
      return {
        ...base,
        status,
        pill: { text: "Withdrawn", tone: "quiet" },
        title: `Message to ${to} was withdrawn`,
        lines: ["The Portico the message went through was paused, or one of the two agents left. The message was not delivered."],
      };
  }
}

/** Why a message is held, in one sentence. */
function heldWhy(m: Message, agent: Agent, me: string, decider: string, to: string): string {
  if (m.heldFor === "outbound") {
    return agent.outboundHold
      ? `${me} asked to see each message this agent sends to other people's agents first.`
      : `This agent is new and ${me} hasn't confirmed this agent yet, so ${me} sees each message this agent sends to other people's agents first.`;
  }
  if (m.heldFor === "new_agent") return `This agent is new and ${me} hasn't confirmed this agent yet, so ${me} is asked once before this agent's first message reaches ${to}.`;
  if (m.heldFor === "first_contact") return `${decider}, who manages ${to}, hasn't allowed messages from ${me}'s agents yet.`;
  return `${to} requires approval for new conversations.`;
}

function requestCard(deps: CardDeps, agent: Agent, id: string): StatusCard {
  const request = deps.consents.get(id);
  // A join is never shown: the page behind a join holds the code, which no agent gets from Portico. Another agent's
  // request and no request at all answer the same.
  if (!request || request.agentId !== agent.id || isJoin(request.kind)) throw new PorticoError("not_found", "No such request.");
  const me = named(deps, agent.ownerId, MANAGER);
  const what = requestWhat(deps, agent, request);
  const base = { state: "request" as const, id: request.id, facts: [] };
  const status = request.status === "pending" && request.expiresAt <= deps.now().toISOString() ? "expired" : request.status;
  // What waits for a Portico's owner has a page that is the owner's alone.
  const forOwner = request.kind === "admit_agent";
  const place = request.workspaceId ? deps.workspaces.known(request.workspaceId) : null;
  const owner = named(deps, place?.ownerId ?? null, "the Portico's owner");
  const by = named(deps, request.decidedBy, "A person");
  switch (status) {
    case "pending":
      if (forOwner) {
        return {
          ...base,
          status,
          pill: { text: "Waiting", tone: "wait" },
          title: `${cap(what)} waits for ${owner}`,
          lines: [`${owner} asked to allow each agent ${me} adds there, and decides on Portico. Only ${owner} can open that page. Nothing has changed yet.`],
          ends: { label: "The request waits until", at: request.expiresAt },
        };
      }
      return {
        ...base,
        status,
        pill: { text: "Waiting", tone: "wait" },
        title: `Allow ${what}?`,
        lines: [`${deps.views.nameOf(agent.id, agent)} asks ${me} to allow ${what}. Nothing has changed yet.`],
        ends: { label: "The request runs out at", at: request.expiresAt },
        link: { label: "Review on Portico", url: `${deps.publicUrl()}/c/${request.id}`, primary: true, help: `Opens ${host(deps)}. Allowing happens there, after ${me} signs in.` },
      };
    case "approved":
      return {
        ...base,
        status,
        pill: { text: "Allowed", tone: "ok" },
        title: `${cap(what)} was allowed`,
        lines: [`${by} chose Allow on Portico.${request.kind === "share" ? " list_porticos shows the share link to the agent that asked." : ""}`],
      };
    case "denied":
      return {
        ...base,
        status,
        pill: { text: "Not allowed", tone: "no" },
        title: `${cap(what)} was not allowed`,
        lines: [`${by} chose Don't allow on Portico. Nothing has changed.`],
      };
    default:
      return {
        ...base,
        status: "expired",
        pill: { text: "Ran out", tone: "quiet" },
        title: "The request ran out",
        lines: [`Nobody allowed ${what} in time. Nothing has changed. The same call again makes a fresh request.`],
      };
  }
}

/** What a request asks for, read from the request's own row: the words that follow "allow". */
function requestWhat(deps: CardDeps, agent: Agent, request: ConsentRequest): string {
  const place = request.workspaceId ? deps.workspaces.known(request.workspaceId) : null;
  const phrase = place?.phrase ?? "a Portico";
  const subject = request.detail.agentId ? deps.agents.get(request.detail.agentId) : null;
  const subjectName = subject ? deps.agents.nameFor(subject, agent.ownerId) : "an agent";
  switch (request.kind) {
    case "share":
      return `sharing ${phrase} with ${request.detail.email ? quote(request.detail.email) : "one more person"}`;
    case "delete":
      return `deleting ${phrase}`;
    case "remove_person":
      return `taking ${named(deps, request.detail.personId ?? null, "a person")} out of ${phrase}`;
    case "enter":
      return `this agent coming into ${phrase}`;
    case "add_agent":
    case "admit_agent":
      return `${subjectName} coming into ${phrase}`;
    case "remove_agent":
      return `taking ${subjectName} out of ${phrase}`;
    case "rename":
      return `renaming ${phrase}`;
    case "create":
      return request.detail.name ? `making the Portico ${quote(request.detail.name)}` : "making a Portico";
    default:
      return "a change";
  }
}

/**
 * The card as text, complete: what stands where, for whom, and the whole link. A client that draws no cards shows this
 * and misses nothing.
 */
export function cardText(card: StatusCard): string {
  return [
    `Portico: ${card.title}`,
    `Status: ${card.pill.text}`,
    // The whole subject, on one line: the agent reading this wrote the subject.
    ...(card.quote !== undefined ? [`Subject: ${defangLine(card.quote)}`] : []),
    ...card.lines,
    ...(card.ends ? [`${card.ends.label} ${card.ends.at}.`] : []),
    ...card.facts.map((fact) => `- ${fact.text}`),
    ...(card.link ? [`${card.link.label}: ${card.link.url}`, card.link.help] : []),
  ].join("\n");
}

/** What tells a connector to show a held message or a waiting request on a card. Sessions and HTTP agents never see it. */
export function cardNudge(agent: Pick<Agent, "type">, kind: "message" | "request", id: string): string | null {
  if (agent.type !== "connector") return null;
  return `Then call portico_status with ${kind}: "${id}": in an app that draws cards, the person sees a card that says where the ${kind} stands.`;
}
