import { Hono } from "hono";
import type { Core } from "../core/core";
import type { PersonEnv } from "./context";

/** /api/setup: create the owner with a one-time setup link. Built by the Accounts track. */
export function setupRoutes(_core: Core): Hono<PersonEnv> {
  return new Hono<PersonEnv>();
}
