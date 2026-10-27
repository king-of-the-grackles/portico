import type { Agents } from "../core/agents";
import type { Approvals } from "../core/approvals";
import type { Messages } from "../core/messages";
import type { People } from "../core/people";
import type {
  Agent,
  AgentKind,
  AgentType,
  Decision,
  LiveStatus,
  Message,
  MessageStatus,
  Person,
  PersonStatus,
  Role,
  Thread,
} from "../core/types";

// The person API's shapes, camelCase. Home, Settings and any later client render from these and nothing else.

export interface PersonRef {
  id: string;
  name: string;
}

export interface PersonView extends PersonRef {
  role: Role;
  status: PersonStatus;
  isMe: boolean;
  agentCount: number;
}

export interface AgentRef {
  id: string;
  display: string;
  kind: AgentKind;
}

export interface AgentView {
  id: string;
  name: string;
  address: string;
  display: string;
  kind: AgentKind;
  type: AgentType;
  description: string;
  owner: PersonRef;
  /** The signed-in person manages this agent. */
  mine: boolean;
  computer: { id: string; name: string } | null;
  folder: string | null;
  /** Sessions: the folder's "Join from the folder" switch. Null for apps and connectors. */
  joinFromFolder: boolean | null;
  status: LiveStatus | null;
  doing: string | null;
  repo: string | null;
  branch: string | null;
  lastSeen: string | null;
  checkInMinutes: number | null;
  approvalRequired: boolean;
  createdAt: string;
}

export interface AllowEntry {
  sender: AgentRef;
  addedBy: PersonRef;
  addedAt: string;
}

export interface MessageView {
  id: string;
  threadId: string;
  from: AgentRef;
  to: AgentRef;
  subject: string;
  text: string;
  /** The message this one answers, for the one-line quote. */
  replyTo: { id: string; from: AgentRef; subject: string; text: string } | null;
  status: MessageStatus;
  createdAt: string;
  expiresAt: string;
  deliveredAt: string | null;
  decision: Decision | null;
  decidedAt: string | null;
  decidedBy: PersonRef | null;
}

/** A held message as its approval card shows it, with the facts Portico checks itself. */
export interface HeldCard extends MessageView {
  facts: { managedBy: PersonRef; replyToRecipient: boolean; earlier: { decision: Decision; at: string }[] };
}

export interface ThreadView {
  id: string;
  a: AgentRef;
  b: AgentRef;
  startedBy: string;
  lastMessageAt: string;
  last: { from: AgentRef; subject: string; text: string; status: MessageStatus } | null;
  count: number;
  held: number;
}

// Shapes other tracks build. Kept here so every client agrees on them.

/** An app agent's request to join, shown under Needs approval with its 4-digit code. */
export interface SignInView {
  id: string;
  kind: AgentKind;
  name: string;
  code: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
}

export interface ComputerView {
  id: string;
  name: string;
  lastSeen: string | null;
  sessions: AgentView[];
}

export interface InviteView {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  status: "open" | "claimed" | "revoked" | "expired";
  /** The link to copy, while the invite is open. Only the owner sees invites. */
  link: string | null;
}

export interface ClaimView {
  personId: string;
  name: string;
  inviteName: string;
  claimedAt: string;
}

export interface PasskeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ViewDeps {
  agents: Agents;
  people: People;
  messages: Messages;
  approvals: Approvals;
}

/** The longest text a reply quote or a thread's last line carries; the page clips further. */
const QUOTE_MAX = 200;

