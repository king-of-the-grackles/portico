import { type Context, Hono } from "hono";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { narrowPage, signInPath } from "./layout";

/** Home: /, /c/:threadId and /a/:agentId. Built by the UI track. */
export function homePage(_core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  const home = (c: Context<PersonEnv>) => {
    if (!c.get("person")) return c.redirect(signInPath(c.req.url), 303);
    return narrowPage(c, { title: "Portico", main: html`<h1>Portico</h1>` });
  };
  route.get("/", home);
  route.get("/c/:threadId", home);
  route.get("/a/:agentId", home);
  return route;
}
