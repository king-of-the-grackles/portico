import { Hono } from "hono";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { narrowPage } from "./layout";

/** /join: the steps an agent follows with a join line. Built by the Onboarding track. */
export function joinPage(_core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.get("/join", (c) => narrowPage(c, { title: "Join Portico", main: html`<h1>Join Portico</h1>` }));
  return route;
}
