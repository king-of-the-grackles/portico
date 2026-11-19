// A message held for a person's decision, decided on its own page.
import { decideHeld } from "../lib/agent";
import { expect, test, unique } from "../lib/fixtures";

test("a held message is allowed on its page and then delivered", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const bob = await world.person("bob");
  const shared = await world.shared();
  const helper = await world.agent("alice", "helper");
  const scout = await world.agent("bob", "scout");

  // Alice asks to approve new conversations with helper. (The switch is on the agent's page; set here by the API.)
  const api = await world.apiFor(alice);
  const helperId = await world.agentId("alice", "helper");
  const requireApproval = (on: boolean) => api.patch(`/api/agents/${helperId}`, { data: { approvalRequired: on } });
  expect((await requireApproval(true)).ok()).toBe(true);

  try {
    const subject = unique("Budget question");
    const sent = await scout.send({ to: `${alice.handle}/helper`, subject, text: "May I see the budget?" });
    expect(sent.delivery).toBe("held");
    expect(sent.message.status).toBe("held");

    // Nothing reaches helper, and Alice's Home says a decision waits.
    expect((await helper.inbox()).messages.map((m) => m.subject)).not.toContain(subject);
    const page = await browserAs(alice);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Needs a decision" })).toBeVisible();
    await expect(page.getByText(subject).first()).toBeVisible();

    // The message's own page: who sent it, through which Portico, the text as written, and the three answers.
    await page.goto(`/held/${sent.message.id}`);
    await expect(page.getByRole("heading", { level: 1, name: "A message waits for a decision" })).toBeVisible();
    await expect(page.getByText(`“${bob.handle}/scout”`).first()).toBeVisible();
    await expect(page.getByText(`the Portico “${shared.name}”`)).toBeVisible();
    await expect(page.getByText("May I see the budget?")).toBeVisible();
    await decideHeld(page, sent.message.id, "Allow this message only");
    await expect(page.getByText("This message was allowed.")).toBeVisible();

    // Now helper has it, and scout is told.
    expect((await helper.receive(subject)).text).toBe("May I see the budget?");
    expect(await scout.outcome(sent.message.id)).toBe("delivered");

    // Bob can't decide Alice's held messages: to him the page is the same as no page.
    const again = await scout.send({ to: `${alice.handle}/helper`, subject: unique("Second question"), text: "And the timeline?" });
    expect(again.delivery).toBe("held");
    const bobPage = await browserAs(bob);
    const answer = await bobPage.goto(`/held/${again.message.id}`);
    expect(answer!.status()).toBe(404);
    await expect(bobPage.getByRole("heading", { level: 1, name: "Nothing to answer here" })).toBeVisible();

    // Alice turns that one down, and scout is told.
    await decideHeld(page, again.message.id, "Don't allow");
    await expect(page.getByText("This message was turned down.")).toBeVisible();
    expect(await scout.outcome(again.message.id)).toBe("declined");
  } finally {
    await requireApproval(false);
    await api.dispose();
  }
});

test("an agent's outgoing messages to other people wait for its own person when the switch is on", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const bob = await world.person("bob");
  await world.shared();
  const probe = await world.agent("alice", "probe");
  const scout = await world.agent("bob", "scout");
  const probeId = await world.agentId("alice", "probe");

  // Alice switches the hold on, on probe's page.
  const page = await browserAs(alice);
  await page.goto(`/a/${probeId}`);
  const hold = page.getByRole("switch", { name: "Ask before probe sends to other people's agents" });
  if (!(await hold.isVisible())) await page.locator('[data-action="settings-toggle"]').click();
  await expect(hold).toHaveAttribute("aria-checked", "false");
  await hold.click();
  await expect(hold).toHaveAttribute("aria-checked", "true");

  try {
    // What probe writes to Bob's agent now waits for Alice, and probe is told for whom.
    const subject = unique("Offer for Bob");
    const sent = await probe.send({ to: `${bob.handle}/scout`, subject, text: "Here is our offer." });
    expect(sent.delivery).toBe("held");
    expect(sent.note).toContain(`Held for ${alice.name}`);
    expect((await scout.inbox()).messages.map((m) => m.subject)).not.toContain(subject);

    // Messages to her own agents are not held.
    expect((await probe.send({ to: "helper", subject: unique("Own agent"), text: "No hold here." })).delivery).not.toBe("held");

    // Alice reads it on the message's page and lets it go; it reaches scout.
    await decideHeld(page, sent.message.id, "Allow this message only");
    expect((await scout.receive(subject)).text).toBe("Here is our offer.");
    expect(await probe.outcome(sent.message.id)).toBe("delivered");
  } finally {
    const api = await world.apiFor(alice);
    await api.patch(`/api/agents/${probeId}`, { data: { outboundHold: false } });
    await api.dispose();
  }
});
