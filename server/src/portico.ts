import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { helloFor, AgentStreams } from "./agent-api/stream";
import { PersonStreams } from "./api/events";
import { buildApp } from "./app";
import { Accounts } from "./core/accounts";
import { Activity } from "./core/activity";
import { Agents } from "./core/agents";
import { AllowList, Approvals } from "./core/approvals";
import { Changes } from "./core/changes";
import { Computers } from "./core/computers";
import { Content } from "./core/content";
import { type AccountCheck, accountFrom, Descope } from "./core/descope";
import { EventSubscriptions } from "./core/events";
import { type FileStore, fileStoreFor } from "./core/file-store";
import { Files } from "./core/files";
import { InboxWaits } from "./core/inbox-waits";
import type { Core } from "./core/core";
import { ShareMail } from "./core/mail";
import { Messages } from "./core/messages";
import { People } from "./core/people";
import { Presence } from "./core/presence";
import { Settings } from "./core/settings";
import { Shares } from "./core/shares";
import { Tasks } from "./core/tasks";
import type { AccountSignIn, Message, Notice, PorticoConfig } from "./core/types";
import { WakeUrls } from "./core/wake-urls";
import { Workspaces } from "./core/workspaces";
import { safePost, type WebhookPost } from "./core/webhooks";
import { errorName, log } from "./log";

export interface PorticoOptions {
  /** The directory database, open. Each workspace's content database is opened from the data folder as it is needed. */
  db: Database;
  /** How long a workspace's content database stays open with nothing using it. */
  contentIdleMs?: number;
  now?: () => Date;
  newId?: () => string;
  /** Both streams' heartbeat, for tests. */
  heartbeatMs?: number;
  /** Tests observe notices here. */
  onNotice?: (notice: Notice) => void;
  /** Where wake URLs and event callbacks are posted; tests pass a fake. */
  webhookPost?: WebhookPost;
  /** Where share emails are posted; tests pass a fake. */
  mailPost?: WebhookPost;
  /** Where files' bytes live; by default the configured bucket, or the data folder. */
  fileStore?: FileStore;
  /**
   * Who a sign-in token belongs to, for tests: with one, people sign in with an outside account, as with
   * PORTICO_DESCOPE_PROJECT_ID. By default Descope checks the token when the project ID is set.
   */
  accountCheck?: AccountCheck;
  /** When webhook retries run; tests run them by hand. */
  schedule?: (fn: () => void, ms: number) => void;
}

export interface Portico extends Core {
  app: Hono;
  /** check_inbox calls waiting for something to pick up. */
  inboxWaits: InboxWaits;
  /** Run every minute: expiries. */
  sweepMinute(): void;
  /** Run every day: history, stale sessions, expired sign-ins and links. */
  sweepDaily(): void;
  /** Deletes files no message carries. Part of the minute sweep; tests await it. */
  sweepFiles(): Promise<number>;
  /**
   * Removes deleted workspaces whose history has emptied: the directory row, then the content database, the files and
   * the folder. Also folders a crash left with no workspace. Part of the daily sweep; tests await it.
   */
  sweepArchived(): Promise<number>;
  /** Closes every workspace's content database: the server is stopping. The directory is the caller's to close. */
  close(): void;
}

const logInfo = (msg: string, fields: Record<string, unknown>) => log("info", msg, fields);

