import type { Database } from "bun:sqlite";
import type { Agents } from "./agents";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import type { Messages } from "./messages";
import type { People } from "./people";
import { DECISIONS } from "./types";
import type { Decision, Message, Notice, Person } from "./types";

/** Who each protected agent always allows: their messages skip the hold. */
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
  /** The previous message in the thread came from the recipient. */
  replyToRecipient: boolean;
  /** Earlier decisions on messages from this sender to this recipient, newest first. */
  earlier: { decision: Decision; at: string }[];
}

export interface ApprovalsDeps {
  db: Database;
  agents: Agents;
  messages: Messages;
  people: People;
  allowList: AllowList;
  changes: Changes;
  now?: () => Date;
  notify?: (notice: Notice) => void;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/** Decisions on held messages. Only a person decides, and only for agents that person manages. */
export class Approvals {
  private readonly db: Database;
  private readonly agents: Agents;
  private readonly messages: Messages;
  private readonly people: People;
  private readonly allowList: AllowList;
  private readonly changes: Changes;
  private readonly now: () => Date;
  private readonly notify: (notice: Notice) => void;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: ApprovalsDeps) {
    this.db = deps.db;
    this.agents = deps.agents;
    this.messages = deps.messages;
    this.people = deps.people;
    this.allowList = deps.allowList;
    this.changes = deps.changes;
    this.now = deps.now ?? (() => new Date());
    this.notify = deps.notify ?? (() => {});
    this.log = deps.log ?? (() => {});
  }

  /** Held messages the person may decide, oldest first. */
  heldFor(personId: string): Message[] {
    return this.messages.heldFor(personId);
  }

  /**
   * Allow once delivers this message. Always allow delivers it, and every other message held from the same sender to the
   * same recipient, and adds the sender to the recipient's Always allow list. Deny declines it.
   */
  decide(personId: string, messageId: string, decision: unknown): Message {
    if (!DECISIONS.some((known) => known === decision)) {
      throw new PorticoError("bad_request", "decision must be allow_once, always_allow or deny.");
    }
    const choice = decision as Decision;
    const held = this.messages.require(messageId);
    const receiver = this.agents.require(held.toId);
    if (receiver.ownerId !== personId) {
      throw new PorticoError("not_allowed", "Only the person who manages the recipient can decide this message.");
    }
    if (held.status !== "held") throw new PorticoError("wrong_status", `The message is already ${held.status}.`);
    const at = this.now().toISOString();
    const decided = this.db.transaction(() => {
      const ids =
        choice === "always_allow" ? this.messages.heldBetween(held.fromId, held.toId).map((m) => m.id) : [held.id];
      if (!ids.includes(held.id)) ids.unshift(held.id);
      if (choice === "always_allow") this.allowList.add(held.toId, held.fromId, personId, at);
      return ids.map((id) => this.messages.decideHeld(id, choice, personId, at)).filter((m): m is Message => m !== null);
    })();
    const message = decided.find((m) => m.id === held.id);
    if (!message) throw new PorticoError("wrong_status", "The message was decided a moment ago.");
    for (const m of decided) {
      this.log("message_decided", { message_id: m.id, decision: choice });
      this.notify({ kind: "message_decided", message: m });
    }
    this.changes.emit("approvals", "threads", "agents");
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
    this.changes.emit("agents");
  }

  facts(message: Message): HeldFacts {
    const sender = this.agents.require(message.fromId);
    const previous = this.messages.previous(message);
    return {
      managedBy: this.people.require(sender.ownerId),
      replyToRecipient: previous !== null && previous.fromId === message.toId,
      earlier: this.messages.decisionsBetween(message.fromId, message.toId, message.id),
    };
  }
}
