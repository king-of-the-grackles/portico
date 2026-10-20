import { Hono } from "hono";
import type { Context } from "hono";
import { html } from "hono/html";
import { BridgeError } from "../core/errors";
import type { PermissionRelay, PermissionRequest } from "../core/permissions";
import type { BridgeService } from "../core/service";
import type { BridgeConfig, Task } from "../core/types";
import { errorName, log } from "../log";
import { formatTime, formBodyLimit, type Html, sendPage, STATUS_WORDS } from "../page/layout";
import { type LinkClaims, verifyLink } from "./links";
import { permissionNoLongerWaitingPush, permissionRepeatPush, taskRepeatPush } from "./messages";
import type { Pusher, PushMessage } from "./ntfy";

type Action = "approve" | "deny";

export interface ApprovalRouteDeps {
  service: BridgeService;
  relay: PermissionRelay;
  config: BridgeConfig;
  push: Pusher;
  now: () => Date;
}

const backLink = (nav: boolean): Html => (nav ? html`<p><a href="/hub">Back to the waiting list</a></p>` : html``);

function confirmTask(task: Task, action: Action): Html {
  return html`<h1>${action === "approve" ? "Approve this task?" : "Deny this task?"}</h1>
<div class="card"><div class="meta">${task.fromAgent} → ${task.toAgent}${task.chainLength > 1 ? " · chained" : ""} · expires ${formatTime(task.expiresAt)}</div>
<pre>${task.instructions}</pre>
<form method="post"><div class="actions">${
    action === "deny"
      ? html`<div class="grow"><label for="note">Note for the sender (optional)</label><textarea id="note" name="note"></textarea></div>`
      : ""
  }<button type="submit" class="${action === "approve" ? "primary" : "danger"}">${action === "approve" ? "Approve" : "Deny"}</button></div></form></div>`;
}

function alreadyDecided(task: Task): Html {
  return html`<h1>This task is no longer waiting for approval.</h1>
<div class="card"><div class="meta">${task.fromAgent} → ${task.toAgent}</div><p>Status: <strong>${STATUS_WORDS[task.status]}</strong>${task.reason && (task.status === "denied" || task.status === "expired") ? html` (${task.reason})` : ""}</p></div>
<p class="meta">Nothing was changed.</p>`;
}

function confirmPermission(request: PermissionRequest, action: Action): Html {
  return html`<h1>${request.agent} wants to use ${request.toolName}</h1>
<div class="card"><div class="meta">Expires ${formatTime(request.expiresAt)}</div>
${request.description ? html`<p>${request.description}</p>` : ""}${request.inputPreview ? html`<pre>${request.inputPreview}</pre>` : ""}
<form method="post"><div class="actions"><button type="submit" class="${action === "approve" ? "primary" : "danger"}">${action === "approve" ? "Allow" : "Deny"}</button></div></form></div>`;
}

const gonePermission = html`<h1>This permission prompt is no longer pending.</h1>
<p class="meta">Prompts are kept for an hour and don't survive a restart. The prompt in the terminal can still be answered.</p>`;

function alreadyAnswered(request: PermissionRequest): Html {
  return html`<h1>Already answered: ${request.answer === "allow" ? "allowed" : "denied"}.</h1><p class="meta">Nothing was changed.</p>`;
}

const invalidLink = html`<h1>This link is invalid or has expired.</h1><p class="meta">Nothing was changed.</p>`;

/** Approves or denies a task and shows what happened. Used by approval links and the hub page. */
export function decideTask(
  c: Context,
  service: BridgeService,
  taskId: string,
  action: Action,
  note: string | undefined,
  nav = false,
): Response | Promise<Response> {
  try {
    if (action === "approve") {
      const task = service.approveTask(taskId);
      return sendPage(c, 200, "Approved", html`<h1>Approved.</h1><p>The task is queued for <strong>${task.toAgent}</strong>.</p>${backLink(nav)}`, { nav });
    }
    const task = service.denyTask(taskId, note);
    return sendPage(c, 200, "Denied", html`<h1>Denied.</h1><p>The outcome goes back to <strong>${task.fromAgent}</strong>.</p>${backLink(nav)}`, { nav });
  } catch (err) {
    if (err instanceof BridgeError) {
      const task = service.findTask(taskId);
      if (err.code === "wrong_status" && task) return sendPage(c, 200, "Already decided", alreadyDecided(task), { nav });
      if (err.code === "not_found") return sendPage(c, 404, "Not found", html`<h1>No such task.</h1>`, { nav });
      if (err.code === "too_large") {
        return sendPage(c, 413, "Note too long", html`<h1>The note is too long.</h1><p class="meta">Nothing was changed.</p>`, { nav });
      }
    }
    throw err;
  }
}