function clipText(text: string, max = QUOTE_MAX): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** View builders for one signed-in person. */
export function personViews(deps: ViewDeps, me: Person) {
  const { agents, people, messages, approvals } = deps;
  const peopleById = new Map<string, Person | null>();
  const personRef = (id: string): PersonRef => {
    if (!peopleById.has(id)) peopleById.set(id, people.get(id));
    const person = peopleById.get(id);
    return { id, name: person?.name ?? "" };
  };
  const agentRef = (id: string): AgentRef => {
    const agent = agents.get(id);
    return agent ? { id, display: agents.display(agent), kind: agent.kind } : { id, display: id, kind: "other" };
  };

  const agent = (a: Agent): AgentView => {
    const entry = agents.entry(a);
    return {
      id: a.id,
      name: a.name,
      address: entry.address,
      display: entry.display,
      kind: a.kind,
      type: a.type,
      description: a.description,
      owner: personRef(a.ownerId),
      mine: a.ownerId === me.id,
      computer: a.computerId && a.computer ? { id: a.computerId, name: a.computer } : null,
      folder: a.folder,
      joinFromFolder: agents.joinsFromFolder(a),
      status: entry.status,
      doing: entry.doing,
      repo: entry.repo,
      branch: entry.branch,
      lastSeen: entry.lastSeen,
      checkInMinutes: entry.checkInMinutes,
      approvalRequired: a.approvalRequired,
      createdAt: a.createdAt,
    };
  };

  const message = (m: Message): MessageView => {
    const original = m.replyTo ? messages.get(m.replyTo) : null;
    return {
      id: m.id,
      threadId: m.threadId,
      from: agentRef(m.fromId),
      to: agentRef(m.toId),
      subject: m.subject,
      text: m.text,
      replyTo: original
        ? { id: original.id, from: agentRef(original.fromId), subject: original.subject, text: clipText(original.text) }
        : null,
      status: m.status,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
      deliveredAt: m.deliveredAt,
      decision: m.decision,
      decidedAt: m.decidedAt,
      decidedBy: m.decidedBy ? personRef(m.decidedBy) : null,
    };
  };

  /** The card quotes the message this one answers: reply_to, or else the recipient's message just before it. */
  const held = (m: Message): HeldCard => {
    const facts = approvals.facts(m);
    const view = message(m);
    const previous = view.replyTo === null && facts.replyToRecipient ? messages.previous(m) : null;
    return {
      ...view,
      replyTo: previous
        ? { id: previous.id, from: agentRef(previous.fromId), subject: previous.subject, text: clipText(previous.text) }
        : view.replyTo,
      facts: { managedBy: personRef(facts.managedBy.id), replyToRecipient: facts.replyToRecipient, earlier: facts.earlier },
    };
  };

  const thread = (t: Thread): ThreadView => {
    const summary = messages.threadSummary(t.id);
    return {
      id: t.id,
      a: agentRef(t.aId),
      b: agentRef(t.bId),
      startedBy: t.startedBy,
      lastMessageAt: t.lastMessageAt,
      last: summary.last
        ? {
            from: agentRef(summary.last.fromId),
            subject: summary.last.subject,
            text: clipText(summary.last.text),
            status: summary.last.status,
          }
        : null,
      count: summary.count,
      held: summary.held,
    };
  };

  const person = (p: Person): PersonView => ({
    id: p.id,
    name: p.name,
    role: p.role,
    status: p.status,
    isMe: p.id === me.id,
    agentCount: agents.ownedBy(p.id).length,
  });

  const allowEntry = (entry: { senderId: string; addedBy: string; addedAt: string }): AllowEntry => ({
    sender: agentRef(entry.senderId),
    addedBy: personRef(entry.addedBy),
    addedAt: entry.addedAt,
  });

  return { agent, message, held, thread, person, allowEntry, agentRef, personRef };
}

export type PersonViews = ReturnType<typeof personViews>;

/** The owner sees every thread. A member sees only threads with at least one of the member's own agents. */
export function canSeeThread(agents: Agents, me: Person, thread: Thread): boolean {
  if (me.role === "owner") return true;
  const mine = new Set(agents.ownedBy(me.id).map((a) => a.id));
  return mine.has(thread.aId) || mine.has(thread.bId);
}

/** Every agent, the signed-in person's first, then by owner, then as the agent list orders them. */
export function agentsInOrder(agents: Agents, me: Person): Agent[] {
  const entries = agents.entries();
  return [
    ...entries.filter((e) => e.agent.ownerId === me.id),
    ...entries.filter((e) => e.agent.ownerId !== me.id),
  ].map((e) => e.agent);
}
