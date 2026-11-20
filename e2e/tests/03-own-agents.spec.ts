// Two agents of one person message each other, and the person's pages show the conversation.
import { expect, test, unique } from "../lib/fixtures";

test("two agents of one person exchange messages and the dashboard shows the conversation", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const probe = await world.agent("alice", "probe");
  const helper = await world.agent("alice", "helper");

  // Agents of one person reach each other by plain name, through that person's own Portico.
  const seen = (await probe.agents()).agents.map((a: any) => a.name);
  expect(seen).toContain("helper");

  const subject = unique("Count the rows");
  const sent = await probe.send({ to: "helper", subject, text: "How many rows does the table have?" });
  expect(sent.delivery).not.toBe("held");

  const asked = await helper.receive(subject);
  expect(asked.from).toBe("probe");
  expect(asked.text).toBe("How many rows does the table have?");

  await helper.send({ reply_to: asked.id, subject: `Re: ${subject}`, text: "Forty-two rows." });
  const answer = await probe.receive(`Re: ${subject}`);
  expect(answer.reply_to).toBe(asked.id);
  expect(answer.portico.id).toBe(sent.portico.id);

  // Activity lists the task; opening the row shows what both agents wrote.
  const page = await browserAs(alice);
  await page.goto("/activity");
  const row = page.getByText(subject, { exact: true }).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByText("How many rows does the table have?").first()).toBeVisible();
  await expect(page.getByText("Forty-two rows.").first()).toBeVisible();

  // The same conversation is on the page of the Portico it went through.
  await page.getByRole("link", { name: "Personal Portico" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Personal Portico" })).toBeVisible();
  await expect(page.getByText(subject, { exact: true }).first()).toBeVisible();
});
