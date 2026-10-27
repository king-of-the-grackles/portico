import { Hono } from "hono";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";

/**
 * Connector sign-in with OAuth 2.1: /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server,
 * /oauth/register, /oauth/authorize (the consent page) and /oauth/token. Built by the Onboarding track.
 */
export function oauthRoutes(_core: Core): Hono<PersonEnv> {
  return new Hono<PersonEnv>();
}
