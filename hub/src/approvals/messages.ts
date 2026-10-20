import type { PermissionBehavior, PermissionRequest } from "../core/permissions";
import type { BridgeConfig, Task } from "../core/types";
import { linkUrl, signLink } from "./links";
import type { PushMessage } from "./ntfy";

const PREVIEW_CHARS = 200;

/** The first 200 characters, with "…" when cut. The only task text a push carries (spec §11). */
export function previewText(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

const taskSequenceId = (task: Task) => `task-${task.id}`;
const permissionSequenceId = (request: PermissionRequest) => `perm-${request.id}`;

export function approvalPush(config: BridgeConfig, task: Task): PushMessage {
  const link = (action: "approve" | "deny") =>
    linkUrl(
      config.publicUrl,
      signLink(config.signingSecret, { subject: "task", id: task.id, action, expiresAt: task.expiresAt }),
      action,
    );
  const open = `${config.publicUrl}/hub/tasks/${encodeURIComponent(task.id)}`;
  return {
    title: `${task.fromAgent} → ${task.toAgent}`,
    message: previewText(task.instructions) + (task.chainLength > 1 ? " (chained)" : ""),
    click: open,
    priority: 4,
    tags: ["inbox_tray"],
    sequenceId: taskSequenceId(task),
    actions: [
      { action: "http", label: "Approve", url: link("approve"), method: "POST", clear: true },
      { action: "http", label: "Deny", url: link("deny"), method: "POST", clear: true },
      { action: "view", label: "Open", url: open },
    ],
  };
}

export function permissionPush(config: BridgeConfig, request: PermissionRequest): PushMessage {
  const link = (action: "approve" | "deny") =>
    linkUrl(
      config.publicUrl,
      signLink(config.signingSecret, {
        subject: "permission",
        id: request.requestId,
        agent: request.agent,
        action,
        expiresAt: request.expiresAt,
      }),
      action,
    );
  const open = `${config.publicUrl}/hub`;
  const parts = [request.description, request.inputPreview].filter((part) => part.trim() !== "").map(previewText);
  return {
    title: `${request.agent} wants to use ${request.toolName}`,
    message: parts.join("\n\n") || request.toolName,
    click: open,
    priority: 4,
    tags: ["lock"],
    sequenceId: permissionSequenceId(request),
    actions: [
      { action: "http", label: "Allow", url: link("approve"), method: "POST", clear: true },
      { action: "http", label: "Deny", url: link("deny"), method: "POST", clear: true },
      { action: "view", label: "Open", url: open },
    ],
  };
}

/** Follow-up pushes replace the approval push (same sequence ID), so a tap shows a result and the buttons go away. */
function followUp(sequenceId: string, title: string, message: string, ok: boolean): PushMessage {
  return { title, message, priority: 3, tags: [ok ? "white_check_mark" : "x"], actions: [], sequenceId };
}

export function taskApprovedPush(task: Task): PushMessage {
  return followUp(taskSequenceId(task), `Approved: ${task.fromAgent} → ${task.toAgent}`, `Task queued for ${task.toAgent}.`, true);
}

export function taskDeniedPush(task: Task): PushMessage {
  return followUp(taskSequenceId(task), `Denied: ${task.fromAgent} → ${task.toAgent}`, "Task not sent.", false);
}

export function taskExpiredPush(task: Task): PushMessage {
  return followUp(taskSequenceId(task), `Expired: ${task.fromAgent} → ${task.toAgent}`, "No answer before the deadline.", false);
}

export function permissionAnsweredPush(request: PermissionRequest, behavior: PermissionBehavior): PushMessage {
  const allowed = behavior === "allow";
  return followUp(permissionSequenceId(request), `${allowed ? "Allowed" : "Denied"}: ${request.toolName}`, "Answered.", allowed);
}

/** What a tap on an old Approve / Deny button gets back: iOS can't remove the delivered push, so each tap answers. */
export function taskRepeatPush(task: Task): PushMessage {
  const approved = task.status === "queued" || task.status === "working" || task.status === "done" || task.status === "failed";
  const message = approved ? "Approved earlier." : task.status === "denied" ? "Denied earlier." : "Expired earlier.";
  return followUp(taskSequenceId(task), `Already decided: ${task.fromAgent} → ${task.toAgent}`, message, approved);
}

export function permissionRepeatPush(request: PermissionRequest): PushMessage {
  const allowed = request.answer === "allow";
  return followUp(permissionSequenceId(request), `Already answered: ${request.toolName}`, allowed ? "Allowed earlier." : "Denied earlier.", allowed);
}

/** The prompt is gone, so no sequence ID is known. */
export function permissionNoLongerWaitingPush(): PushMessage {
  return { title: "No longer waiting", message: "This prompt was answered or expired.", priority: 3, tags: ["x"], actions: [] };
}
