import type { PermissionRequest } from "../core/permissions";
import type { BridgeConfig, Task } from "../core/types";
import { linkUrl, signLink } from "./links";
import type { PushMessage } from "./ntfy";

const PREVIEW_CHARS = 200;

/** The first 200 characters, with "…" when cut. The only task text a push carries (spec §11). */
export function previewText(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

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
    actions: [
      { action: "http", label: "Allow", url: link("approve"), method: "POST", clear: true },
      { action: "http", label: "Deny", url: link("deny"), method: "POST", clear: true },
      { action: "view", label: "Open", url: open },
    ],
  };
}
