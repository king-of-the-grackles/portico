import type { Database } from "bun:sqlite";
import type { Activity } from "./activity";
import type { Agents } from "./agents";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import type { Messages } from "./messages";
import type { People } from "./people";
import type { Workspaces } from "./workspaces";
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
  agents: Agents;
  /** Whether a message's workspace still joins its two agents. */
  workspaces: Workspaces;
  messages: Messages;
  people: People;
  allowList: AllowList;
  changes: Changes;
  activity?: Activity;
  now?: () => Date;
  notify?: (notice: Notice) => void;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/** Decisions on held messages. Only a person decides, and only for agents that person manages. */
export class Approvals {
  private readonly agents: Agents;
  private readonly workspaces: Workspaces;
  private readonly messages: Messages;
  private readonly people: People;
  private readonly allowList: AllowList;
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

  /**
   * Allow once delivers this message. Always allow delivers it, and every other message held from the same sender to the
   * same recipient, and adds the sender to the recipient's Always allow list. Deny declines it.
   *
   * The message is looked for only in the workspaces of the person's own agents. Always allow writes the list in the
   * directory first, then decides the held messages workspace by workspace: there is no transaction across databases,
   * and a stop in between leaves the sender allowed and some messages still held, which the person can decide again.
   */
  decide(personId: string, messageId: string, decision: unknown): Message {
    if (!DECISIONS.some((known) => known === decision)) {
      throw new PorticoError("bad_request", "decision must be allow_once, always_allow or deny.");
    }
    const choice = decision as Decision;
    const held = this.messages.require({ person: personId }, messageId);
    const receiver = this.agents.require(held.toId);
    if (receiver.ownerId !== personId) {
      throw new PorticoError("not_allowed", "Only the person who manages the recipient can decide this message.");
    }
    if (held.status !== "held") throw new PorticoError("wrong_status", `The message is already ${held.status}.`);
    // The message's workspace stopped joining the two agents while the message waited: the conversation there is
    // read-only, so the message can be turned down, not let through.
    if (choice !== "deny" && !this.workspaces.joins(held.workspaceId, held.fromId, held.toId)) {
      throw new PorticoError("wrong_status", "The workspace this message came through no longer joins the sender and this agent, so the message can only be turned down.");
    }
    const at = this.now().toISOString();
    // With Always allow, every other message held from the sender, in a workspace that still joins the two.
    const others =
      choice === "always_allow"
        ? this.messages
            .heldBetween(held.fromId, held.toId)
            .filter((m) => m.id !== held.id && this.workspaces.joins(m.workspaceId, m.fromId, m.toId))
        : [];
    if (choice === "always_allow") this.allowList.add(held.toId, held.fromId, personId, at);
    const decided = this.messages.decideHeld([held, ...others], choice, personId, at);
    const message = decided.find((m) => m.id === held.id);
    if (!message) throw new PorticoError("wrong_status", "The message was decided a moment ago.");
    for (const m of decided) {
      this.log("message_decided", { message_id: m.id, decision: choice });
      this.notify({ kind: "message_decided", message: m });
    }
    this.activity?.record("decision", {
      agentId: held.toId,
      otherId: held.fromId,
      personId,
      detail: { decision: choice, messageId: held.id, count: String(decided.length) },
    });
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
    this.activity?.record("allow_removed", { agentId, otherId: senderId, personId });
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
