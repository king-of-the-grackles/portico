import { Hono } from "hono";
import type { Core } from "../core/core";
import type { PersonEnv } from "./context";

/** /api/people, /api/invites and /api/claims: members, invites and claims. Built by the People track. */
export function peopleRoutes(_core: Core): Hono<PersonEnv> {
  return new Hono<PersonEnv>();
}
