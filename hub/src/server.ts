import type { Pusher } from "./approvals/ntfy";
import { unknownRuleNames } from "./core/rules";
import type { BridgeService } from "./core/service";
import type { BridgeConfig } from "./core/types";
import { openDb } from "./db";
import { createHub } from "./hub";
import { errorName, log } from "./log";

export interface RunningServer {
  port: number;
  service: BridgeService;
  stop(): void;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function startServer(config: BridgeConfig, opts: { port?: number; push?: Pusher } = {}): RunningServer {
  const db = openDb(config.dbPath);
  const hub = createHub(config, { db, push: opts.push });
  const service: BridgeService = hub.service;
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: opts.port ?? config.port,
      fetch: hub.app.fetch,
      maxRequestBodySize: config.limits.maxTextKb * 1024 * 4,
      // Above the stream heartbeat (25 s), so quiet live streams aren't cut. Bun's default is 10 s.
      idleTimeout: 60,
    });
  } catch (err) {
    // E.g. the port is in use: release the database before the error reaches the CLI.
    db.close();
    throw err;
  }

  const expireSweep = () => {
    try {
      const expired = service.expireDue();
      if (expired.length > 0) log("info", "tasks_expired", { count: expired.length });
      hub.relay.sweep();
    } catch (err) {
      log("error", "expiry_sweep_failed", { error: errorName(err) });
    }
  };
  const historySweep = () => {
    try {
      const deleted = service.deleteOldHistory();
      if (deleted.tasks > 0 || deleted.events > 0) log("info", "history_pruned", deleted);
    } catch (err) {
      log("error", "history_prune_failed", { error: errorName(err) });
    }
  };
  expireSweep();
  historySweep();
  const expireTimer = setInterval(expireSweep, MINUTE_MS);
  const historyTimer = setInterval(historySweep, DAY_MS);

  const port = server.port as number;
  log("info", "bridge_started", { port, agents: config.agents.length, public_url: config.publicUrl });
  if (!config.ntfy) {
    log("warn", "ntfy_disabled", { note: "BRIDGE_NTFY_TOPIC is not set; approvals happen on the hub page only" });
  }
  // Rules may name agents that join later; at startup, say which exact names nothing knows yet.
  const unknownNames = unknownRuleNames(config.rules, (name) => hub.directory.find(name) !== null);
  if (unknownNames.length > 0) log("warn", "rule_names_unknown", { names: unknownNames });
  const shadowed = hub.network
    .listAssistants()
    .map((assistant) => assistant.name)
    .filter((name) => config.agents.some((agent) => agent.name === name));
  if (shadowed.length > 0) log("warn", "assistant_name_conflict", { names: shadowed });

  return {
    port,
    service,
    stop() {
      clearInterval(expireTimer);
      clearInterval(historyTimer);
      server.stop(true);
      db.close();
    },
  };
}
