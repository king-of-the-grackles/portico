import type { ActivityEntry, ActivityKind } from "../core/activity";
import type { Agents, Run } from "../core/agents";
import type { Core } from "../core/core";
import type { Approvals } from "../core/approvals";
import type { Files } from "../core/files";
import type { Messages } from "../core/messages";
import type { People } from "../core/people";
import type { AnswerLevel, AnswerVia, Question, Questions, QuestionStatus } from "../core/questions";
import { neverSent, type Task, type TaskOutcome, type TaskReason, type Tasks, type TaskStepKind } from "../core/tasks";
import type { Workspaces } from "../core/workspaces";
import type {
  Agent,
  AgentKind,
  AgentType,
  Decision,
  HeldFor,
  LiveStatus,
  Message,
  MessageStatus,
  Person,
  PersonStatus,
  Role,
  Thread,
  Workspace,
} from "../core/types";

// The person API's shapes, camelCase. Home, Settings and any later client render from these and nothing else.

export interface PersonRef {
  id: string;
  name: string;
  /** What goes in front of the person's agents' names for everyone else. */
  handle?: string | null;
}

export interface PersonView extends PersonRef {
  role: Role;
  status: PersonStatus;
  isMe: boolean;
  agentCount: number;
  /** The signed-in person's own verified address, where sign-in is by account. Never anyone else's. */
  email?: string | null;
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
  /** "Ask me before this agent sends to other people's agents." Only said to the agent's own person. */
  outboundHold: boolean;
  /** When the agent's person revoked it, or null. */
  revokedAt: string | null;
  createdAt: string;
  /** Sessions: how many terminals or Codex conversations are open in the folder now. */
  liveRuns: number;
}

export interface AllowEntry {
  sender: AgentRef;
  addedBy: PersonRef;
  addedAt: string;
}

/** A file a message carries. The page downloads it from /api/files/:id. */
export interface FileView {
  id: string;
  name: string;
  type: string;
  size: number;
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
  /** The sender said no reply is needed: the "No reply needed" tag. */
  noReplyNeeded: boolean;
  files: FileView[];
}

/** A held message as its approval card shows it, with the facts Portico checks itself (managedBy: the sender's manager). */
export interface HeldCard extends MessageView {
  facts: { managedBy: PersonRef; heldFor: HeldFor; newSender: boolean; replyToRecipient: boolean; earlier: { decision: Decision; at: string }[] };
}

/**
 * Something one of the signed-in person's own agents asked that person ("Input needed"), with the text. Only ever
 * built for the person the question is for: nobody else gets one.
 */
export interface QuestionCard {
  id: string;
  agent: AgentRef;
  /** The agent's words: shown as a quote, never as Portico speaking. */
  question: string;
  detail: string | null;
  options: string[] | null;
  status: QuestionStatus;
  /** The task the question is about, when it is about one the person can still see. */
  task: { id: string; subject: string } | null;
  /** Set while the agent is new and its person hasn't confirmed it: when the agent was added. */
  newAgent: { addedAt: string } | null;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  /** The person's own answer, once given: the choice pressed, and what was typed. */
  answer: { option: string | null; text: string | null; at: string; via: AnswerVia | null; level: AnswerLevel | null } | null;
}

/** One side of a thread, with who manages the agent: the panel names managers when two people's agents talk. */
export interface ThreadAgent extends AgentRef {
  owner: PersonRef;
}

/**
 * Where a conversation runs. A pair of agents can have conversations in more than one Portico: when the Portico that
 * joined the two stops doing so, the conversation there is read-only and the next one starts in another the two share.
 * The pages show those under one heading, each part with this.
 */
export interface Place {
  workspaceId: string;
  /** The Portico's name as the signed-in person reads it: "Personal Portico", "Launch". Empty once the Portico's row is gone. */
  portico: string;
  /** The Portico no longer joins the two agents: nothing new goes in this conversation. */
  readOnly: boolean;
}

/**
 * A Portico's name as its heading: a person's own is "Personal Portico" to that person, and the shared one the person
 * started with is "Shared Portico".
 */
export function porticoTitle(w: Pick<Workspace, "kind" | "ownerId" | "name" | "starter">, me: Pick<Person, "id">): string {
  if (w.ownerId !== me.id) return w.name;
  return w.kind === "personal" ? "Personal Portico" : w.starter ? "Shared Portico" : w.name;
}

/** The same Portico inside a sentence: "your Personal Portico", "the Launch Portico". */
export function porticoPhrase(w: Pick<Workspace, "kind" | "ownerId" | "phrase" | "starter">, me: Pick<Person, "id">): string {
  if (w.ownerId !== me.id) return w.phrase;
  return w.kind === "personal" ? "your Personal Portico" : w.starter ? "your Shared Portico" : w.phrase;
}

