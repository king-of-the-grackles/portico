// An agent asks to join; its person opens the link, signs in on that page, types the code and presses Allow.
import { pollJoin, startJoin, AgentClient } from "../lib/agent";
import { nonce } from "../lib/env";
import { expect, test } from "../lib/fixtures";
import { signIn } from "../lib/person";

test("an agent joins through the consent page and lists its Portico", async ({ world, browser }) => {
  const alice = await world.person("alice");
  // The first run's agent becomes the cast's `probe`. With kept people (E2E_KEEP=1), a throwaway agent joins instead.
  const reuse = !world.hasAgent("alice", "probe");
  const name = reuse ? "probe" : `joiner-${nonce(4)}`;

  const join = await startJoin(name);
  expect(join.code).toMatch(/^\d{4}$/);
  expect(join.show).toContain(join.link);
  expect(join.show).toContain(join.code);

  // Signed out, the link says nothing about the request: only that signing in comes first.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(join.link);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to continue" })).toBeVisible();
  await expect(page.locator("descope-wc")).toBeAttached();
  await expect(page.getByText(name)).toHaveCount(0);

  // Signing in comes back to the same page (the Descope screen itself is stood in for by its session JWT).
  expect(await signIn(context, alice.email, new URL(join.link).pathname)).toBe(new URL(join.link).pathname);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Let an agent join Portico" })).toBeVisible();
  await expect(page.getByText(`asks to join Portico as “${name}”`)).toBeVisible();
  await expect(page.getByLabel("Agent name")).toHaveValue(name);

  // A wrong code changes nothing and says so.
  const wrong = String((Number(join.code) + 1) % 10000).padStart(4, "0");
  await page.getByLabel("Code the agent shows").fill(wrong);
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();

  await page.getByLabel("Code the agent shows").fill(join.code);
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Allowed" })).toBeVisible();
  await expect(page.getByText(`The agent “${name}” joined Portico`)).toBeVisible();
  await context.close();

  // The agent's poll now carries its token, once.
  const token = await pollJoin(join);
  const agent = reuse ? world.adopt("alice", name, token) : new AgentClient("alice", name, token);

  const listed = await agent.call("list_porticos");
  expect(listed.handle).toBe(alice.handle);
  const own = listed.porticos.find((p: any) => p.kind === "own");
  expect(own.owned_by_this_person).toBe(true);
  expect(own.this_agent_is_in).toBe(true);
  expect(own.agents).toContain(name);
});
