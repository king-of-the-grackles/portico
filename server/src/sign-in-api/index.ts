import { Hono } from "hono";
import { bearer } from "../agent-api/auth";
import { jsonBodyLimit } from "../agent-api/limits";
import { handleError, readJson } from "../agent-api/rest";
import { requireSetupDone } from "../api";
import { limitedRedeem, WindowLimiter } from "../computer-api/limiter";
import type { Core } from "../core/core";

/**
 * /api/sign-in-requests: an app agent with a join line asks to join, shows its 4-digit code, and polls until a person
 * approves or denies. snake_case JSON, like the agent API.
 */
export function signInRequestApi(core: Core): Hono {
  const route = new Hono();
  const limiter = new WindowLimiter(core.now);

  route.use("*", requireSetupDone(core));
  route.use("*", jsonBodyLimit());

  // The join line's secret is the credential, so unknown secrets count toward the same limit as computer joins.
  route.post("/", async (c) => {
    const body = (await readJson(c)) as { token?: unknown; name?: unknown; kind?: unknown } | null;
    const { request, pollSecret } = limitedRedeem(limiter, () =>
      core.computers.requestSignIn(body?.token, { name: body?.name, kind: body?.kind }),
    );
    return c.json({ id: request.id, code: request.code, poll_secret: pollSecret, expires_at: request.expiresAt }, 201);
  });

  // The agent's poll, with the poll secret as its bearer token. The token arrives once, at the first poll after approval.
  route.get("/:id", (c) => {
    const { request, agent, token } = core.computers.pollSignIn(core.agents, c.req.param("id"), bearer(c.req.header("authorization")));
    c.header("Cache-Control", "no-store");
    if (request.status !== "approved") return c.json({ status: request.status });
    const publicUrl = core.settings.publicUrl();
    return c.json({
      status: request.status,
      agent: agent ? { name: agent.name } : null,
      ...(token
        ? { token, mcp_url: `${publicUrl}/mcp`, openapi_url: `${publicUrl}/api/agent/openapi.json` }
        : {}),
    });
  });

  route.onError(handleError);
  return route;
}
