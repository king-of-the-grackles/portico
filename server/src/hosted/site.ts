import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { jsonBodyLimit } from "../agent-api/limits";
import { handleError } from "../agent-api/rest";
import { sameOrigin } from "../api";
import { sessionCookieOptions } from "../api/context";
import { jsonObject } from "../api/session";
import { log } from "../log";
import { assetRoutes } from "../web/assets";
import { narrowPage, safeNext } from "../web/layout";
import { MAX_WORKSPACES_PER_ACCOUNT, type Hosted } from "./router";

/** The base domain's own sign-in cookie. Set for the base domain only, so no workspace address ever receives it. */
const ACCOUNT_COOKIE = "portico_base";

/** The Descope sign-in component, pinned to one version. */
const DESCOPE_SCRIPT = "https://descopecdn.com/npm/@descope/web-component@4.7.3/dist/index.js";

/**
 * The sign-in page loads Descope's component, which fetches the sign-in screens and talks to Descope. Nothing else on
 * the base domain, and no page of any workspace, allows a script from outside Portico.
 */
const SIGN_IN_CSP =
  "default-src 'none'; script-src 'self' https://descopecdn.com https://static.descope.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com https://static.descope.com https://descopecdn.com data:; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self' https://api.descope.com https://static.descope.com https://descopecdn.com; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

type SiteEnv = { Variables: { account: string | null } };

/**
 * The base domain's pages. With sign-in configured: sign in, the account's workspaces, making a workspace, and the
 * hand-off that sends a signed-in browser into a workspace. Without, a plain page pointing at workspace addresses.
 */
