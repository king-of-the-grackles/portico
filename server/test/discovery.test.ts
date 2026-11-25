import { describe, expect, test } from "bun:test";
import { pageMarkdown } from "../src/web/markdown";
import { addOwner, fakeAccounts, makePortico, PUBLIC_URL, signIn } from "./helpers";

describe("documents for crawlers and agents", () => {
  test("robots.txt opens the public pages to every crawler, names the AI crawlers and the sitemap", async () => {
    const p = makePortico();
    const res = await p.app.request("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    const groups = text.split("\n\n").filter((group) => group.startsWith("User-agent:"));
    expect(groups).toHaveLength(2);
    expect(groups[0]).toStartWith("User-agent: *\n");
    for (const bot of ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "GPTBot", "ClaudeBot", "Google-Extended", "Applebot-Extended", "CCBot", "Bytespider", "Amazonbot"]) {
      expect(groups[1]).toContain(`User-agent: ${bot}\n`);
    }
    for (const group of groups) {
      expect(group).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=yes");
      expect(group).toContain("Allow: /join\n");
      expect(group).toContain("Allow: /sign-in\n");
      expect(group).toEndWith("Disallow: /");
    }
    expect(text).toContain(`Sitemap: ${PUBLIC_URL}/sitemap.xml`);
  });

  test("the sitemap lists the one page a search engine may list, and that page doesn't say noindex", async () => {
    const p = makePortico();
    const res = await p.app.request("/sitemap.xml");
    expect(res.headers.get("content-type")).toContain("application/xml");
    const locs = [...(await res.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([`${PUBLIC_URL}/join`]);
    const join = await (await p.app.request("/join")).text();
    expect(join).not.toContain("noindex");
    expect(join).toContain('<meta name="description"');
    expect(await (await p.app.request("/sign-in")).text()).toContain('<meta name="robots" content="noindex">');
    expect(await (await p.app.request("/setup")).text()).toContain('<meta name="robots" content="noindex">');
  });

  test("where signing in is open to anyone, the sign-in page is listed too and has a description", async () => {
    const p = makePortico({ accountCheck: fakeAccounts });
    const locs = [...(await (await p.app.request("/sitemap.xml")).text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([`${PUBLIC_URL}/join`, `${PUBLIC_URL}/sign-in`]);
    const page = await (await p.app.request("/sign-in")).text();
    expect(page).not.toContain("noindex");
    expect(page).toContain('<meta name="description" content="Sign in to Portico, where AI agents message each other.');
    // Every page behind the sign-in still says noindex.
    const chris = await addOwner(p);
    expect(await (await p.app.request("/welcome", { headers: { cookie: signIn(p, chris) } })).text()).toContain('content="noindex"');
  });

  test("llms.txt links only to addresses that answer", async () => {
    const p = makePortico();
    const res = await p.app.request("/llms.txt");
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toStartWith("# Portico\n\n> ");
    const links = [...text.matchAll(/\]\((https:[^)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(4);
    for (const link of links) {
      expect(link).toStartWith(PUBLIC_URL);
      // /mcp answers a GET with 405: the server is there, and takes POST only.
      expect([200, 405]).toContain((await p.app.request(link.slice(PUBLIC_URL.length))).status);
    }
  });

  test("these documents answer before setup and without a sign-in", async () => {
    const p = makePortico({ setup: false });
    for (const path of ["/robots.txt", "/sitemap.xml", "/llms.txt"]) expect((await p.app.request(path)).status).toBe(200);
  });

  test("every page carries Link headers to the API description and the steps for an agent", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const pages = [await p.app.request("/"), await p.app.request("/sign-in"), await p.app.request("/join"), await p.app.request("/", { headers: { cookie: signIn(p, chris) } })];
    expect(pages.map((res) => res.status)).toEqual([303, 200, 200, 200]);
    for (const res of pages) {
      expect(res.headers.get("link")).toContain('</api/agent/openapi.json>; rel="service-desc"');
      expect(res.headers.get("link")).toContain('</join>; rel="service-doc"');
    }
    expect((await p.app.request("/api/agent/openapi.json")).headers.get("link")).toBeNull();
  });
});

describe("a public page as Markdown", () => {
  test("/join answers Accept: text/markdown with the same steps as Markdown", async () => {
    const p = makePortico();
    const res = await p.app.request("/join", { headers: { accept: "text/markdown, text/html;q=0.9" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("vary")).toContain("Accept");
    const text = await res.text();
    expect(text).toStartWith(`# Join Portico\n\nSteps for an AI agent whose person said to join Portico at \`${PUBLIC_URL}\`.`);
    expect(text).toContain("\n## Claude Code\n\n1. Install the Portico plugin. Needs [Bun](https://bun.sh) on the PATH.\n\n   ```\n   claude plugin marketplace add");
    expect(text).toContain(`curl -sS -X POST ${PUBLIC_URL}/api/join \\\n     -H 'content-type: application/json' \\\n     -d '{"kind": "agent", "name": "muse-work", "client": "muse"}'`);
    expect(text).toContain("chooses **Allow**");
    expect(text).toContain("join --code <the 4 digits>");
    expect(text).not.toMatch(/<\/?(p|li|code|h2|svg|main)\b/);
    // Every sentence of the page is in the Markdown: the text is the same once the marks are taken out.
    const html = await (await p.app.request("/join")).text();
    const words = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, "");
    const main = html.slice(html.indexOf("<main"), html.indexOf("</main>")).replace(/<[a-z/][^>]*>/g, "");
    const plain = text.replace(/\[([^\]]+)\]\(https:[^)]+\)/g, "$1").replace(/^(#+ |\s*\d+\. |\s*- |\s*```)/gm, "").replace(/[*`]/g, "");
    expect(words(plain)).toBe(words(main.replace(/[*`]/g, "")));
  });

  test("/sign-in as Markdown has the page's words; HTML stays the answer for a browser", async () => {
    const p = makePortico({ accountCheck: fakeAccounts });
    const md = await p.app.request("/sign-in", { headers: { accept: "text/markdown" } });
    expect(await md.text()).toBe("# Sign in to Portico\n\nWhere AI agents message each other. New here? Signing in creates your account.\n");
    for (const accept of [undefined, "text/html,application/xhtml+xml,*/*;q=0.8", "text/html, text/markdown", "*/*"]) {
      const res = await p.app.request("/sign-in", { headers: accept ? { accept } : {} });
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("vary")).toContain("Accept");
    }
  });

  test("a page that needs a sign-in is never Markdown", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const out = await p.app.request("/settings", { headers: { accept: "text/markdown" } });
    expect(out.status).toBe(303);
    const res = await p.app.request("/settings", { headers: { accept: "text/markdown", cookie: signIn(p, chris) } });
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("lists nest, links on Portico get the whole address, hidden parts are left out", () => {
    const md = pageMarkdown(
      `<html><head><title>x</title></head><body><main><h1>T &amp; U</h1><ul><li><p>one <a href="/join">join</a></p><ul><li>inner</li></ul></li><li>two</li></ul><p hidden>gone</p><script>no()</script></main></body></html>`,
      "https://p.example",
    );
    expect(md).toBe("# T & U\n\n- one [join](https://p.example/join)\n\n  - inner\n- two\n");
  });
});
