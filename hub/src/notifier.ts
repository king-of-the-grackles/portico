import { approvalPush } from "./approvals/messages";
import type { Pusher } from "./approvals/ntfy";
import { type BridgeConfig, isPushAgent, type Notice } from "./core/types";
import type { Store } from "./db";
import { errorName, log } from "./log";
import type { StreamHub } from "./ways-in/stream";

export interface NotifierDeps {
  store: Store;
  config: BridgeConfig;
  streams: StreamHub;
  push: Pusher;
}

/**
 * Turns service notices into stream nudges and approval pushes. The service raises notices inside its
 * synchronous transactions; this does its work in a microtask, after the transaction has committed or
 * rolled back. It never throws.
 */
export function makeNotifier(deps: NotifierDeps): (notice: Notice) => void {
  const { store, config, streams, push } = deps;
  return (notice) => {
    queueMicrotask(() => {
      try {
        // A rolled-back transaction leaves no task, or one in a different state: then there's nothing to do.
        const task = store.getTask(notice.task.id);
        if (!task || task.status !== notice.task.status) return;
        switch (notice.kind) {
          case "queued":
            if (isPushAgent(config, task.toAgent)) streams.nudge(task.toAgent);
            break;
          case "result_ready":
            if (isPushAgent(config, task.fromAgent)) streams.nudge(task.fromAgent);
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
        }
      } catch (err) {
        log("error", "notify_failed", { kind: notice.kind, error: errorName(err) });
      }
    });
  };
}
