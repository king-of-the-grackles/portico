import { Hono } from "hono";
import { z } from "zod";
import type { Directory } from "../core/directory";
import { PorticoError } from "../core/errors";
import type { PorticoService } from "../core/service";
import type { PorticoConfig, Task } from "../core/types";
import { clip, log } from "../log";
import { type AgentEnv, type AgentResolver, type PrincipalResolver, requireAgent } from "../ways-in/auth";
import { jsonBodyLimit } from "../ways-in/limits";
import { handleError, readJson } from "../ways-in/rest";
import { taskView } from "../ways-in/views";
import type { ApprovalDesk } from "./desk";

export const ONLY_SESSIONS = "Only a session on a joined machine answers approval requests.";
export const NO_REQUEST = "No approval request for this session matches.";

const AnswerBody = z.object({
  nonce: z.string().min(1).max(200),
  decision: z.enum(["approve", "deny"]),
  note: z.string().optional(),
});

export interface ApprovalRouteDeps {
  config: PorticoConfig;
  service: PorticoService;
  directory: Directory;
  desk: Pick<ApprovalDesk, "check">;
  resolvers: { agent: AgentResolver; principal: PrincipalResolver };
}

/**
 * POST /:taskId, mounted at /api/approvals: a pop-up's answer, from the session the request was sent to (spec §4.4).
 * Plugin-only, so it stays out of the OpenAPI document. Neither the nonce nor the note is ever logged.
 */
export function approvalRoutes(deps: ApprovalRouteDeps): Hono<AgentEnv> {
  const { config, service, directory, desk, resolvers } = deps;
  const route = new Hono<AgentEnv>();
  route.use("*", jsonBodyLimit(config));
  route.use("*", requireAgent(resolvers.agent, resolvers.principal));
  route.post("/:taskId", async (c) => {
    const agent = c.get("agent");
    if (directory.find(agent)?.source !== "session") throw new PorticoError("not_allowed", ONLY_SESSIONS);
    const body = AnswerBody.parse(await readJson(c));
    const taskId = c.req.param("taskId");
    const refused = (why: "decided" | "no_request") =>
      log("warn", "approval_answer_refused", { task_id: clip(taskId, 64), agent, why });
    const state = desk.check(taskId, agent, body.nonce);
    if (state !== "open") {
      refused(state === "closed" ? "decided" : "no_request");
      if (state === "closed") throw new PorticoError("wrong_status", `Task ${taskId} was already decided.`);
      throw new PorticoError("not_allowed", NO_REQUEST);
    }
    let task: Task;
    try {
      // The note is a reason for Deny only, as on the hub page.
      task = body.decision === "approve" ? service.approveTask(taskId) : service.denyTask(taskId, body.note);
    } catch (err) {
      // Decided a moment ago, by another pop-up or the hub page, before the desk heard of it.
      if (err instanceof PorticoError && err.code === "wrong_status") refused("decided");
      throw err;
    }
    log("info", "approval_answered", { task_id: taskId, agent, decision: body.decision });
    return c.json({ task: taskView(task) });
  });
  route.onError(handleError);
  return route;
}
