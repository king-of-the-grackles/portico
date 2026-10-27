import { describe, expect, test } from "bun:test";
import { safeNext, scriptJson, signInPath } from "../src/web/layout";
import { addOwner, makePortico, PUBLIC_URL, signIn } from "./helpers";

describe("pages", () => {
  test("before setup, every page but /setup says Portico isn't set up", async () => {
    const p = makePortico({ setup: false });
    const res = await p.app.request("/");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Portico isn't set up yet");
    expect((await p.app.request("/setup")).status).toBe(200);
  });

  test("Home and Settings send a signed-out visit to sign in, keeping the page", async () => {
    const p = makePortico();
    const res = await p.app.request("/a/some-agent");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/sign-in?next=%2Fa%2Fsome-agent");
    const chris = await addOwner(p);
    expect((await p.app.request("/settings", { headers: { cookie: signIn(p, chris) } })).status).toBe(200);
  });

  test("pages carry the security headers", async () => {
    const p = makePortico();
    const res = await p.app.request("/sign-in");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("unknown pages are a page, unknown API paths are JSON", async () => {
    const p = makePortico();
    expect((await p.app.request("/nowhere")).headers.get("content-type")).toContain("text/html");
    expect((await p.app.request("/api/agent/nowhere", { headers: { authorization: "Bearer x" } })).status).toBe(401);
    expect((await p.app.request("/mcp/nowhere")).headers.get("content-type")).toContain("application/json");
  });

  test("next paths stay on Portico", () => {
    expect(safeNext("/c/abc")).toBe("/c/abc");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/%2e%2e/x")).toBe("/");
    expect(safeNext("/sign-in")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(signInPath(`${PUBLIC_URL}/`)).toBe("/sign-in");
  });

  test("first data can't close its script element", () => {
    expect(scriptJson({ text: "</script><script>alert(1)</script>" })).not.toContain("</script>");
  });
});

describe("assets", () => {
  test("browser modules are served as JavaScript, transpiled from TypeScript", async () => {
    const p = makePortico();
    const res = await p.app.request("/assets/forms.js");
    expect(res.headers.get("content-type")).toContain("text/javascript");
    const body = await res.text();
    expect(body).toContain('from "./api.js"');
    expect(body).not.toContain(": HTMLFormElement");
    const etag = res.headers.get("etag")!;
    expect((await p.app.request("/assets/forms.js", { headers: { "if-none-match": etag } })).status).toBe(304);
    expect((await p.app.request("/assets/base.css")).headers.get("content-type")).toContain("text/css");
    expect((await p.app.request("/assets/nope.js")).status).toBe(404);
  });
});
