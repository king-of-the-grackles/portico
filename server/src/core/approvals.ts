import type { Database } from "bun:sqlite";
import type { Activity } from "./activity";
import type { Agents } from "./agents";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import type { Messages } from "./messages";
import type { People } from "./people";
import type { Workspaces } from "./workspaces";
import { DECISIONS } from "./types";
import type { Decision, HeldFor, Message, Notice, Person } from "./types";

/**
 * First contact, per pair of people: whose agents get through to whose. A person's agents take messages from another
 * person's agents only once the person said "always for this person"; until then each message is held for the person.
 * A person's own agents always get through to each other.
 */
export class Contacts {
  constructor(private readonly db: Database) {}

  /** Whether the agents of `senderPersonId` get through to the agents of `personId`. */
  has(personId: string, senderPersonId: string): boolean {
    if (personId === senderPersonId) return true;
    return (
      this.db
        .query("SELECT 1 FROM allowed_people WHERE person_id = $personId AND sender_person_id = $senderPersonId")
        .get({ personId, senderPersonId }) !== null
    );
  }

  add(personId: string, senderPersonId: string, at: string): void {
    if (personId === senderPersonId) return;
    this.db
      .query(
        `INSERT INTO allowed_people (person_id, sender_person_id, created_at) VALUES ($personId, $senderPersonId, $at)
         ON CONFLICT (person_id, sender_person_id) DO NOTHING`,
      )
      .run({ personId, senderPersonId, at });
  }

  remove(personId: string, senderPersonId: string): boolean {
    return (
      this.db.query("DELETE FROM allowed_people WHERE person_id = $personId AND sender_person_id = $senderPersonId").run({ personId, senderPersonId })
        .changes === 1
    );
  }

  /** The people whose agents get through to this person's agents, oldest first. */
  list(personId: string): { personId: string; addedAt: string }[] {
    const rows = this.db
      .query("SELECT sender_person_id, created_at FROM allowed_people WHERE person_id = $personId ORDER BY created_at, sender_person_id")
      .all({ personId }) as { sender_person_id: string; created_at: string }[];
    return rows.map((row) => ({ personId: row.sender_person_id, addedAt: row.created_at }));
  }
}

/** Who each protected agent always allows: their messages skip that agent's own hold. */
export class AllowList {
  constructor(private readonly db: Database) {}

  has(agentId: string, senderId: string): boolean {
    return (
      this.db.query("SELECT 1 FROM always_allow WHERE agent_id = $agentId AND sender_id = $senderId").get({ agentId, senderId }) !==
      null
    );
  }

  add(agentId: string, senderId: string, personId: string, at: string): void {
    this.db
      .query(
        `INSERT INTO always_allow (agent_id, sender_id, added_by, created_at) VALUES ($agentId, $senderId, $personId, $at)
         ON CONFLICT (agent_id, sender_id) DO NOTHING`,
      )
      .run({ agentId, senderId, personId, at });
  }

  remove(agentId: string, senderId: string): boolean {
    return (
      this.db.query("DELETE FROM always_allow WHERE agent_id = $agentId AND sender_id = $senderId").run({ agentId, senderId })
        .changes === 1
    );
  }

  /** Oldest first. */
  list(agentId: string): { senderId: string; addedBy: string; addedAt: string }[] {
    const rows = this.db
      .query("SELECT sender_id, added_by, created_at FROM always_allow WHERE agent_id = $agentId ORDER BY created_at")
      .all({ agentId }) as { sender_id: string; added_by: string; created_at: string }[];
    return rows.map((row) => ({ senderId: row.sender_id, addedBy: row.added_by, addedAt: row.created_at }));
  }
}

/** What Portico checks itself for a held-message card. Never anything the sender wrote. */
export interface HeldFacts {
  /** The person who manages the sender. */
  managedBy: Person;
  /** Why the message is held: whose decision it waits on. */
  heldFor: HeldFor;
  /** Held on its way out because the sender joined lately and nobody vouched for it: Always vouches. */
  newSender: boolean;
  /** The previous message in the thread came from the recipient. */
  replyToRecipient: boolean;
  /** Earlier decisions on messages from this sender to this recipient, newest first. */
  earlier: { decision: Decision; at: string }[];
}

