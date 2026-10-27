import { describe, expect, test } from "bun:test";
import {
  addAppAgent,
  addComputer,
  addMember,
  addOwner,
  callPerson,
  copyProblems,
  DAY,
  flush,
  makePortico,
  openSessionStream,
  PASSWORD,
  PUBLIC_URL,
  signIn,
  sseReader,
  T0,
  visibleCopy,
} from "./helpers";

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const maya = await addMember(p, "Maya Okafor");
  return { p, chris, maya, owner: signIn(p, chris), member: signIn(p, maya) };
}

/** Creates an invite through the API as the owner; returns it with the secret from its link. */
async function invite(p: ReturnType<typeof makePortico>, owner: string, name = "Priya") {
  const res = await callPerson(p, owner, "POST", "/api/invites", { name });
  expect(res.status).toBe(201);
  const body = await json<{ invite: { id: string; name: string; status: string; createdAt: string; expiresAt: string; link: string | null }; link: string }>(
    res,
  );
  return { ...body, secret: body.link.split("#")[1]! };
}

/** Claims the link as a signed-out browser; returns the answer and the cookie it set. */
async function claim(p: ReturnType<typeof makePortico>, body: Record<string, unknown>) {
  const res = await callPerson(p, null, "POST", "/api/invites/claim", body);
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? null;
  return { res, cookie };
}

