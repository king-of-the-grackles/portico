import { Hono } from "hono";
import { type PersonEnv, loadPerson } from "../api/context";
import type { Core } from "../core/core";
import { PAGE_LINKS, PUBLIC_PAGES } from "../discovery";
import { accountPages } from "./account";
import { assetRoutes } from "./assets";
import { codexBridgeRoutes } from "./codex-bridge";
import { consentPages } from "./consent";
import { homePage } from "./home";
import { invitePage } from "./invite";
import { joinPage } from "./join-page";
import { notSetUpPage } from "./layout";
import { mailPages } from "./mail";
import { pageMarkdown } from "./markdown";
import { settingsPage } from "./settings";
import { setupPage } from "./setup";
import { sharePages } from "./share";
import { signInPage } from "./sign-in";

/** Pages that answer before setup is done. */
const OPEN_BEFORE_SETUP = new Set(["/setup"]);
/** Paths that aren't pages: the APIs and well-known documents answer for themselves. */
const NOT_PAGES = /^\/(api|mcp|oauth|\.well-known|healthz|assets|codex|favicon\.ico)(\/|$)/;

/** A page's path with nothing in it a browser could read as another site: single slashes and plain segments. */
const PLAIN_PATH = /^(\/[A-Za-z0-9._~-]+)+$/;

/**
 * Whether the Accept header asks for Markdown before HTML: text/markdown with a quality above 0, and above
 * text/html's, or equal to it and named first. A reader that names neither, or only a wildcard, gets HTML.
 */
export function prefersMarkdown(accept: string | undefined): boolean {
  const quality = new Map<string, { q: number; at: number }>();
  (accept ?? "").toLowerCase().split(",").forEach((part, at) => {
    const [type, ...params] = part.split(";").map((piece) => piece.trim());
    const q = params.find((param) => param.startsWith("q="));
    const value = q === undefined ? 1 : Number(q.slice(2));
    if (type && !quality.has(type)) quality.set(type, { q: Number.isFinite(value) ? value : 0, at });
  });
  const markdown = quality.get("text/markdown");
  const page = quality.get("text/html");
  if (!markdown || markdown.q <= 0) return false;
  if (!page) return true;
  return markdown.q > page.q || (markdown.q === page.q && markdown.at < page.at);
}

/** Every page. Pages read who is signed in; each page decides whether it needs someone. */
export function webRoutes(core: Core): Hono<PersonEnv> {
  const web = new Hono<PersonEnv>();
  web.route("/assets", assetRoutes());
  web.route("/codex", codexBridgeRoutes());
  web.use("*", async (c, next) => {
    const page = c.req.method === "GET" && !NOT_PAGES.test(c.req.path);
    // No page takes a password in its address. One that arrives there anyway (a form submitted without the page's
    // script) is sent to the same page without it, so the address doesn't stay in the bar with the password in it.
    // Only a plain path of Portico's own is answered that way, so the redirect can't lead anywhere else.
    if (page && c.req.query("password") !== undefined) return c.redirect(PLAIN_PATH.test(c.req.path) ? c.req.path : "/", 303);
    if (page && !core.settings.setupDone() && !OPEN_BEFORE_SETUP.has(c.req.path)) return notSetUpPage(c);
    if (!page) return next();
    // Every page says where the API's description and the steps for an agent are.
    c.header("Link", PAGE_LINKS);
    await next();
    // A public page is also there as Markdown, for a reader that asks for Markdown before HTML.
    // Signed out, / is the sign-in page, so it is there as Markdown too. Signed in, / is the person's own page: HTML only.
    const signedOutFirstPage = c.req.path === "/" && !c.get("person");
    if (!PUBLIC_PAGES.includes(c.req.path) && !signedOutFirstPage) return;
    c.res.headers.append("Vary", "Accept");
    if (!prefersMarkdown(c.req.header("accept")) || c.res.status !== 200) return;
    if (!(c.res.headers.get("content-type") ?? "").startsWith("text/html")) return;
    const markdown = pageMarkdown(await c.res.text(), core.settings.publicUrl());
    c.res = new Response(markdown, {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept", Link: PAGE_LINKS },
    });
  });
  web.use("*", loadPerson(core));
  // Two sign-ins. An outside account: signing in makes the person, so no setup link, password page or invites.
  if (core.accountSignIn) web.route("/", accountPages(core, core.accountSignIn));
  else {
    web.route("/", setupPage(core));
    web.route("/", signInPage(core));
    web.route("/", invitePage(core));
  }
  web.route("/", joinPage(core));
  web.route("/", sharePages(core));
  web.route("/", consentPages(core));
  web.route("/", mailPages(core));
  web.route("/", settingsPage(core));
  web.route("/", homePage(core));
  return web;
}
