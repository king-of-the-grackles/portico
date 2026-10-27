import { Hono } from "hono";
import type { Core } from "../core/core";
import type { PersonEnv } from "./context";

/** /api/me changes: name and password. Built by the Accounts track. */
export function accountRoutes(_core: Core): Hono<PersonEnv> {
  return new Hono<PersonEnv>();
}
