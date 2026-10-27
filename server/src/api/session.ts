import { Hono } from "hono";
import type { Core } from "../core/core";
import type { PersonEnv } from "./context";

/** /api/session: sign in with a name and password (or a passkey), and sign out. Built by the Accounts track. */
export function sessionRoutes(_core: Core): Hono<PersonEnv> {
  return new Hono<PersonEnv>();
}