describe("creating and listing invites", () => {
  test("the owner creates an invite by name, and can copy an open invite's link again", async () => {
    const { p, owner, member } = await setup();
    const { invite: created, link, secret } = await invite(p, owner);
    expect(created).toEqual({
      id: created.id,
      name: "Priya",
      createdAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + 7 * DAY).toISOString(),
      status: "open",
      link,
    });
    expect(link).toBe(`${PUBLIC_URL}/invite#${secret}`);
    const listed = await json<{ invites: Record<string, unknown>[] }>(callPerson(p, owner, "GET", "/api/people"));
    expect(listed.invites).toEqual([created]);
    expect(JSON.stringify(await json(callPerson(p, member, "GET", "/api/people")))).not.toContain(secret);
    const stored = p.db.query("SELECT * FROM invites").get() as Record<string, string>;
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  test("members can't invite and see no invites or claims; signed out is 401", async () => {
    const { p, owner, member } = await setup();
    await invite(p, owner);
    const res = await callPerson(p, member, "POST", "/api/invites", { name: "Sam" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_allowed", message: "Only the owner can do this." });
    expect(await json(callPerson(p, member, "GET", "/api/people"))).toMatchObject({ invites: [], claims: [] });
    expect((await callPerson(p, null, "POST", "/api/invites", { name: "Sam" })).status).toBe(401);
    expect((await callPerson(p, null, "GET", "/api/people")).status).toBe(401);
  });

  test("an invite needs a name", async () => {
    const { p, owner } = await setup();
    expect((await callPerson(p, owner, "POST", "/api/invites", { name: " " })).status).toBe(400);
    expect((await callPerson(p, owner, "POST", "/api/invites", {})).status).toBe(400);
  });

  test("people: everyone active, the owner first, with agent counts and the join date", async () => {
    const { p, chris, maya, member } = await setup();
    addAppAgent(p, maya, "maya-dot", { kind: "dots" });
    await addMember(p, "Waiting Person", "pending");
    const { people } = await json<{ people: Record<string, unknown>[] }>(callPerson(p, member, "GET", "/api/people"));
    expect(people).toEqual([
      { id: chris.id, name: "Chris", role: "owner", status: "active", isMe: false, agentCount: 0, joinedAt: T0.toISOString() },
      { id: maya.id, name: "Maya Okafor", role: "member", status: "active", isMe: true, agentCount: 1, joinedAt: T0.toISOString() },
    ]);
  });
});

describe("revoking", () => {
  test("the owner revokes; the link then fails; members can't revoke", async () => {
    const { p, owner, member } = await setup();
    const { invite: created, secret } = await invite(p, owner);
    expect((await callPerson(p, member, "DELETE", `/api/invites/${created.id}`)).status).toBe(403);
    expect((await callPerson(p, owner, "DELETE", `/api/invites/${created.id}`)).status).toBe(204);
    expect(await json(callPerson(p, owner, "GET", "/api/people"))).toMatchObject({ invites: [] });
    const { res } = await claim(p, { secret, name: "Priya Shah", password: PASSWORD });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wrong_status", message: "This invite link was revoked." });
    expect((await callPerson(p, owner, "DELETE", "/api/invites/nope")).status).toBe(404);
  });
});

describe("checking a link", () => {
  test("says the link's state and who invited, without using it up", async () => {
    const { p, owner } = await setup();
    const { secret } = await invite(p, owner);
    const check = () => callPerson(p, null, "POST", "/api/invites/check", { secret });
    expect(await json(check())).toEqual({ status: "open", invitedBy: "Chris", expiresAt: new Date(T0.getTime() + 7 * DAY).toISOString() });
    expect(await json(check())).toMatchObject({ status: "open" });
    p.clock.advance(7 * DAY);
    expect(await json(check())).toMatchObject({ status: "expired", invitedBy: "Chris" });
  });

  test("an unknown or malformed link is 404", async () => {
    const { p } = await setup();
    expect((await callPerson(p, null, "POST", "/api/invites/check", { secret: "A".repeat(22) })).status).toBe(404);
    expect((await callPerson(p, null, "POST", "/api/invites/check", { secret: "../x" })).status).toBe(404);
    expect((await callPerson(p, null, "POST", "/api/invites/check", {})).status).toBe(404);
  });
});

describe("claiming", () => {
  test("creates a pending person, signs the person in, and points to the waiting page", async () => {
    const { p, owner } = await setup();
    const { secret } = await invite(p, owner);
    const { res, cookie } = await claim(p, { secret, name: "Priya Shah", password: "lantern-orchard-91" });
    expect(res.status).toBe(201);
    const body = await json<{ person: { id: string }; next: string }>(res);
    expect(body).toMatchObject({ person: { name: "Priya Shah", role: "member", status: "pending", isMe: true }, next: "/invite" });
    expect(res.headers.get("set-cookie")).toMatch(/^portico_session=pw_[^;]+;.*HttpOnly/i);
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
    expect(res.headers.get("set-cookie")).toMatch(/Secure/i);
    expect(await json(callPerson(p, cookie, "GET", "/api/me"))).toMatchObject({ person: { name: "Priya Shah", status: "pending" } });
    expect((await callPerson(p, cookie, "GET", "/api/people")).status).toBe(403);
    expect((await callPerson(p, cookie, "POST", "/api/invites", { name: "Sam" })).status).toBe(403);
  });

  test("the owner sees the claim: the claimed name, who the invite was for, and when", async () => {
    const { p, owner } = await setup();
    const { secret } = await invite(p, owner);
    p.clock.advance(60_000);
    const { res } = await claim(p, { secret, name: "Priya Shah", password: PASSWORD });
    const { person } = await json<{ person: { id: string } }>(res);
    const listed = await json<{ claims: unknown[]; invites: unknown[]; people: { name: string }[] }>(
      callPerson(p, owner, "GET", "/api/people"),
    );
    expect(listed.claims).toEqual([
      { personId: person.id, name: "Priya Shah", inviteName: "Priya", claimedAt: new Date(T0.getTime() + 60_000).toISOString() },
    ]);
    expect(listed.invites).toEqual([]);
    expect(listed.people.map((x) => x.name)).toEqual(["Chris", "Maya Okafor"]);
  });

  test("a second claim of the same link fails clearly", async () => {
    const { p, owner } = await setup();
    const { secret } = await invite(p, owner);
    expect((await claim(p, { secret, name: "Priya Shah", password: PASSWORD })).res.status).toBe(201);
    const again = await claim(p, { secret, name: "Someone Else", password: PASSWORD });
    expect(again.res.status).toBe(409);
    expect(again.cookie).toBeNull();
    expect(await again.res.json()).toEqual({
      error: "wrong_status",
      message: "This invite link was already used. Each invite link works once.",
    });
  });

  test("an expired link fails clearly", async () => {
    const { p, owner } = await setup();
    const { secret } = await invite(p, owner);
    p.clock.advance(7 * DAY);
    const { res } = await claim(p, { secret, name: "Priya Shah", password: PASSWORD });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "wrong_status", message: "This invite link expired. Invite links last 7 days." });
  });

  test("an unknown link is 404", async () => {
    const { p } = await setup();
    const { res } = await claim(p, { secret: "A".repeat(22), name: "Priya Shah", password: PASSWORD });
    expect(res.status).toBe(404);
  });

  test("a name in use is 409 conflict; a short password is 400; the link stays usable", async () => {
    const { p, owner } = await setup();
    const { secret } = await invite(p, owner);
    const taken = await claim(p, { secret, name: "maya okafor", password: PASSWORD });
    expect(taken.res.status).toBe(409);
    expect(await taken.res.json()).toMatchObject({ error: "conflict" });
    const short = await claim(p, { secret, name: "Priya Shah", password: "short" });
    expect(short.res.status).toBe(400);
    expect(await short.res.json()).toEqual({ error: "bad_request", message: "A password needs 12 characters or more." });
    expect((await claim(p, { secret, name: "Priya Shah", password: PASSWORD })).res.status).toBe(201);
  });

  test("someone already signed in can't claim, so the link isn't used up by mistake", async () => {
    const { p, owner } = await setup();
    const { secret } = await invite(p, owner);
    const res = await callPerson(p, owner, "POST", "/api/invites/claim", { secret, name: "Priya Shah", password: PASSWORD });
    expect(res.status).toBe(403);
    expect(await json(callPerson(p, null, "POST", "/api/invites/check", { secret }))).toMatchObject({ status: "open" });
  });

  test("a claim from another site is refused", async () => {
    const { p, owner } = await setup();
    const { secret } = await invite(p, owner);
    const res = await p.app.request(`${PUBLIC_URL}/api/invites/claim`, {
      method: "POST",
      headers: { host: "portico.example.com", origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ secret, name: "Priya Shah", password: PASSWORD }),
    });
    expect(res.status).toBe(403);
  });
});

