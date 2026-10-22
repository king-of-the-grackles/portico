import { describe, expect, test } from "bun:test";
import type { Message } from "../src/core/types";
import { PRONOUNS, makeApp, signIn, visibleCopy } from "./helpers";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-00000001",
    fromAgent: "notes-app-claude@macbook",
    toAgent: "muse",
    text: "hello",
    replyTo: null,
    createdAt: "2026-10-20T11:00:00.000Z",
    expiresAt: "2026-10-21T11:00:00.000Z",
    deliveredAt: null,
    ...overrides,
  };
}

const idOf = (n: number) => `msg-${String(n).padStart(8, "0")}`;
const minute = (n: number) => `2026-10-20T${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00.000Z`;

async function setup() {
  const ctx = makeApp();
  const cookie = await signIn(ctx.app);
  const get = async (query = "") => (await ctx.app.request(`/hub/messages${query}`, { headers: { cookie } })).text();
  return { ...ctx, cookie, get };
}

const shownIds = (page: string) => [...page.matchAll(/id="m-([^"]+)"/g)].map((m) => m[1]);

describe("hub page: Messages", () => {
  test("signed out redirects to sign-in", async () => {
    const { app } = makeApp();
    const res = await app.request("/hub/messages");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/hub/login?next=${encodeURIComponent("/hub/messages")}`);
  });

  test("the nav links to Messages after History", async () => {
    const { get } = await setup();
    const page = await get();
    expect(page).toContain('<a href="/hub/messages">Messages</a>');
    expect(page.indexOf('href="/hub/history"')).toBeLessThan(page.indexOf('href="/hub/messages"'));
  });

  test("empty state and the kept-for line", async () => {
    const { get } = await setup();
    const page = await get();
    expect(page).toContain("No messages.");
    expect(page).toContain("Messages are kept for 30 days.");
  });

  test("lists newest first with sender, receiver, short id and anchor", async () => {
    const { store, get } = await setup();
    store.insertMessage(message({ id: "aaaaaaaa-1111", text: "older-text", createdAt: minute(1) }));
    store.insertMessage(message({ id: "bbbbbbbb-2222", text: "newer-text", createdAt: minute(2) }));
    const page = await get();
    expect(shownIds(page)).toEqual(["bbbbbbbb-2222", "aaaaaaaa-1111"]);
    expect(page).toContain("notes-app-claude@macbook");
    expect(page).toContain("muse");
    expect(page).toContain("bbbbbbbb");
    expect(page).toContain("newer-text");
  });

  test("101 messages: 100 shown, an Older link, and the next page has the rest with no overlap", async () => {
    const { store, get } = await setup();
    for (let i = 0; i < 101; i++) store.insertMessage(message({ id: idOf(i), createdAt: minute(i) }));
    const first = await get();
    const firstIds = shownIds(first);
    expect(firstIds).toHaveLength(100);
    expect(firstIds[0]).toBe(idOf(100));
    expect(first).toContain(`href="/hub/messages?before=${firstIds[99]}"`);
    expect(first).toContain("Older messages");
    expect(first).not.toContain("Newest messages");
    const second = await get(`?before=${firstIds[99]}`);
    expect(shownIds(second)).toEqual([idOf(0)]);
    expect(second).not.toContain("Older messages");
    expect(second).toContain('href="/hub/messages"');
    expect(second).toContain("Newest messages");
  });

  test("paging neither repeats nor skips messages that share a created_at", async () => {
    const { store, get } = await setup();
    for (let i = 0; i < 150; i++) store.insertMessage(message({ id: idOf(i), createdAt: minute(Math.floor(i / 3)) }));
    const first = shownIds(await get());
    const second = shownIds(await get(`?before=${first[99]}`));
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(50);
    const all = [...first, ...second];
    expect(new Set(all).size).toBe(150);
    expect([...all].sort()).toEqual(Array.from({ length: 150 }, (_, i) => idOf(i)));
  });

  test("an unknown or malformed before shows the first page", async () => {
    const { store, get } = await setup();
    store.insertMessage(message({ id: "only-one", text: "the-only-one" }));
    for (const query of ["?before=nope", "?before=", "?before=%00%ff", "?before=a&before=b"]) {
      expect(await get(query)).toContain("the-only-one");
    }
  });

  test("status labels: Delivered with time, Waiting, Expired unread", async () => {
    const { store, get, clock } = await setup();
    const now = clock.now().toISOString();
    const future = new Date(clock.now().getTime() + 3_600_000).toISOString();
    const past = new Date(clock.now().getTime() - 3_600_000).toISOString();
    store.insertMessage(message({ id: "d", createdAt: minute(1), deliveredAt: "2026-10-20T11:30:00.000Z", expiresAt: past }));
    store.insertMessage(message({ id: "w", createdAt: minute(2), expiresAt: future }));
    store.insertMessage(message({ id: "x", createdAt: minute(3), expiresAt: past }));
    store.insertMessage(message({ id: "e", createdAt: minute(4), expiresAt: now }));
    const page = await get();
    const entry = (id: string) => page.split(`id="m-${id}"`)[1]!.split("</article>")[0];
    expect(entry("d")).toContain("Delivered");
    expect(entry("d")).toContain("2026-10-20 11:30 UTC");
    expect(entry("w")).toContain("Waiting");
    expect(entry("x")).toContain("Expired unread");
    expect(entry("e")).toContain("Expired unread");
    expect(entry("w")).not.toContain("Expired unread");
  });

  test("a reply links to the message it answers", async () => {
    const { store, get } = await setup();
    store.insertMessage(message({ id: "11112222-orig", createdAt: minute(1) }));
    store.insertMessage(message({ id: "33334444-repl", createdAt: minute(2), replyTo: "11112222-orig" }));
    const page = await get();
    expect(page).toContain('Reply to <a href="#m-11112222-orig">11112222</a>');
  });

  test("text is escaped and defanged, shown in full", async () => {
    const { store, get } = await setup();
    const long = "x".repeat(5000);
    store.insertMessage(
      message({ id: "m1", createdAt: minute(1), text: `<script>alert(1)</script>‮evil\u001b[31mred\nsecond line ${long}` }),
    );
    const page = await get();
    expect(page).not.toContain("<script>alert(1)");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).not.toContain("‮");
    expect(page).not.toContain("\u001b");
    expect(page).toContain("evilred");
    expect(page).toContain("second line");
    expect(page).toContain(long);
  });

  test("copy has no pronouns and never names the app", async () => {
    const { store, get } = await setup();
    store.insertMessage(message({ id: "m1", text: "plain body" }));
    for (const page of [await get(), await (await setup()).get()]) {
      const text = visibleCopy(page);
      expect(text).not.toMatch(PRONOUNS);
      expect(text.toLowerCase()).not.toContain("agent-bridge");
    }
  });
});
