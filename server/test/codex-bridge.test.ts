import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BRIDGE_STUB } from "../scripts/bundle-client";
import { makePortico, PUBLIC_URL } from "./helpers";

describe("GET /codex/portico-codex.js", () => {
  test("serves the bridge to anyone, even before setup, as JavaScript whose ETag is its sha256", async () => {
    const p = makePortico({ setup: false });
    const res = await p.app.request("/codex/portico-codex.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const body = await res.text();
    expect(res.headers.get("etag")).toBe(`"${createHash("sha256").update(body).digest("hex")}"`);
    // One file that runs under Bun: the MCP SDK is inside, and so are the bridge's commands.
    expect(body).toContain("portico-codex.js");
    expect(body).not.toMatch(/from\s+"@modelcontextprotocol/);
    expect((await p.app.request("/codex/portico-codex.js", { headers: { "if-none-match": res.headers.get("etag")! } })).status).toBe(304);
    const head = await p.app.request("/codex/portico-codex.js", { method: "HEAD" });
    expect(head.headers.get("etag")).toBe(res.headers.get("etag"));
    expect(await head.text()).toBe("");
  });

  test("the generated module a single-file build carries is the stub in the repo", async () => {
    expect(await Bun.file(join(import.meta.dir, "..", "src", "web", "codex-bundle.gen.ts")).text()).toBe(BRIDGE_STUB);
  });
});

describe("/join for Codex", () => {
  test("downloads the bridge from this Portico, joins with the line, and approves the hook", async () => {
    const html = await (await makePortico().app.request("/join")).text();
    expect(html).toContain(`curl -fsS ${PUBLIC_URL}/codex/portico-codex.js -o ~/.portico/portico-codex.js`);
    expect(html).toContain(`bun ~/.portico/portico-codex.js join 'Join Portico: ${PUBLIC_URL}/join#&lt;secret&gt;'`);
    expect(html).toContain("open <code>/hooks</code> and approve the Portico Stop hook");
    expect(html).toContain("<h2>Muse, Grok Bot, Dots, Claude Duet and other app agents</h2>");
  });
});
