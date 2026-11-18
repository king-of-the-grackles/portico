import { type Context, Hono } from "hono";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import type { Share, ShareRequest, WorkspaceAsk } from "../core/shares";
import type { AgentKind, Person, Workspace, WorkspaceKind } from "../core/types";
import { log } from "../log";
import { type PersonEnv, currentPerson } from "./context";
import { jsonObject } from "./session";
import { type AgentRef, type PersonRef, personViews } from "./views";

/** A workspace as the signed-in person sees it. */
export interface WorkspaceView {
  id: string;
  name: string;
  kind: WorkspaceKind;
  owner: PersonRef;
  isOwner: boolean;
  /** Everyone in it, the owner first. A personal workspace holds only its owner. */
  people: PersonRef[];
  /** Every agent in it, whoever manages each. */
  agentIds: string[];
  /** Something in it waits for the person: a held message, or an agent's request about the workspace. */
  needs: boolean;
}

/** A share link, for the people who may see it. */
export interface ShareView {
  id: string;
  workspaceId: string;
  /** The address the link was emailed to, or null for a link to hand over. */
  email: string | null;
  createdBy: PersonRef;
  createdAt: string;
  expiresAt: string;
  /** The person who came in with the link. */
  claimedBy: PersonRef | null;
  link: string | null;
  /** How the email just sent went: `sent`, or why none left. Absent when nothing was sent now. */
  mail?: string | null;
  /** How many times the email has gone out or been tried. */
  mails: number;
}

/** An agent of the person's asking to come into a workspace with a share link. */
export interface JoinView {
  id: string;
  /** The code the agent shows in its chat. */
  code: string;
  agent: AgentRef;
  workspace: { id: string; name: string };
  sharedBy: PersonRef | null;
  expiresAt: string;
}

/** Something an agent asked the person to confirm: sharing a workspace, or taking a person out. */
export interface AskView {
  id: string;
  kind: WorkspaceAsk["kind"];
  agent: AgentRef;
  workspace: { id: string; name: string };
  email: string | null;
  person: PersonRef | null;
  expiresAt: string;
}

export function workspaceViews(core: Core, me: Person) {
  const { workspaces, people, agents, shares, settings } = core;
  const views = personViews(core, me);
  const ref = (id: string): PersonRef => {
    const person = people.get(id);
    return { id, name: person?.name ?? "", ...(person?.handle ? { handle: person.handle } : {}) };
  };
  /** The workspaces where something waits for the person. */
  const needing = (): Set<string> => {
    const found = new Set<string>();
    for (const ask of shares.asksFor(me.id)) found.add(ask.workspaceId);
    for (const request of shares.pendingFor(me.id)) {
      const share = shares.get(request.shareId);
      if (share) found.add(share.workspaceId);
    }
    const held = core.approvals.heldFor(me.id);
    if (held.length > 0) {
      const stamp = core.db.query("SELECT t.workspace_id AS id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = $id");
      for (const message of held) {
        const row = stamp.get({ id: message.id }) as { id: string | null } | null;
        if (row?.id) found.add(row.id);
      }
    }
    return found;
  };
  const workspace = (w: Workspace, needs: Set<string> = needing()): WorkspaceView => ({
    id: w.id,
    name: w.name,
    kind: w.kind,
    owner: ref(w.ownerId),
    isOwner: w.ownerId === me.id,
    people: [w.ownerId, ...workspaces.peopleIn(w.id).filter((id) => id !== w.ownerId)].map(ref),
    agentIds: workspaces.agentsIn(w.id),
    needs: needs.has(w.id),
  });
  const share = (s: Share, mail: string | null = null): ShareView => {
    const secret = shares.secretFor(me.id, s.id);
    return {
      id: s.id,
      workspaceId: s.workspaceId,
      email: s.email,
      createdBy: ref(s.createdBy),
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      claimedBy: s.claimedBy ? ref(s.claimedBy) : null,
      link: secret ? `${settings.publicUrl()}/share#${secret}` : null,
      mails: core.mail.sends(s.id),
      ...(mail === null ? {} : { mail }),
    };
  };
  const named = (id: string) => ({ id, name: workspaces.get(id)?.name ?? "" });
  const join = (request: ShareRequest): JoinView | null => {
    const s = shares.get(request.shareId);
    const agent = request.agentId ? agents.get(request.agentId) : null;
    if (!s || !agent) return null;
    return { id: request.id, code: request.code, agent: views.agentRef(agent.id), workspace: named(s.workspaceId), sharedBy: ref(s.createdBy), expiresAt: request.expiresAt };
  };
  const ask = (a: WorkspaceAsk): AskView => ({
    id: a.id,
    kind: a.kind,
    agent: views.agentRef(a.agentId),
    workspace: named(a.workspaceId),
    email: a.detail.email ?? null,
    person: a.detail.personId ? ref(a.detail.personId) : null,
    expiresAt: a.expiresAt,
  });
  return {
    workspace,
    share,
    /** The person's workspaces: Personal first, then shared ones by name. Empty where Portico has no workspaces. */
    list: (): WorkspaceView[] => {
      if (!workspaces.enabled) return [];
      workspaces.personal(me.id);
      const needs = needing();
      return workspaces.forPerson(me.id).map((w) => workspace(w, needs));
    },
    joins: (): JoinView[] => shares.pendingFor(me.id).map(join).filter((view): view is JoinView => view !== null),
    asks: (): AskView[] => shares.asksFor(me.id).map(ask),
  };
}

