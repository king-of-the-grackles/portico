import { describe, expect, test } from "bun:test";
import { hashSecret } from "../src/core/tokens";
import { addAppAgent, addComputer, addMember, addOwner, addSession, DAY, errorCode, flush, makePortico, T0 } from "./helpers";

const HASH = "argon2id-test-hash";

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const maya = await addMember(p, "Maya Okafor");
  return { p, chris, maya };
}

/** Claims a new invite for Priya and returns the pending person with the invite. */
async function claimed() {
  const s = await setup();
  const { invite, secret } = s.p.people.createInvite(s.chris.id, "Priya");
  const priya = s.p.people.claim({ secret, name: "Priya Shah", passwordHash: HASH });
  return { ...s, invite, secret, priya };
}

describe("invites", () => {
  test("only the owner invites, by name; the secret is stored only as its hash; the link lasts 7 days", async () => {
    const { p, chris, maya } = await setup();
    expect(errorCode(() => p.people.createInvite(maya.id, "Priya"))).toBe("not_allowed");
    expect(errorCode(() => p.people.createInvite(chris.id, "  "))).toBe("bad_request");
    const { invite, secret } = p.people.createInvite(chris.id, "  Priya ");
    expect(invite).toMatchObject({
      name: "Priya",
      createdBy: chris.id,
      createdAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + 7 * DAY).toISOString(),
      claimedAt: null,
      revokedAt: null,
      status: "open",
    });
    expect(secret).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const row = p.db.query("SELECT * FROM invites WHERE id = $id").get({ id: invite.id }) as Record<string, string>;
    expect(row.secret_hash).toBe(hashSecret(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(p.people.openInvites().map((i) => i.id)).toEqual([invite.id]);
  });

  test("a link is looked up by its secret; malformed and unknown secrets are not_found", async () => {
    const { p, chris } = await setup();
    const { invite, secret } = p.people.createInvite(chris.id, "Priya");
    expect(p.people.lookupInvite(secret).id).toBe(invite.id);
    expect(errorCode(() => p.people.lookupInvite("short"))).toBe("not_found");
    expect(errorCode(() => p.people.lookupInvite("A".repeat(22)))).toBe("not_found");
    expect(errorCode(() => p.people.lookupInvite(42))).toBe("not_found");
  });

  test("a link expires after 7 days and then can't be claimed", async () => {
    const { p, chris } = await setup();
    const { secret } = p.people.createInvite(chris.id, "Priya");
    p.clock.advance(7 * DAY);
    expect(p.people.lookupInvite(secret).status).toBe("expired");
    expect(p.people.openInvites()).toEqual([]);
    expect(errorCode(() => p.people.claim({ secret, name: "Priya", passwordHash: HASH }))).toBe("wrong_status");
    expect(p.people.byName("Priya")).toBeNull();
  });

  test("revoking: owner only; a revoked link can't be claimed; a claimed invite can't be revoked", async () => {
    const { p, chris, maya } = await setup();
    const first = p.people.createInvite(chris.id, "Priya");
    expect(errorCode(() => p.people.revokeInvite(maya.id, first.invite.id))).toBe("not_allowed");
    expect(p.people.revokeInvite(chris.id, first.invite.id).status).toBe("revoked");
    expect(p.people.revokeInvite(chris.id, first.invite.id).status).toBe("revoked");
    expect(p.people.openInvites()).toEqual([]);
    expect(errorCode(() => p.people.claim({ secret: first.secret, name: "Priya", passwordHash: HASH }))).toBe("wrong_status");
    expect(errorCode(() => p.people.revokeInvite(chris.id, "nope"))).toBe("not_found");

    const second = p.people.createInvite(chris.id, "Jordan");
    p.people.claim({ secret: second.secret, name: "Jordan Reyes", passwordHash: HASH });
    expect(errorCode(() => p.people.revokeInvite(chris.id, second.invite.id))).toBe("wrong_status");
  });

  test("the daily sweep deletes invites a month past expiry, unless a claim still waits on one", async () => {
    const { p, chris } = await setup();
    const old = p.people.createInvite(chris.id, "Old");
    const waiting = p.people.createInvite(chris.id, "Waiting");
    p.people.claim({ secret: waiting.secret, name: "Waiting Person", passwordHash: HASH });
    p.clock.advance(20 * DAY);
    const recent = p.people.createInvite(chris.id, "Recent");
    expect(p.people.sweep()).toBe(0);
    p.clock.advance(20 * DAY);
    expect(p.people.sweep()).toBe(1);
    expect(p.people.invite(old.invite.id)).toBeNull();
    expect(p.people.invite(waiting.invite.id)).not.toBeNull();
    expect(p.people.invite(recent.invite.id)).not.toBeNull();
  });

  test("invite changes reach people's pages as the people topic", async () => {
    const { p, chris } = await setup();
    const heard: string[][] = [];
    p.changes.on((topics) => heard.push(topics));
    const { invite } = p.people.createInvite(chris.id, "Priya");
    await flush();
    p.people.revokeInvite(chris.id, invite.id);
    await flush();
    expect(heard).toEqual([["people"], ["people"]]);
  });
});

describe("claims", () => {
  test("claiming creates a pending member tied to the invite and uses the link up", async () => {
    const { p, invite, secret, priya } = await claimed();
    expect(priya).toMatchObject({ name: "Priya Shah", role: "member", status: "pending", inviteId: invite.id, approvedAt: null });
    expect(p.people.passwordHash(priya.id)).toBe(HASH);
    expect(p.people.lookupInvite(secret)).toMatchObject({ status: "claimed", claimedAt: T0.toISOString() });
    expect(p.people.openInvites()).toEqual([]);
  });

  test("a second claim of the same link fails", async () => {
    const { p, secret } = await claimed();
    expect(errorCode(() => p.people.claim({ secret, name: "Someone Else", passwordHash: HASH }))).toBe("wrong_status");
    expect(p.people.byName("Someone Else")).toBeNull();
  });

  test("a name in use is a conflict, and the link stays open for another try", async () => {
    const { p, chris } = await setup();
    const { secret } = p.people.createInvite(chris.id, "Maya");
    expect(errorCode(() => p.people.claim({ secret, name: "maya okafor", passwordHash: HASH }))).toBe("conflict");
    expect(p.people.lookupInvite(secret).status).toBe("open");
    expect(p.people.claim({ secret, name: "Maya Lee", passwordHash: HASH }).status).toBe("pending");
  });

  test("the owner sees each claim: the claimed name, who the invite was for, and when", async () => {
    const { p, priya } = await claimed();
    expect(p.people.claims()).toEqual([
      { personId: priya.id, name: "Priya Shah", inviteName: "Priya", claimedAt: T0.toISOString() },
    ]);
  });

  test("approve activates the person; only the owner approves, and only a pending claim", async () => {
    const { p, chris, maya, priya } = await claimed();
    const heard: string[][] = [];
    p.changes.on((topics) => heard.push(topics));
    expect(errorCode(() => p.people.approveClaim(maya.id, priya.id))).toBe("not_allowed");
    p.clock.advance(5 * 60_000);
    const active = p.people.approveClaim(chris.id, priya.id);
    expect(active).toMatchObject({ status: "active", approvedAt: new Date(T0.getTime() + 5 * 60_000).toISOString() });
    await flush();
    expect(heard).toEqual([["people", "me"]]);
    expect(p.people.claims()).toEqual([]);
    expect(errorCode(() => p.people.approveClaim(chris.id, priya.id))).toBe("wrong_status");
    expect(errorCode(() => p.people.approveClaim(chris.id, maya.id))).toBe("wrong_status");
    expect(errorCode(() => p.people.approveClaim(chris.id, "nobody"))).toBe("not_found");
  });

  test("decline deletes the pending person and leaves the invite revoked", async () => {
    const { p, chris, maya, priya, secret } = await claimed();
    expect(errorCode(() => p.people.declineClaim(maya.id, priya.id))).toBe("not_allowed");
    p.people.declineClaim(chris.id, priya.id);
    expect(p.people.get(priya.id)).toBeNull();
    expect(p.people.lookupInvite(secret).status).toBe("revoked");
    expect(p.people.claims()).toEqual([]);
    expect(errorCode(() => p.people.declineClaim(chris.id, maya.id))).toBe("wrong_status");
  });
});

describe("removing a member", () => {
  test("owner only, never the owner; the member's agents, computers and sign-ins go too", async () => {
    const { p, chris, maya } = await setup();
    const { computer } = addComputer(p, maya, "maya-linux");
    const session = addSession(p, computer).agent;
    const dot = addAppAgent(p, maya, "maya-dot", { kind: "dots" }).agent;
    const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" }).agent;
    p.messages.send(grok, { to: "maya-dot", subject: "Churn", text: "Last quarter?" });
    const { token } = p.accounts.startSession(maya.id);

    expect(errorCode(() => p.people.removeMember(maya.id, chris.id))).toBe("not_allowed");
    expect(errorCode(() => p.people.removeMember(chris.id, chris.id))).toBe("not_allowed");
    expect(errorCode(() => p.people.removeMember(chris.id, "nobody"))).toBe("not_found");

    expect(p.people.removeMember(chris.id, maya.id).name).toBe("Maya Okafor");
    expect(p.people.get(maya.id)).toBeNull();
    expect(p.agents.get(session.id)).toBeNull();
    expect(p.agents.get(dot.id)).toBeNull();
    expect(p.computers.get(computer.id)).toBeNull();
    expect(p.accounts.personForSession(token)).toBeNull();
    expect(p.messages.threads({})).toEqual([]);
    expect(p.agents.get(grok.id)).not.toBeNull();
  });
});
