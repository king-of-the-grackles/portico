import { Hono } from "hono";
import { bearer } from "../agent-api/auth";
import { jsonBodyLimit } from "../agent-api/limits";
import { handleError, readJson } from "../agent-api/rest";
import { requireSetupDone } from "../api";
import { clientIp } from "../client-ip";
import { WindowLimiter } from "../computer-api/limiter";
import type { ConsentRequest } from "../core/consents";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import { LIMITS, MINUTE_MS } from "../core/limits";

/** Where a person answers a request: the one consent page. */
export function consentLink(publicUrl: string, request: Pick<ConsentRequest, "id">): string {
  return `${publicUrl}/c/${request.id}`;
}

/** What a joining computer or agent shows its person, word for word: the link, the code and when the code runs out. */
export function joinSentence(publicUrl: string, request: Pick<ConsentRequest, "id" | "code" | "expiresAt">): string {
  return (
    `To finish joining Portico, open ${consentLink(publicUrl, request)} in a browser, sign in, type the code ${request.code} and press Allow. ` +
    `The code runs out at ${request.expiresAt}. Type the code only on that page.`
  );
}

/**
 * /api/join: a computer or an app agent that isn't on Portico asks to join. No credential is needed to ask, so asking
 * is limited per client address and tells nothing about any account. The asker shows its person a link and a 4-digit
 * code; the person signs in on that page, types the code and presses Allow; the asker polls for its token.
 *
 *   POST /api/join { kind?: "computer" | "agent", name, client?, link?, replaces?: { id, poll_secret } }
 *        → 201 { id, link, code, poll_secret, expires_at, show }
 *   GET  /api/join/:id  (Authorization: Bearer <poll_secret>)
 *        → { status } and, once allowed, { computer | agent, token, … } with the token exactly once
 *
 * snake_case JSON, like the agent API.
 */
export function joinApi(core: Core): Hono {
  const route = new Hono();
  const starts = new WindowLimiter(core.now, LIMITS.consentStartsPerClient, 15 * MINUTE_MS);

  route.use("*", requireSetupDone(core));
  route.use("*", jsonBodyLimit());

  route.post("/", async (c) => {
    const body = (await readJson(c)) as { kind?: unknown; name?: unknown; client?: unknown; link?: unknown; replaces?: unknown } | null;
    const address = clientIp(c);
    // Nothing awaits between the check and the count (bun:sqlite is synchronous), so a burst can't all pass the check first.
    if (starts.blocked(address)) throw new PorticoError("rate_limited", "Too many requests to join from this address. Try again in 15 minutes.");
    starts.record(address);
    const { request, pollSecret } = core.consents.startJoin(body ?? {}, address);
    const publicUrl = core.settings.publicUrl();
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        id: request.id,
        link: consentLink(publicUrl, request),
        code: request.code,
        poll_secret: pollSecret,
        expires_at: request.expiresAt,
        show: joinSentence(publicUrl, request),
      },
      201,
    );
  });

  // The asker's poll, with the poll secret as its bearer token. The token arrives once, at the first poll after Allow.
  route.get("/:id", (c) => {
    const { request, agent, computer, token } = core.consents.poll(c.req.param("id"), bearer(c.req.header("authorization")));
    c.header("Cache-Control", "no-store");
    if (request.status !== "approved") return c.json({ status: request.status });
    const publicUrl = core.settings.publicUrl();
    if (request.kind === "computer") {
      return c.json({ status: request.status, computer: computer ? { id: computer.id, name: computer.name } : null, ...(token ? { token } : {}) });
    }
    return c.json({
      status: request.status,
      agent: agent ? { name: agent.name } : null,
      ...(token ? { token, mcp_url: `${publicUrl}/mcp`, openapi_url: `${publicUrl}/api/agent/openapi.json` } : {}),
    });
  });

  route.onError(handleError);
  return route;
}
