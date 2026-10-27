import { Hono } from "hono";
import type { Core } from "../core/core";
import type { Person } from "../core/types";
import { PorticoError } from "../core/errors";
import { checkNewPassword, hashPassword } from "../core/accounts";
import { cleanPersonName, type Claim, type Invite } from "../core/people";
import { log } from "../log";
import { type PersonEnv, currentOwner, currentPerson } from "./context";
import { jsonObject, startBrowserSession } from "./session";
import { type ClaimView, type InviteView, type PersonView, personViews } from "./views";

/** A row in the People list: the person view plus when the person joined, for "Joined Oct 23. 2 agents." */
export type PeopleEntry = PersonView & { joinedAt: string };

export function inviteView(invite: Invite, link: string | null = null): InviteView {
  return {
    id: invite.id,
    name: invite.name,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    status: invite.status,
    link,
  };
}

/**
 * What GET /api/people answers, and Settings' first data: everyone active, and for the owner, open invites (with their
 * links) and claims waiting for approval.
 */
export function peopleListing(core: Core, me: Person): { people: PeopleEntry[]; invites: InviteView[]; claims: ClaimView[] } {
  const { people, settings } = core;
  const views = personViews(core, me);
  const isOwner = me.role === "owner";
  const link = (secret: string | null) => (secret ? `${settings.publicUrl()}/invite#${secret}` : null);
  return {
    people: people
      .list()
      .filter((p) => p.status === "active")
      .map((p) => ({ ...views.person(p), joinedAt: p.approvedAt ?? p.createdAt })),
    invites: isOwner ? people.openInvites().map((invite) => inviteView(invite, link(people.inviteSecret(invite.id)))) : [],
    claims: isOwner ? people.claims().map(claimView) : [],
  };
}

export function claimView(claim: Claim): ClaimView {
  return { personId: claim.personId, name: claim.name, inviteName: claim.inviteName, claimedAt: claim.claimedAt };
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
  const { people, agents, settings } = core;
  const route = new Hono<PersonEnv>();
  const inviteLink = (secret: string | null) => (secret ? `${settings.publicUrl()}/invite#${secret}` : null);

  route.get("/people", (c) => c.json(peopleListing(core, currentPerson(c))));

  route.post("/invites", async (c) => {
    const me = currentOwner(c);
    const body = await jsonObject(c);
    const { invite, secret } = people.createInvite(me.id, body.name);
    log("info", "invite_created", { invite_id: invite.id });
    const link = inviteLink(secret)!;
    return c.json({ invite: inviteView(invite, link), link }, 201);
  });

  // Before /invites/:id, so these paths never read as an invite ID.
  route.post("/invites/check", async (c) => {
    const body = await jsonObject(c);
    const invite = people.lookupInvite(body.secret);
    return c.json({ status: invite.status, invitedBy: people.get(invite.createdBy)?.name ?? "", expiresAt: invite.expiresAt });
  });

  route.post("/invites/claim", async (c) => {
    if (c.get("person")) {
      throw new PorticoError("not_allowed", "Already signed in to Portico. Sign out first to use this invite link.");
    }
    const body = await jsonObject(c);
    // Every cheap check first, so a bad link or a name in use never waits on the slow password hash.
    people.openInvite(body.secret);
    const name = cleanPersonName(body.name);
    if (people.byName(name)) throw new PorticoError("conflict", `The name ${name} is already in use.`);
    const password = checkNewPassword(body.password);
    const person = people.claim({ secret: body.secret, name, passwordHash: await hashPassword(password) });
    startBrowserSession(c, core, person.id);
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
    const { decision } = await jsonObject(c);
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
