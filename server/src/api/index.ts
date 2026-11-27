import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { handleError } from "../agent-api/rest";
import { jsonBodyLimit } from "../agent-api/limits";
import type { Core } from "../core/core";
import { accountRoutes } from "./account";
import { accountSignInRoutes } from "./account-sign-in";
import { analyticsRoute } from "./analytics";
import { agentRoutes } from "./agents";
import { approvalRoutes } from "./approvals";
import { computerRoutes } from "./computers";
import { consentRoutes } from "./consents";
import { type PersonEnv, loadPerson } from "./context";
import { eventRoutes } from "./events";
import { meRoutes } from "./me";
import { passkeyRoutes } from "./passkeys";
import { peopleRoutes } from "./people";
import { questionRoutes } from "./questions";
import { sessionRoutes } from "./session";
import { setupRoutes } from "./setup";
import { threadRoutes } from "./threads";
import { taskRoutes } from "./tasks";
import { workspaceRoutes } from "./workspaces";

/** Paths under /api that answer before setup is done: setup itself. */
const OPEN_BEFORE_SETUP = /^\/api\/setup(\/|$)/;

/** What sign-in with an outside account doesn't take: setup links, passwords and passkeys. Signing out (DELETE /session) stays. */
const OFF_WITH_ACCOUNTS = /^\/api\/(setup|passkeys|me\/password|session\/passkey)(\/|$)/;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a request came from Portico's own pages: no Origin header (same-origin GETs, non-browser clients), or an
 * Origin whose host is the public URL's (for a public URL on this computer, any of its loopback names). Before a public URL is set or confirmed at setup (`publicUrl` null), the
 * request's own Host stands in. X-Forwarded-Host is never read: any client can send one.
 */
export function sameOrigin(c: Context, publicUrl: string | null): boolean {
  const origin = c.req.header("origin");
  if (origin === undefined) return true;
  let from: URL;
  try {
    from = new URL(origin);
  } catch {
    return false;
  }
  if (publicUrl === null) return from.host === (c.req.header("host") ?? new URL(c.req.url).host);
  const own = new URL(publicUrl);
  if (from.host === own.host) return true;
  // A server on this computer is the same one under each of its loopback names: same scheme and port.
  return LOOPBACK.has(own.hostname) && LOOPBACK.has(from.hostname) && from.port === own.port && from.protocol === own.protocol;
}

/** Changes from another site are refused. SameSite=Lax cookies are the first defense; this is the second. */
export function requireSameOrigin(core: Core): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOrigin(c, core.settings.knownPublicUrl())) {
      return c.json({ error: "not_allowed", message: "Requests from other sites aren't accepted." }, 403);
    }
    await next();
  };
}

/** Until the owner finishes setup, Portico is closed. */
export function requireSetupDone(core: Core): MiddlewareHandler {
  return async (c, next) => {
    if (!core.settings.setupDone() && !OPEN_BEFORE_SETUP.test(c.req.path)) {
      return c.json(
        { error: "setup_required", message: "Portico isn't set up yet. Run portico setup on the host for a setup link." },
        503,
      );
    }
    await next();
  };
}

/**
 * The person API, mounted at /api after the agent, computer and join routes. JSON in and out, the browser's
 * sign-in cookie, same-origin changes only. Each router checks who may call each route (see context.ts).
 */
export function personApi(core: Core, opts: { heartbeatMs?: number } = {}): Hono<PersonEnv> {
  const api = new Hono<PersonEnv>();
  api.use("*", requireSetupDone(core));
  api.use("*", requireSameOrigin(core));
  if (core.accountSignIn) {
    api.use("*", async (c, next) => {
      if (OFF_WITH_ACCOUNTS.test(c.req.path)) {
        return c.json({ error: "not_found", message: "This Portico server signs people in at the Sign in page." }, 404);
      }
      await next();
    });
  }
  // Before the person is loaded: a new person on the welcome page has no handle yet, and that page counts too.
  if (core.analytics.on) api.post("/analytics", analyticsRoute(core));
  api.use("*", jsonBodyLimit());
  api.use("*", loadPerson(core));
  api.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  if (core.accountSignIn) api.route("/", accountSignInRoutes(core, core.accountSignIn));
  api.route("/setup", setupRoutes(core));
  api.route("/session", sessionRoutes(core));
  api.route("/me", meRoutes(core));
  api.route("/me", accountRoutes(core));
  api.route("/passkeys", passkeyRoutes(core));
  api.route("/", peopleRoutes(core));
  api.route("/agents", agentRoutes(core));
  api.route("/", workspaceRoutes(core));
  api.route("/approvals", approvalRoutes(core));
  api.route("/threads", threadRoutes(core));
  api.route("/", taskRoutes(core));
  api.route("/consents", consentRoutes(core));
  api.route("/questions", questionRoutes(core));
  api.route("/computers", computerRoutes(core));
  api.route("/events", eventRoutes(core, opts));

  api.notFound((c) => c.json({ error: "not_found", message: "No such endpoint." }, 404));
  api.onError(handleError);
  return api;
}
