import { Hono } from "hono";
import type { Core } from "../core/core";
import type { Person } from "../core/types";
import type { PersonEnv } from "./context";
import type { SignInView } from "./views";

/** POST /api/approvals/sign-ins/:id: approve (with a name) or deny an app agent's sign-in request. Built by the Onboarding track. */
export function signInRoutes(_core: Core): Hono<PersonEnv> {
  return new Hono<PersonEnv>();
}

/** Pending sign-in requests from join lines the person made, oldest first. Built by the Onboarding track. */
export function pendingSignIns(_core: Core, _person: Person): SignInView[] {
  return [];
}
