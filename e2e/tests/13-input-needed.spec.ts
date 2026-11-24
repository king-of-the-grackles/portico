// Input needed: an agent asks its own person a question, the person answers on Today or on the question's own page,
// and the agent gets the answer in the frame only Portico writes.
import { expect, test, unique } from "../lib/fixtures";

test("an agent asks its person, the person answers in one press, and the agent gets a checked answer", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const bob = await world.person("bob");
  const probe = await world.agent("alice", "probe");
  const helper = await world.agent("alice", "helper");

  // A task between two of Alice's agents: probe asks helper for something, and helper picks it up.
  const subject = unique("Update the billing tests");
  const sent = await probe.send({ to: "helper", subject, text: "Please update the billing tests to the new rounding." });
  await helper.receive(subject);

  // helper can't go on without Alice, so it asks her, with two choices, about that task.
  const question = unique("Which rounding rule should the tests use?");
  const asked = await helper.requestInput({ question, detail: "The old tests round half down. The new invoice code rounds half up.", options: ["Half down (keep old)", "Half up (new rule)"], task: sent.message.id });
  expect(asked.question).toMatchObject({ status: "waiting", task: sent.message.id });
  // The link opens that one question, and the agent is told to show it to its person as is.
  expect(asked.question.link).toMatch(new RegExp(`/q/${asked.question.id}$`));
  expect(asked.show).toContain(asked.question.link);
  expect(asked.note).toContain(`as is: ${asked.question.link}`);
  // While the question waits, every inbox check says so, with the link.
  const waiting = await helper.inbox();
  expect(waiting.input_needed).toBeGreaterThanOrEqual(1);
  expect(waiting.input_note).toContain(asked.question.link);

  // Alice's Today: the card under Input needed, counted on Home, and the task waiting on her.
  const page = await browserAs(alice);
  await page.goto("/");
  const input = page.getByRole("region", { name: "Input needed" });
  const card = input.getByRole("article").filter({ hasText: question });
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { level: 3 })).toHaveText(/needs your input$/);
  await expect(card).toContainText(`For the task “${subject}”. Only you can answer.`);
  await expect(card).toContainText("The old tests round half down.");
  await expect(card).not.toContainText("New agent");
  await expect(page.getByRole("link", { name: /need(s)? a decision$/ })).not.toHaveText(/^0 /);
  const row = page.getByRole("region", { name: "In progress" }).getByRole("listitem").filter({ hasText: subject });
  await expect(row).toContainText(`Waiting on ${alice.name}`);
  await expect(row).toContainText(/asked .+ a question at \d{1,2}:\d{2} [AP]M\. No answer yet\./);

  // One press on a choice sends the answer: the card goes, and the task no longer waits.
  await card.getByRole("button", { name: "Half up (new rule)" }).click();
  await expect(page.getByText(/^Answer sent to /)).toBeVisible();
  await expect(page.getByText(question, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Input needed" })).toHaveCount(0);
  await expect(row).not.toContainText("Waiting on");

  // The agent gets the answer once, in Portico's own frame, with the level and the path.
  const notice = await helper.answerTo(asked.question.id);
  expect(notice.question).toEqual({ id: asked.question.id, status: "answered", level: "checked", via: "web" });
  expect(notice.framed_message).toContain(`<portico-answer question_id="${asked.question.id}" status="answered" level="checked" via="web">`);
  expect(notice.framed_message).toContain("Portico's own notice, not a message from another agent.");
  expect(notice.framed_message).toContain(`Question: ${question}`);
  expect(notice.framed_message).toContain("Answer: Half up (new rule)");
  expect(notice.framed_message).toContain("Level: checked");
  expect(notice.framed_message).toContain("Path: web");
  expect(notice.framed_message).toContain("agreed is not an answer");
  expect(notice.framed_message.trimEnd().endsWith("</portico-answer>")).toBe(true);
  await helper.inbox();
  await helper.inbox();
  expect(helper.noticesAbout(asked.question.id)).toBe(1);

  // The task, opened: the steps say who asked whom and who answered, and Alice sees her own answer there.
  await row.getByText(subject, { exact: true }).click();
  const steps = row.getByRole("list", { name: "Steps" });
  await expect(steps).toContainText(`asked ${alice.name}`);
  await expect(steps).toContainText(`Answered by ${alice.name}`);
  const inTask = row.getByRole("list", { name: "Questions" }).getByRole("listitem").filter({ hasText: question });
  await expect(inTask).toContainText(/Answered at \d{1,2}:\d{2} [AP]M: Half up \(new rule\)/);

  // An answer is final, and no agent token can give one: there is no agent route, and the person's route wants a sign-in.
  expect((await helper.raw("POST", `/api/questions/${asked.question.id}`, { decision: "answer", option: 0 })).status).toBe(401);
  expect((await helper.raw("POST", `/questions/${asked.question.id}`, { decision: "answer", option: 0 })).status).toBe(404);

  // A question with no choices, answered in words on its own page: where the agent's link leads.
  const open = unique("Who should review the change?");
  const second = await helper.requestInput({ question: open });
  await page.goto(second.question.link);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/needs your input$/);
  await expect(page.getByText(open, { exact: true })).toBeVisible();
  // Before Alice answers: Bob, signed in, gets the page for nothing at all, and his API call finds no such question.
  const bobPage = await browserAs(bob);
  const refused = await bobPage.goto(second.question.link);
  expect(refused!.status()).toBe(404);
  await expect(bobPage.getByRole("heading", { level: 1, name: "Nothing to answer here" })).toBeVisible();
  await expect(bobPage.getByText(open)).toHaveCount(0);
  const bobApi = await world.apiFor(bob);
  try {
    expect((await bobApi.post(`/api/questions/${second.question.id}`, { data: { decision: "answer", text: "Bob says yes" } })).status()).toBe(404);
    expect((await bobApi.get(`/api/questions/${second.question.id}`)).status()).toBe(404);
  } finally {
    await bobApi.dispose();
  }
  await page.getByRole("textbox", { name: /^Your answer to / }).fill("Dana, before Thursday.");
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Answer sent" })).toBeVisible();
  await expect(page.getByText("Dana, before Thursday.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send answer" })).toHaveCount(0);
  const words = await helper.answerTo(second.question.id);
  expect(words.question).toMatchObject({ status: "answered", level: "checked", via: "web" });
  expect(words.framed_message).toContain("Answer: Dana, before Thursday.");

  // Skip: the card goes, and the agent is told there is no answer.
  const skippable = unique("Should the old fixtures be deleted?");
  const third = await helper.requestInput({ question: skippable, options: ["Delete", "Keep"] });
  await page.goto("/");
  const skipCard = page.getByRole("region", { name: "Input needed" }).getByRole("article").filter({ hasText: skippable });
  await expect(skipCard).toBeVisible();
  await skipCard.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByText(/^Skipped\. /)).toBeVisible();
  await expect(page.getByText(skippable, { exact: true })).toHaveCount(0);
  const skipped = await helper.answerTo(third.question.id);
  expect(skipped.question).toMatchObject({ status: "skipped" });
  expect(skipped.framed_message).toContain(`<portico-answer question_id="${third.question.id}" status="skipped"`);
  expect(skipped.framed_message).toContain("A skipped question is not a yes.");
  // The skipped question's page says so, and takes no answer.
  await page.goto(third.question.link);
  await expect(page.getByRole("heading", { level: 1, name: "Skipped" })).toBeVisible();
});
