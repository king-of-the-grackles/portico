import { Hono } from "hono";
import { type PersonEnv, loadPerson } from "../api/context";
import type { Core } from "../core/core";
import { assetRoutes } from "./assets";
import { codexBridgeRoutes } from "./codex-bridge";
import { homePage } from "./home";
import { invitePage } from "./invite";
import { joinPage } from "./join-page";
import { notSetUpPage } from "./layout";
import { settingsPage } from "./settings";
import { setupPage } from "./setup";
import { signInPage } from "./sign-in";

/** Pages that answer before setup is done. */
const OPEN_BEFORE_SETUP = new Set(["/setup"]);
/** Paths that aren't pages: the APIs and well-known documents answer for themselves. */
const NOT_PAGES = /^\/(api|mcp|oauth|\.well-known|healthz|assets|codex|favicon\.ico)(\/|$)/;

/** Every page. Pages read who is signed in; each page decides whether it needs someone. */
export function webRoutes(core: Core): Hono<PersonEnv> {
  const web = new Hono<PersonEnv>();
  web.route("/assets", assetRoutes());
  web.route("/codex", codexBridgeRoutes());
  web.use("*", async (c, next) => {
    const page = c.req.method === "GET" && !NOT_PAGES.test(c.req.path);
    if (page && !core.settings.setupDone() && !OPEN_BEFORE_SETUP.has(c.req.path)) return notSetUpPage(c);
    await next();
  });
  web.use("*", loadPerson(core.accounts));
  web.route("/", setupPage(core));
  web.route("/", signInPage(core));
  web.route("/", invitePage(core));
  web.route("/", joinPage(core));
  web.route("/", settingsPage(core));
  web.route("/", homePage(core));
  return web;
}
