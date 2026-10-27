import { Hono } from "hono";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { narrowPage } from "./layout";

/** /invite#<secret>: claim an invite, then wait for the owner's approval. Built by the People track. */
export function invitePage(_core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.get("/invite", (c) => narrowPage(c, { title: "Join Portico", main: html`<h1>Join Portico</h1>` }));
  return route;
}