export interface ThreadView extends Place {
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
export interface TaskView extends Place {
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
  /** The first message said no reply is needed: the task is done once that message is picked up. */
  noReplyNeeded: boolean;
  heldMessageId: string | null;
  messageCount: number;
  /** A session's folder on either side, for the Project filter. */
  project: string | null;
  /** `agent` is set on the steps about a question: the agent that asked its own person. */
  steps: { kind: TaskStepKind; at: string; by: PersonRef | null; decision: Decision | null; agent?: AgentRef | null }[];
  /**
   * One of the two agents waits for its own person's answer: who asked whom. Both people of the task see this, and
   * never the question.
   */
  waitingOn: { person: PersonRef; agent: AgentRef; askedAt: string } | null;
  /** The questions about this task that were asked of the signed-in person, with the text. Nobody else's. */
  questions: QuestionCard[];
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

export interface ComputerView {
  id: string;
  name: string;
  lastSeen: string | null;
  sessions: AgentView[];
  /** The person chose Always allow for this computer: sessions here aren't asked about for being new. */
  alwaysAllowed: boolean;
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
  workspaces: Workspaces;
  agents: Agents;
  people: People;
  messages: Messages;
  approvals: Approvals;
  files: Files;
  questions: Questions;
  tasks: Tasks;
}

/** The longest text a reply quote or a thread's last line carries; the page clips further. */
const QUOTE_MAX = 200;

function clipText(text: string, max = QUOTE_MAX): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** View builders for one signed-in person. */
export function personViews(deps: ViewDeps, me: Person) {
  const { agents, people, messages, approvals, files, workspaces, questions } = deps;
  const titles = new Map<string, string>();
  /** Where a conversation between the two runs, and whether anything new can still go there. */
  const place = (workspaceId: string, aId: string, bId: string): Place => {
    if (!titles.has(workspaceId)) {
      const w = workspaces.known(workspaceId);
      titles.set(workspaceId, w ? porticoTitle(w, me) : "");
    }
    return { workspaceId, portico: titles.get(workspaceId)!, readOnly: !workspaces.joins(workspaceId, aId, bId) };
  };
  const peopleById = new Map<string, Person | null>();
  const personRef = (id: string): PersonRef => {
    if (!peopleById.has(id)) peopleById.set(id, people.get(id));
    const person = peopleById.get(id);
    return { id, name: person?.name ?? "", ...(person?.handle ? { handle: person.handle } : {}) };
  };
  const refs = new Map<string, AgentRef>();
  const agentRef = (id: string): AgentRef => {
    const known = refs.get(id);
    if (known) return known;
    const agent = agents.get(id);
    const ref: AgentRef = agent
      ? { id, display: agents.nameFor(agent, me.id), label: agents.label(agent), kind: agent.kind }
      : { id, display: id, label: id, kind: "other" };
    refs.set(id, ref);
    return ref;
  };

  const agent = (a: Agent): AgentView => {
    const entry = agents.entryFor(a, me.id);
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
      outboundHold: a.ownerId === me.id && a.outboundHold,
      revokedAt: a.revokedAt,
      createdAt: a.createdAt,
      liveRuns: agents.liveRuns(a.id),
    };
  };

