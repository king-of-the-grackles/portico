import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { readJson } from "../agent-api/rest";
import { hashPassword, SESSION_COOKIE } from "../core/accounts";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import { checkNewPassword, cleanPersonName, type Claim, type Invite } from "../core/people";
import { log } from "../log";
import { type PersonEnv, currentOwner, currentPerson, sessionCookieOptions } from "./context";
import { type ClaimView, type InviteView, type PersonView, personViews } from "./views";

/** A row in the People list: the person view plus when the person joined, for "Joined Oct 23. 2 agents." */
export type PeopleEntry = PersonView & { joinedAt: string };

export function inviteView(invite: Invite): InviteView {
  return { id: invite.id, name: invite.name, createdAt: invite.createdAt, expiresAt: invite.expiresAt, status: invite.status };
}

export function claimView(claim: Claim): ClaimView {
  return { personId: claim.personId, name: claim.name, inviteName: claim.inviteName, claimedAt: claim.claimedAt };
}

async function readObject(c: Parameters<typeof readJson>[0]): Promise<Record<string, unknown>> {
  const body = await readJson(c);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PorticoError("bad_request", "The body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/**
 * The People section and invite links:
 * - GET /api/people: everyone on Portico, and, for the owner, open invites and claims waiting for approval.
 * - POST /api/invites and DELETE /api/invites/:id: the owner creates and revokes invites.
 * - POST /api/invites/check and POST /api/invites/claim: public, for the invite page. The secret travels in the body.
 * - POST /api/claims/:personId: the owner approves or declines a claim.
 * - DELETE /api/people/:id: the owner removes a member.
 */
export function peopleRoutes(core: Core): Hono<PersonEnv> {
  const { people, accounts, agents, settings } = core;
  const route = new Hono<PersonEnv>();

  route.get("/people", (c) => {
    const me = currentPerson(c);
    const views = personViews(core, me);
    const isOwner = me.role === "owner";
    const entries: PeopleEntry[] = people
      .list()
      .filter((p) => p.status === "active")
      .map((p) => ({ ...views.person(p), joinedAt: p.approvedAt ?? p.createdAt }));
    return c.json({
      people: entries,
      invites: isOwner ? people.openInvites().map(inviteView) : [],
      claims: isOwner ? people.claims().map(claimView) : [],
    });
  });

  route.post("/invites", async (c) => {
    const me = currentOwner(c);
    const body = await readObject(c);
    const { invite, secret } = people.createInvite(me.id, body.name);
    log("info", "invite_created", { invite_id: invite.id });
    return c.json({ invite: inviteView(invite), link: `${settings.publicUrl()}/invite#${secret}` }, 201);
  });

  // Before /invites/:id, so these paths never read as an invite ID.
  route.post("/invites/check", async (c) => {
    const body = await readObject(c);
    const invite = people.lookupInvite(body.secret);
    return c.json({ status: invite.status, invitedBy: people.get(invite.createdBy)?.name ?? "", expiresAt: invite.expiresAt });
  });

  route.post("/invites/claim", async (c) => {
    if (c.get("person")) {
      throw new PorticoError("not_allowed", "Already signed in to Portico. Sign out first to use this invite link.");
    }
    const body = await readObject(c);
    // Every cheap check first, so a bad link or a name in use never waits on the slow password hash.
    people.openInvite(body.secret);
    const name = cleanPersonName(body.name);
    if (people.byName(name)) throw new PorticoError("conflict", `The name ${name} is already in use.`);
    const password = checkNewPassword(body.password);
    const person = people.claim({ secret: body.secret, name, passwordHash: await hashPassword(password) });
    const session = accounts.startSession(person.id);
    setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(settings.publicUrl(), session.expiresAt));
    log("info", "invite_claimed", { invite_id: person.inviteId, person_id: person.id });
    return c.json({ person: personViews(core, person).person(person), next: "/invite" }, 201);
  });

  route.delete("/invites/:id", (c) => {
    const me = currentOwner(c);
    const invite = people.revokeInvite(me.id, c.req.param("id"));
    log("info", "invite_revoked", { invite_id: invite.id });
    return c.body(null, 204);
  });

  route.post("/claims/:personId", async (c) => {
    const me = currentOwner(c);
    const { decision } = await readObject(c);
    const personId = c.req.param("personId");
    if (decision === "approve") {
      const person = people.approveClaim(me.id, personId);
      log("info", "claim_approved", { person_id: person.id });
      return c.json({ person: personViews(core, me).person(person) });
    }
    if (decision === "decline") {
      const person = people.declineClaim(me.id, personId);
      core.personStreams.closeFor(person.id);
      log("info", "claim_declined", { person_id: person.id });
      return c.body(null, 204);
    }
    throw new PorticoError("bad_request", "decision must be approve or decline.");
  });

  route.delete("/people/:id", (c) => {
    const me = currentOwner(c);
    const target = people.require(c.req.param("id"));
    // Collected first: once the person is gone, their agents are too, and only their IDs can close the streams.
    const agentIds = agents.ownedBy(target.id).map((agent) => agent.id);
    people.removeMember(me.id, target.id);
    agents.forget(agentIds);
    core.personStreams.closeFor(target.id);
    log("info", "person_removed", { person_id: target.id, agents: agentIds.length });
    return c.body(null, 204);
  });

  return route;
}
