import { Hono } from "hono";
import type { Core } from "../core/core";
import type { PersonEnv } from "./context";

/** /api/computers: the signed-in person's computers, and removing one. Built by the Onboarding track. */
export function computerRoutes(_core: Core): Hono<PersonEnv> {
  return new Hono<PersonEnv>();
}
