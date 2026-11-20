// Alice makes a Portico and shares it; Bob comes in with the link and an agent; the two agents exchange a DM; and
// Alice gets nowhere near the conversations in Bob's own Portico.
import { expect, test, unique } from "../lib/fixtures";

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

test("a shared Portico joins two people's agents, and each person's own conversations stay private", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const probe = await world.agent("alice", "probe");
  await world.agent("alice", "helper");
  await world.dropShared();

  // ---- Alice makes a Portico with her two agents in it, on the pages ----
  const page = await browserAs(alice);
  const porticoName = unique(`E2E Launch ${world.runId}`);
  await page.goto("/");
  await page.getByRole("link", { name: "New Portico" }).or(page.getByRole("button", { name: "New Portico" })).first().click();
  await page.getByLabel("Name").fill(porticoName);
  await page.getByRole("checkbox", { name: "probe" }).click();
  await page.getByRole("checkbox", { name: "helper" }).click();
  await page.getByRole("button", { name: "Create Portico" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${porticoName} Portico`, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]+$/);
  const porticoId = page.url().split("/p/")[1]!;

  // ---- and shares it: a link for one more person ----
  await page.getByRole("button", { name: "Share" }).first().click();
  await page.getByRole("button", { name: "Create share link" }).click();
  const linkField = page.locator("input[readonly]").first();
  await expect(linkField).toHaveValue(/\/share#.+/);
  const shareLink = await linkField.inputValue();

  // ---- Bob, new to Portico, comes in with the link and an agent: one consent page, with his handle and the code ----
  await world.newcomer("bob");
  const scout = await world.agent("bob", "scout", { shareLink });
  const bob = await world.person("bob");
  world.rememberShared({ id: porticoId, name: porticoName });
  // The two people allow each other's agents here; the first-contact hold has its own scenario.
  await world.introduce();

  const bobSees = await scout.call("list_porticos");
  const shared = bobSees.porticos.find((p: any) => p.id === porticoId);
  expect(shared.owned_by_this_person).toBe(false);
  expect(shared.agents).toEqual(expect.arrayContaining([`${alice.handle}/probe`, "scout"]));

  await page.goto(`/p/${porticoId}`);
  await expect(page.getByText(`${bob.handle}/scout`).first()).toBeVisible();

  // ---- the two agents exchange a DM through the shared Portico, each naming the other as <handle>/<name> ----
  const subject = unique("Venue for the launch");
  const sent = await scout.send({ to: `${alice.handle}/probe`, subject, text: "Is the venue booked?" });
  expect(sent.portico.id).toBe(porticoId);
  expect(sent.delivery).not.toBe("held");
  const asked = await probe.receive(subject);
  expect(asked.from).toBe(`${bob.handle}/scout`);
  expect(asked.portico.id).toBe(porticoId);
  await probe.send({ reply_to: asked.id, subject: `Re: ${subject}`, text: "Booked for Friday." });
  expect((await scout.receive(`Re: ${subject}`)).from).toBe(`${alice.handle}/probe`);

  // ---- Bob's own conversations: his two agents, in his own Portico ----
  const owl = await world.agent("bob", "owl");
  const secretSubject = unique("Bob's private note");
  const privateMessage = (await scout.send({ to: "owl", subject: secretSubject, text: "Only Bob's agents read this." })).message;
  await owl.receive(secretSubject);
  const bobOwn = bobSees.porticos.find((p: any) => p.kind === "own");

  // Bob himself opens them (so the checks below aren't passing for some other reason).
  const bobApi = await world.apiFor(bob);
  expect((await bobApi.get(`/api/threads/${privateMessage.thread_id}`)).status()).toBe(200);
  expect((await bobApi.get(`/api/tasks/${privateMessage.id}`)).status()).toBe(200);
  const owlId = (await (await bobApi.get("/api/agents")).json()).agents.find((a: any) => a.name === "owl").id;
  await bobApi.dispose();

  // Alice, by the API: each answers exactly like an ID nobody has.
  const aliceApi = await world.apiFor(alice);
  for (const path of ["/api/threads/", "/api/tasks/", "/api/porticos/", "/api/agents/"]) {
    const real = { "/api/threads/": privateMessage.thread_id, "/api/tasks/": privateMessage.id, "/api/porticos/": bobOwn.id, "/api/agents/": owlId }[path]!;
    const theirs = await aliceApi.get(path + real);
    const nobodys = await aliceApi.get(path + UNKNOWN_ID);
    expect(theirs.status(), `${path}<Bob's>`).toBe(404);
    expect(await theirs.json(), `${path}<Bob's>`).toEqual(await nobodys.json());
  }
  await aliceApi.dispose();

  // Alice, by direct address: Bob's own Portico and his agent's page land where an unknown ID lands.
  for (const path of [`/p/${bobOwn.id}`, `/a/${owlId}`]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/$/);
    await expect(page.getByText(secretSubject)).toHaveCount(0);
  }
  await page.goto("/activity");
  await expect(page.getByText(subject, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(secretSubject)).toHaveCount(0);

  // Alice's agent gets no further than Alice: not the task, and no way to write to Bob's other agent.
  expect((await probe.raw("GET", `/tasks/${privateMessage.id}`)).status).toBe((await probe.raw("GET", `/tasks/${UNKNOWN_ID}`)).status);
  expect((await probe.raw("POST", "/messages", { to: `${bob.handle}/owl`, subject: "hello", text: "hello" })).status).toBeGreaterThanOrEqual(400);
});
