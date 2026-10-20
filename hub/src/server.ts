import { buildApp } from "./app";
import { BridgeService } from "./core/service";
import type { BridgeConfig, Notice } from "./core/types";
import { openDb, Store } from "./db";
import { log } from "./log";

export interface RunningServer {
  port: number;
  service: BridgeService;
  stop(): void;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function startServer(
  config: BridgeConfig,
  opts: { port?: number; notify?: (notice: Notice) => void } = {},
): RunningServer {
  const db = openDb(config.dbPath);
  const service = new BridgeService({
    store: new Store(db),
    config,
    notify: opts.notify,
    log: (msg, fields) => log("info", msg, fields),
  });
  const server = Bun.serve({
    port: opts.port ?? config.port,
    fetch: buildApp(service, config).fetch,
    maxRequestBodySize: config.limits.maxTextKb * 1024 * 4,
  });

  const expireSweep = () => {
    try {
      const expired = service.expireDue();
      if (expired.length > 0) log("info", "tasks_expired", { count: expired.length });
    } catch (err) {
      log("error", "expiry_sweep_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };
  const historySweep = () => {
    try {
      const deleted = service.deleteOldHistory();
      if (deleted.tasks > 0 || deleted.events > 0) log("info", "history_pruned", deleted);
    } catch (err) {
      log("error", "history_prune_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };
  expireSweep();
  historySweep();
  const expireTimer = setInterval(expireSweep, MINUTE_MS);
  const historyTimer = setInterval(historySweep, DAY_MS);

  const port = server.port as number;
  log("info", "bridge_started", { port, agents: config.agents.length, public_url: config.publicUrl });

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
