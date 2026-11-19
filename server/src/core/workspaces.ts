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

function toWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, kind: row.kind as WorkspaceKind, ownerId: row.owner_id, createdAt: row.created_at };
}

export const PERSONAL_NAME = "Personal";
export const MAX_WORKSPACE_NAME = 60;

/** A workspace's name as typed: trimmed, on one line, 1 to 60 characters. */
export function cleanWorkspaceName(value: unknown): string {
  if (typeof value !== "string") throw new PorticoError("bad_request", "name must be a string.");
  const name = value.replace(/\s+/g, " ").trim();
  if (name === "" || /[\u0000-\u001f\u007f]/.test(name)) throw new PorticoError("bad_request", "Enter a name for the workspace.");
  if (Array.from(name).length > MAX_WORKSPACE_NAME) {
    throw new PorticoError("bad_request", `A workspace name can be at most ${MAX_WORKSPACE_NAME} characters.`);
  }
  return name;
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
    return rows.map(toWorkspace);
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

  // ---- reads ----

  /** The workspace, unless deleted: a deleted workspace answers the same as one that never existed. */
  get(id: string): Workspace | null {
    const row = this.db.query("SELECT * FROM workspaces WHERE id = $id AND archived_at IS NULL").get({ id }) as WorkspaceRow | null;
    return row ? toWorkspace(row) : null;
  }

  /** The workspace, for a person in it. One the person isn't in answers the same as one that doesn't exist. */
  requireFor(personId: string, id: string): Workspace {
    const workspace = this.get(id);
    if (!workspace || !this.hasPerson(id, personId)) throw new PorticoError("not_found", "No such workspace.");
    return workspace;
  }

  /** The workspaces the person is in, personal first. */
  forPerson(personId: string): Workspace[] {
    const rows = this.db
      .query(`SELECT w.* FROM workspaces w JOIN workspace_people p ON p.workspace_id = w.id WHERE p.person_id = $personId AND w.archived_at IS NULL ${ORDER}`)
      .all({ personId }) as WorkspaceRow[];
    return rows.map(toWorkspace);
  }

  /** The workspaces the agent is in now, personal first. */
  ofAgent(agentId: string): Workspace[] {
    const rows = this.db
      .query(
        `SELECT w.* FROM workspaces w JOIN workspace_agents a ON a.workspace_id = w.id
         WHERE a.agent_id = $agentId AND a.left_at IS NULL AND w.archived_at IS NULL ${ORDER}`,
      )
      .all({ agentId }) as WorkspaceRow[];
    return rows.map(toWorkspace);
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
    if (row) return toWorkspace(row);
    const at = this.iso();
    const workspace: Workspace = { id: this.newId(), name: PERSONAL_NAME, kind: "personal", ownerId: personId, createdAt: at };
    this.db.transaction(() => {
      this.insert(workspace);
      this.db
        .query("INSERT INTO workspace_agents (workspace_id, agent_id, added_at) SELECT $id, id, $at FROM agents WHERE owner_id = $personId")
        .run({ id: workspace.id, personId, at });
    })();
    this.log("workspace_created", { workspace_id: workspace.id, kind: "personal" });
    return workspace;
  }

  /** A new agent joins its owner's personal workspace. */
  agentCreated(agentId: string, ownerId: string): void {
    const personal = this.personal(ownerId);
    this.db
      .query("INSERT OR IGNORE INTO workspace_agents (workspace_id, agent_id, added_at) VALUES ($workspaceId, $agentId, $at)")
      .run({ workspaceId: personal.id, agentId, at: this.iso() });
  }

  // ---- shared ----

  /** A new shared workspace, owned by the person, who is its first member. No agents yet: the person puts them in. */
  create(personId: string, rawName: unknown): Workspace {
    this.requireHandle(personId);
    const workspace: Workspace = {
      id: this.newId(),
      name: cleanWorkspaceName(rawName),
      kind: "shared",
      ownerId: personId,
      createdAt: this.iso(),
    };
    this.db.transaction(() => this.insert(workspace))();
    this.log("workspace_created", { workspace_id: workspace.id, kind: "shared" });
    this.changes.emit("workspaces");
    return workspace;
  }

  /** Only the workspace's owner renames it. Personal keeps its name. */
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
    if (!this.hasPerson(workspace.id, byId)) throw new PorticoError("not_found", "No such workspace.");
    if (byId !== personId && byId !== workspace.ownerId) {
      throw new PorticoError("not_allowed", "Only the owner of the workspace can remove another person.");
    }
    if (personId === workspace.ownerId) {
      throw new PorticoError("not_allowed", "The owner of a workspace can't leave. Delete the workspace instead.");
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

  /** Puts one of the person's own agents into a shared workspace the person is in. */
  addAgent(byId: string, workspaceId: string, agentId: string): void {
    // Whether the person is in the workspace comes first, so a stranger learns nothing about what kind it is.
    this.requireFor(byId, workspaceId);
    const workspace = this.requireShared(workspaceId);
    if (!this.hasPerson(workspace.id, byId)) throw new PorticoError("not_found", "No such workspace.");
    if (!this.owns(byId, agentId)) {
      throw new PorticoError("not_allowed", "Only the person who manages an agent can add the agent to a workspace.");
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
   * Takes an agent out of a shared workspace: the person who manages the agent can, and so can the workspace's owner.
   * Every agent stays in its owner's personal workspace. The row stays, marked as left: the agent reaches nobody through
   * the workspace, and the conversations the agent had there stay readable.
   */
  removeAgent(byId: string, workspaceId: string, agentId: string): void {
    // Whether the person is in the workspace comes first, so a stranger learns nothing about what kind it is.
    this.requireFor(byId, workspaceId);
    const workspace = this.requireShared(workspaceId);
    if (!this.hasPerson(workspace.id, byId)) throw new PorticoError("not_found", "No such workspace.");
    if (!this.owns(byId, agentId) && byId !== workspace.ownerId) {
      throw new PorticoError("not_allowed", "Only the person who manages the agent, or the owner of the workspace, can remove the agent.");
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

  private insert(workspace: Workspace): void {
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
      throw new PorticoError("wrong_status", "Pick a handle first: agents in a shared workspace are addressed by the handle.");
    }
  }

  /** Set by the sharing module: ends the links a person made or used in a workspace the person is no longer in. */
  onPersonRemoved: ((workspaceId: string, personId: string) => void) | null = null;

  private requireShared(workspaceId: string): Workspace {
    const workspace = this.get(workspaceId);
    if (!workspace) throw new PorticoError("not_found", "No such workspace.");
    if (workspace.kind === "personal") {
      throw new PorticoError("not_allowed", "A personal workspace holds only the agents of one person and can't be shared.");
    }
    return workspace;
  }

  private requireOwned(byId: string, workspaceId: string): Workspace {
    this.requireFor(byId, workspaceId);
    const workspace = this.requireShared(workspaceId);
    if (!this.hasPerson(workspace.id, byId)) throw new PorticoError("not_found", "No such workspace.");
    if (workspace.ownerId !== byId) throw new PorticoError("not_allowed", "Only the owner of the workspace can do this.");
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