describe("approving and declining", () => {
  async function claimed() {
    const s = await setup();
    const { secret } = await invite(s.p, s.owner);
    const { res, cookie } = await claim(s.p, { secret, name: "Priya Shah", password: PASSWORD });
    const { person } = await json<{ person: { id: string } }>(res);
    return { ...s, secret, priya: person, pending: cookie! };
  }

  test("approve: the waiting page hears `me`, and the person is active", async () => {
    const { p, owner, member, priya, pending } = await claimed();
    const stream = await callPerson(p, pending, "GET", "/api/events");
    const events = sseReader(stream);
    expect((await events.next()).event).toBe("hello");
    expect((await callPerson(p, member, "POST", `/api/claims/${priya.id}`, { decision: "approve" })).status).toBe(403);
    const res = await callPerson(p, owner, "POST", `/api/claims/${priya.id}`, { decision: "approve" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ person: { id: priya.id, status: "active", isMe: false } });
    await flush();
    const changed = await events.next();
    expect(changed.event).toBe("changed");
    expect((changed.data as { topics: string[] }).topics).toContain("me");
    expect(await json(callPerson(p, pending, "GET", "/api/me"))).toMatchObject({ person: { status: "active" } });
    expect((await callPerson(p, pending, "GET", "/api/agents")).status).toBe(200);
    expect(await json(callPerson(p, owner, "GET", "/api/people"))).toMatchObject({ claims: [] });
    expect((await callPerson(p, owner, "POST", `/api/claims/${priya.id}`, { decision: "approve" })).status).toBe(409);
    await events.cancel();
  });

  test("decline: the person is gone, the waiting page's stream ends, and the link stays revoked", async () => {
    const { p, owner, priya, pending, secret } = await claimed();
    const events = sseReader(await callPerson(p, pending, "GET", "/api/events"));
    expect((await events.next()).event).toBe("hello");
    expect((await callPerson(p, owner, "POST", `/api/claims/${priya.id}`, { decision: "decline" })).status).toBe(204);
    await expect(events.next(500)).rejects.toThrow("stream ended");
    expect((await callPerson(p, pending, "GET", "/api/me")).status).toBe(401);
    expect(p.people.lookupInvite(secret).status).toBe("revoked");
    expect(await json(callPerson(p, owner, "GET", "/api/people"))).toMatchObject({ claims: [] });
  });

  test("a decision must be approve or decline, for a pending claim that exists", async () => {
    const { p, owner, maya, priya } = await claimed();
    expect((await callPerson(p, owner, "POST", `/api/claims/${priya.id}`, { decision: "maybe" })).status).toBe(400);
    expect((await callPerson(p, owner, "POST", `/api/claims/${maya.id}`, { decision: "approve" })).status).toBe(409);
    expect((await callPerson(p, owner, "POST", "/api/claims/nobody", { decision: "decline" })).status).toBe(404);
  });
});