  const message = (m: Message): MessageView => {
    const original = messages.original(m);
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
      noReplyNeeded: m.noReplyNeeded,
      files: files.of(m).map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size })),
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
      facts: { managedBy: personRef(facts.managedBy.id), heldFor: facts.heldFor, newSender: facts.newSender, replyToRecipient: facts.replyToRecipient, earlier: facts.earlier },
    };
  };

  const threadAgent = (id: string): ThreadAgent => {
    const agent = agents.get(id);
    return agent
      ? { id, display: agents.nameFor(agent, me.id), label: agents.label(agent), kind: agent.kind, owner: personRef(agent.ownerId) }
      : { id, display: id, label: id, kind: "other", owner: personRef("") };
  };

  /** A message held on its way out is its sender's person's to see first: the other side reads it once it is let go. */
  const notYetSent = (m: Pick<Message, "status" | "heldFor" | "fromId">): boolean => neverSent(m) && agents.get(m.fromId)?.ownerId !== me.id;

  const thread = (t: Thread): ThreadView => {
    // What never left someone else's side is neither the newest message nor counted, wherever in the thread it is.
    const summary = messages.threadSummary(t, agents.ownedBy(me.id).map((a) => a.id));
    return {
      id: t.id,
      ...place(t.workspaceId, t.aId, t.bId),
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

  let seenAgents: Set<string> | null = null;
  const seen = () => (seenAgents ??= workspaces.visibleAgents(me.id));
  const person = (p: Person): PersonView => ({
    id: p.id,
    name: p.name,
    role: p.role,
    status: p.status,
    isMe: p.id === me.id,
    // Someone else's agents count only as far as the signed-in person reaches them: an agent kept out of every shared
    // Portico stays unknown, even as a number. A Portico server's owner, who removes people, sees the whole count.
    agentCount: p.id === me.id || me.role === "owner" ? agents.ownedBy(p.id).length : agents.ownedBy(p.id).filter((a) => seen().has(a.id)).length,
    ...(p.handle ? { handle: p.handle } : {}),
    ...(p.id === me.id && p.email ? { email: p.email } : {}),
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
    const page = messages.inThread(t, range);
    const shown = page.messages.filter((m) => !notYetSent(m));
    return { thread: thread(t), messages: shown.map(message), more: page.more };
  };

  const projectOf = (id: string): string | null => {
    const a = agents.get(id);
    return a?.type === "session" ? a.folder : null;
  };

  /**
   * A question for the signed-in person. `subject` is the task's, when the caller has the task at hand; otherwise the
   * task is looked up among the conversations the person can read.
   */
  const question = (q: Question, subject?: string): QuestionCard => {
    const asker = agents.get(q.agentId);
    const taskSubject = q.taskId === null ? null : (subject ?? deps.tasks.get({ person: me.id }, q.taskId, agents.ownedBy(me.id).map((a) => a.id))?.task.subject ?? null);
    const choice = q.answerOption !== null ? (q.options?.[q.answerOption] ?? null) : null;
    return {
      id: q.id,
      agent: agentRef(q.agentId),
      question: q.question,
      detail: q.detail,
      options: q.options,
      status: q.status,
      task: q.taskId !== null && taskSubject !== null ? { id: q.taskId, subject: taskSubject } : null,
      newAgent: asker && asker.unproven && asker.revokedAt === null ? { addedAt: asker.createdAt } : null,
      createdAt: q.createdAt,
      expiresAt: q.expiresAt,
      endedAt: q.endedAt,
      answer: q.status === "answered" && q.answeredAt ? { option: choice, text: q.answerText, at: q.answeredAt, via: q.answeredVia, level: q.answerLevel } : null,
    };
  };

  const task = (t: Task): TaskView => ({
    id: t.id,
    ...place(t.workspaceId, t.fromId, t.toId),
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
    noReplyNeeded: t.noReplyNeeded,
    heldMessageId: t.heldMessageId,
    messageCount: t.messageCount,
    project: projectOf(t.toId) ?? projectOf(t.fromId),
    steps: t.steps.map((step) => ({
      kind: step.kind,
      at: step.at,
      by: step.personId ? personRef(step.personId) : null,
      decision: step.decision,
      ...(step.agentId ? { agent: agentRef(step.agentId) } : {}),
    })),
    waitingOn: t.waitingOn ? { person: personRef(t.waitingOn.personId), agent: agentRef(t.waitingOn.agentId), askedAt: t.waitingOn.askedAt } : null,
    // The text of a question is its own person's alone: the other person of the task sees the steps and no more.
    questions: t.steps.some((step) => step.kind === "input_asked" && step.personId === me.id) ? questions.ofTaskFor(me.id, t.id).map((q) => question(q, t.subject)) : [],
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

  return { agent, message, held, thread, threadData, person, allowEntry, agentRef, personRef, task, question, run, activity, place, notYetSent };
}

export type PersonViews = ReturnType<typeof personViews>;

/** A person reads a thread only when one of the person's own agents is in it. That holds for everyone, a server's owner too. */
export function canSeeThread(core: Pick<Core, "agents">, me: Person, thread: Thread): boolean {
  const { agents } = core;
  const mine = new Set(agents.ownedBy(me.id).map((a) => a.id));
  return mine.has(thread.aId) || mine.has(thread.bId);
}

/**
 * Every agent the person sees, the signed-in person's first, then by owner, then as the agent list orders them. Only
 * the person's own agents and those in a workspace the person is in.
 */
export function agentsInOrder(agents: Agents, me: Person): Agent[] {
  const entries = agents.entriesForPerson(me.id);
  return [
    ...entries.filter((e) => e.agent.ownerId === me.id),
    ...entries.filter((e) => e.agent.ownerId !== me.id),
  ].map((e) => e.agent);
}
