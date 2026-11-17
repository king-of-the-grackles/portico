import type { HostedConfig } from "./config";
import type { PorticoConfig } from "./core/types";
import { Hosted } from "./hosted/router";
import { LIMITS, MAX_BODY_BYTES } from "./core/limits";
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
  const db = openDb(config.dbPath, (msg, fields) => log("info", msg, fields));
  const portico = createPortico(config, { db });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: opts.port ?? config.port,
      fetch: portico.app.fetch,
      // A backstop above jsonBodyLimit. With files in the data folder, uploads come through Portico, so the backstop
      // rises to the file limit and every route but /files keeps the old one (see buildApp).
      maxRequestBodySize: portico.files.takesUploads ? LIMITS.maxFileMb * 1024 * 1024 + MAX_BODY_BYTES : MAX_BODY_BYTES * 2,
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

export interface RunningHosted {
  port: number;
  hosted: Hosted;
  stop(): void;
}

/** How often closed workspaces are opened for their expiries. */
const CLOSED_SWEEP_MS = 15 * MINUTE_MS;

/** Hosted Portico: one server routing each request to its workspace by host. */
export function startHosted(config: HostedConfig, opts: { port?: number } = {}): RunningHosted {
  const hosted = new Hosted(config);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: opts.port ?? config.port,
      fetch: hosted.fetch,
      maxRequestBodySize: hosted.takesUploads ? LIMITS.maxFileMb * 1024 * 1024 + MAX_BODY_BYTES : MAX_BODY_BYTES * 2,
      idleTimeout: 60,
    });
  } catch (err) {
    hosted.stop();
    throw err;
  }
  void hosted.sweepAll(true);
  const minuteTimer = setInterval(() => hosted.sweepMinute(), MINUTE_MS);
  const closedTimer = setInterval(() => void hosted.sweepAll(), CLOSED_SWEEP_MS);
  const dailyTimer = setInterval(() => void hosted.sweepAll(true), DAY_MS);
  const port = server.port as number;
  log("info", "portico_hosted_started", { port, domain: config.domain, workspaces: hosted.control.all().length });
  return {
    port,
    hosted,
    stop() {
      clearInterval(minuteTimer);
      clearInterval(closedTimer);
      clearInterval(dailyTimer);
      server.stop(true);
      hosted.stop();
    },
  };
}
