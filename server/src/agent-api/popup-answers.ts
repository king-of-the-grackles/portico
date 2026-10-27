import { Hono } from "hono";
import { z } from "zod";
import type { Approvals } from "../core/approvals";
import { PorticoError } from "../core/errors";
import { DECISIONS } from "../core/types";
import type { Desk } from "../desk";
import { clip, log } from "../log";
import { type AgentEnv, requireAgent, requireSession, type Resolver } from "./auth";
import { jsonBodyLimit } from "./limits";
import { handleError, readJson } from "./rest";
import type { AgentViews } from "./views";

export const NO_REQUEST = "No pop-up request for this session matches.";

const AnswerBody = z.object({
  nonce: z.string().min(1).max(200),
  decision: z.enum(DECISIONS as [string, ...string[]]),
});

export interface PopupAnswerDeps {
  approvals: Approvals;
  desk: Pick<Desk, "check">;
  views: AgentViews;
  resolver: Resolver;
}

/**
 * POST /:messageId, mounted at /api/agent/approvals: a desktop pop-up's answer, from the session the request was sent
 * to. The person clicking is the computer's owner, who is the only one the request goes to. The nonce is never logged.
 */
export function popupAnswerRoutes(deps: PopupAnswerDeps): Hono<AgentEnv> {
  const route = new Hono<AgentEnv>();
  route.use("*", jsonBodyLimit());
  route.use("*", requireAgent(deps.resolver));
  route.post("/:messageId", async (c) => {
    const agent = c.get("agent");
    requireSession(agent, "answer pop-ups");
    const body = AnswerBody.parse(await readJson(c));
    const messageId = c.req.param("messageId");
    const refused = (why: "decided" | "no_request") =>
      log("warn", "popup_answer_refused", { message_id: clip(messageId, 64), agent_id: agent.id, why });
    const state = deps.desk.check(messageId, agent.id, body.nonce);
    if (state !== "open") {
      refused(state === "closed" ? "decided" : "no_request");
      if (state === "closed") throw new PorticoError("wrong_status", "The message was already decided.");
      throw new PorticoError("not_allowed", NO_REQUEST);
    }
    try {
      const message = deps.approvals.decide(agent.ownerId, messageId, body.decision);
      log("info", "popup_answered", { message_id: messageId, agent_id: agent.id, decision: body.decision });
      return c.json({ message: deps.views.message(message) });
    } catch (err) {
      // Decided a moment ago, in the browser or another pop-up, before the desk heard of it.
      if (err instanceof PorticoError && err.code === "wrong_status") refused("decided");
      throw err;
    }
  });
  route.onError(handleError);
  return route;
}
