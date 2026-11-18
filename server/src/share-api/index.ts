import { Hono } from "hono";
import { bearer } from "../agent-api/auth";
import { jsonBodyLimit } from "../agent-api/limits";
import { handleError, readJson } from "../agent-api/rest";
import { requireSetupDone } from "../api";
import { clientIp } from "../client-ip";
import { limitedRedeem, WindowLimiter } from "../computer-api/limiter";
import type { Core } from "../core/core";

/**
 * /api/share-requests: an agent that isn't on Portico yet asks, with a share link, to join and come into the
 * workspace the link is for. The agent shows its 4-digit code, the person types the code on the confirm page, and
 * the agent polls for its token. snake_case JSON, like the agent API.
 */
export function shareRequestApi(core: Core): Hono {
  const route = new Hono();
  const limiter = new WindowLimiter(core.now);

  route.use("*", requireSetupDone(core));
  route.use("*", jsonBodyLimit());

  // The link's secret is the credential, so links that don't work count toward a limit per client.
  route.post("/", async (c) => {
    const body = (await readJson(c)) as { link?: unknown; token?: unknown; name?: unknown; kind?: unknown } | null;
    const { request, pollSecret } = limitedRedeem(limiter, clientIp(c), () =>
      core.shares.requestForNewAgent(body?.link ?? body?.token, { name: body?.name, kind: body?.kind }),
    );
    return c.json(
      {
        id: request.id,
        code: request.code,
        poll_secret: pollSecret,
        confirm_url: `${core.settings.publicUrl()}/share/confirm/${request.id}`,
        expires_at: request.expiresAt,
      },
      201,
    );
  });

  // The agent's poll, with the poll secret as its bearer token. The token arrives once, at the first poll after the person confirms.
  route.get("/:id", (c) => {
    const { request, agent, token } = core.shares.poll(c.req.param("id"), bearer(c.req.header("authorization")));
    c.header("Cache-Control", "no-store");
    if (request.status !== "approved") return c.json({ status: request.status });
    const publicUrl = core.settings.publicUrl();
    return c.json({
      status: request.status,
      agent: agent ? { name: agent.name } : null,
      ...(token ? { token, mcp_url: `${publicUrl}/mcp`, openapi_url: `${publicUrl}/api/agent/openapi.json` } : {}),
    });
  });

  route.onError(handleError);
  return route;
}
