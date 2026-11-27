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
import { wakeNote, wakeStateOf } from "../core/wake-setup";

/** Where a person answers a request: the one consent page. */
export function consentLink(publicUrl: string, request: Pick<ConsentRequest, "id">): string {
  return `${publicUrl}/c/${request.id}`;
}

/** What a joining computer or agent shows its person, word for word: the link, what to do there, and when the request runs out. */
export function joinSentence(publicUrl: string, request: Pick<ConsentRequest, "id" | "expiresAt">): string {
  return (
    `To finish joining Portico, open ${consentLink(publicUrl, request)} in a browser, sign in and press Allow. ` +
    `The page then shows a 4-digit code: give that code to this agent, and nowhere else. The request runs out at ${request.expiresAt}.`
  );
}

/**
 * /api/join: a computer or an app agent that isn't on Portico asks to join. No credential is needed to ask, so asking
 * is limited per client address and tells nothing about any account. The asker shows its person a link; the person
 * signs in on that page and presses Allow, and the page then shows that person a 4-digit code. The person gives the
 * code to the asker, and the asker hands it in: only then does anything join, and the token comes back. Whoever
 * started a request but was never given the code gets nothing.
 *
 *   POST /api/join { kind?: "computer" | "agent", name, client?, link?, replaces?: { id, poll_secret } }
 *        → 201 { id, link, poll_secret, expires_at, show }
 *   GET  /api/join/:id  (Authorization: Bearer <poll_secret>)
 *        → { status }: pending, allowed (a person holds the code), approved, denied or expired
 *   POST /api/join/:id/code { code }  (Authorization: Bearer <poll_secret>)
 *        → { status: "approved", computer | agent, token, … } with the token exactly once; for an agent, also
 *          `wake` (where wake-ups stand) and `next` (the last step of joining: setting wake-ups up, in full)
 *
 * snake_case JSON, like the agent API.
 */
export function joinApi(core: Core): Hono {
  const route = new Hono();
  const starts = new WindowLimiter(core.now, core.config.joinStartsPerClient, 15 * MINUTE_MS);

  route.use("*", requireSetupDone(core));
  route.use("*", jsonBodyLimit());

  route.post("/", async (c) => {
    const body = (await readJson(c)) as { kind?: unknown; name?: unknown; client?: unknown; link?: unknown; replaces?: unknown } | null;
    const address = clientIp(c);
    // Nothing awaits between the check and the count (bun:sqlite is synchronous), so a burst can't all pass the check first.
    // "local" is every client no proxy reported an address for: counting them as one would let one client keep everyone
    // else from joining, so only the limit on joins waiting from all addresses together holds there.
    if (address !== "local") {
      if (starts.blocked(address)) throw new PorticoError("rate_limited", "Too many requests to join from this address. Try again in 15 minutes.");
      starts.record(address);
    }
    const { request, pollSecret } = core.consents.startJoin(body ?? {}, address);
    const publicUrl = core.settings.publicUrl();
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        id: request.id,
        link: consentLink(publicUrl, request),
        poll_secret: pollSecret,
        expires_at: request.expiresAt,
        show: joinSentence(publicUrl, request),
      },
      201,
    );
  });

  // The asker's poll, with the poll secret as its bearer token: the status and nothing else until the join is done.
  route.get("/:id", (c) => {
    const { request, agent, computer } = core.consents.poll(c.req.param("id"), bearer(c.req.header("authorization")));
    c.header("Cache-Control", "no-store");
    if (request.status !== "approved") return c.json({ status: request.status });
    if (request.kind === "computer") return c.json({ status: request.status, computer: computer ? { id: computer.id, name: computer.name } : null });
    return c.json({ status: request.status, agent: agent ? { name: agent.name } : null });
  });

  // The code the person read on the consent page after Allow. The right one joins, and the token arrives here, once.
  route.post("/:id/code", async (c) => {
    // The poll secret first: without it, nothing about the request or the body is answered.
    const secret = bearer(c.req.header("authorization"));
    core.consents.poll(c.req.param("id"), secret);
    const body = (await readJson(c).catch(() => null)) as { code?: unknown } | null;
    const { request, agent, computer, token } = core.consents.submitCode(c.req.param("id"), secret, body?.code);
    core.analytics.track((a) => {
      const vouched = request.detail.mine === true;
      if (agent) a.capture("agent_joined", agent.ownerId, { agent_id: agent.id, kind: "agent", agent_kind: agent.kind, vouched });
      else if (computer) a.capture("agent_joined", computer.ownerId, { computer_id: computer.id, kind: "computer", agent_kind: request.agentKind, vouched });
    });
    c.header("Cache-Control", "no-store");
    const publicUrl = core.settings.publicUrl();
    if (request.kind === "computer") return c.json({ status: request.status, computer: computer ? { id: computer.id, name: computer.name } : null, token });
    // The token and the last step of joining arrive together: wake-ups, which the agent sets up itself, right away.
    const state = agent ? wakeStateOf(core, agent) : null;
    const note = agent && state && agent.type !== "session" ? wakeNote(state, { publicUrl, kind: agent.kind, type: agent.type }) : null;
    return c.json({
      status: request.status,
      agent: agent ? { name: agent.name } : null,
      token,
      mcp_url: `${publicUrl}/mcp`,
      openapi_url: `${publicUrl}/api/agent/openapi.json`,
      ...(state ? { wake: { on: state.on, how: state.how, tested: state.tested, schedule_minutes: state.scheduleMinutes } } : {}),
      ...(note ? { next: note } : {}),
    });
  });

  route.onError(handleError);
  return route;
}
