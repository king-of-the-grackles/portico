import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { buildApp } from "./app";
import { ApprovalDesk } from "./approvals/desk";
import { Directory } from "./core/directory";
import { NetworkService } from "./core/network";
import { Presence } from "./core/presence";
import { PorticoService } from "./core/service";
import { SessionRegistry } from "./core/sessions";
import type { Notice, PorticoConfig } from "./core/types";
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
  /** The approval nonces' random source, for tests. */
  newNonce?: () => string;
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
  service: PorticoService;
  streams: StreamHub;
  /** Open approval requests, and who holds them on each machine. */
  desk: ApprovalDesk;
  app: Hono;
}

/** The most waiting tasks whose requests a restart re-opens. */
const RESTORE_LIMIT = 500;

/** Wires every piece of the hub together. Used by startServer and by the tests. */
export function createHub(config: PorticoConfig, opts: HubOptions): Hub {
  const store = new Store(opts.db);
  const network = new NetworkStore(opts.db);
  const streams = new StreamHub();
  const desk = new ApprovalDesk({
    streams,
    publicUrl: config.publicUrl,
    now: opts.now,
    newNonce: opts.newNonce,
    log: (msg, fields) => log("info", msg, fields),
  });
  streams.onChange((change) => desk.streamChanged(change));
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
  const notify = makeNotifier({
    store,
    directory,
    streams,
    approvalNeeded: (task) => desk.open(task),
    approvalDecided: (task, outcome) => desk.close(task.id, outcome),
  });
  const service = new PorticoService({
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
    approvalInfo: (task) => desk.info(task),
  });
  // Requests live in memory: after a restart, tasks still waiting pop up again as sessions reconnect.
  const waiting = store.listTasks({ status: "waiting_approval", limit: RESTORE_LIMIT, oldestFirst: true });
  for (const task of waiting) desk.open(task);
  if (waiting.length > 0) log("info", "approval_requests_restored", { count: waiting.length });
  const app = buildApp({
    service,
    config,
    directory,
    networkService,
    resolvers,
    presence,
    sessions,
    streams,
    desk,
    now: opts.now ?? (() => new Date()),
    heartbeatMs: opts.heartbeatMs,
  });
  return { store, network, networkService, directory, resolvers, presence, sessions, service, streams, desk, app };
}
