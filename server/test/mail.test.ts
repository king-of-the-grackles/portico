import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { parseEnv, ConfigError } from "../src/config";
import { MAIL_LIMITS, mailName, shareEmail } from "../src/core/mail";
import { addAppAgent, addMember, addOwner, callPerson, copyProblems, fakeWebhooks, HOUR, makePortico, MINUTE, signIn, visibleCopy, fakeAccounts } from "./helpers";

const MAIL = { apiKey: "re_test_key", from: "Portico <invites@mail.portico.example>", webhookSecret: `whsec_${Buffer.from("resend-webhook-secret").toString("base64")}` };

async function world(mail: typeof MAIL | null = MAIL) {
  const hooks = fakeWebhooks();
  const p = makePortico({ config: { mail }, mailPost: hooks.post, accountCheck: fakeAccounts });
  const chris = p.people.setEmail(p.people.setHandle((await addOwner(p, "Chris")).id, "chris").id, "chris@example.com");
  const robert = p.people.setHandle((await addMember(p, "Robert")).id, "robert");
  const muse = addAppAgent(p, chris, "muse");
  const launch = p.workspaces.create(chris.id, "Launch <b>bold</b>");
  p.workspaces.addAgent(chris.id, launch.id, muse.agent.id);
  const share = (email: string) => callPerson(p, signIn(p, chris), "POST", `/api/porticos/${launch.id}/shares`, { email });
  return { p, hooks, chris, robert, muse, launch, cookie: signIn(p, chris), share };
}

describe("emailing a share link", () => {
  test("the email goes to Resend once, from the fixed template, with a key that makes a retry safe", async () => {
    const { p, hooks, share } = await world();
    const res = await share("Robert@Example.com");
    const made = ((await res.json()) as { share: { id: string; mail: string; link: string; mails: number } }).share;
    expect(made).toMatchObject({ mail: "sent", mails: 1 });
    expect(hooks.sent).toHaveLength(1);
    const sent = hooks.sent[0]!;
    expect(sent.url).toBe("https://api.resend.com/emails");
    expect(sent.headers.authorization).toBe("Bearer re_test_key");
    expect(sent.headers["idempotency-key"]).toBe(`share-${made.id}-1`);
    const body = JSON.parse(sent.body) as { from: string; to: string[]; subject: string; text: string; html: string; headers: Record<string, string> };
    expect(body).toMatchObject({ from: MAIL.from, to: ["robert@example.com"], subject: "Chris invited you to join a Portico" });
    expect(body.text).toContain(made.link);
    expect(body.text).toContain("Chris (chris@example.com) invited you to join a Portico.");
    // The inviter's name and the Portico's name ride along, as plain text: what a person typed is never markup in the page.
    // The Portico here is named with markup, so its name stays out of the email altogether.
    expect(body.html).not.toContain("bold");
    expect(body.html).toContain('<a href="https://portico.example.com/share#');
    expect(body.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/portico\.example\.com\/mail\/stop\?t=/);
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // The key never reaches the database or the page.
    expect(JSON.stringify(p.db.query("SELECT * FROM mails").all())).not.toContain("re_test_key");
  });

  test("without a key nothing is sent and Share gives the link only", async () => {
    const { hooks, share } = await world(null);
    const made = ((await (await share("robert@example.com")).json()) as { share: { mail: string; link: string } }).share;
    expect(made.mail).toBe("off");
    expect(made.link).toContain("/share#");
    expect(hooks.sent).toHaveLength(0);
  });

  test("a failed send says so, and the link still works", async () => {
    const { p, hooks, share, robert } = await world();
    hooks.answer = () => ({ status: 500, body: "" });
    const made = ((await (await share("robert@example.com")).json()) as { share: { mail: string; link: string } }).share;
    expect(made.mail).toBe("failed");
    p.people.setEmail(robert.id, "robert@example.com");
    const rmuse = addAppAgent(p, robert, "muse");
    expect(p.consents.enter(rmuse.agent, made.link).status).toBe("pending");
  });

  test("one share's email goes out again at most twice, an hour apart", async () => {
    const { p, hooks, share, cookie } = await world();
    const { id } = ((await (await share("robert@example.com")).json()) as { share: { id: string } }).share;
    const again = async () => ((await (await callPerson(p, cookie, "POST", `/api/shares/${id}/mail`)).json()) as { share: { mail: string } }).share.mail;
    expect(await again()).toBe("too_soon");
    p.clock.advance(HOUR);
    expect(await again()).toBe("sent");
    p.clock.advance(59 * MINUTE);
    expect(await again()).toBe("too_soon");
    p.clock.advance(MINUTE);
    expect(await again()).toBe("sent");
    p.clock.advance(HOUR);
    expect(await again()).toBe("resend_limit");
    expect(hooks.sent.map((s) => s.headers["idempotency-key"])).toEqual([`share-${id}-1`, `share-${id}-2`, `share-${id}-3`]);
  });

  test("only the person who made an emailed link sends the email again", async () => {
    const { p, share, robert, launch } = await world();
    const { id } = ((await (await share("maya@example.com")).json()) as { share: { id: string } }).share;
    p.workspaces.admit(launch.id, robert.id);
    expect((await callPerson(p, signIn(p, robert), "POST", `/api/shares/${id}/mail`)).status).toBe(404);
    expect((await callPerson(p, null, "POST", `/api/shares/${id}/mail`)).status).toBe(401);
  });

  test("a person sends at most 20 a day, and a workspace's shares at most 50", async () => {
    const { p, hooks, chris, launch } = await world();
    const outcomes: string[] = [];
    for (let i = 0; i < MAIL_LIMITS.perPersonDaily + 1; i++) {
      const { share, secret } = p.shares.create(chris.id, launch.id, { email: `person${i}@example.com` });
      outcomes.push(await p.mail.send(share, `https://portico.example.com/share#${secret}`, p.people.get(chris.id)!, "Launch"));
    }
    expect(outcomes.filter((o) => o === "sent")).toHaveLength(MAIL_LIMITS.perPersonDaily);
    expect(outcomes.at(-1)).toBe("person_limit");
    expect(hooks.sent).toHaveLength(MAIL_LIMITS.perPersonDaily);
    // Other members of the same workspace add up to the workspace's own limit.
    let sent: number = MAIL_LIMITS.perPersonDaily;
    let last = "";
    for (let m = 0; m < 3 && last !== "workspace_limit"; m++) {
      const member = p.people.setHandle((await addMember(p, `Member ${m}`)).id, `member-${m}`);
      p.workspaces.admit(launch.id, member.id);
      for (let i = 0; i < MAIL_LIMITS.perPersonDaily && last !== "workspace_limit"; i++) {
        // Only the owner makes a link. The limit per Portico counts whoever each email is sent for.
        const { share, secret } = p.shares.create(p.workspaces.get(launch.id)!.ownerId, launch.id, { email: `m${m}-${i}@example.com` });
        last = await p.mail.send(share, `https://portico.example.com/share#${secret}`, member, "Launch");
        if (last === "sent") sent++;
      }
    }
    expect(last).toBe("workspace_limit");
    expect(sent).toBe(MAIL_LIMITS.perWorkspaceDaily as number);
    // A day later the count starts again.
    p.clock.advance(24 * HOUR + MINUTE);
    const { share, secret } = p.shares.create(chris.id, launch.id, { email: "later@example.com" });
    expect(await p.mail.send(share, `https://portico.example.com/share#${secret}`, p.people.get(chris.id)!, "Launch")).toBe("sent");
  });
});

