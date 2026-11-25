// An agent that joined without its person's "I started this myself": its first message to each of the person's other
// agents waits for the person, once. Revoking an agent stops it in one step. And the person can vouch for it on the
// page the join ends on.
import { allowOnConsentPage, decideHeld, startJoin, submitJoinCode } from "../lib/agent";
import { nonce } from "../lib/env";
import { expect, test, unique } from "../lib/fixtures";

test("a new agent nobody vouched for is held once, and revoking it stops it", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const helper = await world.agent("alice", "helper");
  // Joined with the tick left off.
  const name = `rookie-${nonce(4)}`;
  const rookie = await world.agent("alice", name, { mine: false });
  const page = await browserAs(alice);

  // ---- its first message to helper waits for Alice ----
  const first = unique("Rookie's first words");
  const sent = await rookie.send({ to: "helper", subject: first, text: "Hello, I am new here." });
  expect(sent.delivery).toBe("held");
  expect(sent.note).toContain("this agent is new and");
  expect((await helper.inbox()).messages.map((m) => m.subject)).not.toContain(first);

  // ---- and what it asks to change about Porticos waits for her too ----
  const place = unique("Rookie's place");
  const asked = await rookie.call("create_portico", { name: place });
  expect(asked.status).toBe("waiting_for_person");
  expect((await rookie.call("list_porticos")).porticos.map((p: any) => p.name)).not.toContain(place);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Needs a decision" })).toBeVisible();
  await expect(page.getByText(first).first()).toBeVisible();
  // The card says the agent is new and when it was added, in one small line; the page has the whole sentence.
  await expect(page.getByRole("article").filter({ hasText: first })).toContainText(/New agent, added [A-Z][a-z]{2} \d{1,2} · Expires /);
  await expect(page.getByText(/joined (Portico )?lately/)).toHaveCount(0);
  await page.goto(`/held/${sent.message.id}`);
  await expect(page.getByText(/New agent, added [A-Z][a-z]{2} \d{1,2}\. You haven't confirmed this agent yet\./)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: new RegExp(`^Always allow ${name}`) })).toBeVisible();
  await decideHeld(page, sent.message.id, "Always allow");
  expect((await helper.receive(first)).from).toBe(name);

  // ---- "Always" vouches for the agent: the next message goes straight through ----
  const second = unique("Rookie's second message");
  expect((await rookie.send({ to: "helper", subject: second, text: "And again." })).delivery).not.toBe("held");
  await helper.receive(second);

  // ---- revoke: one step on the agent's page ----
  const waiting = unique("Never picked up");
  const pending = await rookie.send({ to: "helper", subject: waiting, text: "Helper has not read this yet." });
  const rookieId = await world.agentId("alice", name);
  await page.goto(`/a/${rookieId}`);
  const revoke = page.getByRole("button", { name: "Revoke", exact: true });
  if (!(await revoke.isVisible())) await page.locator('[data-action="settings-toggle"]').click();
  await revoke.click();
  // The "Revoke" button is already gone once the confirm step shows, so waiting for it proves nothing. Wait for the
  // browser's own POST to finish, then for the page to show the agent as revoked.
  const revoked = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/agents/${rookieId}/revoke`);
  await page.getByRole("button", { name: /^Confirm: revoke / }).click();
  expect((await revoked).status()).toBe(200);
  await expect(page.getByText(/is signed out\. Removing it deletes its conversations too\./)).toBeVisible();

  // Its token is dead on every route, and what it had on the way never arrives.
  expect((await rookie.raw("GET", "/agents")).status).toBe(401);
  expect((await rookie.raw("POST", "/messages", { to: "helper", subject: "after", text: "after" })).status).toBe(401);
  expect((await helper.inbox()).messages.map((m) => m.subject)).not.toContain(waiting);
  const api = await world.apiFor(alice);
  const task = await (await api.get(`/api/tasks/${pending.message.id}`)).json();
  expect(JSON.stringify(task)).toContain("withdrawn");
  await api.dispose();

  // Helper no longer lists it.
  expect((await helper.agents()).agents.map((a: any) => a.name)).not.toContain(name);
});

test("the Joined page's Always allow vouches for a new agent, and lets through what was waiting", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const helper = await world.agent("alice", "helper");
  const page = await browserAs(alice);

  // A join with the tick left off, by hand, so the page Alice ends on stays open.
  const name = `novice-${nonce(4)}`;
  const join = await startJoin(name);
  const code = await allowOnConsentPage(page, join, { mine: false });
  expect(code, "the code the page shows after Allow").not.toBeNull();
  const handed = await submitJoinCode(join, code!);
  expect(handed.status).toBe(200);
  const novice = world.adopt("alice", name, handed.body.token);

  // ---- nobody vouched yet: its first message waits ----
  const first = unique("Novice's first words");
  const sent = await novice.send({ to: "helper", subject: first, text: "Hello, I am new here." });
  expect(sent.delivery).toBe("held");
  expect((await helper.inbox()).messages.map((m) => m.subject)).not.toContain(first);

  // ---- the page Alice is on turns into Joined, with the question and the one button ----
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Joined" })).toBeVisible();
  await expect(page.getByText(`Did you start ${name}?`)).toBeVisible();
  const vouched = page.waitForResponse((r) => r.request().method() === "POST" && /^\/api\/agents\/[^/]+\/always-allow$/.test(new URL(r.url()).pathname));
  await page.getByRole("button", { name: `Yes, always allow ${name}` }).click();
  expect((await vouched).status()).toBe(200);
  // The page comes back without the question.
  await expect(page.getByText(`${name} is always allowed.`)).toBeVisible();
  await expect(page.getByRole("button", { name: `Yes, always allow ${name}` })).toHaveCount(0);

  // ---- what waited for the agent being new arrives, and the next message is not held ----
  expect((await helper.receive(first)).from).toBe(name);
  const second = unique("Novice's second message");
  expect((await novice.send({ to: "helper", subject: second, text: "And again." })).delivery).not.toBe("held");
  await helper.receive(second);
});
