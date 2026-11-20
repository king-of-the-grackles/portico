// An agent asks to join. Its person opens the link, signs in on that page and presses Allow; the page then shows a
// code, and only the agent that is handed the code joins.
import { AgentClient, type Join, joinStatus, readJoinCode, sayStartedThisJoin, startJoin, submitJoinCode } from "../lib/agent";
import { nonce } from "../lib/env";
import { expect, test } from "../lib/fixtures";
import { signIn } from "../lib/person";

const wrongCode = (code: string) => String((Number(code) + 1) % 10000).padStart(4, "0");

test("an agent joins through the consent page and lists its Portico", async ({ world, browser }) => {
  const alice = await world.person("alice");
  // The first run's agent becomes the cast's `probe`. With kept people (E2E_KEEP=1), a throwaway agent joins instead.
  const reuse = !world.hasAgent("alice", "probe");
  const name = reuse ? "probe" : `joiner-${nonce(4)}`;

  const join = await startJoin(name);
  expect(join.show).toContain(join.link);
  expect(join, "the agent is never given a code").not.toHaveProperty("code");
  expect(await joinStatus(join)).toEqual({ status: "pending" });

  // Signed out, the link says nothing about the request: only that signing in comes first.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(join.link);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to continue" })).toBeVisible();
  await expect(page.locator("descope-wc")).toBeAttached();
  await expect(page.getByText(name)).toHaveCount(0);

  // Signing in comes back to the same page (the Descope screen itself is stood in for by its session JWT).
  const path = new URL(join.link).pathname;
  expect(await signIn(context, alice.email, path)).toBe(path);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: /^Allow .+ to join\?$/ })).toBeVisible();
  await expect(page.locator('input[name="name"]')).toHaveValue(name);
  await expect(page.locator('input[name="mine"]')).toHaveCount(0);

  // Later specs reuse this agent, so the join is marked as Alice's own (see sayStartedThisJoin).
  await sayStartedThisJoin(page);
  // Alice started this join herself and presses Allow: the page shows the code, and nothing has joined yet.
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Share this code with your agent" })).toBeVisible();
  const code = await readJoinCode(page);
  expect(await joinStatus(join)).toEqual({ status: "allowed" });

  // A wrong code joins nothing; the right one hands the agent its token.
  const refused = await submitJoinCode(join, wrongCode(code));
  expect(refused.status).toBe(400);
  expect(refused.body).not.toHaveProperty("token");
  const joined = await submitJoinCode(join, code);
  expect(joined.status).toBe(200);
  expect(joined.body.status).toBe("approved");
  expect(joined.body.agent.name).toBe(name);

  // The token came once: the poll never carries it, and the code doesn't work twice.
  expect(await joinStatus(join)).not.toHaveProperty("token");
  expect((await submitJoinCode(join, code)).body).not.toHaveProperty("token");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: /^(Joined|Allowed)$/ })).toBeVisible();
  await context.close();

  const agent = reuse ? world.adopt("alice", name, joined.body.token) : new AgentClient("alice", name, joined.body.token);
  const listed = await agent.call("list_porticos");
  expect(listed.handle).toBe(alice.handle);
  const own = listed.porticos.find((p: any) => p.kind === "own");
  expect(own.owned_by_this_person).toBe(true);
  expect(own.this_agent_is_in).toBe(true);
  expect(own.agents).toContain(name);
});

test("a join someone else started gets nothing, even after the person presses Allow", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const bob = await world.person("bob");

  // Someone starts a join and gets Alice to open the link and press Allow. They hold the poll secret, not the code.
  const name = `intruder-${nonce(4)}`;
  const attack: Join = await startJoin(name);
  const page = await browserAs(alice);
  await page.goto(attack.link);
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Share this code with your agent" })).toBeVisible();
  const code = await readJoinCode(page);

  // The poll says "allowed" and nothing more; guessing is refused; Alice has no new agent.
  expect(await joinStatus(attack)).toEqual({ status: "allowed" });
  const guess = await submitJoinCode(attack, wrongCode(code));
  expect(guess.status).toBe(400);
  expect(guess.body).not.toHaveProperty("token");
  const api = await world.apiFor(alice);
  const names = async () => (await (await api.get("/api/agents")).json()).agents.map((a: any) => a.name);
  expect(await names()).not.toContain(name);

  // Another signed-in person who has the link sees no code: to them the address holds nothing.
  const bobPage = await browserAs(bob);
  const answer = await bobPage.goto(attack.link);
  expect(answer!.status()).toBe(404);
  await expect(bobPage.getByRole("heading", { level: 1, name: "Nothing to answer here" })).toBeVisible();
  await expect(bobPage.locator(".join-code")).toHaveCount(0);

  // Alice thinks again: Cancel. Now even the right code joins nothing.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Not allowed" })).toBeVisible();
  expect((await joinStatus(attack)).status).toBe("denied");
  const late = await submitJoinCode(attack, code);
  expect(late.status).toBeGreaterThanOrEqual(400);
  expect(late.body).not.toHaveProperty("token");
  expect(await names()).not.toContain(name);
  await api.dispose();
});
