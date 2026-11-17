import { Hono } from "hono";
import { html } from "hono/html";
import type { HostedConfig } from "../config";
import { assetRoutes } from "../web/assets";
import { narrowPage } from "../web/layout";

/** The base domain's own pages. Sign-up and "your workspaces" join this once sign-in is wired. */
export function siteRoutes(config: HostedConfig): Hono {
  const site = new Hono();
  site.route("/assets", assetRoutes());
  site.get("/healthz", (c) => c.json({ ok: true }));
  site.get("/", (c) =>
    narrowPage(c, {
      title: "Portico",
      main: html`<div><h1>Portico</h1><p class="lead">Each workspace has an address of its own, such as <code>acme.${config.domain}</code>. Open a workspace's address to sign in.</p></div>`,
    }),
  );
  site.notFound((c) => {
    if (/^\/(api|mcp|oauth|\.well-known)(\/|$)/.test(c.req.path)) {
      return c.json({ error: "not_found", message: "No such endpoint. A workspace's API lives at the workspace's own address." }, 404);
    }
    return narrowPage(c, { title: "Not found", status: 404, main: html`<h1>Nothing here</h1><p class="lead"><a href="/">Go to Portico</a></p>` });
  });
  return site;
}

/** What an address that names no workspace answers. Plain and self-contained: nothing else is served at that address. */
export function noWorkspace(request: Request, baseUrl: string): Response {
  const path = new URL(request.url).pathname;
  if (/^\/(api|mcp|oauth|\.well-known|files)(\/|$)/.test(path)) {
    return Response.json({ error: "not_found", message: "No workspace at this address." }, { status: 404 });
  }
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No workspace here</title><style>body{font:16px/1.5 system-ui,sans-serif;color:#102b25;background:#e9ece6;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:28rem;padding:24px}a{color:#1f6f5c}</style></head><body><main><h1>No workspace at this address</h1><p>Check the address for a typo, or <a href="${baseUrl}">go to Portico</a>.</p></main></body></html>`;
  return new Response(page, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
