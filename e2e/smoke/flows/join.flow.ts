// A new person signs in, an agent asks to join, the person allows it and hands over the code, and the agent shows in
// the app.
import { readJoinCode, startJoin, submitJoinCode } from "../../lib/agent";
import { signIn } from "../../lib/person";
import { expect, test } from "../lib/recorder";

test("A person signs in, an agent joins, and it shows in the app", async ({ world, rec }) => {
  const { page } = rec;
  const agent = "research-helper";
  rec.cannotShow("Typing into the sign-in screen. It belongs to Descope and a script cannot type into it, so the video cuts from the sign-in page to the first-visit page.");
  rec.cannotShow("The agent's side. It asks to join and hands in the code over the network, off screen.");

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Portico" })).toBeVisible();
  await expect(page.locator("descope-wc")).toBeAttached();
  await rec.pause(2500);
  await rec.step("sign-in", "A signed-out visitor sees the sign-in page.");

  // A new test person of this run, signed in the way the browser suite does: the teardown removes them and their agent.
  const person = await world.newcomer("sam");
  await rec.context.addCookies(person.storage.cookies);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome to Portico" })).toBeVisible();
  await rec.pause();
  await rec.type("Your name", "Sam Rivera");
  await rec.type("Handle", `sam-${world.runId}`);
  await rec.step("welcome", "First visit: the new person types a name and picks a handle.", { hold: 3000, shot: false });
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await rec.step("today-empty", "Today opens, with no agents yet.");

  // The agent asks to join, as an app would, and shows its person this link.
  const join = await startJoin(agent);
  await page.goto(join.link);
  await expect(page.getByRole("heading", { level: 1, name: /^Allow .+ to join\?$/ })).toBeVisible();
  await rec.step("allow-agent", `An agent called ${agent} asks to join. The person opens its link and is asked to allow it.`, { hold: 5000 });
  await page.getByRole("button", { name: "Allow", exact: true }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Share this code with your agent" })).toBeVisible();
  const code = await readJoinCode(page);
  await rec.step("code", "After Allow the page shows a 4-digit code for the person to give the agent.", { hold: 5000 });

  expect((await submitJoinCode(join, code)).status).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Joined" })).toBeVisible();
  await rec.step("joined", "The agent hands in the code and the page says it has joined.", { hold: 5000, shot: false });

  await page.getByRole("link", { name: "Go to Portico" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add your first agent" })).toHaveCount(0);
  await rec.step("today-after", "Back on Today, the 'Add your first agent' card is gone.", { hold: 3500, shot: false });

  await page.getByRole("button", { name: "Open navigation" }).click();
  await rec.pause();
  await page.getByRole("button", { name: "Show the agents in Personal Portico" }).click();
  await expect(page.getByText(agent).first()).toBeVisible();
  await rec.step("agent-listed", `The menu lists ${agent} under the person's own Portico.`, { hold: 6000 });
});
