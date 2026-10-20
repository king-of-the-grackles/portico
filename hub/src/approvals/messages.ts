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