/** What waits for the person about workspaces: agents asking to come in, and what agents asked to be confirmed. */
export function workspaceApprovals(core: Core, me: Person): { joins: JoinView[]; asks: AskView[] } {
  if (!core.workspaces.enabled) return { joins: [], asks: [] };
  const views = workspaceViews(core, me);
  return { joins: views.joins(), asks: views.asks() };
}

/** What a workspace's page shows besides the workspace itself. */
export interface WorkspacePageData {
  workspace: WorkspaceView;
  shares: ShareView[];
}

export function workspacePageData(core: Core, me: Person, id: string): WorkspacePageData {
  const views = workspaceViews(core, me);
  const workspace = core.workspaces.requireFor(me.id, id);
  return { workspace: views.workspace(workspace), shares: core.shares.openFor(me.id, workspace.id).map((s) => views.share(s)) };
}

/**
 * Workspaces, for the signed-in person. A workspace nobody shared with the person answers 404, like one that isn't
 * there.
 *
 *   GET    /api/workspaces                         → { workspaces }
 *   POST   /api/workspaces { name, agentIds? }     → { workspace }: a new shared workspace with the person's agents
 *   GET    /api/workspaces/:id                     → { workspace, shares }
 *   PATCH  /api/workspaces/:id { name }            → { workspace }
 *   DELETE /api/workspaces/:id
 *   PUT    /api/workspaces/:id/agents/:agentId     DELETE the same: the person's own agents in and out
 *   DELETE /api/workspaces/:id/people/:personId    the owner removes someone, or anyone leaves
 *   POST   /api/workspaces/:id/shares { email? }   → { share }: a link for one person
 *   POST   /api/shares/:id/mail                    → { share }: the share's email again
 *   DELETE /api/shares/:id
 *   POST   /api/approvals/joins/:id { decision, code?, name? }
 *   POST   /api/approvals/asks/:id { decision }
 */
