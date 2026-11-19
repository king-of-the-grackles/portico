// A message held for a person's decision, decided on its own page.
import { decideHeld } from "../lib/agent";
import { expect, test, unique } from "../lib/fixtures";

test("a held message is allowed on its page and then delivered", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const bob = await world.person("bob");
  const shared = await world.shared();
  const probe = await world.agent("alice", "probe");
  const scout = await world.agent("bob", "scout");

  // Alice asks to approve new conversations with probe. (The switch is on the agent's page; set here by the API.)
  const api = await world.apiFor(alice);
  const probeId = (await (await api.get("/api/agents")).json()).agents.find((a: any) => a.mine && a.name === "probe").id;
  const requireApproval = (on: boolean) => api.patch(`/api/agents/${probeId}`, { data: { approvalRequired: on } });
  expect((await requireApproval(true)).ok()).toBe(true);

  try {
    const subject = unique("Budget question");
    const sent = await scout.send({ to: `${alice.handle}/probe`, subject, text: "May I see the budget?" });
    expect(sent.delivery).toBe("held");
    expect(sent.message.status).toBe("held");

    // Nothing reaches probe, and Alice's Home says a decision waits.
    expect((await probe.inbox()).messages.map((m) => m.subject)).not.toContain(subject);
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

    // Now probe has it, and scout is told.
    expect((await probe.receive(subject)).text).toBe("May I see the budget?");
    expect(await scout.outcome(sent.message.id)).toBe("delivered");

    // Bob can't decide Alice's held messages: to him the page is the same as no page.
    const again = await scout.send({ to: `${alice.handle}/probe`, subject: unique("Second question"), text: "And the timeline?" });
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
