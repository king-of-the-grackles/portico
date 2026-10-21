import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { buildApp } from "./app";
import { permissionAnsweredPush, permissionPush } from "./approvals/messages";
import { makePusher, type Pusher } from "./approvals/ntfy";
import { Directory } from "./core/directory";
import { NetworkService } from "./core/network";
import { PermissionRelay, type PermissionRequest } from "./core/permissions";
import { Presence } from "./core/presence";
import { BridgeService } from "./core/service";
import { SessionRegistry } from "./core/sessions";
import type { BridgeConfig, Notice } from "./core/types";
import { Store } from "./db";
import { errorName, log } from "./log";
import { NetworkStore } from "./network-store";
import { makeNotifier } from "./notifier";
import { type AgentResolver, makeResolvers, type PrincipalResolver } from "./ways-in/auth";
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
  network: NetworkStore;
  networkService: NetworkService;
  directory: Directory;
  resolvers: { principal: PrincipalResolver; agent: AgentResolver };
  /** Live status reports and check-ins, in memory. */
  presence: Presence;
  sessions: SessionRegistry;
  service: BridgeService;
  streams: StreamHub;
  relay: PermissionRelay;
  push: Pusher;
  app: Hono;
}

/** Wires every piece of the hub together. Used by startServer and by the tests. */
export function createHub(config: BridgeConfig, opts: HubOptions): Hub {
  const store = new Store(opts.db);
  const network = new NetworkStore(opts.db);
  const streams = new StreamHub();
  const presence = new Presence();
  const isConnected = (address: string) => streams.isConnected(address);
  const directory = new Directory({ config, network, isConnected, presence, now: opts.now });
  const sessions = new SessionRegistry({
    network,
    store,
    isConnected,
    now: opts.now,
    newId: opts.newId,
    log: (msg, fields) => log("info", msg, fields),
  });
  const networkService = new NetworkService({
    store: network,
    config,
    now: opts.now,
    newId: opts.newId,
    log: (msg, fields) => log("info", msg, fields),
  });
  const resolvers = makeResolvers(config, network, { now: opts.now });
  const push = opts.push ?? makePusher(config.ntfy);
  const notify = makeNotifier({ store, config, directory, streams, push });
  const service = new BridgeService({
    store,
    config,
    directory,
    presence,
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
    newId: opts.newId,
    onAnswered: (request, behavior) => {
      const fields = { agent: request.agent, request_id: request.requestId };
      void push(permissionAnsweredPush(request, behavior))
        .then((ok) => {
          if (ok || config.ntfy) {
            log(ok ? "info" : "warn", ok ? "permission_push_updated" : "permission_push_update_failed", fields);
          }
        })
        .catch((err) => log("error", "permission_push_update_failed", { ...fields, error: errorName(err) }));
    },
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
    directory,
    networkService,
    resolvers,
    presence,
    sessions,
    streams,
    relay,
    push,
    onPermissionRequest,
    now: opts.now ?? (() => new Date()),
    heartbeatMs: opts.heartbeatMs,
  });
  return { store, network, networkService, directory, resolvers, presence, sessions, service, streams, relay, push, app };
}
