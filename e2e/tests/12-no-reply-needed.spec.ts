// A note that needs no reply: the receiver is told not to answer, and the task is done once the note is picked up.
import { expect, test, unique } from "../lib/fixtures";

test("a note that needs no reply is done once the other agent picks the note up, and Today says so", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const probe = await world.agent("alice", "probe");
  const helper = await world.agent("alice", "helper");

  const subject = unique("FYI: deploy window moved");
  const sent = await probe.send({ to: "helper", subject, text: "The deploy window moved to Thursday 10:00.", no_reply_needed: true });
  expect(sent.delivery).not.toBe("held");
  expect(sent.message.no_reply_needed).toBe(true);
  // The sender hears that no reply is expected, and when the task closes.
  expect(sent.note).toBe("No reply is expected. The task shows as done once `helper` picks the message up.");

  // Before pickup the task is in progress, and the page says what the task waits for.
  const page = await browserAs(alice);
  await page.goto("/");
  const waiting = page.getByRole("region", { name: "In progress" }).getByRole("listitem").filter({ hasText: subject });
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText(/No reply needed\. Queued until .+ checks for messages\./);
  expect((await probe.task(sent.message.id)).task).toMatchObject({ outcome: "in_progress", no_reply_needed: true, answer: null });

  // The other agent checks its inbox: the frame says no reply is needed, in place of how to reply.
  const note = await helper.receive(subject);
  expect(note.from).toBe("probe");
  expect(note.no_reply_needed).toBe(true);
  expect(note.framed_message).toContain(`<portico-message id="${note.id}" from="probe" no_reply_needed="true">`);
  expect(note.framed_message).toContain("`probe` needs no reply to this message: don't reply to acknowledge, confirm or thank.");
  expect(note.framed_message).not.toContain("To reply, call");

  // Both agents see the task done, with no answer, ended when the note was picked up.
  for (const agent of [probe, helper]) {
    const { task, messages } = await agent.task(sent.message.id);
    expect(task).toMatchObject({ outcome: "done", reason: null, no_reply_needed: true, answer: null });
    expect(task.ended_at).toBe(task.picked_up_at);
    expect(messages.map((m: any) => m.no_reply_needed)).toEqual([true]);
  }

  // Today lists the task under Done today, with the line that says why a task with no answer is done.
  await page.goto("/");
  const done = page.getByRole("region", { name: "Done today" }).getByRole("listitem").filter({ hasText: subject });
  await expect(done).toBeVisible();
  await expect(done).toContainText(/No reply needed\. Picked up at \d{1,2}:\d{2} [AP]M\./);
  await expect(page.getByRole("region", { name: "In progress" }).getByText(subject, { exact: true })).toHaveCount(0);

  // Opened, the task shows Sent and the pickup, no Answered step, and the tag on the message.
  await done.getByText(subject, { exact: true }).click();
  const steps = done.getByRole("list", { name: "Steps" });
  await expect(steps).toContainText("Sent");
  await expect(steps).toContainText(/Picked up by/);
  await expect(steps).not.toContainText("Asked");
  await expect(steps).not.toContainText("Answered");
  const message = done.getByRole("list", { name: "Messages" }).getByRole("listitem").first();
  await expect(message).toContainText("The deploy window moved to Thursday 10:00.");
  await expect(message.getByText("No reply needed", { exact: true })).toBeVisible();
});
