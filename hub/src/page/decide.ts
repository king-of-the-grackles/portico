import type { Context } from "hono";
import { html } from "hono/html";
import { PorticoError } from "../core/errors";
import type { PorticoService } from "../core/service";
import type { Task } from "../core/types";
import { type Html, sendPage, STATUS_WORDS } from "./layout";

const BACK_LINK = html`<p><a href="/hub">Back to the waiting list</a></p>`;

function alreadyDecided(task: Task): Html {
  return html`<h1>This task is no longer waiting for approval.</h1>
<div class="card"><div class="meta">${task.fromAgent} → ${task.toAgent}</div><p>Status: <strong>${STATUS_WORDS[task.status]}</strong>${task.reason && (task.status === "denied" || task.status === "expired") ? html` (${task.reason})` : ""}</p></div>
<p class="meta">Nothing was changed.</p>`;
}

/**
 * Approves or denies a task from the hub page and shows what happened. A post for a task that is already decided
 * shows the "no longer waiting" page and changes nothing.
 */
export function decideTask(
  c: Context,
  service: PorticoService,
  taskId: string,
  action: "approve" | "deny",
  note: string | undefined,
): Response | Promise<Response> {
  const withNav = { nav: true };
  try {
    if (action === "approve") {
      const task = service.approveTask(taskId);
      return sendPage(c, 200, "Approved", html`<h1>Approved.</h1><p>The task is queued for <strong>${task.toAgent}</strong>.</p>${BACK_LINK}`, withNav);
    }
    const task = service.denyTask(taskId, note);
    return sendPage(c, 200, "Denied", html`<h1>Denied.</h1><p>The outcome goes back to <strong>${task.fromAgent}</strong>.</p>${BACK_LINK}`, withNav);
  } catch (err) {
    if (err instanceof PorticoError) {
      const task = service.findTask(taskId);
      if (err.code === "wrong_status" && task) return sendPage(c, 200, "Already decided", alreadyDecided(task), withNav);
      if (err.code === "not_found") return sendPage(c, 404, "Not found", html`<h1>No such task.</h1>`, withNav);
      if (err.code === "too_large") {
        return sendPage(c, 413, "Note too long", html`<h1>The note is too long.</h1><p class="meta">Nothing was changed.</p>`, withNav);
      }
    }
    throw err;
  }
}
