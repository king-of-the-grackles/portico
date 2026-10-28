import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { handleError } from "../agent-api/rest";
import { jsonBodyLimit } from "../agent-api/limits";
import type { Core } from "../core/core";
import { accountRoutes } from "./account";
import { agentRoutes } from "./agents";
import { approvalRoutes } from "./approvals";
import { computerRoutes } from "./computers";
import { type PersonEnv, loadPerson } from "./context";
import { eventRoutes } from "./events";
import { joinLineRoutes } from "./join-lines";
import { meRoutes } from "./me";
import { passkeyRoutes } from "./passkeys";
import { peopleRoutes } from "./people";
import { sessionRoutes } from "./session";
import { setupRoutes } from "./setup";
import { threadRoutes } from "./threads";
import { taskRoutes } from "./tasks";

/** Paths under /api that answer before setup is done: setup itself. */
const OPEN_BEFORE_SETUP = /^\/api\/setup(\/|$)/;

/**
 * Whether a request came from Portico's own pages: no Origin header (same-origin GETs, non-browser clients), or an
 * Origin whose host is this request's host or the public URL's.
 */
export function sameOrigin(c: Context, publicUrl: string): boolean {
  const origin = c.req.header("origin");
  if (origin === undefined) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const requestHost = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
  return host === requestHost || host === new URL(publicUrl).host;
}

/** Changes from another site are refused. SameSite=Lax cookies are the first defense; this is the second. */
export function requireSameOrigin(core: Core): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOrigin(c, core.settings.publicUrl())) {
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
 * The person API, mounted at /api after the agent, computer and sign-in-request routes. JSON in and out, the browser's
 * sign-in cookie, same-origin changes only. Each router checks who may call each route (see context.ts).
 */
export function personApi(core: Core, opts: { heartbeatMs?: number } = {}): Hono<PersonEnv> {
  const api = new Hono<PersonEnv>();
  api.use("*", requireSetupDone(core));
  api.use("*", requireSameOrigin(core));
  api.use("*", jsonBodyLimit());
  api.use("*", loadPerson(core.accounts));
  api.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  api.route("/setup", setupRoutes(core));
  api.route("/session", sessionRoutes(core));
  api.route("/me", meRoutes(core));
  api.route("/me", accountRoutes(core));
  api.route("/passkeys", passkeyRoutes(core));
  api.route("/", peopleRoutes(core));
  api.route("/agents", agentRoutes(core));
  api.route("/approvals", approvalRoutes(core));
  api.route("/threads", threadRoutes(core));
  api.route("/", taskRoutes(core));
  api.route("/join-lines", joinLineRoutes(core));
  api.route("/computers", computerRoutes(core));
  api.route("/events", eventRoutes(core, opts));

  api.notFound((c) => c.json({ error: "not_found", message: "No such endpoint." }, 404));
  api.onError(handleError);
  return api;
}
