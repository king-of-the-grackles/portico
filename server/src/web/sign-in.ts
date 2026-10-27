import { Hono } from "hono";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { narrowPage } from "./layout";

/** /sign-in: name and password, or a passkey. Built by the Accounts track. */
export function signInPage(_core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.get("/sign-in", (c) => narrowPage(c, { title: "Sign in", main: html`<h1>Sign in</h1>` }));
  return route;
}
