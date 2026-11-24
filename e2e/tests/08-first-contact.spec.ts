// The first message from another person's agents is held for one decision: this message only, or always for this person.
import { decideHeld } from "../lib/agent";
import { expect, test, unique } from "../lib/fixtures";

test("first contact between two people is held: once per message, or never again for that person", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const bob = await world.person("bob");
  await world.shared();
  await world.introduce();
  const helper = await world.agent("alice", "helper");
  const scout = await world.agent("bob", "scout");
  const to = `${alice.handle}/helper`;

  // Alice takes Bob off her list, so his agents are strangers to hers again.
  const api = await world.apiFor(alice);
  expect((await api.delete(`/api/contacts/${await world.personId("bob")}`)).status()).toBe(204);
  await api.dispose();

  // ---- held, and allowed for this message only ----
  const first = unique("First contact");
  const one = await scout.send({ to, subject: first, text: "May my person's agents write to yours?" });
  expect(one.delivery).toBe("held");
  expect(one.note).toContain("hasn't allowed messages from");
  expect(one.note).toContain(bob.name);

  const page = await browserAs(alice);
  await page.goto(`/held/${one.message.id}`);
  await expect(page.getByText("First message from an agent of")).toBeVisible();
  await expect(page.getByText("May my person's agents write to yours?")).toBeVisible();
  // This message only is Allow; always for this person is the tick, which says whom it covers.
  await expect(page.getByRole("checkbox", { name: `Always allow messages from ${bob.name}'s agents` , exact: false })).not.toBeChecked();
  await decideHeld(page, one.message.id, "Allow");
  await helper.receive(first);

  // ---- so the next one is asked about again; this time, always for this person ----
  const second = unique("Second contact");
  const two = await scout.send({ to, subject: second, text: "Asking once more." });
  expect(two.delivery).toBe("held");
  await decideHeld(page, two.message.id, "Always allow");
  await helper.receive(second);

  // ---- and from then on Bob's agents get through ----
  const third = unique("Third contact");
  expect((await scout.send({ to, subject: third, text: "No more questions." })).delivery).not.toBe("held");
  await helper.receive(third);
});
