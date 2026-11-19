// A second Portico's life: a share link that works once, an owner who is asked for each later agent, the record of
// who came and went (with no message text), and a person removed.
import { ApiError, startJoin } from "../lib/agent";
import { nonce } from "../lib/env";
import { expect, test, unique } from "../lib/fixtures";

test("a share link works once, the owner admits later agents, the record tells it, and a removed person is out", async ({ world, browserAs }) => {
  const alice = await world.person("alice");
  const bob = await world.person("bob");
  const probe = await world.agent("alice", "probe");
  const scout = await world.agent("bob", "scout");
  await world.agent("bob", "owl");
  await world.introduce();

  // Alice makes a second Portico, with probe in it.
  const api = await world.apiFor(alice);
  const name = unique(`E2E Review ${world.runId}`);
  const made = await api.post("/api/porticos", { data: { name, agentIds: [await world.agentId("alice", "probe")] } });
  const review: string = (await made.json()).workspace.id;
  const find = (listed: any) => listed.porticos.find((p: any) => p.id === review);

  try {
    // ---- a share link whose person asks Alice for each agent added later ----
    const page = await browserAs(alice);
    await page.goto(`/p/${review}`);
    await page.getByRole("button", { name: "Share" }).first().click();
    await page.getByRole("radio", { name: `Asks ${alice.name} for each agent added` }).click();
    await page.getByRole("button", { name: "Create share link" }).click();
    const linkField = page.locator("input[readonly]").first();
    await expect(linkField).toHaveValue(/\/share#.+/);
    const shareLink = await linkField.inputValue();

    // Bob's owl comes in with it: an agent Bob already has asks, and Bob presses Allow (no code).
    const owl = await world.agent("bob", "owl", { shareLink });
    expect(find(await owl.call("list_porticos")).agents).toEqual(expect.arrayContaining([`${alice.handle}/probe`, "owl"]));

    // ---- the link is used up ----
    // For Bob's other agent: told so, and how to go on. For anyone else: a link that doesn't work.
    const again = await scout.raw("POST", "/portico-tools/join_portico", { link: shareLink });
    expect(again.status).toBe(409);
    expect(again.body.message).toContain("a link works once");
    const stranger = await startJoin(`latecomer-${nonce(4)}`, shareLink).then(
      () => null,
      (err) => err,
    );
    expect(stranger, "a join with a used share link is refused").toBeInstanceOf(ApiError);
    expect(stranger.status).toBe(404);
    expect(stranger.body.message).toContain("This share link doesn't work");

    // ---- a later agent of Bob's waits for Alice ----
    const asked = await scout.call("add_to_portico", { portico: review, agent: "scout" });
    expect(asked.status).toBe("waiting_for_owner");
    expect(asked.request).not.toHaveProperty("link");
    expect(find(await scout.call("list_porticos")).agents).not.toContain("scout");

    await page.goto(`/p/${review}`);
    await expect(page.getByRole("heading", { name: `Waiting for ${alice.name}` })).toBeVisible();
    await page.getByRole("link", { name: "Decide" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Let one more agent into a Portico" })).toBeVisible();
    await expect(page.getByText(`${bob.handle}/scout`).first()).toBeVisible();
    // The page's buttons work once its script has loaded.
    await page.waitForLoadState("load");
    await page.locator('button[name="decision"][value="approve"]').click();
    await expect(page.getByRole("heading", { level: 1, name: "Allowed" })).toBeVisible();
    expect(find(await scout.call("list_porticos")).agents).toContain("scout");

    // ---- a conversation there, and the record ----
    const subject = unique("Review notes");
    const secret = `Confidential ${nonce(8)}`;
    await owl.send({ to: `${alice.handle}/probe`, subject, text: secret });
    await probe.receive(subject);

    await page.goto(`/p/${review}`);
    await expect(page.getByRole("heading", { name: "Record" })).toBeVisible();
    await expect(page.getByText("came in with a share link").first()).toBeVisible();
    const recordText = async () => ((await (await api.get(`/api/porticos/${review}`)).json()).record as any[]).map((r) => r.text).join("\n");
    const record = await recordText();
    expect(record).toContain("made a share link for one person, who asks the owner for each agent added later");
    expect(record).toContain(`put ${bob.handle}/owl in`);
    expect(record).toContain(`${bob.handle}/scout`);
    expect(record, "the record never carries what agents wrote").not.toContain(subject);
    expect(record).not.toContain(secret);

    // ---- Alice removes Bob: he and every agent he had there are out ----
    await page.getByRole("button", { name: /^People \(2\)/ }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("button", { name: `Confirm: remove ${bob.name}` }).click();
    await expect(page.getByRole("button", { name: /^People \(1\)/ })).toBeVisible();

    expect(find(await owl.call("list_porticos"))).toBeUndefined();
    expect((await owl.raw("POST", "/messages", { to: `${alice.handle}/probe`, subject: "after", text: "after" })).status).toBeGreaterThanOrEqual(400);
    expect((await probe.agents()).agents.map((a: any) => a.name)).not.toContain(`${bob.handle}/owl`);
    expect(await recordText()).toMatch(new RegExp(`${bob.name}.*(out|removed)`, "i"));
  } finally {
    await api.delete(`/api/porticos/${review}`);
    await api.dispose();
  }
});
