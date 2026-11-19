// An agent that joined without its person's "I started this myself": its first message to each of the person's other
// agents waits for the person, once. And revoking an agent stops it in one step.
import { decideHeld } from "../lib/agent";
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
  expect(sent.note).toContain("joined Portico lately");
  expect((await helper.inbox()).messages.map((m) => m.subject)).not.toContain(first);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Needs a decision" })).toBeVisible();
  await expect(page.getByText(first).first()).toBeVisible();
  await decideHeld(page, sent.message.id, "Always allow this sender");
  expect((await helper.receive(first)).from).toBe(name);

  // ---- asked once: the next message to the same agent goes straight through ----
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
  await page.getByRole("button", { name: `Confirm: revoke ${name}` }).click();
  await expect(page.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);

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