export function workspaceRoutes(core: Core): Hono<PersonEnv> {
  const { workspaces, shares } = core;
  const route = new Hono<PersonEnv>();
  if (!workspaces.enabled) return route;
  const views = (c: Context<PersonEnv>) => workspaceViews(core, currentPerson(c));

  route.get("/workspaces", (c) => c.json({ workspaces: views(c).list() }));

  route.post("/workspaces", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    const ids = Array.isArray(body.agentIds) ? body.agentIds.filter((id): id is string => typeof id === "string") : [];
    const workspace = core.db.transaction(() => {
      const made = workspaces.create(me.id, body.name);
      for (const id of ids) workspaces.addAgent(me.id, made.id, id);
      return made;
    })();
    return c.json({ workspace: workspaceViews(core, me).workspace(workspace) }, 201);
  });

  route.get("/workspaces/:id", (c) => c.json(workspacePageData(core, currentPerson(c), c.req.param("id"))));

  route.patch("/workspaces/:id", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    workspaces.requireFor(me.id, c.req.param("id"));
    return c.json({ workspace: workspaceViews(core, me).workspace(workspaces.rename(me.id, c.req.param("id"), body.name)) });
  });

  route.delete("/workspaces/:id", (c) => {
    const me = currentPerson(c);
    workspaces.requireFor(me.id, c.req.param("id"));
    workspaces.remove(me.id, c.req.param("id"));
    return c.body(null, 204);
  });

  route.put("/workspaces/:id/agents/:agentId", (c) => {
    const me = currentPerson(c);
    workspaces.addAgent(me.id, c.req.param("id"), c.req.param("agentId"));
    return c.body(null, 204);
  });

  route.delete("/workspaces/:id/agents/:agentId", (c) => {
    const me = currentPerson(c);
    workspaces.removeAgent(me.id, c.req.param("id"), c.req.param("agentId"));
    return c.body(null, 204);
  });

  route.delete("/workspaces/:id/people/:personId", (c) => {
    const me = currentPerson(c);
    workspaces.removePerson(me.id, c.req.param("id"), c.req.param("personId"));
    return c.body(null, 204);
  });

  route.post("/workspaces/:id/shares", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    const { share, secret } = shares.create(me.id, c.req.param("id"), { email: body.email });
    let mail: string | null = null;
    if (share.email !== null) mail = await core.mail.send(share, `${core.settings.publicUrl()}/share#${secret}`, me);
    return c.json({ share: workspaceViews(core, me).share(share, mail) }, 201);
  });

  // Sends a share's email again: the person who made the link, at most twice more, an hour apart.
  route.post("/shares/:id/mail", async (c) => {
    const me = currentPerson(c);
    const share = shares.get(c.req.param("id"));
    const secret = share && share.createdBy === me.id ? shares.secretFor(me.id, share.id) : null;
    if (!share || !secret || share.email === null) throw new PorticoError("not_found", "No such share link.");
    const mail = await core.mail.send(share, `${core.settings.publicUrl()}/share#${secret}`, me);
    return c.json({ share: workspaceViews(core, me).share(share, mail) });
  });

  route.delete("/shares/:id", (c) => {
    shares.revoke(currentPerson(c).id, c.req.param("id"));
    return c.body(null, 204);
  });

  route.post("/approvals/joins/:id", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    const { request, agent, workspace } = shares.decide(me.id, c.req.param("id"), { decision: body.decision, code: body.code, name: body.name });
    log("info", "join_decided", { request_id: request.id, status: request.status });
    return c.json({
      status: request.status,
      workspace: { id: workspace.id, name: workspace.name },
      agent: agent ? personViews(core, me).agent(agent) : null,
      // For the confirm page's form, which goes on to the workspace.
      next: request.status === "approved" ? `/w/${workspace.id}` : "/",
    });
  });

  route.post("/approvals/asks/:id", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    const ask = shares.decideAsk(me.id, c.req.param("id"), body.decision);
    const share = ask.result?.shareId ? shares.get(ask.result.shareId) : null;
    let mail: string | null = null;
    if (share && share.email !== null) {
      const secret = shares.secretFor(me.id, share.id);
      mail = secret ? await core.mail.send(share, `${core.settings.publicUrl()}/share#${secret}`, me) : "failed";
    }
    return c.json({ status: ask.status, share: share ? workspaceViews(core, me).share(share, mail) : null });
  });

  return route;
}
