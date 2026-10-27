import { Hono } from "hono";
import type { Core } from "../core/core";

/**
 * /api/sign-in-requests: an app agent with a join line asks to join, shows its 4-digit code, and polls until a person
 * approves or denies. Built by the Onboarding track.
 */
export function signInRequestApi(_core: Core): Hono {
  return new Hono();
}