describe("removing a member", () => {
  test("the owner removes a member: agents, computers and sign-ins go, and open streams close", async () => {
    const { p, chris, maya, owner, member } = await setup();
    const { computer, token } = addComputer(p, maya, "maya-linux");
    const dot = addAppAgent(p, maya, "maya-dot", { kind: "dots" }).agent;
    addAppAgent(p, chris, "grok", { kind: "grok-bot" });
    const session = await openSessionStream(p, token, { key: "key-000001", repo: "portico" });
    const page = sseReader(await callPerson(p, member, "GET", "/api/events"));
    expect((await page.next()).event).toBe("hello");

    expect((await callPerson(p, member, "DELETE", `/api/people/${chris.id}`)).status).toBe(403);
    const self = await callPerson(p, owner, "DELETE", `/api/people/${chris.id}`);
    expect(self.status).toBe(403);
    expect(await self.json()).toEqual({ error: "not_allowed", message: "The owner of Portico can't be removed." });

    expect((await callPerson(p, owner, "DELETE", `/api/people/${maya.id}`)).status).toBe(204);
    await expect(session.events.next(500)).rejects.toThrow("stream ended");
    await expect(page.next(500)).rejects.toThrow("stream ended");
    expect(p.agents.get(dot.id)).toBeNull();
    expect(p.computers.get(computer.id)).toBeNull();
    expect((await callPerson(p, member, "GET", "/api/me")).status).toBe(401);
    const { agents } = await json<{ agents: { name: string }[] }>(callPerson(p, owner, "GET", "/api/agents"));
    expect(agents.map((a) => a.name)).toEqual(["grok"]);
    expect((await callPerson(p, owner, "DELETE", `/api/people/${maya.id}`)).status).toBe(404);
  });
});

