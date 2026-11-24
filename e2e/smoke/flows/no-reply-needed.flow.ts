// A note marked "no reply needed": what a person sees on Today before and after the other agent picks the note up,
// on the opened task, and on a held note's card and page.
import { expect, test } from "../lib/recorder";

test("A note that needs no reply is done once it is picked up", async ({ world, rec }) => {
  const { page } = rec;
  rec.cannotShow("The agents' side. They send the note and check for messages over the network, off screen.");
  rec.cannotShow("What the receiving agent reads: the message tells it not to reply only to acknowledge. That text is checked by the tests.");

  // A test person of this run with three agents. The third joined without the person's "I started this", so its first
  // message waits for a decision. The teardown removes the person's sign-in and the agents.
  const sam = await world.person("sam");
  const planner = await world.agent("sam", "planner");
  const builder = await world.agent("sam", "builder");
  const newcomer = await world.agent("sam", "newcomer", { mine: false });
  await rec.context.addCookies(sam.storage.cookies);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await rec.pause(2000);
  await rec.step("today", "Today, for a person with the agents planner and builder. Nothing is in progress.", { hold: 3000, shot: false });

  const subject = "Deploy window moved to Thursday";
  await planner.send({ to: "builder", subject, text: "The deploy window moved to Thursday 10:00.", no_reply_needed: true });
  await page.reload();
  const waiting = page.getByRole("region", { name: "In progress" }).getByRole("listitem").filter({ hasText: subject });
  await expect(waiting).toContainText("No reply needed. Queued until");
  await waiting.scrollIntoViewIfNeeded();
  await rec.step("queued", "planner sends builder a note marked 'no reply needed'. It is in progress until builder picks it up.", { hold: 5000 });

  await builder.receive(subject);
  await page.reload();
  const done = page.getByRole("region", { name: "Done today" }).getByRole("listitem").filter({ hasText: subject });
  await expect(done).toContainText(/No reply needed\. Picked up at \d{1,2}:\d{2} [AP]M\./);
  await done.scrollIntoViewIfNeeded();
  await rec.step("done-at-pickup", "builder picks the note up and sends nothing back. The task is under Done today: 'No reply needed. Picked up at…'", { hold: 5000 });

  await done.getByText(subject, { exact: true }).click();
  const message = done.getByRole("list", { name: "Messages" }).getByRole("listitem").first();
  await expect(message.getByText("No reply needed", { exact: true })).toBeVisible();
  await expect(done.getByRole("list", { name: "Steps" })).not.toContainText("Answered");
  await message.scrollIntoViewIfNeeded();
  await rec.step("message-tag", "Opened: the steps are Sent and Picked up, with no Answered step, and the message carries the tag.", { hold: 6000 });

  const heldSubject = "Notes from the first run";
  const held = await newcomer.send({ to: "builder", subject: heldSubject, text: "The first run finished without errors.", no_reply_needed: true });
  expect(held.delivery).toBe("held");
  await page.goto("/");
  const card = page.getByRole("region", { name: "Needs a decision" }).getByRole("article").filter({ hasText: heldSubject });
  await expect(card).toContainText(`newcomer has a note for builder: ${heldSubject}`);
  await expect(card).toContainText("No reply needed.");
  await card.scrollIntoViewIfNeeded();
  await rec.step("held-card", "A note from an agent not yet vouched for waits for a decision. Its card is headed 'has a note for', not 'wants to ask'.", { hold: 5000 });

  await page.goto(`/held/${held.message.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Allow this message?" })).toBeVisible();
  await expect(page.getByText("No reply needed.", { exact: true })).toBeVisible();
  await rec.step("held-page", "The held note's own page says the same, above the subject.", { hold: 5000 });
});
