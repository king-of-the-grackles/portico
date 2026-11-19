import { Hono } from "hono";
import { type PersonEnv, loadPerson } from "../api/context";
import type { Core } from "../core/core";
import { accountPages } from "./account";
import { assetRoutes } from "./assets";
import { codexBridgeRoutes } from "./codex-bridge";
import { consentPages } from "./consent";
import { homePage } from "./home";
import { invitePage } from "./invite";
import { joinPage } from "./join-page";
import { notSetUpPage } from "./layout";
import { mailPages } from "./mail";
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
    await next();
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
