import { Hono } from "hono";
import type { Core } from "../core/core";
import type { PersonEnv } from "./context";

/** /api/passkeys: add, list and remove passkeys. Built by the Accounts track. */
export function passkeyRoutes(_core: Core): Hono<PersonEnv> {
  return new Hono<PersonEnv>();
}
