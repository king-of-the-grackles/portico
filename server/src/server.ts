import type { HostedConfig } from "./config";
import type { PorticoConfig } from "./core/types";
import { MainHosted, readMain } from "./hosted/main";
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
  hosted: Hosted | MainHosted;
  stop(): void;
}

/** How often closed workspaces are opened for their expiries. */
const CLOSED_SWEEP_MS = 15 * MINUTE_MS;

/** Hosted Portico: one server routing each request to its workspace by host. */
export function startHosted(config: HostedConfig, opts: { port?: number } = {}): RunningHosted {
  // One database once the data folder has one; until then, a database per workspace.
  const hosted = readMain(config) ? new MainHosted(config) : new Hosted(config);
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
  if (hosted instanceof MainHosted) log("info", "portico_hosted_started", { port, domain: config.domain, one_database: true });
  else log("info", "portico_hosted_started", { port, domain: config.domain, workspaces: hosted.control.all().length });
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

/**
 * Holds the address without opening any database: the health check answers, and everything else is told to come back
 * shortly. For work on the data folder that nothing may write during, such as moving to one database: agents and
 * browsers retry, and what the folder holds stays exactly as the release before left it.
 */
export function startHold(port: number): { port: number; stop(): void } {
  const server = Bun.serve({
    port,
    fetch: (request) => {
      if (new URL(request.url).pathname === "/healthz") return Response.json({ ok: true });
      return Response.json(
        { error: "unavailable", message: "Portico is being moved and is back in a few minutes." },
        { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } },
      );
    },
  });
  log("info", "portico_holding", { port: server.port });
  return { port: server.port as number, stop: () => server.stop(true) };
}