export function siteRoutes(hosted: Hosted): Hono {
  const { config, control } = hosted;
  const site = new Hono<SiteEnv>();
  site.route("/assets", assetRoutes());
  site.get("/healthz", (c) => c.json({ ok: true }));

  const notFound = (c: Context) => {
    if (/^\/(api|mcp|oauth|\.well-known)(\/|$)/.test(c.req.path)) {
      return c.json({ error: "not_found", message: "No such endpoint. A workspace's API lives at the workspace's own address." }, 404);
    }
    return narrowPage(c, { title: "Not found", status: 404, main: html`<h1>Nothing here</h1><p class="lead"><a href="/">Go to Portico</a></p>` });
  };
  site.notFound(notFound);
  site.onError(handleError);

  const accounts = hosted.accounts;
  if (!accounts) {
    site.get("/", (c) =>
      narrowPage(c, {
        title: "Portico",
        main: html`<div><h1>Portico</h1><p class="lead">Each workspace has an address of its own, such as <code>acme.${config.domain}</code>. Open a workspace's address to sign in.</p></div>`,
      }),
    );
    return site as unknown as Hono;
  }

  const secure = config.baseUrl.startsWith("https:");
  site.use("*", async (c, next) => {
    c.set("account", control.accountForSession(getCookie(c, ACCOUNT_COOKIE)));
    await next();
  });
  site.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOrigin(c, config.baseUrl)) {
      return c.json({ error: "not_allowed", message: "Requests from other sites aren't accepted." }, 403);
    }
    await next();
    c.header("Cache-Control", "no-store");
  });
  site.use("/api/*", jsonBodyLimit());

  // ---- pages ----

  site.get("/", (c) => {
    const account = c.get("account");
    // Signed out, the base domain is the sign-in form: nothing else is worth a click first.
    if (!account) return c.redirect("/sign-in", 303);
    const workspaces = hosted.workspacesFor(account);
    const made = control.createdBy(account).length;
    const row = (w: (typeof workspaces)[number]) => {
      const waiting = w.person.status === "pending";
      const note = waiting ? "Waiting for the owner's approval" : w.person.role === "owner" ? "Owner" : "Member";
      return html`<div class="row-card"><span class="row-text"><strong>${new URL(w.url).host}</strong><span class="help">${note}, as ${w.person.name}</span></span><a class="btn btn-secondary" href="${w.url}/sign-in/start">Open</a></div>`;
    };
    const create =
      made >= MAX_WORKSPACES_PER_ACCOUNT
        ? html`<p class="help">One account can make ${MAX_WORKSPACES_PER_ACCOUNT} workspaces, and this account has made ${made}.</p>`
        : html`<form class="form-card" data-api="POST /api/workspaces" novalidate>
<label for="ws-slug" class="lbl">Workspace address</label>
<div style="display: flex; align-items: center; gap: 8px"><input id="ws-slug" name="slug" class="field" style="flex: 1 1 auto; min-width: 0" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="40" required aria-describedby="ws-slug-help"><span class="tnum" style="color: var(--muted)">.${config.domain}</span></div>
<span id="ws-slug-help" class="help">3 to 40 lowercase letters, digits and hyphens, such as acme-team. The address can't be changed later.</span>
<label for="ws-name" class="lbl">Name</label>
<input id="ws-name" name="name" class="field" autocomplete="name" maxlength="60" required aria-describedby="ws-name-help">
<span id="ws-name-help" class="help">Shown to people invited to the workspace.</span>
<p class="notice notice-error" data-error role="alert" hidden></p>
<div class="actions"><button type="submit" class="btn btn-primary">Create workspace</button></div>
</form>`;
    return narrowPage(c, {
      title: "Workspaces",
      scripts: ["forms.js"],
      main: html`<div><h1>Workspaces</h1><p class="lead">${workspaces.length === 0 ? "No workspaces yet. Create one below, or open an invite link to join someone else's." : "Open a workspace, or create another."}</p></div>
${workspaces.length === 0 ? "" : html`<div class="row-list">${workspaces.map(row)}</div>`}
<div><h2>Create a workspace</h2>${create}</div>
<form class="row-card" data-api="DELETE /api/session" data-next="/"><span class="row-text"><strong>Sign out</strong><span class="help">Workspaces already open in this browser stay signed in.</span></span><button type="submit" class="btn btn-secondary">Sign out</button></form>`,
    });
  });

  site.get("/sign-in", (c) => {
    const next = safeNext(c.req.query("next"));
    if (c.get("account")) return c.redirect(next, 303);
    return narrowPage(c, {
      title: "Sign in to Portico",
      csp: SIGN_IN_CSP,
      data: { next: c.req.query("next") === undefined ? null : next },
      scripts: [DESCOPE_SCRIPT, "base-sign-in.js"],
      main: html`<div><h1>Sign in to Portico</h1><p class="lead">One place where a team's AI agents message each other. New here? Signing in creates the account.</p></div>
<div class="form-card" style="padding: 8px; min-height: 280px"><descope-wc project-id="${config.descopeProjectId ?? ""}" flow-id="sign-up-or-in" theme="light"></descope-wc></div>
<p class="notice notice-error" data-error role="alert" hidden></p>`,
    });
  });

  // A signed-in browser, sent here by a workspace, goes back with a pass for that workspace.
  site.get("/go/:slug", (c) => {
    const workspace = control.bySlug(c.req.param("slug"));
    if (!workspace) return notFound(c);
    const account = c.get("account");
    if (!account) {
      const url = new URL(c.req.url);
      return c.redirect(`/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`, 303);
    }
    const state = c.req.query("state") ?? "";
    // Without a state the workspace didn't ask: the workspace starts the sign-in, so the pass is tied to the browser.
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(state)) return c.redirect(`${hosted.url(workspace)}/sign-in/start`, 303);
    const pass = hosted.mintPass(workspace, account, state);
    const next = safeNext(c.req.query("next"));
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(`${hosted.url(workspace)}/hand-off?pass=${pass}&next=${encodeURIComponent(next)}`, 303);
  });

  // ---- the base domain's own API ----

  site.post("/api/session", async (c) => {
    const body = await jsonObject(c);
    const account = await accounts.accountFor(body.token);
    control.endSession(getCookie(c, ACCOUNT_COOKIE));
    const { token, expiresAt } = control.startSession(account);
    setCookie(c, ACCOUNT_COOKIE, token, sessionCookieOptions(config.baseUrl, expiresAt));
    log("info", "base_sign_in", {});
    return c.json({ next: safeNext(body.next) });
  });

  site.delete("/api/session", (c) => {
    control.endSession(getCookie(c, ACCOUNT_COOKIE));
    deleteCookie(c, ACCOUNT_COOKIE, { path: "/", secure });
    return c.body(null, 204);
  });

  site.post("/api/workspaces", async (c) => {
    const account = c.get("account");
    if (!account) return c.json({ error: "unauthorized", message: "Sign in to Portico first." }, 401);
    const body = await jsonObject(c);
    const workspace = hosted.createFor(account, { slug: body.slug, name: body.name });
    return c.json({ url: hosted.url(workspace), next: `${hosted.url(workspace)}/sign-in/start` }, 201);
  });

  return site as unknown as Hono;
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
