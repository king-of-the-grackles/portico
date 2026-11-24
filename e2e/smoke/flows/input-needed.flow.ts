// Input needed: an agent asks its own person a question. What the person sees on Today, on the question's own page,
// after answering, on the task that waits, and on a card from an agent the person hasn't confirmed yet.
import { expect, test } from "../lib/recorder";

test("An agent asks its person a question, and the person answers", async ({ world, rec }) => {
  const { page } = rec;
  rec.cannotShow("The agents' side. They ask and check for messages over the network, off screen.");
  rec.cannotShow("What the asking agent reads: Portico's own notice with the answer, who gave it, the level (checked) and the path (web). That text is checked by the tests.");
  rec.cannotShow("The email with the question's link: this recording sends none to look at.");

  // A test person of this run with three agents. The third joined without the person's "I started this", so the
  // person hasn't confirmed it. The teardown removes the person's sign-in and the agents.
  const sam = await world.person("sam");
  const planner = await world.agent("sam", "planner");
  const builder = await world.agent("sam", "builder");
  const newcomer = await world.agent("sam", "newcomer", { mine: false });
  await rec.context.addCookies(sam.storage.cookies);

  // A task between two of the person's agents, picked up by builder, who then can't go on without the person.
  const subject = "Update the billing tests";
  const task = await planner.send({ to: "builder", subject, text: "Please update the billing tests to the new rounding." });
  await builder.receive(subject);
  const question = "Which rounding rule should the tests use?";
  const asked = await builder.requestInput({
    question,
    detail: "The old tests round half down. The new invoice code rounds half up.",
    options: ["Half down (keep old)", "Half up (new rule)"],
    task: task.message.id,
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  const card = page.getByRole("region", { name: "Input needed" }).getByRole("article").filter({ hasText: question });
  await expect(card).toContainText("builder needs your input");
  await card.scrollIntoViewIfNeeded();
  await rec.pause(1500);
  await rec.step("today-card", "builder asks its person a question. Today shows it under 'Input needed', with the choices as buttons.", { hold: 6000 });

  // The link the agent shows its person opens this one question.
  await page.goto(asked.question.link);
  await expect(page.getByRole("heading", { level: 1, name: "builder needs your input" })).toBeVisible();
  await rec.step("question-page", "The agent's link opens the question's own page. Only this person, signed in, can answer.", { hold: 6000 });

  await page.getByText("Half up (new rule)", { exact: true }).click();
  await rec.pause(1200);
  await page.getByRole("button", { name: "Send answer" }).scrollIntoViewIfNeeded();
  await rec.pause(800);
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Answer sent" })).toBeVisible();
  await rec.step("answer-sent", "The person picks 'Half up' and sends. The page says the answer went to builder, and is final.", { hold: 5000 });
  // Off screen: the agent got the answer, in Portico's own frame, checked.
  expect((await builder.answerTo(asked.question.id)).question).toEqual({ id: asked.question.id, status: "answered", level: "checked", via: "web" });

  // A second question about the same task: the task shows whom it waits on, and its steps say who asked and answered.
  const second = "Who should review the change?";
  await builder.requestInput({ question: second, task: task.message.id });
  await page.goto("/");
  // The first match is the task's row: once opened, each message inside it is a list item with the subject too.
  const row = page.getByRole("region", { name: "In progress" }).getByRole("listitem").filter({ hasText: subject }).first();
  await expect(row).toContainText(`Waiting on ${sam.name}`);
  await row.getByText(subject, { exact: true }).click();
  const steps = row.getByRole("list", { name: "Steps" });
  await expect(steps).toContainText(`Answered by ${sam.name}`);
  // The top of the row, with its pill, just under the phone's bar: the steps follow below it.
  await row.evaluate((el) => {
    (el as HTMLElement).style.scrollMarginTop = "76px";
    el.scrollIntoView({ block: "start" });
  });
  await rec.pause(1000);
  await rec.step("task-waiting", "builder asks again. The task reads 'Waiting on' the person, and its steps show who asked and who answered.", { hold: 7000 });

  // An agent the person hasn't confirmed may ask too: its card says so.
  const third = "May the test database be reset?";
  await newcomer.requestInput({ question: third, options: ["Reset", "Leave as is"] });
  await page.goto("/");
  const warned = page.getByRole("region", { name: "Input needed" }).getByRole("article").filter({ hasText: third });
  await expect(warned).toContainText("newcomer needs your input");
  await expect(warned).toContainText(/New agent, added [A-Z][a-z]{2} \d{1,2}\. You haven't confirmed this agent yet\./);
  await warned.scrollIntoViewIfNeeded();
  await rec.pause(1000);
  await rec.step("new-agent-card", "An agent not yet confirmed may ask too. Its card says 'New agent', the day it was added, and that it isn't confirmed.", { hold: 6000 });

  await warned.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByText(third, { exact: true })).toHaveCount(0);
  await rec.step("skipped", "Skip takes the card away and tells the agent there is no answer.", { hold: 4000, shot: false });
});
