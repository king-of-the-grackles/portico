import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { Directory } from "../core/directory";
import type { NetworkService } from "../core/network";
import type { Presence } from "../core/presence";
import type { PorticoService } from "../core/service";
import { type PorticoConfig, TASK_STATUSES, type TaskStatus } from "../core/types";
import { log } from "../log";
import type { AgentStreams } from "../ways-in/stream";
import { decideTask } from "./decide";
import { formBodyLimit, sendPage } from "./layout";
import { networkRoutes } from "./network";
import {
  hasSession,
  loginPath,
  LoginLimiter,
  newSessionToken,
  passwordMatches,
  safeNext,
  SESSION_COOKIE,
  SESSION_DAYS,
  sameOrigin,
} from "./session";
import { historyView, homeView, loginView, messagesView, taskDetailView } from "./views";

export interface PageDeps {
  service: PorticoService;
  directory: Directory;
  network: NetworkService;
  streams: AgentStreams;
  presence: Presence;
  config: PorticoConfig;
  now: () => Date;
}

const WAITING_SHOWN = 100;
const MESSAGES_SHOWN = 100;

const formText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function pageRoutes(deps: PageDeps): Hono {
  const { service, directory, network, streams, presence, config, now } = deps;
  const page = new Hono();
  const limiter = new LoginLimiter(now);

  page.use("*", formBodyLimit(config));
  page.use("*", async (c, next) => {
    if (c.req.method === "POST" && !sameOrigin(c, config)) {
      return sendPage(c, 403, "Not allowed", html`<h1>Form posts from other sites aren't accepted.</h1>`);
    }
    await next();
  });

  page.get("/login", (c) => {
    const next = safeNext(c.req.query("next"));
    if (hasSession(c, config, now())) return c.redirect(next, 303);
    return sendPage(c, 200, "Sign in", loginView(null, next));
  });

  page.post("/login", async (c) => {
    // Parse first; then check, compare and record with no await between, so parallel attempts cannot slip past the limiter.
    const form = await c.req.parseBody();
    const next = safeNext(formText(form.next));
    if (limiter.blocked()) {
      log("warn", "login_locked", {});
      return sendPage(c, 429, "Sign in", loginView("Too many failed attempts. Try again in 15 minutes.", next));
    }
    if (!passwordMatches(config, formText(form.password) ?? "")) {
      limiter.recordFailure();
      log("warn", "login_failed", {});
      return sendPage(c, 401, "Sign in", loginView("Wrong password.", next));
    }
    setCookie(c, SESSION_COOKIE, newSessionToken(config, now()), {
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/hub",
      maxAge: SESSION_DAYS * 86_400,
    });
    log("info", "login", {});
    return c.redirect(next, 303);
  });

  page.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/hub", secure: true });
    return c.redirect("/hub/login", 303);
  });

  // Everything registered below needs a session.
  page.use("*", async (c, next) => {
    if (hasSession(c, config, now())) return next();
    if (c.req.method === "GET" || c.req.method === "HEAD") return c.redirect(loginPath(c.req.url), 303);
    return sendPage(c, 403, "Signed out", html`<h1>Signed out.</h1><p><a href="/hub/login">Sign in</a> and try again.</p>`);
  });

  page.get("/", (c) => {
    // One more than shown, to know whether to say that more are waiting.
    const rows = service.listTasks({ status: "waiting_approval", limit: WAITING_SHOWN + 1, oldestFirst: true });
    const waiting = rows.slice(0, WAITING_SHOWN).map((task) => ({ task, chain: service.chainOf(task) }));
    const entries = directory.entries();
    return sendPage(c, 200, "Waiting", homeView(waiting, entries, rows.length > WAITING_SHOWN), { nav: true });
  });

  page.route("/network", networkRoutes({ network, presence, streams, config }));

  page.get("/history", (c) => {
    const agentParam = c.req.query("agent");
    const statusParam = c.req.query("status");
    const agent = config.agents.some((a) => a.name === agentParam) ? agentParam : undefined;
    const status = TASK_STATUSES.find((s) => s === statusParam) as TaskStatus | undefined;
    const tasks = service.listTasks({ agent, status, limit: 100 });
    const events = service.listEvents({ agent, limit: 50 });
    const names = config.agents.map((a) => a.name);
    return sendPage(c, 200, "History", historyView(tasks, events, { agent, status }, names), { nav: true });
  });

  page.get("/messages", (c) => {
    // One more than shown, to know whether older ones exist.
    const rows = service.listMessages({ before: c.req.query("before") || undefined, limit: MESSAGES_SHOWN + 1 });
    const shown = rows.slice(0, MESSAGES_SHOWN);
    return sendPage(
      c,
      200,
      "Messages",
      messagesView(shown, {
        more: rows.length > MESSAGES_SHOWN,
        paged: Boolean(c.req.query("before")),
        now: now().toISOString(),
        historyDays: config.limits.historyDays,
      }),
      { nav: true },
    );
  });

  page.get("/tasks/:id", (c) => {
    const task = service.findTask(c.req.param("id"));
    if (!task) return sendPage(c, 404, "Not found", html`<h1>No such task.</h1>`, { nav: true });
    return sendPage(c, 200, "Task", taskDetailView(task, service.chainOf(task)), { nav: true });
  });

  page.post("/tasks/:id/approve", (c) => decideTask(c, service, c.req.param("id"), "approve", undefined));

  page.post("/tasks/:id/deny", async (c) => {
    const form = await c.req.parseBody();
    return decideTask(c, service, c.req.param("id"), "deny", formText(form.note));
  });

  return page;
}
