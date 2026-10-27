import { Hono } from "hono";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { narrowPage } from "./layout";

/** /setup#<token>: the one-time setup link's page, which creates the owner. Built by the Accounts track. */
export function setupPage(_core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.get("/setup", (c) => narrowPage(c, { title: "Set up Portico", main: html`<h1>Set up Portico</h1>` }));
  return route;
}
