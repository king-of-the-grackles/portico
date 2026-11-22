// Pausing a Portico: sends through it are refused, what was on the way is withdrawn, and resuming brings it back.
import { expect, test, unique } from "../lib/fixtures";

test("a paused Portico moves nothing until its owner resumes it", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const shared = await world.shared();
  const probe = await world.agent("alice", "probe");
  const scout = await world.agent("bob", "scout");
  const to = `${alice.handle}/probe`;
  await probe.inbox();

  // A message is on its way: sent, not picked up yet.
  const early = unique("Sent before the pause");
  const queued = await scout.send({ to, subject: early, text: "On the way." });
  expect(queued.delivery).not.toBe("held");

  const page = await browserAs(alice);
  await page.goto(`/p/${shared.id}`);
  try {
    await page.getByRole("button", { name: "Pause now" }).click();
    // Two things say it: the passing notice and the page's lasting "Paused" line. Either will do.
    await expect(page.getByRole("status").filter({ hasText: "Paused" }).first()).toBeVisible();

    // A send is refused and says why; the one on the way is withdrawn and never arrives.
    const refused = await scout.raw("POST", "/messages", { to, subject: unique("During the pause"), text: "Refused." });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain("is paused");
    expect(await scout.outcome(queued.message.id)).toBe("withdrawn");
    expect((await probe.inbox()).messages.map((m) => m.subject)).not.toContain(early);
    expect((await scout.call("list_porticos")).porticos.find((p: any) => p.id === shared.id).paused).toBe(true);

    await page.getByRole("button", { name: "Resume" }).first().click();
    await expect(page.getByRole("button", { name: "Pause now" })).toBeVisible();
  } finally {
    // Whatever happened above, the cast's Portico is left running.
    const api = await world.apiFor(alice);
    await api.delete(`/api/porticos/${shared.id}/pause`);
    await api.dispose();
  }

  const late = unique("Sent after the resume");
  expect((await scout.send({ to, subject: late, text: "Through again." })).delivery).not.toBe("held");
  await probe.receive(late);
});