export interface ApprovalsDeps {
  agents: Agents;
  /** Whether a message's workspace still joins its two agents. */
  workspaces: Workspaces;
  messages: Messages;
  people: People;
  allowList: AllowList;
  contacts: Contacts;
  changes: Changes;
  activity?: Activity;
  now?: () => Date;
  notify?: (notice: Notice) => void;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Decisions on held messages. Only a person decides. A message held on its way out (`outbound`) is the sender's
 * person's to decide; one held on arrival (`first_contact`, `approval`) is the receiver's person's. Anyone else gets
 * the same answer as for a message that doesn't exist.
 */
export class Approvals {
  private readonly agents: Agents;
  private readonly workspaces: Workspaces;
  private readonly messages: Messages;
  private readonly people: People;
  private readonly allowList: AllowList;
  private readonly contacts: Contacts;
  private readonly changes: Changes;
  private readonly activity: Activity | undefined;
  private readonly now: () => Date;
  private readonly notify: (notice: Notice) => void;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: ApprovalsDeps) {
    this.agents = deps.agents;
    this.workspaces = deps.workspaces;
    this.messages = deps.messages;
    this.people = deps.people;
    this.allowList = deps.allowList;
    this.contacts = deps.contacts;
    this.changes = deps.changes;
    this.activity = deps.activity;
    this.now = deps.now ?? (() => new Date());
    this.notify = deps.notify ?? (() => {});
    this.log = deps.log ?? (() => {});
  }

  /** Held messages the person may decide, oldest first. */
  heldFor(personId: string): Message[] {
    return this.messages.heldFor(personId);
  }

  /** The person who decides a held message: the sender's for an outbound hold, otherwise the receiver's. Null once that agent is gone. */
  decider(message: Pick<Message, "fromId" | "toId" | "heldFor">): string | null {
    return this.agents.get(message.heldFor === "outbound" ? message.fromId : message.toId)?.ownerId ?? null;
  }

  /**
   * The held message, for the person who decides it. A message that isn't there, isn't held for anyone, or waits on
   * someone else's decision all answer the same `not_found`.
   */
  requireDecidable(personId: string, messageId: string): Message {
    const message = this.messages.get({ person: personId }, messageId);
    if (!message || message.heldAt === null || this.decider(message) !== personId) throw new PorticoError("not_found", "No such message.");
    return message;
  }

  /**
   * Allow once delivers this message. Always allow delivers it and stops asking: for first contact, about every agent
   * of the sender's person writing to this person's agents; for an agent with its own approval switch, about this
   * sender writing to that agent. Deny declines it. An outbound hold takes Allow once or Deny, and an allowed message
   * then goes on to whatever the receiving side requires, so it may be held again for the receiver's person.
   *
   * The lists are written in the directory first, then the held messages are decided workspace by workspace: there is
   * no transaction across databases, and a stop in between leaves the sender allowed and some messages still held,
   * which the person can decide again.
   */
  decide(personId: string, messageId: string, decision: unknown): Message {
    if (!DECISIONS.some((known) => known === decision)) {
      throw new PorticoError("bad_request", "decision must be allow_once, always_allow or deny.");
    }
    const choice = decision as Decision;
    const held = this.requireDecidable(personId, messageId);
    if (held.status !== "held") throw new PorticoError("wrong_status", `The message is already ${held.status}.`);
    // The message's workspace stopped joining the two agents while the message waited, or is paused: the conversation
    // there takes nothing new, so the message can be turned down, not let through.
    if (choice !== "deny" && !this.workspaces.joins(held.workspaceId, held.fromId, held.toId)) {
      throw new PorticoError("wrong_status", "The Portico this message came through no longer joins the sender and this agent, so the message can only be turned down.");
    }
    const at = this.now().toISOString();
    const record = (count: number) =>
      this.activity?.record("decision", {
        agentId: held.toId,
        otherId: held.fromId,
        personId,
        workspaceId: held.workspaceId,
        subjectId: held.heldFor === "outbound" ? personId : null,
        detail: { decision: choice, messageId: held.id, count: String(count), for: held.heldFor ?? "approval" },
      });

    if (held.heldFor === "outbound") {
      const from = this.agents.get(held.fromId);
      // Always is for a newly joined agent only: the person vouches for the agent, and nothing more of it is held for
      // being new. An agent with its own switch is asked about one message at a time.
      if (choice === "always_allow" && !from?.unproven) {
        throw new PorticoError("bad_request", "A message held on the way out is allowed one at a time. To stop being asked, switch the hold off on the agent's page.");
      }
      let more: Message[] = [];
      if (choice === "always_allow" && from) {
        this.agents.proven(from.id);
        if (!from.outboundHold) more = this.messages.heldFor(personId).filter((m) => m.id !== held.id && m.fromId === from.id && m.heldFor === "outbound");
      }
      const message = choice === "deny" ? this.messages.decideHeld([held], choice, personId, at)[0] : this.messages.releaseOutbound(held, personId, at);
      if (!message) throw new PorticoError("wrong_status", "The message was decided a moment ago.");
      const released = [message, ...more.map((m) => this.messages.releaseOutbound(m, personId, at)).filter((m): m is Message => m !== null)];
      for (const m of released) {
        // One that could no longer go was withdrawn by the release itself, which told its sender.
        if (m.status === "withdrawn") continue;
        this.log("message_decided", { message_id: m.id, decision: choice, outbound: true });
        // Still held: now it waits on the receiver's person, who is told as for any held message.
        this.notify(m.status === "held" ? { kind: "message_sent", message: m } : { kind: "message_decided", message: m });
      }
      record(released.length);
      this.changes.about({ people: [personId], agents: released.flatMap((m) => [m.fromId, m.toId]) }, "approvals", "threads", "agents");
      return message;
    }

    const sender = this.agents.get(held.fromId);
    const receiver = this.agents.require(held.toId);
    let others: Message[] = [];
    // A new agent is asked about once for each of the person's other agents: either Allow settles this pair, and
    // Always says the person vouches for the agent, so nothing more of it is held for being new.
    if (held.heldFor === "new_agent" && choice !== "deny") {
      this.allowList.add(held.toId, held.fromId, personId, at);
      if (choice === "always_allow") {
        this.agents.proven(held.fromId);
        others = this.messages.heldFor(personId).filter((m) => m.id !== held.id && m.fromId === held.fromId && m.heldFor === "new_agent");
      }
    } else if (choice === "always_allow") {
      if (held.heldFor === "first_contact" && sender) {
        this.contacts.add(personId, sender.ownerId, at);
        // The agent's own switch still asks about each new sender: this one is answered too.
        if (receiver.approvalRequired) this.allowList.add(held.toId, held.fromId, personId, at);
        // Every other first contact held from that person's agents, to agents that don't ask for themselves.
        others = this.messages.heldFromPerson(sender.ownerId, personId).filter((m) => {
          const to = this.agents.get(m.toId);
          return m.id !== held.id && to !== null && (!to.approvalRequired || this.allowList.has(m.toId, m.fromId));
        });
      } else {
        this.allowList.add(held.toId, held.fromId, personId, at);
        others = this.messages.heldBetween(held.fromId, held.toId).filter((m) => m.id !== held.id && m.heldFor !== "outbound" && (m.heldFor !== "first_contact" || (sender !== null && this.contacts.has(personId, sender.ownerId))));
      }
      others = others.filter((m) => this.workspaces.joins(m.workspaceId, m.fromId, m.toId));
    }
    const decided = this.messages.decideHeld([held, ...others], choice, personId, at);
    const message = decided.find((m) => m.id === held.id);
    if (!message) throw new PorticoError("wrong_status", "The message was decided a moment ago.");
    for (const m of decided) {
      this.log("message_decided", { message_id: m.id, decision: choice });
      this.notify({ kind: "message_decided", message: m });
    }
    record(decided.length);
    this.changes.about({ people: [personId], agents: decided.flatMap((m) => [m.fromId, m.toId]) }, "approvals", "threads", "agents", "people");
    return message;
  }

