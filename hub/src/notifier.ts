import { approvalPush, taskApprovedPush, taskDeniedPush, taskExpiredPush } from "./approvals/messages";
import type { Pusher } from "./approvals/ntfy";
import type { Directory } from "./core/directory";
import type { BridgeConfig, Notice } from "./core/types";
import type { Store } from "./db";
import { errorName, log } from "./log";
import type { StreamHub } from "./ways-in/stream";

export interface NotifierDeps {
  store: Store;
  config: BridgeConfig;
  directory: Directory;
  streams: StreamHub;
  push: Pusher;
}

/**
 * Turns service notices into stream nudges and approval pushes. The service raises notices inside its
 * synchronous transactions; this does its work in a microtask, after the transaction has committed or
 * rolled back. It never throws.
 */
export function makeNotifier(deps: NotifierDeps): (notice: Notice) => void {
  const { store, config, directory, streams, push } = deps;
  return (notice) => {
    queueMicrotask(() => {
      try {
        if (notice.kind === "message_queued") {
          // Re-read: the message may already be delivered (a pull at the same moment), or gone with a rollback.
          const message = store.getMessage(notice.message.id);
          if (message && message.deliveredAt === null && directory.isPush(message.toAgent)) streams.nudge(message.toAgent);
          return;
        }
        // A rolled-back transaction leaves no task, or one in a different state: then there's nothing to do.
        const task = store.getTask(notice.task.id);
        // A decision follow-up reports what already happened, so the task having moved on (say to working) doesn't matter.
        if (!task || (notice.kind !== "approval_decided" && task.status !== notice.task.status)) return;
        switch (notice.kind) {
          case "queued":
            if (directory.isPush(task.toAgent)) streams.nudge(task.toAgent);
            break;
          case "result_ready":
            if (directory.isPush(task.fromAgent)) streams.nudge(task.fromAgent);
            break;
          case "approval_needed":
            void push(approvalPush(config, task))
              .then((ok) => {
                // With ntfy off nothing was attempted (startup already logged ntfy_disabled).
                if (ok || config.ntfy) {
                  log(ok ? "info" : "warn", ok ? "approval_pushed" : "approval_push_failed", { task_id: task.id });
                }
              })
              .catch((err) => log("error", "approval_push_failed", { task_id: task.id, error: errorName(err) }));
            break;
          case "approval_decided": {
            const followUp = { approved: taskApprovedPush, denied: taskDeniedPush, expired: taskExpiredPush }[notice.outcome];
            void push(followUp(notice.task))
              .then((ok) => {
                if (ok || config.ntfy) {
                  log(ok ? "info" : "warn", ok ? "approval_push_updated" : "approval_push_update_failed", { task_id: task.id });
                }
              })
              .catch((err) => log("error", "approval_push_update_failed", { task_id: task.id, error: errorName(err) }));
            break;
          }
        }
      } catch (err) {
        log("error", "notify_failed", { kind: notice.kind, error: errorName(err) });
      }
    });
  };
}
