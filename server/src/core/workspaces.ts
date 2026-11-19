import type { Database } from "bun:sqlite";
import { quote } from "./framing";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import { posesAsOwnPortico, titleKey } from "./names";
import { AGENTS_POLICIES, type AgentsPolicy, type Workspace, type WorkspaceKind } from "./types";

interface WorkspaceRow {
  id: string;
  name: string;
  kind: string;
  owner_id: string;
  created_at: string;
  paused_at: string | null;
}

/**
 * Something that changed who is in a workspace, or whether anything moves through it. Raised after the change is
 * written; portico.ts turns each into the workspace's record, notices to the agents there, and the withdrawal of
 * messages that can no longer be delivered. `agentIds` are the agents that stopped reaching through the workspace.
 */
export type WorkspaceEvent =
  | { kind: "person_joined"; workspace: Workspace; personId: string; byId: string }
  | { kind: "person_left"; workspace: Workspace; personId: string; byId: string; agentIds: string[] }
  | { kind: "agent_joined"; workspace: Workspace; agentId: string; byId: string; ownerAllowed: boolean }
  | { kind: "agent_left"; workspace: Workspace; agentId: string; byId: string }
  | { kind: "paused" | "resumed"; workspace: Workspace; byId: string }
  | { kind: "deleted"; workspace: Workspace; byId: string; agentIds: string[]; personIds: string[] };

/** The owner's choice as given: `self` when nothing was said. */
export function cleanAgentsPolicy(value: unknown): AgentsPolicy {
  if (value === undefined || value === null || value === "") return "self";
  if (!AGENTS_POLICIES.some((policy) => policy === value)) throw new PorticoError("bad_request", "agents must be self or ask.");
  return value as AgentsPolicy;
}

/** A Portico's name folded for comparing: "Launch", "the Launch Portico" and "LAUNCH" are one name. */
export function porticoKey(name: string): string {
  const key = titleKey(name);
  const tail = titleKey("Portico");
  return key.length > tail.length && key.endsWith(tail) ? key.slice(0, -tail.length) : key;
}

/**
 * What the directory stores as the name of a person's own Portico. Never shown: everyone sees "Chris's Portico", and
 * its owner sees "Your Portico" on the pages.
 */
export const PERSONAL_NAME = "Personal";
export const MAX_WORKSPACE_NAME = 60;

/**
 * A Portico's name as typed: trimmed, on one line, at most 60 characters. A name is optional: without one ("" here)
 * the Portico is named after the people in it.
 */
export function cleanWorkspaceName(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new PorticoError("bad_request", "name must be a string.");
  const name = value.replace(/\s+/g, " ").trim();
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new PorticoError("bad_request", "A Portico's name is plain text on one line.");
  if (Array.from(name).length > MAX_WORKSPACE_NAME) {
    throw new PorticoError("bad_request", `A Portico's name can be at most ${MAX_WORKSPACE_NAME} characters.`);
  }
  return name;
}

/** "Chris", "Chris and Robert", "Chris, Robert and Bill". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Personal first, then the oldest: the order every list of workspaces comes in. */
const ORDER = "ORDER BY w.kind = 'personal' DESC, w.created_at, w.id";

export interface WorkspacesDeps {
  db: Database;
  changes: Changes;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * Workspaces, who is in each, and the reach rule: two agents see and message each other only while both are in one
 * workspace. `reach` is the one access check; every agent list, name lookup and send asks it, and nothing else decides
 * who reaches whom. Every person has a personal workspace holding all of that person's agents, so a person's own agents
 * always reach each other. A shared workspace holds people, and the agents each of those people put in.
 */
export class Workspaces {
  private readonly db: Database;
  private readonly changes: Changes;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: WorkspacesDeps) {
    this.db = deps.db;
    this.changes = deps.changes;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
  }

  // ---- the reach rule ----

  /** Whether the two agents can see and message each other: both are in at least one workspace now. */
  reach(agentId: string, otherId: string): boolean {
    if (agentId === otherId) return true;
    return (
      this.db
        .query(
          `SELECT 1 FROM workspace_agents x JOIN workspace_agents y ON y.workspace_id = x.workspace_id
           WHERE x.agent_id = $agentId AND y.agent_id = $otherId AND x.left_at IS NULL AND y.left_at IS NULL LIMIT 1`,
        )
        .get({ agentId, otherId }) !== null
    );
  }

