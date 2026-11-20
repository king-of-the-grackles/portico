import { type Context, Hono } from "hono";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import type { Share } from "../core/shares";
import { recordWords } from "../core/record-words";
import { quote } from "../core/consent-words";
import type { AgentsPolicy, Person, Workspace, WorkspaceKind } from "../core/types";
import { type PersonEnv, currentPerson } from "./context";
import { jsonObject } from "./session";
import { type PersonRef, porticoPhrase, porticoTitle } from "./views";

/** A Portico (a workspace, in this code) as the signed-in person sees it. */
export interface WorkspaceView {
  id: string;
  /** Its heading: "Personal Portico" for the person's own, otherwise the name someone gave it or the people in it. */
  name: string;
  /** The same inside a sentence: "your Personal Portico", "the Launch Portico". */
  phrase: string;
  /** Whether someone gave it a name. Without one it is named after the people in it. */
  named: boolean;
  /** The shared Portico the person started with, not renamed yet. */
  starter: boolean;
  kind: WorkspaceKind;
  owner: PersonRef;
  isOwner: boolean;
  /** Whether a share link can be for one email address only: where signing in verifies addresses. Absent means yes. */
  linksByEmail?: boolean;
  /**
   * Everyone in it, the owner first. A personal workspace holds only its owner. `agents` is the owner's choice for the
   * person: `self`, the person adds more of the person's own agents alone; `ask`, each one waits for the owner.
   * `allowed` says whether that person's agents get through to the signed-in person's agents without being asked about.
   */
  people: (PersonRef & { agents: AgentsPolicy; allowed: boolean })[];
  /** Set while the owner has it paused: nothing moves through it. */
  pausedAt: string | null;
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
  /** The owner's choice for the person the link lets in. */
  agents: AgentsPolicy;
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

export function workspaceViews(core: Core, me: Person) {
  const { workspaces, people, shares, settings } = core;
  const ref = (id: string): PersonRef => {
    const person = people.get(id);
    return { id, name: person?.name ?? "", ...(person?.handle ? { handle: person.handle } : {}) };
  };
  /** The workspaces where something waits for the person. */
  const needing = (): Set<string> => {
    const found = new Set<string>();
    for (const request of core.consents.waitingFor(me.id)) if (request.workspaceId) found.add(request.workspaceId);
    // Each held message says which workspace it is in: the one whose content database holds the message.
    for (const message of core.approvals.heldFor(me.id)) found.add(message.workspaceId);
    return found;
  };
  const workspace = (w: Workspace, needs: Set<string> = needing()): WorkspaceView => ({
    id: w.id,
    name: porticoTitle(w, me),
    phrase: porticoPhrase(w, me),
    named: w.named,
    starter: w.starter === true,
    kind: w.kind,
    owner: ref(w.ownerId),
    isOwner: w.ownerId === me.id,
    linksByEmail: core.shares.bindsEmail,
    people: [w.ownerId, ...workspaces.peopleIn(w.id).filter((id) => id !== w.ownerId)].map((id) => ({
      ...ref(id),
      agents: workspaces.policyOf(w.id, id),
      allowed: core.contacts.has(me.id, id),
    })),
    pausedAt: w.pausedAt,
    agentIds: workspaces.agentsIn(w.id),
    needs: needs.has(w.id),
  });
  const share = (s: Share, mail: string | null = null): ShareView => {
    const secret = shares.secretFor(me.id, s.id);
    return {
      id: s.id,
      workspaceId: s.workspaceId,
      email: s.email,
      agents: s.agentsPolicy,
      createdBy: ref(s.createdBy),
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      claimedBy: s.claimedBy ? ref(s.claimedBy) : null,
      link: secret ? `${settings.publicUrl()}/share#${secret}` : null,
      mails: core.mail.sends(s.id),
      ...(mail === null ? {} : { mail }),
    };
  };
  return {
    workspace,
    share,
    /** The person's workspaces: the person's own first, then shared ones, the oldest first. */
    list: (): WorkspaceView[] => {
      workspaces.personal(me.id);
      const needs = needing();
      return workspaces.forPerson(me.id).map((w) => workspace(w, needs));
    },
  };
}

/** One line of a Portico's record: Portico's own sentence, with no message subject or text. */
export interface RecordView {
  id: string;
  at: string;
  kind: string;
  text: string;
}

/** What a workspace's page shows besides the workspace itself. */
export interface WorkspacePageData {
  workspace: WorkspaceView;
  shares: ShareView[];
  /** The Portico's record, newest first: who came in and left, shares, holds, refused sends and pauses. */
  record: RecordView[];
  /** What the people here asked the owner: agents waiting to come in. Only for the owner. */
  asks: { id: string; link: string; text: string; expiresAt: string }[];
}

/** A Portico's record as one person in it reads it. */
export function recordFor(core: Core, me: Person, workspace: Workspace): RecordView[] {
  const person = (id: string | null) => {
    const p = id ? core.people.get(id) : null;
    return p ? `${p.name}${p.handle ? ` (${p.handle})` : ""}` : null;
  };
  const names = {
    person,
    agent: (id: string | null) => {
      const agent = id ? core.agents.get(id) : null;
      return agent ? core.agents.addressFor(agent, me.id) : null;
    },
    email: (id: string | null) => (id && workspace.ownerId === me.id ? (core.people.get(id)?.email ?? null) : null),
  };
  return core.activity.recordOf(workspace.id, { forPerson: me.id }).flatMap((entry) => {
    const text = recordWords(entry, names);
    return text === null ? [] : [{ id: entry.id, at: entry.at, kind: entry.kind, text }];
  });
}

export function workspacePageData(core: Core, me: Person, id: string): WorkspacePageData {
  const views = workspaceViews(core, me);
  const workspace = core.workspaces.requireFor(me.id, id);
  const asks = core.consents
    .waitingFor(me.id)
    .filter((request) => request.kind === "admit_agent" && request.workspaceId === workspace.id)
    .map((request) => {
      const asker = request.detail.personId ? core.people.get(request.detail.personId) : null;
      const subject = request.detail.agentId ? core.agents.get(request.detail.agentId) : null;
      return {
        id: request.id,
        link: `/c/${request.id}`,
        text: `${asker?.name ?? "A person here"} asks to put the agent ${quote(subject ? core.agents.addressFor(subject, me.id) : "agent")} in.`,
        expiresAt: request.expiresAt,
      };
    });
  return {
    workspace: views.workspace(workspace),
    shares: core.shares.openFor(me.id, workspace.id).map((s) => views.share(s)),
    record: recordFor(core, me, workspace),
    asks,
  };
}

/**
 * Porticos, for the signed-in person. One nobody shared with the person answers 404, like one that isn't there. The
 * JSON keeps the code's word for a Portico, `workspace`.
 *
 *   GET    /api/porticos                         → { workspaces }
 *   POST   /api/porticos { name?, agentIds? }    → { workspace }: a new one with the person's agents, named or not
 *   GET    /api/porticos/:id                     → { workspace, shares }
 *   PATCH  /api/porticos/:id { name }            → { workspace }
 *   DELETE /api/porticos/:id
 *   PUT    /api/porticos/:id/agents/:agentId     DELETE the same: the person's own agents in and out, the person's
 *                                                own Portico included (taking an agent out of it, and putting it back).
 *                                                Where the owner chose to be asked, PUT answers 202 { waiting }: the
 *                                                agent comes in once the owner allows the request.
 *   DELETE /api/porticos/:id/people/:personId    the owner removes someone, or anyone leaves
 *   PATCH  /api/porticos/:id/people/:personId { agents }  the owner's choice for that person: self or ask
 *   PUT    /api/porticos/:id/pause               DELETE the same: the owner pauses and resumes
 *   POST   /api/porticos/:id/shares { email?, agents? }   → { share }: a link for one person, made by the owner
 *   DELETE /api/contacts/:personId               ask again about that person's agents' messages
 *   POST   /api/shares/:id/mail                    → { share }: the share's email again
 *   DELETE /api/shares/:id
 */
export function workspaceRoutes(core: Core): Hono<PersonEnv> {
  const { workspaces, shares } = core;
  const route = new Hono<PersonEnv>();
  const views = (c: Context<PersonEnv>) => workspaceViews(core, currentPerson(c));

  route.get("/porticos", (c) => c.json({ workspaces: views(c).list() }));

  route.post("/porticos", async (c) => {
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

  route.get("/porticos/:id", (c) => c.json(workspacePageData(core, currentPerson(c), c.req.param("id"))));

  route.patch("/porticos/:id", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    workspaces.requireFor(me.id, c.req.param("id"));
    return c.json({ workspace: workspaceViews(core, me).workspace(workspaces.rename(me.id, c.req.param("id"), body.name)) });
  });

  route.delete("/porticos/:id", (c) => {
    const me = currentPerson(c);
    workspaces.requireFor(me.id, c.req.param("id"));
    workspaces.remove(me.id, c.req.param("id"));
    return c.body(null, 204);
  });

  route.put("/porticos/:id/agents/:agentId", (c) => {
    const me = currentPerson(c);
    const workspace = workspaces.requireFor(me.id, c.req.param("id"));
    // The owner chose to be asked for each agent this person adds: the request goes to the owner.
    if (workspaces.asksOwner(workspace.id, me.id)) {
      const agent = core.agents.get(c.req.param("agentId"));
      if (!agent || agent.ownerId !== me.id) throw new PorticoError("not_allowed", "Only the person who manages an agent can add the agent to a Portico.");
      const request = core.consents.askOwner(me.id, workspace.id, agent);
      return c.json({ waiting: true, expiresAt: request.expiresAt }, 202);
    }
    workspaces.addAgent(me.id, workspace.id, c.req.param("agentId"));
    return c.body(null, 204);
  });

  route.put("/porticos/:id/pause", (c) => {
    const me = currentPerson(c);
    return c.json({ workspace: workspaceViews(core, me).workspace(workspaces.pause(me.id, c.req.param("id"))) });
  });

  route.delete("/porticos/:id/pause", (c) => {
    const me = currentPerson(c);
    return c.json({ workspace: workspaceViews(core, me).workspace(workspaces.resume(me.id, c.req.param("id"))) });
  });

  route.patch("/porticos/:id/people/:personId", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    workspaces.setPolicy(me.id, c.req.param("id"), c.req.param("personId"), body.agents);
    return c.body(null, 204);
  });

  // First contact: taking a person off the list means the next message from that person's agents is asked about again.
  route.delete("/contacts/:personId", (c) => {
    core.approvals.removeAllowedPerson(currentPerson(c).id, c.req.param("personId"));
    return c.body(null, 204);
  });

  route.delete("/porticos/:id/agents/:agentId", (c) => {
    const me = currentPerson(c);
    workspaces.removeAgent(me.id, c.req.param("id"), c.req.param("agentId"));
    return c.body(null, 204);
  });

  route.delete("/porticos/:id/people/:personId", (c) => {
    const me = currentPerson(c);
    workspaces.removePerson(me.id, c.req.param("id"), c.req.param("personId"));
    return c.body(null, 204);
  });

  route.post("/porticos/:id/shares", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    const { share, secret } = shares.create(me.id, c.req.param("id"), { email: body.email, agents: body.agents });
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

  return route;
}
