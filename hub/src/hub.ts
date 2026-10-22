import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { buildApp } from "./app";
import { Directory } from "./core/directory";
import { NetworkService } from "./core/network";
import { Presence } from "./core/presence";
import { BridgeService } from "./core/service";
import { SessionRegistry } from "./core/sessions";
import type { BridgeConfig, Notice } from "./core/types";
import { Store } from "./db";
import { log } from "./log";
import { NetworkStore } from "./network-store";
import { makeNotifier } from "./notifier";
import { type AgentResolver, makeResolvers, type PrincipalResolver } from "./ways-in/auth";
import { StreamHub } from "./ways-in/stream";

export interface HubOptions {
  db: Database;
  now?: () => Date;
  newId?: () => string;
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
  const notify = makeNotifier({ store, directory, streams });
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
  const app = buildApp({
    service,
    config,
    directory,
    networkService,
    resolvers,
    presence,
    sessions,
    streams,
    now: opts.now ?? (() => new Date()),
    heartbeatMs: opts.heartbeatMs,
  });
  return { store, network, networkService, directory, resolvers, presence, sessions, service, streams, app };
}
