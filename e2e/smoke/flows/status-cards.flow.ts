// The status cards an app such as ChatGPT draws from portico_status: joined, a message held, a request waiting, the
// Portico page a card's button leads to, and the same answer as text for an app that draws no cards.
import { cardMessages, cardPage, drawCard, openCardHost, statusResult } from "../../lib/card-host";
import { BASE_URL } from "../../lib/env";
import { expect, test } from "../lib/recorder";

test("Status cards: joined, a held message, a waiting request, and the same answer as text", async ({ world, rec }) => {
  const { page } = rec;
  rec.cannotShow("ChatGPT itself. These are the cards as Portico serves them, drawn in a stand-in host: a sandboxed frame that gets the real answer the way an app that draws cards hands it over. How ChatGPT frames and places a card is not shown.");
  rec.cannotShow("The agents' side. They ask Portico for each status over the network, off screen.");
  rec.cannotShow("The button opening a browser tab. In the stand-in host a press only asks the host to open the link, so the video goes to that page itself.");

  // A test person of this run with three agents. The third joined without the person's "I started this", so its first
  // message to another of the person's agents waits for that person. The teardown removes all of them.
  const sam = await world.person("sam");
  const planner = await world.agent("sam", "planner");
  await world.agent("sam", "builder");
  const newcomer = await world.agent("sam", "newcomer", { mine: false });
  await rec.context.addCookies(sam.storage.cookies);

  // The card's page, read from the server as a host reads the page, and each real answer.
  const html = await cardPage(planner.token);
  const joined = await statusResult(planner.token);
  expect(joined.structuredContent.state).toBe("joined");

  await openCardHost(page, "Stand-in host · portico_status");
  let card = await drawCard(page, html, joined);
  await expect(card.getByRole("heading", { level: 1 })).toHaveText("planner is on Portico");
  await expect(card.getByRole("button", { name: "Open Portico" })).toBeVisible();
  await rec.pause(1500);
  await rec.step("joined-card", "Asked 'am I on Portico?', the agent's app shows this card: joined, and one button to Portico.", { hold: 6000 });

  const subject = "Notes from the first run";
  const sent = await newcomer.send({ to: "builder", subject, text: "The first run finished without errors." });
  expect(sent.delivery).toBe("held");
  const heldLink = `${BASE_URL}/held/${sent.message.id}`;
  // The send's own answer names the page too, for every kind of agent.
  expect(sent.note).toContain(heldLink);
  const held = await statusResult(newcomer.token, { message: sent.message.id });
  card = await drawCard(page, html, held);
  await expect(card.getByRole("heading", { level: 1 })).toHaveText("Message to builder is held");
  await expect(card.locator("#quote")).toHaveText(subject);
  await expect(card.locator("#addr")).toHaveText(heldLink);
  await rec.pause(1500);
  await rec.step("held-card", "A new agent's first message is held. The card says for whom and why, with 'Review on Portico'.", { hold: 7000 });

  // The press asks the host for exactly that page, and for nothing else.
  await card.getByRole("button", { name: "Review on Portico" }).click();
  await expect.poll(async () => (await cardMessages(page)).filter((m) => m.method === "ui/open-link").map((m) => m.params)).toEqual([{ url: heldLink }]);
  await page.goto(`/held/${sent.message.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Allow this message?" })).toBeVisible();
  await expect(page.getByText(subject).first()).toBeVisible();
  await rec.step("held-page", "The button leads to the message's own page on Portico. Allowing happens here, signed in.", { hold: 6000 });

  // The person's own shared Portico, and the agent's request to share it: nothing changes until the person allows.
  const porticos = (await planner.call("list_porticos")).porticos as { id: string; kind: string; owned_by_this_person: boolean }[];
  const shared = porticos.find((p) => p.kind === "shared" && p.owned_by_this_person) ?? (await planner.call("create_portico", { name: "Research" })).portico;
  const asked = await planner.call("share_portico", { portico: shared.id });
  expect(asked.status).toBe("waiting_for_person");
  const waiting = await statusResult(planner.token, { request: asked.request.id });
  await openCardHost(page, "Stand-in host · portico_status");
  card = await drawCard(page, html, waiting);
  await expect(card.getByRole("heading", { level: 1 })).toContainText("Allow sharing");
  await expect(card.locator("#addr")).toHaveText(`${BASE_URL}/c/${asked.request.id}`);
  await rec.pause(1500);
  await rec.step("request-card", "The agent asked to share a Portico. The card says nothing has changed yet, and links to the page to allow.", { hold: 7000 });

  // An app that draws no cards gets the same answer as text: shown here as written, in a plain block.
  await openCardHost(page, "An app that draws no cards · the same answer as text");
  await page.evaluate((text) => {
    const pre = document.createElement("pre");
    pre.style.cssText = "margin: 0; padding: 12px; border-radius: 10px; background: #f4f4f2; color: #1f1f1f; font: 13px/20px ui-monospace, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere";
    pre.textContent = text;
    document.body.appendChild(pre);
  }, held.content[0].text as string);
  await expect(page.locator("pre")).toContainText(`Review on Portico: ${heldLink}`);
  await rec.step("text-answer", "An app that draws no cards gets the same answer as text, with the full link.", { hold: 7000 });
});
