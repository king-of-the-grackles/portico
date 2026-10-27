import { describe, expect, test } from "bun:test";
import { mcpTools } from "../src/agent-api/mcp";
import { openApiDocument } from "../src/agent-api/openapi";
import { addOwner, copyProblems, makePortico, PUBLIC_URL, signIn, visibleCopy } from "./helpers";

/**
 * The copy sweeps: no pronouns (except "Add your first agent") and no "hub", on every page and in agent-facing text.
 * Each track adds its pages and renderers to PAGES or its own sweep test, using copyProblems(visibleCopy(html)).
 */
const PAGES = ["/", "/settings", "/sign-in", "/setup", "/invite", "/join", "/nowhere"];

describe("copy sweeps", () => {
  test("pages", async () => {
    const p = makePortico();
    const cookie = signIn(p, await addOwner(p));
    for (const path of PAGES) {
      const html = await (await p.app.request(path, { headers: { cookie } })).text();
      expect(`${path}: ${copyProblems(visibleCopy(html)).join("; ")}`).toBe(`${path}: `);
    }
    const before = makePortico({ setup: false });
    expect(copyProblems(visibleCopy(await (await before.app.request("/")).text()))).toEqual([]);
  });

  test("agent-facing tool and API descriptions", () => {
    expect(copyProblems(JSON.stringify(mcpTools()))).toEqual([]);
    expect(copyProblems(JSON.stringify(openApiDocument(PUBLIC_URL)))).toEqual([]);
  });

  test("the allowed phrase is the only exception", () => {
    expect(copyProblems(visibleCopy("<h2>Add your first agent</h2>"))).toEqual([]);
    expect(copyProblems(visibleCopy("<p>Your agents</p>"))).toHaveLength(1);
    expect(copyProblems(visibleCopy("<p>The hub is down</p>"))).toHaveLength(1);
    expect(copyProblems(visibleCopy("<pre>you can paste this</pre><p>Portico</p>"))).toEqual([]);
  });
});