/** Answers a relayed permission prompt and shows what happened. Used by permission links and the hub page. */
export function answerPermission(
  c: Context,
  relay: PermissionRelay,
  agent: string,
  requestId: string,
  action: Action,
  nav = false,
): Response | Promise<Response> {
  const behavior = action === "approve" ? "allow" : "deny";
  try {
    const request = relay.answer(agent, requestId, behavior);
    const where = request.delivered
      ? html`<p>The answer was sent to <strong>${agent}</strong>. If the prompt was already answered in the terminal, this answer is ignored.</p>`
      : html`<p><strong>${agent}</strong> isn't connected right now. The answer goes out on reconnect, within the hour.</p>`;
    return sendPage(c, 200, behavior === "allow" ? "Allowed" : "Denied", html`<h1>${behavior === "allow" ? "Allowed." : "Denied."}</h1>${where}${backLink(nav)}`, { nav });
  } catch (err) {
    if (err instanceof BridgeError && err.code === "not_found") return sendPage(c, 404, "No longer pending", gonePermission, { nav });
    const request = relay.get(agent, requestId);
    if (err instanceof BridgeError && err.code === "wrong_status" && request) {
      return sendPage(c, 200, "Already answered", alreadyAnswered(request), { nav });
    }
    throw err;
  }
}

/** `/approve/:token` and `/deny/:token`: a GET shows a confirm form, and only a POST acts (spec §11). */
export function approvalRoutes(deps: ApprovalRouteDeps): Hono {
  const { service, relay, config, push, now } = deps;
  const routes = new Hono();

  const claimsFor = (c: Context, action: Action): LinkClaims | null => {
    const claims = verifyLink(config.signingSecret, c.req.param("token") ?? "", now());
    return claims && claims.action === action ? claims : null;
  };

  /**
   * What a link that fails verification shows. A link signed for this action but past its expiry is told apart
   * from a tampered one: a permission prompt is gone by then (spec §9.5), and a task has moved on.
   */
  const unverifiedLink = (c: Context, action: Action): Response | Promise<Response> => {
    // Checked against the epoch, any expiry passes, so only the signature and the claims' shape count here.
    const old = verifyLink(config.signingSecret, c.req.param("token") ?? "", new Date(0));
    if (old && old.action === action) {
      if (old.subject === "permission") return sendPage(c, 404, "No longer pending", gonePermission);
      const task = service.findTask(old.id);
      // Still waiting means the sweep hasn't expired it yet; "no longer waiting" would be wrong, so it stays invalid.
      if (task && task.status !== "waiting_approval") return sendPage(c, 200, "Already decided", alreadyDecided(task));
    }
    return sendPage(c, 404, "Link not valid", invalidLink);
  };

  /** iOS keeps the old buttons, so a tap on a decided prompt gets a short push. Failures are logged, never thrown. */
  const pushRepeat = (kind: "approval" | "permission", message: PushMessage, fields: Record<string, string>) => {
    const name = kind === "approval" ? "approval_push_repeat" : "permission_push_repeat";
    void push(message)
      .then((ok) => {
        if (ok || config.ntfy) log(ok ? "info" : "warn", ok ? name : `${name}_failed`, fields);
      })
      .catch((err) => log("error", `${name}_failed`, { ...fields, error: errorName(err) }));
  };

  for (const action of ["approve", "deny"] as const) {
    routes.get(`/${action}/:token`, (c) => {
      const claims = claimsFor(c, action);
      if (!claims) return unverifiedLink(c, action);
      if (claims.subject === "task") {
        const task = service.findTask(claims.id);
        if (!task) return sendPage(c, 404, "Link not valid", invalidLink);
        if (task.status !== "waiting_approval") return sendPage(c, 200, "Already decided", alreadyDecided(task));
        return sendPage(c, 200, action === "approve" ? "Approve task" : "Deny task", confirmTask(task, action));
      }
      const request = relay.get(claims.agent!, claims.id);
      if (!request) return sendPage(c, 404, "No longer pending", gonePermission);
      if (request.answer) return sendPage(c, 200, "Already answered", alreadyAnswered(request));
      return sendPage(c, 200, "Permission prompt", confirmPermission(request, action));
    });

    routes.post(`/${action}/:token`, formBodyLimit(config), async (c) => {
      const claims = claimsFor(c, action);
      if (!claims) return unverifiedLink(c, action);
      log("info", "approval_link_used", { subject: claims.subject, action, id: claims.id });
      if (claims.subject === "permission") {
        const request = relay.get(claims.agent!, claims.id);
        if (!request) pushRepeat("permission", permissionNoLongerWaitingPush(), { agent: claims.agent! });
        else if (request.answer) {
          pushRepeat("permission", permissionRepeatPush(request), { agent: request.agent, request_id: request.requestId });
        }
        return answerPermission(c, relay, claims.agent!, claims.id, action);
      }
      const decided = service.findTask(claims.id);
      if (decided && decided.status !== "waiting_approval") pushRepeat("approval", taskRepeatPush(decided), { task_id: decided.id });
      const form = await c.req.parseBody();
      return decideTask(c, service, claims.id, action, typeof form.note === "string" ? form.note : undefined);
    });
  }

  return routes;
}
