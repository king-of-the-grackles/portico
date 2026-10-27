import { Hono } from "hono";
import type { Core } from "../core/core";
import type { PersonEnv } from "./context";

/** /api/join-lines: make a join line, and watch for the agent that joins with it. Built by the Onboarding track. */
export function joinLineRoutes(_core: Core): Hono<PersonEnv> {
  return new Hono<PersonEnv>();
}
