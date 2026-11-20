// The test object every spec imports: `world` (the shared cast) and `browserAs` (a signed-in page for a person).
import { test as base, expect, type Page } from "@playwright/test";
import { type Person, World } from "./world";

export const test = base.extend<{ browserAs: (person: Person) => Promise<Page> }, { world: World }>({
  world: [
    async ({ browser }, use) => {
      await use(new World(browser));
    },
    { scope: "worker" },
  ],

  browserAs: async ({ world }, use) => {
    const contexts: { close(): Promise<void> }[] = [];
    await use(async (person) => {
      const context = await world.contextFor(person);
      contexts.push(context);
      return context.newPage();
    });
    for (const context of contexts) await context.close();
  },
});

export { expect };

/** A subject no earlier run used, so a row on a page is this test's own. */
export const unique = (what: string) => `${what} ${Date.now().toString(36)}`;