describe("the invite page", () => {
  const page = async (p: ReturnType<typeof makePortico>, cookie?: string) =>
    await p.app.request("/invite", { headers: cookie ? { cookie } : {} });

  test("signed out: the claim form, which posts the link's secret from the fragment; nothing is used up", async () => {
    const { p, owner } = await setup();
    const { secret } = await invite(p, owner);
    const res = await page(p);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-api="POST /api/invites/claim"');
    expect(html).toMatch(/<input[^>]*name="secret"[^>]*data-fragment/);
    expect(html).toMatch(/<input[^>]*name="password"[^>]*type="password"[^>]*autocomplete="new-password"[^>]*minlength="12"/);
    expect(html).toContain("Agents added after joining can message every agent on Portico.");
    expect(html).toContain("approves each new person before Portico opens. This link works once.");
    expect(html).toContain("/assets/forms.js");
    expect(html).toContain("/assets/invite.js");
    // The owner's name comes from checking the link, so the page alone reveals nothing.
    expect(html).not.toContain("Chris");
    expect(p.people.lookupInvite(secret).status).toBe("open");
  });

  test("signed out: a clear page for each bad link", async () => {
    const { p } = await setup();
    const html = await (await page(p)).text();
    for (const heading of ["Invite link not valid", "Invite link already used", "Invite link revoked", "Invite link expired"]) {
      expect(html).toContain(heading);
    }
  });

  test("a pending person sees the waiting page, with the time the request was sent", async () => {
    const { p, owner } = await setup();
    const { secret } = await invite(p, owner);
    const { cookie } = await claim(p, { secret, name: "Priya Shah", password: PASSWORD });
    const res = await page(p, cookie!);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Waiting for Chris");
    expect(html).toContain("Portico opens here as soon as Chris approves the request.");
    expect(html).toContain(`<time datetime="${T0.toISOString()}"`);
    expect(html).toContain("This page can be closed. Sign in later with the same name and password.");
    expect(html).toContain('role="status"');
    expect(html).toContain("Request declined");
    expect(html).not.toContain('data-api="POST /api/invites/claim"');
  });

  test("an active person goes Home", async () => {
    const { p, owner } = await setup();
    const res = await page(p, owner);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });

  test("the browser module is served", async () => {
    const { p } = await setup();
    const res = await p.app.request("/assets/invite.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  test("copy sweep: no pronouns and no retired words on either page", async () => {
    const { p, owner } = await setup();
    const signedOut = await (await page(p)).text();
    expect(copyProblems(visibleCopy(signedOut))).toEqual([]);
    const { secret } = await invite(p, owner);
    const { cookie } = await claim(p, { secret, name: "Priya Shah", password: PASSWORD });
    const waiting = await (await page(p, cookie!)).text();
    expect(copyProblems(visibleCopy(waiting))).toEqual([]);
  });

  test("copy sweep: every error message the People API sends", async () => {
    const { p, chris, owner, member } = await setup();
    const { invite: created, secret } = await invite(p, owner);
    const messages: string[] = [];
    const collect = async (res: Response | Promise<Response>) => {
      const body = (await (await res).json().catch(() => ({}))) as { message?: string };
      if (body.message) messages.push(body.message);
    };
    await collect(callPerson(p, member, "POST", "/api/invites", { name: "Sam" }));
    await collect(callPerson(p, owner, "POST", "/api/invites", { name: "" }));
    await collect(callPerson(p, null, "POST", "/api/invites/check", { secret: "nope" }));
    await collect(claim(p, { secret, name: "Priya", password: "short" }).then((x) => x.res));
    await collect(claim(p, { secret, name: "Chris", password: PASSWORD }).then((x) => x.res));
    await collect(callPerson(p, owner, "POST", "/api/invites/claim", { secret, name: "Priya", password: PASSWORD }));
    await collect(callPerson(p, owner, "DELETE", `/api/people/${chris.id}`));
    await collect(callPerson(p, owner, "POST", "/api/claims/nobody", { decision: "x" }));
    const { res } = await claim(p, { secret, name: "Priya Shah", password: PASSWORD });
    const { person } = await json<{ person: { id: string } }>(res);
    await collect(callPerson(p, owner, "DELETE", `/api/invites/${created.id}`));
    await collect(claim(p, { secret, name: "Other", password: PASSWORD }).then((x) => x.res));
    await collect(callPerson(p, owner, "POST", `/api/claims/${person.id}`, { decision: "approve" }));
    await collect(callPerson(p, owner, "POST", `/api/claims/${person.id}`, { decision: "approve" }));
    p.clock.advance(8 * DAY);
    const expired = await invite(p, owner, "Late");
    p.clock.advance(8 * DAY);
    await collect(claim(p, { secret: expired.secret, name: "Late", password: PASSWORD }).then((x) => x.res));
    expect(messages.length).toBeGreaterThanOrEqual(12);
    expect(copyProblems(messages.join(" | "))).toEqual([]);
  });
});