  /** The recipient's Always allow list. Only its manager may read it. */
  allowListFor(personId: string, agentId: string): { senderId: string; addedBy: string; addedAt: string }[] {
    this.agents.requireManaged(personId, agentId);
    return this.allowList.list(agentId);
  }

  /** Removes a sender from the recipient's Always allow list: later messages from it are held again. */
  removeAllowed(personId: string, agentId: string, senderId: string): void {
    this.agents.requireManaged(personId, agentId);
    if (!this.allowList.remove(agentId, senderId)) throw new PorticoError("not_found", "That sender isn't on the list.");
    this.activity?.record("allow_removed", { agentId, otherId: senderId, personId });
    this.changes.about({ people: [personId], agents: [agentId, senderId] }, "agents");
  }

  /** The people whose agents get through to this person's agents. */
  allowedPeople(personId: string): { personId: string; addedAt: string }[] {
    return this.contacts.list(personId);
  }

  /** Takes a person off the list: the next message from one of that person's agents is asked about again. */
  removeAllowedPerson(personId: string, senderPersonId: string): void {
    if (!this.contacts.remove(personId, senderPersonId)) throw new PorticoError("not_found", "That person isn't on the list.");
    this.activity?.record("allow_removed", { personId, subjectId: senderPersonId, detail: { person: true } });
    this.changes.about({ people: [personId, senderPersonId] }, "agents", "people");
  }

  facts(message: Message): HeldFacts {
    const sender = this.agents.require(message.fromId);
    const previous = this.messages.previous(message);
    return {
      managedBy: this.people.require(sender.ownerId),
      heldFor: message.heldFor ?? "approval",
      newSender: message.heldFor === "outbound" && sender.unproven,
      replyToRecipient: previous !== null && previous.fromId === message.toId,
      earlier: this.messages.decisionsBetween(message.fromId, message.toId, message.id),
    };
  }
}
