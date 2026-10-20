import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { buildApp } from "./app";
import { permissionPush } from "./approvals/messages";
import { makePusher, type Pusher } from "./approvals/ntfy";
import { PermissionRelay, type PermissionRequest } from "./core/permissions";
import { BridgeService } from "./core/service";
import type { BridgeConfig, Notice } from "./core/types";
import { Store } from "./db";
import { errorName, log } from "./log";
import { makeNotifier } from "./notifier";
import { StreamHub } from "./ways-in/stream";

export interface HubOptions {
  db: Database;
  now?: () => Date;
  newId?: () => string;
  /** Defaults to an ntfy pusher built from config.ntfy. */
  push?: Pusher;
  heartbeatMs?: number;
  /** Tests observe notices here. */
  onNotice?: (notice: Notice) => void;
}

export interface Hub {
  store: Store;
  service: BridgeService;
  streams: StreamHub;
  relay: PermissionRelay;
  push: Pusher;
  app: Hono;
}

/** Wires every piece of the hub together. Used by startServer and by the tests. */
export function createHub(config: BridgeConfig, opts: HubOptions): Hub {
  const store = new Store(opts.db);
  const streams = new StreamHub();
  const push = opts.push ?? makePusher(config.ntfy);
  const notify = makeNotifier({ store, config, streams, push });
  const service = new BridgeService({
    store,
    config,
    now: opts.now,
    newId: opts.newId,
    notify: (notice) => {
      opts.onNotice?.(notice);
      notify(notice);
    },
    log: (msg, fields) => log("info", msg, fields),
  });
  const relay = new PermissionRelay({
    maxTextKb: config.limits.maxTextKb,
    now: opts.now,
    deliver: (agent, requestId, behavior) => streams.sendPermissionAnswer(agent, requestId, behavior),
  });
  const onPermissionRequest = (request: PermissionRequest) => {
    const fields = { agent: request.agent, request_id: request.requestId };
    void push(permissionPush(config, request))
      .then((ok) => {
        // With ntfy off nothing was attempted (startup already logged ntfy_disabled).
        if (ok || config.ntfy) {
          log(ok ? "info" : "warn", ok ? "permission_pushed" : "permission_push_failed", fields);
        }
      })
      .catch((err) => log("error", "permission_push_failed", { ...fields, error: errorName(err) }));
  };
  const app = buildApp({
    service,
    config,
    streams,
    relay,
    onPermissionRequest,
    now: opts.now ?? (() => new Date()),
    heartbeatMs: opts.heartbeatMs,
  });
  return { store, service, streams, relay, push, app };
}
