import { Hono } from "hono";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { narrowPage, signInPath } from "./layout";

/** /settings: People, Computers and Account. Built by the UI track. */
export function settingsPage(_core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.get("/settings", (c) => {
    if (!c.get("person")) return c.redirect(signInPath(c.req.url), 303);
    return narrowPage(c, { title: "Settings", main: html`<h1>Settings</h1>` });
  });
  return route;
}
