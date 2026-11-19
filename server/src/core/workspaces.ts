import type { Database } from "bun:sqlite";
import type { Changes } from "./changes";
import { PorticoError } from "./errors";
import type { Workspace, WorkspaceKind } from "./types";

interface WorkspaceRow {
  id: string;
  name: string;
  kind: string;
  owner_id: string;
  created_at: string;
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

  /** Whether the workspace joins the two agents now: both are in the workspace, and the workspace isn't deleted. */
  joins(workspaceId: string, agentId: string, otherId: string): boolean {
    return this.shared(agentId, otherId).some((w) => w.id === workspaceId);
  }

  /**
   * The workspace a new conversation between the two goes in: the most private one both are in now. First the personal
   * workspace of the person who manages both; then a shared one whose people are exactly the two agents' owners; then
   * the oldest shared one. Null when the two share none. A reply doesn't ask this: a conversation stays in the
   * workspace where the conversation started (core/messages.ts).
   */
  route(agentId: string, otherId: string): Workspace | null {
    const shared = this.shared(agentId, otherId);
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
   * sentence names it: "the Launch Portico".
   */
  private view(row: WorkspaceRow): Workspace {
    const base = { id: row.id, kind: row.kind as WorkspaceKind, ownerId: row.owner_id, createdAt: row.created_at };
    const personName = (id: string) => (this.db.query("SELECT name FROM people WHERE id = $id").get({ id }) as { name: string } | null)?.name ?? "";
    if (base.kind === "personal") {
      const owner = personName(row.owner_id);
      const name = owner === "" ? "A Portico" : `${owner}'s Portico`;
      return { ...base, name, named: false, phrase: owner === "" ? "a Portico" : name };
    }
    if (row.name !== "") {
      return { ...base, name: row.name, named: true, phrase: /\bportico$/i.test(row.name) ? `the ${row.name}` : `the ${row.name} Portico` };
    }
    // A deleted Portico has nobody in it any more: its owner's name stands in.
    const people = this.peopleIn(row.id).map(personName).filter((name) => name !== "");
    if (people.length >= 2) {
      const name = listNames(people);
      return { ...base, name, named: false, phrase: `the ${name} Portico` };
    }
    const owner = people[0] ?? personName(row.owner_id);
    const name = owner === "" ? "A new Portico" : `${owner}'s new Portico`;
    return { ...base, name, named: false, phrase: owner === "" ? "a new Portico" : name };
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
    this.db.transaction(() => this.insert({ id, name, kind: "shared", ownerId: personId, createdAt: this.iso() }))();
    this.log("workspace_created", { workspace_id: id, kind: "shared" });
    this.changes.emit("workspaces");
    return this.get(id)!;
  }

  /** Only the workspace's owner renames it. A person's own keeps its name. An empty name goes back to the people's names. */
  rename(byId: string, workspaceId: string, rawName: unknown): Workspace {
    const workspace = this.requireOwned(byId, workspaceId);
    this.db.query("UPDATE workspaces SET name = $name WHERE id = $id").run({ id: workspace.id, name: cleanWorkspaceName(rawName) });
    this.changes.emit("workspaces");
    return this.get(workspace.id)!;
  }

  /**
   * Deletes a shared workspace. Only its owner can. The workspace is archived: nobody is in it or reaches through it
   * any more, and its share links end. The conversations that ran through it stay readable, and take nothing new, until
   * the history window has emptied them; then the workspace's content and its row go (`archived`, `purge`).
   */
  remove(byId: string, workspaceId: string): Workspace {
    const workspace = this.requireOwned(byId, workspaceId);
    this.db.transaction(() => archiveWorkspaces(this.db, "id = $id", { id: workspace.id }, this.iso()))();
    this.log("workspace_removed", { workspace_id: workspace.id });
    this.changes.emit("workspaces", "agents", "threads");
    return workspace;
  }

  /**
   * Lets a person into a shared workspace. Called once a share is confirmed: this method decides nothing about who may
   * come in. The person needs a handle, since everyone else there addresses the person's agents by it. No agents come
   * along: the person puts them in.
   */
  admit(workspaceId: string, personId: string): void {
    const workspace = this.requireShared(workspaceId);
    this.requireHandle(personId);
    this.db
      .query("INSERT OR IGNORE INTO workspace_people (workspace_id, person_id, added_at) VALUES ($workspaceId, $personId, $at)")
      .run({ workspaceId: workspace.id, personId, at: this.iso() });
    this.log("workspace_person_added", { workspace_id: workspace.id });
    this.changes.emit("workspaces", "people");
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
    this.changes.emit("workspaces", "people", "agents", "threads");
    this.onPersonRemoved?.(workspace.id, personId);
  }

  /**
   * Puts one of the person's own agents into a workspace the person is in: a shared one, or back into the person's own
   * after the agent was taken out.
   */
  addAgent(byId: string, workspaceId: string, agentId: string): void {
    const workspace = this.requireFor(byId, workspaceId);
    if (!this.owns(byId, agentId)) {
      throw new PorticoError("not_allowed", "Only the person who manages an agent can add the agent to a Portico.");
    }
    // An agent that was here before comes back on the same row.
    this.db
      .query(
        `INSERT INTO workspace_agents (workspace_id, agent_id, added_at) VALUES ($workspaceId, $agentId, $at)
         ON CONFLICT (workspace_id, agent_id) DO UPDATE SET added_at = excluded.added_at, left_at = NULL WHERE left_at IS NOT NULL`,
      )
      .run({ workspaceId: workspace.id, agentId, at: this.iso() });
    this.log("workspace_agent_added", { workspace_id: workspace.id, agent_id: agentId });
    this.changes.emit("workspaces", "agents");
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
    this.db
      .query("UPDATE workspace_agents SET left_at = $at WHERE workspace_id = $workspaceId AND agent_id = $agentId AND left_at IS NULL")
      .run({ workspaceId: workspace.id, agentId, at: this.iso() });
    this.log("workspace_agent_removed", { workspace_id: workspace.id, agent_id: agentId });
    this.changes.emit("workspaces", "agents", "threads");
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

  /** Set by the sharing module: ends the links a person made or used in a workspace the person is no longer in. */
  onPersonRemoved: ((workspaceId: string, personId: string) => void) | null = null;

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
  db.query(`DELETE FROM workspace_asks WHERE workspace_id IN (${ids})`).run(bindings);
  db.query(`UPDATE workspaces SET archived_at = $at WHERE archived_at IS NULL AND ${where}`).run({ ...bindings, at });
}
