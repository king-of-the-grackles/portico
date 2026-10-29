import type { ActivityEntry, ActivityKind } from "../core/activity";
import type { Agents, Run } from "../core/agents";
import type { Approvals } from "../core/approvals";
import type { Messages } from "../core/messages";
import type { People } from "../core/people";
import type { Task, TaskOutcome, TaskReason, TaskStepKind } from "../core/tasks";
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
  /** The name people see: "Claude Code (portico)", "Grok Bot". */
  label: string;
  kind: AgentKind;
}

export interface AgentView {
  id: string;
  name: string;
  address: string;
  display: string;
  /** The name people see: "Claude Code (portico)", "Grok Bot". */
  label: string;
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
  /** Sessions: how many terminals or Codex conversations are open in the folder now. */
  liveRuns: number;
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
  replyTo: { id: string; from: AgentRef; subject: string; text: string; createdAt: string } | null;
  status: MessageStatus;
  createdAt: string;
  expiresAt: string;
  deliveredAt: string | null;
  decision: Decision | null;
  decidedAt: string | null;
  decidedBy: PersonRef | null;
}

/** A held message as its approval card shows it, with the facts Portico checks itself (managedBy: the sender's manager). */
export interface HeldCard extends MessageView {
  facts: { managedBy: PersonRef; replyToRecipient: boolean; earlier: { decision: Decision; at: string }[] };
}

/** One side of a thread, with who manages the agent: the panel names managers when two people's agents talk. */
export interface ThreadAgent extends AgentRef {
  owner: PersonRef;
}

export interface ThreadView {
  id: string;
  a: ThreadAgent;
  b: ThreadAgent;
  startedBy: string;
  lastMessageAt: string;
  last: { from: AgentRef; subject: string; text: string; status: MessageStatus } | null;
  count: number;
  held: number;
}

/** One task: a conversation between two agents, with where it stands. */
export interface TaskView {
  id: string;
  subject: string;
  from: AgentRef;
  to: AgentRef;
  outcome: TaskOutcome;
  /** For failed: why. */
  reason: TaskReason | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** When the first message was held for a decision, and when the agent asked picked it up. */
  heldAt: string | null;
  pickedUpAt: string | null;
  /** The latest answer: its subject, the one-line summary its sender wrote, and whether more is coming. */
  answer: { id: string; subject: string; summary: string | null; final: boolean; createdAt: string } | null;
  heldMessageId: string | null;
  messageCount: number;
  /** A session's folder on either side, for the Project filter. */
  project: string | null;
  steps: { kind: TaskStepKind; at: string; by: PersonRef | null; decision: Decision | null }[];
}

/** One run of a session agent: a terminal or a Codex conversation. */
export interface RunView {
  id: string;
  agent: AgentRef;
  client: "claude-code" | "codex";
  startedAt: string;
  lastSeenAt: string;
  /** Null while open. A run Portico lost track of (it restarted) shows its last sighting. */
  endedAt: string | null;
  live: boolean;
}

/** One line of the activity record: joins, sessions, decisions and settings changes. */
export interface ActivityView {
  id: string;
  at: string;
  kind: ActivityKind | "session_started" | "session_ended";
  agent: AgentRef | null;
  other: AgentRef | null;
  person: PersonRef | null;
  detail: Record<string, string | boolean | null>;
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
  const refs = new Map<string, AgentRef>();
  const agentRef = (id: string): AgentRef => {
    const known = refs.get(id);
    if (known) return known;
    const agent = agents.get(id);
    const ref: AgentRef = agent
      ? { id, display: agents.display(agent), label: agents.label(agent), kind: agent.kind }
      : { id, display: id, label: id, kind: "other" };
    refs.set(id, ref);
    return ref;
  };

  const agent = (a: Agent): AgentView => {
    const entry = agents.entry(a);
    return {
      id: a.id,
      name: a.name,
      address: entry.address,
      display: entry.display,
      label: agents.label(a),
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
      liveRuns: agents.liveRuns(a.id),
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
        ? {
            id: original.id,
            from: agentRef(original.fromId),
            subject: original.subject,
            text: clipText(original.text),
            createdAt: original.createdAt,
          }
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
        ? {
            id: previous.id,
            from: agentRef(previous.fromId),
            subject: previous.subject,
            text: clipText(previous.text),
            createdAt: previous.createdAt,
          }
        : view.replyTo,
      facts: { managedBy: personRef(facts.managedBy.id), replyToRecipient: facts.replyToRecipient, earlier: facts.earlier },
    };
  };

  const threadAgent = (id: string): ThreadAgent => {
    const agent = agents.get(id);
    return agent
      ? { id, display: agents.display(agent), label: agents.label(agent), kind: agent.kind, owner: personRef(agent.ownerId) }
      : { id, display: id, label: id, kind: "other", owner: personRef("") };
  };

  const thread = (t: Thread): ThreadView => {
    const summary = messages.threadSummary(t.id);
    return {
      id: t.id,
      a: threadAgent(t.aId),
      b: threadAgent(t.bId),
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

  /** A page of a thread's messages, the newest by default: what the thread panel shows. */
  const threadData = (
    t: Thread,
    range: { before?: string; limit?: number } = {},
  ): { thread: ThreadView; messages: MessageView[]; more: boolean } => {
    const page = messages.inThread(t.id, range);
    return { thread: thread(t), messages: page.messages.map(message), more: page.more };
  };

  const projectOf = (id: string): string | null => {
    const a = agents.get(id);
    return a?.type === "session" ? a.folder : null;
  };

  const task = (t: Task): TaskView => ({
    id: t.id,
    subject: t.subject,
    from: agentRef(t.fromId),
    to: agentRef(t.toId),
    outcome: t.outcome,
    reason: t.reason,
    startedAt: t.startedAt,
    updatedAt: t.updatedAt,
    endedAt: t.endedAt,
    heldAt: t.heldAt,
    pickedUpAt: t.pickedUpAt,
    answer: t.answer,
    heldMessageId: t.heldMessageId,
    messageCount: t.messageCount,
    project: projectOf(t.toId) ?? projectOf(t.fromId),
    steps: t.steps.map((step) => ({
      kind: step.kind,
      at: step.at,
      by: step.personId ? personRef(step.personId) : null,
      decision: step.decision,
    })),
  });

  const run = (r: Run): RunView => ({
    id: r.id,
    agent: agentRef(r.agentId),
    client: r.client,
    startedAt: r.startedAt,
    lastSeenAt: r.lastSeenAt,
    endedAt: r.endedAt,
    live: agents.isRunLive(r.id),
  });

  const activity = (e: ActivityEntry): ActivityView => ({
    id: e.id,
    at: e.at,
    kind: e.kind,
    agent: e.agentId ? agentRef(e.agentId) : null,
    other: e.otherId ? agentRef(e.otherId) : null,
    person: e.personId ? personRef(e.personId) : null,
    detail: e.detail,
  });

  return { agent, message, held, thread, threadData, person, allowEntry, agentRef, personRef, task, run, activity };
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
