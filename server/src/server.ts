import type { PorticoConfig } from "./core/types";
import { MAX_BODY_BYTES } from "./core/limits";
import { openDb } from "./db";
import { log } from "./log";
import { createPortico, type Portico } from "./portico";

export interface RunningServer {
  port: number;
  portico: Portico;
  stop(): void;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export function startServer(config: PorticoConfig, opts: { port?: number } = {}): RunningServer {
  const db = openDb(config.dbPath);
  const portico = createPortico(config, { db });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: opts.port ?? config.port,
      fetch: portico.app.fetch,
      // A backstop above jsonBodyLimit.
      maxRequestBodySize: MAX_BODY_BYTES * 2,
      // Above the streams' heartbeat (25 s), so quiet live streams aren't cut. Bun's default is 10 s.
      idleTimeout: 60,
    });
  } catch (err) {
    // E.g. the port is in use: release the database before the error reaches the CLI.
    db.close();
    throw err;
  }

  portico.sweepMinute();
  portico.sweepDaily();
  const minuteTimer = setInterval(() => portico.sweepMinute(), MINUTE_MS);
  const dailyTimer = setInterval(() => portico.sweepDaily(), DAY_MS);

  const port = server.port as number;
  log("info", "portico_started", { port, public_url: portico.settings.publicUrl(), setup_done: portico.settings.setupDone() });

  return {
    port,
    portico,
    stop() {
      clearInterval(minuteTimer);
      clearInterval(dailyTimer);
      server.stop(true);
      db.close();
    },
  };
}