  /** The workspaces both agents are in now that aren't paused: the ones a message between the two can go through. */
  open(agentId: string, otherId: string): Workspace[] {
    return this.shared(agentId, otherId).filter((w) => w.pausedAt === null);
  }

  /** Every other agent the agent reaches. */
  reachable(agentId: string): Set<string> {
    const rows = this.db
      .query(
        `SELECT DISTINCT y.agent_id AS id FROM workspace_agents x JOIN workspace_agents y ON y.workspace_id = x.workspace_id
         WHERE x.agent_id = $agentId AND y.agent_id != $agentId AND x.left_at IS NULL AND y.left_at IS NULL`,
      )
      .all({ agentId }) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  /** The workspaces both agents are in now, personal first, then the oldest. */
  shared(agentId: string, otherId: string): Workspace[] {
    const rows = this.db
      .query(
        `SELECT w.* FROM workspaces w
         JOIN workspace_agents x ON x.workspace_id = w.id AND x.agent_id = $agentId AND x.left_at IS NULL
         JOIN workspace_agents y ON y.workspace_id = w.id AND y.agent_id = $otherId AND y.left_at IS NULL
         WHERE w.archived_at IS NULL ${ORDER}`,
      )
      .all({ agentId, otherId }) as WorkspaceRow[];
    return rows.map((row) => this.view(row));
  }

  /** Whether the workspace joins the two agents now: both are in the workspace, and the workspace isn't deleted or paused. */
  joins(workspaceId: string, agentId: string, otherId: string): boolean {
    return this.open(agentId, otherId).some((w) => w.id === workspaceId);
  }

  /**
   * The workspace a new conversation between the two goes in: the most private one both are in now. First the personal
   * workspace of the person who manages both; then a shared one whose people are exactly the two agents' owners; then
   * the oldest shared one. Null when the two share none. A reply doesn't ask this: a conversation stays in the
   * workspace where the conversation started (core/messages.ts).
   */
  route(agentId: string, otherId: string): Workspace | null {
    const shared = this.open(agentId, otherId);
    if (shared.length <= 1) return shared[0] ?? null;
    const personal = shared.find((w) => w.kind === "personal");
    if (personal) return personal;
    const owners = new Set(
      (this.db.query("SELECT owner_id FROM agents WHERE id IN ($agentId, $otherId)").all({ agentId, otherId }) as { owner_id: string }[]).map(
        (row) => row.owner_id,
      ),
    );
    const onlyThem = shared.find((w) => {
      const people = this.peopleIn(w.id);
      return people.length === owners.size && people.every((id) => owners.has(id));
    });
    return onlyThem ?? shared[0]!;
  }

  /** The agents a person sees: the person's own, and every agent in a workspace the person is in. */
  visibleAgents(personId: string): Set<string> {
    const rows = this.db
      .query(
        `SELECT DISTINCT a.agent_id AS id FROM workspace_people p JOIN workspace_agents a ON a.workspace_id = p.workspace_id
         WHERE p.person_id = $personId AND a.left_at IS NULL
         UNION SELECT id FROM agents WHERE owner_id = $personId`,
      )
      .all({ personId }) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  /** The people a person sees: everyone in a workspace the person is in, and the person. */
  visiblePeople(personId: string): Set<string> {
    const rows = this.db
      .query(
        `SELECT DISTINCT q.person_id AS id FROM workspace_people p JOIN workspace_people q ON q.workspace_id = p.workspace_id
         WHERE p.person_id = $personId`,
      )
      .all({ personId }) as { id: string }[];
    return new Set([personId, ...rows.map((row) => row.id)]);
  }

  /**
   * Whether the two agents were ever in one Portico together, in or out of it now. A refusal may say "no longer share
   * a Portico" only to an agent that already knew the other.
   */
  everShared(agentId: string, otherId: string): boolean {
    return (
      this.db
        .query(
          `SELECT 1 FROM workspace_agents x JOIN workspace_agents y ON y.workspace_id = x.workspace_id
           WHERE x.agent_id = $agentId AND y.agent_id = $otherId LIMIT 1`,
        )
        .get({ agentId, otherId }) !== null
    );
  }

  // ---- reads ----

  /**
   * A Portico as everyone names it. A person's own is "Chris's Portico". A shared one has the name someone gave it, or
   * is named after the people in it ("Chris and Robert"), which follows them as they come and go. `phrase` is how a
   * sentence names it, with the name as a quote, since a person typed it or it is made of people's names: the Portico
   * “Launch”. A sentence an agent reads can then never take a name for Portico's own words.
   */
  private view(row: WorkspaceRow): Workspace {
    const base = { id: row.id, kind: row.kind as WorkspaceKind, ownerId: row.owner_id, createdAt: row.created_at, pausedAt: row.paused_at };
    const personName = (id: string) => (this.db.query("SELECT name FROM people WHERE id = $id").get({ id }) as { name: string } | null)?.name ?? "";
    if (base.kind === "personal") {
      const owner = personName(row.owner_id);
      const name = owner === "" ? "A Portico" : `${owner}'s Portico`;
      return { ...base, name, named: false, phrase: owner === "" ? "a Portico" : quote(name) };
    }
    if (row.name !== "") {
      return { ...base, name: row.name, named: true, phrase: `the Portico ${quote(row.name)}` };
    }
    // A deleted Portico has nobody in it any more: its owner's name stands in.
    const people = this.peopleIn(row.id).map(personName).filter((name) => name !== "");
    if (people.length >= 2) {
      const name = listNames(people);
      return { ...base, name, named: false, phrase: `the Portico ${quote(name)}` };
    }
    const owner = people[0] ?? personName(row.owner_id);
    const name = owner === "" ? "A new Portico" : `${owner}'s new Portico`;
    return { ...base, name, named: false, phrase: owner === "" ? "a new Portico" : quote(name) };
  }

  /** The workspace, unless deleted: a deleted workspace answers the same as one that never existed. */
  get(id: string): Workspace | null {
    const row = this.db.query("SELECT * FROM workspaces WHERE id = $id AND archived_at IS NULL").get({ id }) as WorkspaceRow | null;
    return row ? this.view(row) : null;
  }

  /** The workspace whether or not it was deleted: for naming where a message went. Null once its row is gone. */
  known(id: string): Workspace | null {
    const row = this.db.query("SELECT * FROM workspaces WHERE id = $id").get({ id }) as WorkspaceRow | null;
    return row ? this.view(row) : null;
  }

  /** The workspace, for a person in it. One the person isn't in answers the same as one that doesn't exist. */
  requireFor(personId: string, id: string): Workspace {
    const workspace = this.get(id);
    if (!workspace || !this.hasPerson(id, personId)) throw new PorticoError("not_found", "No such Portico.");
    return workspace;
  }

  /** The workspaces the person is in, personal first. */
  forPerson(personId: string): Workspace[] {
    const rows = this.db
      .query(`SELECT w.* FROM workspaces w JOIN workspace_people p ON p.workspace_id = w.id WHERE p.person_id = $personId AND w.archived_at IS NULL ${ORDER}`)
      .all({ personId }) as WorkspaceRow[];
    return rows.map((row) => this.view(row));
  }

  /** The workspaces the agent is in now, personal first. */
  ofAgent(agentId: string): Workspace[] {
    const rows = this.db
      .query(
        `SELECT w.* FROM workspaces w JOIN workspace_agents a ON a.workspace_id = w.id
         WHERE a.agent_id = $agentId AND a.left_at IS NULL AND w.archived_at IS NULL ${ORDER}`,
      )
      .all({ agentId }) as WorkspaceRow[];
    return rows.map((row) => this.view(row));
  }

  /** The IDs of the people in the workspace, the owner first, then as they came in. */
  peopleIn(workspaceId: string): string[] {
    const rows = this.db
      .query(
        `SELECT p.person_id AS id FROM workspace_people p JOIN workspaces w ON w.id = p.workspace_id
         WHERE p.workspace_id = $workspaceId ORDER BY p.person_id = w.owner_id DESC, p.added_at, p.person_id`,
      )
      .all({ workspaceId }) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** The IDs of the agents in the workspace now, as they came in. */
  agentsIn(workspaceId: string): string[] {
    const rows = this.db
      .query("SELECT agent_id AS id FROM workspace_agents WHERE workspace_id = $workspaceId AND left_at IS NULL ORDER BY added_at, agent_id")
      .all({ workspaceId }) as { id: string }[];
    return rows.map((row) => row.id);
  }

  hasPerson(workspaceId: string, personId: string): boolean {
    return (
      this.db
        .query("SELECT 1 FROM workspace_people WHERE workspace_id = $workspaceId AND person_id = $personId")
        .get({ workspaceId, personId }) !== null
    );
  }

  hasAgent(workspaceId: string, agentId: string): boolean {
    return (
      this.db
        .query("SELECT 1 FROM workspace_agents WHERE workspace_id = $workspaceId AND agent_id = $agentId AND left_at IS NULL")
        .get({ workspaceId, agentId }) !== null
    );
  }

  /** The owner's choice for a person in the workspace: whether the person adds more of the person's own agents alone. */
  policyOf(workspaceId: string, personId: string): AgentsPolicy {
    const row = this.db
      .query("SELECT agents_policy FROM workspace_people WHERE workspace_id = $workspaceId AND person_id = $personId")
      .get({ workspaceId, personId }) as { agents_policy: AgentsPolicy } | null;
    return row?.agents_policy ?? "self";
  }

  /**
   * Whether the person's next agent in the workspace waits for the owner: the owner chose to be asked for each one.
   * Never for the owner, and never for a person's own Portico.
   */
  asksOwner(workspaceId: string, personId: string): boolean {
    const workspace = this.get(workspaceId);
    return workspace !== null && workspace.kind === "shared" && workspace.ownerId !== personId && this.policyOf(workspaceId, personId) === "ask";
  }

  /** The owner changes the choice for one person in the workspace. */
  setPolicy(byId: string, workspaceId: string, personId: string, policy: unknown): void {
    const workspace = this.requireOwned(byId, workspaceId);
    if (!this.hasPerson(workspace.id, personId) || personId === workspace.ownerId) throw new PorticoError("not_found", `Nobody like that is in ${workspace.phrase}.`);
    this.db
      .query("UPDATE workspace_people SET agents_policy = $policy WHERE workspace_id = $workspaceId AND person_id = $personId")
      .run({ workspaceId: workspace.id, personId, policy: cleanAgentsPolicy(policy) });
    this.changes.about({ people: [personId], workspaces: [workspaceId] }, "workspaces");
  }

  /** The agents of one person that are in the workspace now. */
  agentsOf(workspaceId: string, personId: string): string[] {
    const rows = this.db
      .query(
        `SELECT x.agent_id AS id FROM workspace_agents x JOIN agents a ON a.id = x.agent_id
         WHERE x.workspace_id = $workspaceId AND x.left_at IS NULL AND a.owner_id = $personId ORDER BY x.added_at, x.agent_id`,
      )
      .all({ workspaceId, personId }) as { id: string }[];
    return rows.map((row) => row.id);
  }

  /**
   * Refuses a name that could be taken for another Portico by any of the people: one that reads the same as a Portico
   * one of them is in (look-alike characters folded, as for handles), or as a form Portico itself gives a Portico nobody
   * named: "Chris's Portico", "Your Portico", or the people's names, "Chris and Robert".
   */
  requireFreeName(name: string, personIds: string[], exceptId: string | null = null): void {
    if (name === "") return;
    const refuse = (why: string): never => {
      throw new PorticoError("conflict", `A Portico can't be named "${name}": ${why} Pick another name.`);
    };
    if (posesAsOwnPortico(name)) refuse("the name reads as a person's own Portico.");
    const key = porticoKey(name);
    const names = new Set<string>();
    for (const personId of personIds) {
      for (const other of this.forPerson(personId)) {
        if (other.id !== exceptId && porticoKey(other.name) === key) refuse("the name reads the same as another Portico one of the people here is in.");
      }
      for (const id of this.visiblePeople(personId)) {
        const person = (this.db.query("SELECT name FROM people WHERE id = $id").get({ id }) as { name: string } | null)?.name;
        if (person) names.add(titleKey(person));
      }
    }
    // "Chris and Robert", "Chris, Robert and Bill": what a Portico nobody named is called after the people in it.
    const parts = name.split(/\s*,\s*|\s+and\s+|\s*&\s*/i).map(titleKey).filter((part) => part !== "");
    if (parts.length >= 2 && parts.every((part) => names.has(part))) refuse("the name reads as a Portico named after the people there.");
  }

  /** The person's handle, or null before one is picked. */
  handleOf(personId: string): string | null {
    const row = this.db.query("SELECT handle FROM people WHERE id = $personId").get({ personId }) as { handle: string | null } | null;
    return row?.handle ?? null;
  }

  // ---- personal ----

  /**
   * The person's personal workspace, made on first use with every agent the person has. It holds only that person's
   * agents and never takes anyone else.
   */
  personal(personId: string): Workspace {
    const row = this.db.query("SELECT * FROM workspaces WHERE owner_id = $personId AND kind = 'personal' AND archived_at IS NULL").get({ personId }) as
      | WorkspaceRow
      | null;
    if (row) return this.view(row);
    const at = this.iso();
    const id = this.newId();
    this.db.transaction(() => {
      this.insert({ id, name: PERSONAL_NAME, kind: "personal", ownerId: personId, createdAt: at });
      this.db
        .query("INSERT INTO workspace_agents (workspace_id, agent_id, added_at) SELECT $id, id, $at FROM agents WHERE owner_id = $personId")
        .run({ id, personId, at });
    })();
    this.log("workspace_created", { workspace_id: id, kind: "personal" });
    return this.get(id)!;
  }

  /**
   * A new agent joins its owner's own Portico. Its owner can take the agent out afterwards (`removeAgent`), so only the
   * agent's other Porticos reach it, and put it back (`addAgent`).
   */
  agentCreated(agentId: string, ownerId: string): void {
    const personal = this.personal(ownerId);
    this.db
      .query("INSERT OR IGNORE INTO workspace_agents (workspace_id, agent_id, added_at) VALUES ($workspaceId, $agentId, $at)")
      .run({ workspaceId: personal.id, agentId, at: this.iso() });
  }

  // ---- shared ----

  /**
   * A new shared workspace, owned by the person, who is its first member. No agents yet: the person puts them in. The
   * name is optional: without one the workspace is named after the people in it, until someone names it.
   */
  create(personId: string, rawName?: unknown): Workspace {
    this.requireHandle(personId);
    const id = this.newId();
    const name = cleanWorkspaceName(rawName);
    this.requireFreeName(name, [personId]);
    this.db.transaction(() => this.insert({ id, name, kind: "shared", ownerId: personId, createdAt: this.iso() }))();
    this.log("workspace_created", { workspace_id: id, kind: "shared" });
    this.changes.about({ people: [personId] }, "workspaces");
    return this.get(id)!;
  }

  /** Only the workspace's owner renames it. A person's own keeps its name. An empty name goes back to the people's names. */
  rename(byId: string, workspaceId: string, rawName: unknown): Workspace {
    const workspace = this.requireOwned(byId, workspaceId);
    const name = cleanWorkspaceName(rawName);
    this.requireFreeName(name, this.peopleIn(workspace.id), workspace.id);
    this.db.query("UPDATE workspaces SET name = $name WHERE id = $id").run({ id: workspace.id, name });
    this.changes.about({ workspaces: [workspace.id] }, "workspaces");
    return this.get(workspace.id)!;
  }

  /**
   * Deletes a shared workspace. Only its owner can. The workspace is archived: nobody is in it or reaches through it
   * any more, and its share links end. The conversations that ran through it stay readable, and take nothing new, until
   * the history window has emptied them; then the workspace's content and its row go (`archived`, `purge`).
   */
  remove(byId: string, workspaceId: string): Workspace {
    const workspace = this.requireOwned(byId, workspaceId);
    const agentIds = this.agentsIn(workspace.id);
    const personIds = this.peopleIn(workspace.id);
    this.db.transaction(() => archiveWorkspaces(this.db, "id = $id", { id: workspace.id }, this.iso()))();
    this.log("workspace_removed", { workspace_id: workspace.id });
    this.changes.about({ people: personIds }, "workspaces", "agents", "threads");
    this.onEvent?.({ kind: "deleted", workspace, byId, agentIds, personIds });
    return workspace;
  }

  /**
   * Pauses a workspace: everyone stays in it and the history stays, and nothing moves through it until its owner
   * resumes it. A send that would go through it is refused, and what was on its way is withdrawn. Only the owner can;
   * a person's own Portico can be paused too.
   */
  pause(byId: string, workspaceId: string): Workspace {
    const workspace = this.requireOwner(byId, workspaceId);
    if (workspace.pausedAt !== null) return workspace;
    this.db.query("UPDATE workspaces SET paused_at = $at WHERE id = $id AND paused_at IS NULL").run({ id: workspace.id, at: this.iso() });
    this.log("workspace_paused", { workspace_id: workspace.id });
    this.changes.about({ workspaces: [workspaceId] }, "workspaces", "agents", "threads", "approvals");
    const paused = this.get(workspace.id)!;
    this.onEvent?.({ kind: "paused", workspace: paused, byId });
    return paused;
  }

  /** Ends a pause: messages move through the workspace again. Nothing withdrawn comes back. */
  resume(byId: string, workspaceId: string): Workspace {
    const workspace = this.requireOwner(byId, workspaceId);
    if (workspace.pausedAt === null) return workspace;
    this.db.query("UPDATE workspaces SET paused_at = NULL WHERE id = $id").run({ id: workspace.id });
    this.log("workspace_resumed", { workspace_id: workspace.id });
    this.changes.about({ workspaces: [workspaceId] }, "workspaces", "agents", "threads");
    const resumed = this.get(workspace.id)!;
    this.onEvent?.({ kind: "resumed", workspace: resumed, byId });
    return resumed;
  }

  /**
   * Lets a person into a shared workspace. Called once a share is confirmed: this method decides nothing about who may
   * come in. The person needs a handle, since everyone else there addresses the person's agents by it. No agents come
   * along: the person puts them in.
   */
  admit(workspaceId: string, personId: string, policy: AgentsPolicy = "self"): void {
    const workspace = this.requireShared(workspaceId);
    this.requireHandle(personId);
    if (this.hasPerson(workspace.id, personId)) return;
    // The name must not read as a Portico the person coming in already has: the person's agents name Porticos by name.
    if (workspace.named) this.requireFreeName(workspace.name, [personId], workspace.id);
    this.db
      .query(
        // Notice emails start from here: what happened before the person came in isn't news to send.
        `INSERT OR IGNORE INTO workspace_people (workspace_id, person_id, added_at, agents_policy, notified_seq)
         VALUES ($workspaceId, $personId, $at, $policy, (SELECT COALESCE(MAX(seq), 0) FROM activity))`,
      )
      .run({ workspaceId: workspace.id, personId, at: this.iso(), policy });
    this.log("workspace_person_added", { workspace_id: workspace.id });
    this.changes.about({ people: [personId], workspaces: [workspace.id] }, "workspaces", "people");
    this.onEvent?.({ kind: "person_joined", workspace: this.get(workspace.id)!, personId, byId: personId });
  }

  /**
   * Takes a person out of a shared workspace with every agent the person had there. The workspace's owner can take
   * anyone else out, and anyone can leave. The owner stays: an owner deletes the workspace instead.
   */
  removePerson(byId: string, workspaceId: string, personId: string): void {
    // Whether the person is in the workspace comes first, so a stranger learns nothing about what kind it is.
    this.requireFor(byId, workspaceId);
    const workspace = this.requireShared(workspaceId);
    if (!this.hasPerson(workspace.id, byId)) throw new PorticoError("not_found", "No such Portico.");
    if (byId !== personId && byId !== workspace.ownerId) {
      throw new PorticoError("not_allowed", `Only the owner of ${workspace.phrase} can remove another person.`);
    }
    if (personId === workspace.ownerId) {
      throw new PorticoError("not_allowed", `The owner of ${workspace.phrase} can't leave. Delete the Portico instead.`);
    }
    const agentIds = this.agentsOf(workspace.id, personId);
    // The agents' rows stay, marked as left, so the conversations each had here stay readable to its owner.
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE workspace_agents SET left_at = $at WHERE workspace_id = $workspaceId AND left_at IS NULL
           AND agent_id IN (SELECT id FROM agents WHERE owner_id = $personId)`,
        )
        .run({ workspaceId: workspace.id, personId, at: this.iso() });
      this.db
        .query("DELETE FROM workspace_people WHERE workspace_id = $workspaceId AND person_id = $personId")
        .run({ workspaceId: workspace.id, personId });
    })();
    this.log("workspace_person_removed", { workspace_id: workspace.id });
    this.changes.about({ people: [personId], workspaces: [workspace.id] }, "workspaces", "people", "agents", "threads");
    this.onPersonRemoved?.(workspace.id, personId);
    this.onEvent?.({ kind: "person_left", workspace, personId, byId, agentIds });
  }

  /**
   * Puts one of the person's own agents into a workspace the person is in: a shared one, or back into the person's own
   * after the agent was taken out. Where the workspace's owner chose to be asked for each agent the person adds, the
   * agent comes in only with `allowed`: the owner's Allow, or the share the person came in with (`asksOwner` says which
   * way a caller has to go).
   */
  addAgent(byId: string, workspaceId: string, agentId: string, opts: { allowed?: boolean; ownerAllowed?: boolean } = {}): void {
    const workspace = this.requireFor(byId, workspaceId);
    if (!this.owns(byId, agentId)) {
      throw new PorticoError("not_allowed", "Only the person who manages an agent can add the agent to a Portico.");
    }
    if (this.isRevoked(agentId)) throw new PorticoError("not_allowed", "A revoked agent can't be put in a Portico.");
    if (this.hasAgent(workspace.id, agentId)) return;
    if (!opts.allowed && !opts.ownerAllowed && this.asksOwner(workspace.id, byId)) {
      throw new PorticoError("not_allowed", `The owner of ${workspace.phrase} asked to allow each agent added there, so the agent comes in once the owner allows the request.`);
    }
    // An agent that was here before comes back on the same row.
    this.db
      .query(
        `INSERT INTO workspace_agents (workspace_id, agent_id, added_at) VALUES ($workspaceId, $agentId, $at)
         ON CONFLICT (workspace_id, agent_id) DO UPDATE SET added_at = excluded.added_at, left_at = NULL WHERE left_at IS NOT NULL`,
      )
      .run({ workspaceId: workspace.id, agentId, at: this.iso() });
    this.log("workspace_agent_added", { workspace_id: workspace.id, agent_id: agentId });
    this.changes.about({ workspaces: [workspace.id], agents: [agentId] }, "workspaces", "agents");
    this.onEvent?.({ kind: "agent_joined", workspace, agentId, byId, ownerAllowed: opts.ownerAllowed === true });
  }

  /**
   * Takes an agent out of a workspace: the person who manages the agent can, and so can the workspace's owner. Out of
   * its owner's own, the agent is reached only through its other workspaces: the way to keep a sensitive agent apart.
   * The row stays, marked as left: the agent reaches nobody through the workspace, and the conversations the agent had
   * there stay readable.
   */
  removeAgent(byId: string, workspaceId: string, agentId: string): void {
    const workspace = this.requireFor(byId, workspaceId);
    if (!this.owns(byId, agentId) && byId !== workspace.ownerId) {
      throw new PorticoError("not_allowed", `Only the person who manages the agent, or the owner of ${workspace.phrase}, can remove the agent.`);
    }
    const left = this.db
      .query("UPDATE workspace_agents SET left_at = $at WHERE workspace_id = $workspaceId AND agent_id = $agentId AND left_at IS NULL")
      .run({ workspaceId: workspace.id, agentId, at: this.iso() }).changes;
    this.log("workspace_agent_removed", { workspace_id: workspace.id, agent_id: agentId });
    this.changes.about({ workspaces: [workspaceId], agents: [agentId] }, "workspaces", "agents", "threads");
    if (left > 0) this.onEvent?.({ kind: "agent_left", workspace, agentId, byId });
  }

  /**
   * A revoked agent leaves every workspace it is in, its owner's own included. Returns the workspaces it left. The
   * caller (core/agents.ts) has checked who may revoke.
   */
  agentRevoked(agentId: string, byId: string): Workspace[] {
    const left = this.ofAgent(agentId);
    this.db.query("UPDATE workspace_agents SET left_at = $at WHERE agent_id = $agentId AND left_at IS NULL").run({ agentId, at: this.iso() });
    this.changes.about({ people: [byId], agents: [agentId], workspaces: left.map((w) => w.id) }, "workspaces", "agents", "threads");
    for (const workspace of left) this.onEvent?.({ kind: "agent_left", workspace, agentId, byId });
    return left;
  }

  // ---- deleted workspaces ----

  /** The IDs of the deleted workspaces still kept for their content, the oldest deletion first. */
  archived(): string[] {
    const rows = this.db.query("SELECT id FROM workspaces WHERE archived_at IS NOT NULL ORDER BY archived_at, id").all() as { id: string }[];
    return rows.map((row) => row.id);
  }

  /** Drops a deleted workspace's row, and with the row the record of who was in it. The caller removes the content next. */
  purge(workspaceId: string): boolean {
    const gone = this.db.query("DELETE FROM workspaces WHERE id = $id AND archived_at IS NOT NULL").run({ id: workspaceId }).changes === 1;
    if (gone) this.log("workspace_purged", { workspace_id: workspaceId });
    return gone;
  }

  // ---- helpers ----

  private insert(workspace: { id: string; name: string; kind: WorkspaceKind; ownerId: string; createdAt: string }): void {
    this.db
      .query("INSERT INTO workspaces (id, name, kind, owner_id, created_at) VALUES ($id, $name, $kind, $ownerId, $createdAt)")
      .run({ ...workspace });
    this.db
      .query("INSERT INTO workspace_people (workspace_id, person_id, added_at) VALUES ($id, $ownerId, $createdAt)")
      .run({ id: workspace.id, ownerId: workspace.ownerId, createdAt: workspace.createdAt });
  }

  private owns(personId: string, agentId: string): boolean {
    return this.db.query("SELECT 1 FROM agents WHERE id = $agentId AND owner_id = $personId").get({ agentId, personId }) !== null;
  }

  private requireHandle(personId: string): void {
    if (this.handleOf(personId) === null) {
      throw new PorticoError("wrong_status", "Pick a handle first: other people's agents in a Portico address agents by the handle.");
    }
  }

  private isRevoked(agentId: string): boolean {
    return this.db.query("SELECT 1 FROM agents WHERE id = $agentId AND revoked_at IS NOT NULL").get({ agentId }) !== null;
  }

  /** Set by the sharing module: ends the links a person made or used in a workspace the person is no longer in. */
  onPersonRemoved: ((workspaceId: string, personId: string) => void) | null = null;
  /** Set by portico.ts: what follows a change to who is in a workspace, or to whether anything moves through it. */
  onEvent: ((event: WorkspaceEvent) => void) | null = null;

  /** The workspace, for its owner: a shared one or the person's own. Anyone else in it is refused; a stranger sees `not_found`. */
  private requireOwner(byId: string, workspaceId: string): Workspace {
    const workspace = this.requireFor(byId, workspaceId);
    if (workspace.ownerId !== byId) throw new PorticoError("not_allowed", `Only the owner of ${workspace.phrase} can do this.`);
    return workspace;
  }

  private requireShared(workspaceId: string): Workspace {
    const workspace = this.get(workspaceId);
    if (!workspace) throw new PorticoError("not_found", "No such Portico.");
    if (workspace.kind === "personal") {
      throw new PorticoError(
        "not_allowed",
        `${workspace.name} holds only the agents of one person: it can't be shared, renamed or deleted. Make a new Portico to bring someone else's agents in.`,
      );
    }
    return workspace;
  }

  private requireOwned(byId: string, workspaceId: string): Workspace {
    this.requireFor(byId, workspaceId);
    const workspace = this.requireShared(workspaceId);
    if (!this.hasPerson(workspace.id, byId)) throw new PorticoError("not_found", "No such Portico.");
    if (workspace.ownerId !== byId) throw new PorticoError("not_allowed", `Only the owner of ${workspace.phrase} can do this.`);
    return workspace;
  }

  private iso(): string {
    return this.now().toISOString();
  }
}

/**
 * Archives the workspaces a condition picks: nobody is in one or reaches through one any more, and the share links and
 * requests about one end. Each agent's row stays, marked as left, so the conversations stay readable to the agents'
 * owners until the history window empties the workspace. Run inside the caller's transaction. Removing a person
 * archives the workspaces that person owns (core/people.ts).
 */
export function archiveWorkspaces(db: Database, where: string, bindings: Record<string, string>, at: string): void {
  const ids = `SELECT id FROM workspaces WHERE ${where}`;
  db.query(`UPDATE workspace_agents SET left_at = $at WHERE left_at IS NULL AND workspace_id IN (${ids})`).run({ ...bindings, at });
  db.query(`DELETE FROM workspace_people WHERE workspace_id IN (${ids})`).run(bindings);
  db.query(`DELETE FROM shares WHERE workspace_id IN (${ids})`).run(bindings);
  // What waits for a person about one stops waiting. The rows stay, so the page that allowed a delete can say so.
  db.query(`UPDATE consent_requests SET status = 'expired' WHERE status = 'pending' AND workspace_id IN (${ids})`).run(bindings);
  db.query(`UPDATE workspaces SET archived_at = $at WHERE archived_at IS NULL AND ${where}`).run({ ...bindings, at });
}