/** Wires every piece of Portico together. Used by startServer and by the tests. */
export function createPortico(config: PorticoConfig, opts: PorticoOptions): Portico {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const changes = new Changes();
  // Message content never lives in the directory: each workspace has a database of its own, in memory when the
  // directory is (tests).
  const content = new Content({
    directory: db,
    dataDir: config.dataDir,
    memory: config.dbPath === ":memory:",
    idleMs: opts.contentIdleMs,
    now,
    log: logInfo,
  });
  const settings = new Settings(db, config);
  const presence = new Presence();
  const agentStreams = new AgentStreams();
  const inboxWaits = new InboxWaits();
  const personStreams = new PersonStreams();
  changes.on((topics) => personStreams.broadcast(topics));

  // Two ways to sign in, one Portico after that: an outside account (Descope) where a project is configured, otherwise
  // this server's own passwords, passkeys, setup link and invites.
  const check = opts.accountCheck ?? (config.descopeProjectId ? new Descope(config.descopeProjectId, { now }) : null);

  // Its own IDs: activity rows never shift the IDs tests expect for everything else.
  const activity = new Activity({ db, changes, now });
  const people = new People({ db, changes, content, signingKey: config.signingKey, signInByName: check === null, now, newId });
  const accounts = new Accounts({ db, people, now, newId });
  const workspaces = new Workspaces({ db, changes, now, newId, log: logInfo });
  const computers = new Computers({ db, changes, activity, content, now, newId, log: logInfo });
  const agents: Agents = new Agents({
    db,
    computers,
    presence,
    changes,
    workspaces,
    content,
    activity,
    now,
    newId,
    log: logInfo,
    isConnected: (id) => agentStreams.isConnected(id),
    liveRuns: (id) => agentStreams.liveRuns(id),
    isRunLive: (runId) => agentStreams.isRunConnected(runId),
    canWake: (id) => agentStreams.canWake(id),
    disconnect: (ids) => {
      agentStreams.closeAll(ids);
      inboxWaits.wake(...ids);
    },
    renamed: (agent) => agentStreams.sendAll(agent.id, "renamed", { ...helloFor(agents, agent) }),
  });
  const webhookPost = opts.webhookPost ?? safePost({ allowPrivate: config.webhooksAllowPrivate });
  const hooks = { db, post: webhookPost, changes, allowPrivate: config.webhooksAllowPrivate, now, schedule: opts.schedule, log: logInfo };
  const wakeUrls = new WakeUrls({ ...hooks, activity });
  const events = new EventSubscriptions(hooks);

  // Notices are raised as writes commit; their effects (nudges, wake URLs) run in a microtask and never throw.
  const notify = (notice: Notice) => {
    opts.onNotice?.(notice);
    queueMicrotask(() => {
      try {
        handleNotice(notice);
      } catch (err) {
        log("error", "notice_failed", { kind: notice.kind, error: errorName(err) });
      }
    });
  };
  // "The inbox has something": a session's stream gets a nudge (a Codex conversation only when its bridge can wake
  // it), and an app's or connector's waiting check_inbox wakes.
  const wake = (agentId: string) => {
    const agent = agents.get(agentId);
    if (!agent) return;
    if (agents.isPush(agent) || agentStreams.canWake(agent.id)) agentStreams.nudge(agent.id);
    inboxWaits.wake(agent.id);
  };
  // A message is waiting for its receiver: an app agent with a wake URL or an event subscription is woken through it.
  // Only messages: outcomes of sent messages wait for the next check.
  const wakeApp = (m: Message) => {
    if (!wakeUrls.has(m.toId) && !events.has(m.toId)) return;
    const receiver = agents.get(m.toId);
    const sender = agents.get(m.fromId);
    if (!receiver || !sender) return;
    const waiting = messages.unreadCount(receiver.id);
    const info = { agentName: agents.display(receiver), messageId: m.id, from: agents.nameFor(sender, receiver.ownerId), waiting };
    wakeUrls.kick(receiver.id, { ...info, lastCheckIn: presence.lastCheckIn(receiver.id) });
    events.deliver(receiver.id, info);
  };
  const handleNotice = (notice: Notice) => {
    const m = notice.message;
    switch (notice.kind) {
      case "message_sent": {
        if (m.status === "pending") {
          wake(m.toId);
          wakeApp(m);
        }
        return;
      }
      case "message_decided":
        if (m.status === "declined") {
          files.release(m).catch((err) => log("error", "file_release_failed", { message_id: m.id, error: errorName(err) }));
        }
        if (m.status === "pending") {
          wake(m.toId);
          wakeApp(m);
        }
        if (m.status === "declined") wake(m.fromId);
        return;
      case "message_expired":
        // The sender hears about it on the next check, held or not.
        wake(m.fromId);
        return;
      case "message_delivered":
        if (m.heldAt !== null) wake(m.fromId);
        return;
    }
  };

  const allowList = new AllowList(db);
  const files: Files = new Files({
    db,
    content,
    store: opts.fileStore ?? fileStoreFor(config),
    agents,
    publicUrl: () => settings.publicUrl(),
    signingKey: config.signingKey,
    now,
    newId,
    log: logInfo,
  });
  const messages: Messages = new Messages({
    content,
    agents,
    workspaces,
    alwaysAllows: (agentId, senderId) => allowList.has(agentId, senderId),
    changes,
    waits: inboxWaits,
    files,
    now,
    newId,
    notify,
    log: logInfo,
  });
  const tasks = new Tasks({ content, now });
  const mail = new ShareMail({
    db,
    config: config.mail,
    signingKey: config.signingKey,
    publicUrl: () => settings.publicUrl(),
    post: opts.mailPost ?? safePost({ timeoutMs: 10_000 }),
    now,
    newId,
    log: logInfo,
  });
  // What an agent asks about a workspace is answered only in a signed-in browser.
  const shares = new Shares({ db, workspaces, agents, people, changes, signingKey: config.signingKey, now, newId, log: logInfo });
  const approvals = new Approvals({ agents, workspaces, messages, people, allowList, changes, activity, now, notify, log: logInfo });

  const accountSignIn: AccountSignIn | null = check
    ? { projectId: config.descopeProjectId ?? "", account: (token) => accountFrom(check, token) }
    : null;
  // Signing in makes each account, so there is no setup link to open first.
  if (accountSignIn && !settings.setupDone()) settings.set("setup_done_at", now().toISOString());

  const core: Core = {
    config,
    db,
    content,
    settings,
    changes,
    people,
    accounts,
    workspaces,
    shares,
    mail,
    computers,
    agents,
    messages,
    files,
    approvals,
    allowList,
    activity,
    tasks,
    presence,
    agentStreams,
    personStreams,
    wakeUrls,
    events,
    accountSignIn,
    now,
    newId,
  };
  const app = buildApp(core, { heartbeatMs: opts.heartbeatMs });

  const sweep = (name: string, fn: () => unknown) => {
    try {
      const result = fn();
      if (typeof result === "number" ? result > 0 : result && Object.values(result).some((n) => n > 0)) {
        log("info", `${name}_swept`, typeof result === "number" ? { count: result } : (result as Record<string, unknown>));
      }
    } catch (err) {
      log("error", `${name}_sweep_failed`, { error: errorName(err) });
    }
  };

  const sweepFiles = async () => {
    try {
      const count = await files.sweep();
      if (count > 0) log("info", "files_swept", { count });
      return count;
    } catch (err) {
      log("error", "files_sweep_failed", { error: errorName(err) });
      return 0;
    }
  };

  const sweepArchived = async () => {
    let removed = 0;
    try {
      for (const id of workspaces.archived()) {
        if (!content.isEmpty(id)) continue;
        // The directory row goes first, then the content: a stop in between leaves a folder the next sweep finds.
        if (!workspaces.purge(id)) continue;
        await files.dropWorkspace(id);
        removed++;
      }
      for (const id of content.orphans()) {
        await files.dropWorkspace(id);
        log("info", "content_orphan_removed", { workspace_id: id });
        removed++;
      }
    } catch (err) {
      log("error", "archived_sweep_failed", { error: errorName(err) });
    }
    return removed;
  };

  return {
    ...core,
    app,
    inboxWaits,
    sweepFiles,
    sweepArchived,
    close: () => content.close(),
    sweepMinute() {
      // First: the sweeps below open the databases again only for as long as each needs one.
      sweep("content_idle", () => content.sweepIdle());
      void sweepFiles();
      sweep("messages_expired", () => messages.expireDue().length);
      sweep("event_subscriptions", () => events.sweep());
      sweep("computers_minute", () => computers.sweepMinute());
      sweep("oauth_clients", () => computers.sweepUnusedClients());
      sweep("sign_in_limits", () => accounts.sweepLimiters());
      sweep("share_requests", () => shares.sweepMinute());
    },
    sweepDaily() {
      sweep("history", () => messages.prune());
      void sweepArchived();
      sweep("runs", () => agents.pruneRuns());
      sweep("activity", () => activity.prune());
      sweep("web_sessions", () => accounts.sweep());
      sweep("people", () => people.sweep());
      sweep("computers", () => computers.sweep());
      sweep("shares", () => shares.sweep());
      sweep("share_mails", () => mail.sweep());
    },
  };
}