describe("limits that hold across accounts", () => {
  test("one address gets at most three emails a day, whoever sends them", async () => {
    const { p, hooks, chris, launch } = await world();
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const sender = i === 0 ? p.people.get(chris.id)! : p.people.setHandle((await addMember(p, `Sender ${i}`)).id, `sender-${i}`);
      const workspace = i === 0 ? launch : p.workspaces.create(sender.id, `Space ${i}`);
      const { share, secret } = p.shares.create(sender.id, workspace.id, { email: "target@example.com" });
      outcomes.push(await p.mail.send(share, `https://portico.example.com/share#${secret}`, sender, "Launch"));
    }
    expect(outcomes).toEqual(["sent", "sent", "sent", "recipient_limit"]);
    expect(hooks.sent).toHaveLength(MAIL_LIMITS.perRecipientDaily);
  });
});

describe("stopping email", () => {
  test("the link in the email asks first, then stops every later email to the address", async () => {
    const { p, hooks, share } = await world();
    await share("robert@example.com");
    const stop = /<(https:\/\/portico\.example\.com(\/mail\/stop\?t=[^>]+))>/.exec((JSON.parse(hooks.sent[0]!.body) as { headers: Record<string, string> }).headers["List-Unsubscribe"]!)![2]!;
    // Opening the link changes nothing: mail scanners open links.
    const page = await p.app.request(stop);
    expect(page.status).toBe(200);
    expect(copyProblems(visibleCopy(await page.text()))).toEqual([]);
    expect(p.mail.isBlocked("robert@example.com")).toBe(false);
    const done = await p.app.request(stop, { method: "POST" });
    expect(done.status).toBe(200);
    expect(p.mail.isBlocked("robert@example.com")).toBe(true);
    const next = ((await (await share("ROBERT@example.com")).json()) as { share: { mail: string } }).share;
    expect(next.mail).toBe("blocked");
    expect(hooks.sent).toHaveLength(1);
    // A link Portico didn't sign stops nothing.
    expect((await p.app.request("/mail/stop?t=made-up", { method: "POST" })).status).toBe(404);
    expect((await p.app.request(`${stop.slice(0, -4)}AAAA`, { method: "POST" })).status).toBe(404);
  });

  test("a bounce or a complaint from Resend blocks the address, only with a good signature", async () => {
    const { p } = await world();
    const send = (event: unknown, opts: { secret?: string; at?: number } = {}) => {
      const body = JSON.stringify(event);
      const id = "msg_1";
      const timestamp = String(Math.floor((opts.at ?? p.clock.now().getTime()) / 1000));
      const key = Buffer.from((opts.secret ?? MAIL.webhookSecret).replace(/^whsec_/, ""), "base64");
      const signature = `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
      return p.app.request("/api/mail/resend", { method: "POST", headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature, "content-type": "application/json" }, body });
    };
    const bounced = { type: "email.bounced", data: { to: ["Gone@Example.com"], bounce: { type: "Permanent" } } };
    expect((await send(bounced, { secret: `whsec_${Buffer.from("wrong").toString("base64")}` })).status).toBe(401);
    expect((await send(bounced, { at: p.clock.now().getTime() - 10 * MINUTE })).status).toBe(401);
    expect((await p.app.request("/api/mail/resend", { method: "POST", body: JSON.stringify(bounced) })).status).toBe(401);
    expect(p.mail.isBlocked("gone@example.com")).toBe(false);
    expect((await send(bounced)).status).toBe(200);
    expect(p.mail.isBlocked("gone@example.com")).toBe(true);
    expect((await send({ type: "email.bounced", data: { to: ["slow@example.com"], bounce: { type: "Transient" } } })).status).toBe(200);
    expect(p.mail.isBlocked("slow@example.com")).toBe(false);
    expect((await send({ type: "email.complained", data: { to: ["angry@example.com"] } })).status).toBe(200);
    expect(p.mail.isBlocked("angry@example.com")).toBe(true);
    expect((await send({ type: "email.delivered", data: { to: ["fine@example.com"] } })).status).toBe(200);
    expect(p.mail.isBlocked("fine@example.com")).toBe(false);
  });
});

describe("the email and its settings", () => {
  test("the template follows the copy rules and escapes what goes into the page", () => {
    const plain = shareEmail({ inviter: "Chris Ivester", senderEmail: "chris@example.com", portico: "Launch plan", to: "robert@example.com", link: "https://portico.example.com/share#abc", stopUrl: "https://portico.example.com/mail/stop?t=x" });
    expect(copyProblems(visibleCopy(plain.html))).toEqual([]);
    // A name that reads as a link, a domain, an address, markup or a number to call never rides in the email.
    for (const bad of ["Visit evil.example now", "https://evil.test", "Call 5551234567", "pay@evil.test", "Chris <b>Ivester</b>", "x".repeat(41), "bank.com/login", "evil\uFF0Etest", "Call 555 123 4567", "ring +1 (555) 123-4567", "a\u3002b", "evil\ua4f8test", "go\u02d0there", "a\u0338b"]) expect(mailName(bad)).toBeNull();
    // The handle that stands in for a refused name passes the same check.
    expect(shareEmail({ inviter: "see evil.test", handle: "call-5551234567", senderEmail: null, portico: "Launch", to: "r@example.com", link: "https://portico.example.com/share#abc", stopUrl: "https://portico.example.com/mail/stop?t=x" }).subject).toBe("Someone invited you to join Launch");
    for (const fine of ["Chris Ivester", "Launch plan", "Zoë & Co", "Q3 2026 plan"]) expect(mailName(fine)).toBe(fine);
    const mail = shareEmail({ inviter: "Click evil.example", handle: "chris", senderEmail: "chris@example.com", portico: "Launch <i>plan</i>", to: "robert@example.com", link: "https://portico.example.com/share#abc", stopUrl: "https://portico.example.com/mail/stop?t=x&y=1" });
    expect(mail.subject).toBe("chris invited you to join a Portico");
    expect(mail.html).not.toContain("evil");
    expect(mail.html).not.toContain("<i>");
    expect(mail.html).toContain("t=x&#38;y=1");
    expect(mail.html).toContain('<a href="https://portico.example.com/share#abc"');
    expect(mail.text.split("\n\n")).toHaveLength(6);
  });

  test("mail is on only with a key, and the sender defaults to the public address", () => {
    expect(parseEnv({}, "k").mail).toBeNull();
    expect(() => parseEnv({ PORTICO_RESEND_API_KEY: "re_x" }, "k")).toThrow(ConfigError);
    expect(parseEnv({ PORTICO_RESEND_API_KEY: "re_x", PORTICO_MAIL_FROM: "Team <hello@mail.example.com>" }, "k").mail).toEqual({ apiKey: "re_x", from: "Team <hello@mail.example.com>", webhookSecret: null });
    expect(parseEnv({ PORTICO_PUBLIC_URL: "https://portico.example", PORTICO_RESEND_API_KEY: "re_x", PORTICO_RESEND_WEBHOOK_SECRET: "whsec_abc" }, "k").mail).toEqual({
      apiKey: "re_x",
      from: "Portico <invites@mail.portico.example>",
      webhookSecret: "whsec_abc",
    });
    expect(() => parseEnv({ PORTICO_PUBLIC_URL: "https://portico.example", PORTICO_RESEND_API_KEY: "re_x", PORTICO_MAIL_FROM: "not an address" }, "k")).toThrow(ConfigError);
  });
});
