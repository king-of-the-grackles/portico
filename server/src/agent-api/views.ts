import type { Agents } from "../core/agents";
import { frameMessage, frameUpdate } from "../core/framing";
import type { People } from "../core/people";
import type { AgentKind, AgentType, DirectoryEntry, LiveStatus, Message, MessageStatus } from "../core/types";

/** What agents see. snake_case, as the agent API has always been. */
export interface AgentEntryView {
  /** The name to address the agent by: a session's short name when unique. */
  name: string;
  address: string;
  kind: AgentKind;
  type: AgentType;
  description: string;
  /** The name of the person who manages the agent. */
  owner: string;
  computer: string | null;
  repo: string | null;
  branch: string | null;
  /** Null for apps and connectors. */
  status: LiveStatus | null;
  doing: string | null;
  last_seen: string | null;
  /** New senders' messages to this agent wait for a person's approval. */
  approval_required: boolean;
}

export interface MessageOutView {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  reply_to: string | null;
  status: MessageStatus;
  created_at: string;
  expires_at: string;
}

export interface UpdateView {
  message_id: string;
  to: string;
  subject: string;
  status: MessageStatus;
  at: string;
  framed_message: string;
}

/** View builders for the agent API, which name agents by address and people by name. */
export function agentViews(agents: Agents, people: People) {
  const names = new Map<string, string>();
  const ownerName = (id: string) => {
    if (!names.has(id)) names.set(id, people.get(id)?.name ?? "");
    return names.get(id)!;
  };
  /** An agent ID as its display name; a removed agent's ID stays as it is. */
  const nameOf = (id: string) => {
    const agent = agents.get(id);
    return agent ? agents.display(agent) : id;
  };

  const entry = (e: DirectoryEntry): AgentEntryView => ({
    name: e.display,
    address: e.address,
    kind: e.agent.kind,
    type: e.agent.type,
    description: e.agent.description,
    owner: ownerName(e.agent.ownerId),
    computer: e.agent.computer,
    repo: e.repo,
    branch: e.branch,
    status: e.status,
    doing: e.doing,
    last_seen: e.lastSeen,
    approval_required: e.agent.approvalRequired,
  });

  const message = (m: Message): MessageOutView => ({
    id: m.id,
    thread_id: m.threadId,
    from: nameOf(m.fromId),
    to: nameOf(m.toId),
    subject: m.subject,
    text: m.text,
    reply_to: m.replyTo,
    status: m.status,
    created_at: m.createdAt,
    expires_at: m.expiresAt,
  });

  const delivery = (m: Message): MessageOutView & { framed_message: string } => {
    const view = message(m);
    return { ...view, framed_message: frameMessage({ id: m.id, from: view.from, subject: m.subject, text: m.text, replyTo: m.replyTo }) };
  };

  const update = (m: Message): UpdateView => {
    const to = nameOf(m.toId);
    const at = m.status === "delivered" ? (m.deliveredAt ?? m.createdAt) : (m.decidedAt ?? m.expiresAt);
    return {
      message_id: m.id,
      to,
      subject: m.subject,
      status: m.status,
      at,
      framed_message: frameUpdate({ messageId: m.id, to, subject: m.subject, status: m.status }),
    };
  };

  return { entry, message, delivery, update, nameOf };
}

export type AgentViews = ReturnType<typeof agentViews>;
