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
import { InboxWaits } from "./core/inbox-waits";
import type { Core } from "./core/core";
import { Messages } from "./core/messages";
import { People } from "./core/people";
import { Presence } from "./core/presence";
import { Settings } from "./core/settings";
import { Tasks } from "./core/tasks";
import type { Notice, PorticoConfig } from "./core/types";
import { Desk } from "./desk";
import { errorName, log } from "./log";

export interface PorticoOptions {
  db: Database;
  now?: () => Date;
  newId?: () => string;
  /** Both streams' heartbeat, for tests. */
  heartbeatMs?: number;
  /** The pop-up nonces' random source, for tests. */
  newNonce?: () => string;
  /** Tests observe notices here. */
  onNotice?: (notice: Notice) => void;
}

export interface Portico extends Core {
  app: Hono;
  /** check_inbox calls waiting for something to pick up. */
  inboxWaits: InboxWaits;
  /** Run every minute: expiries. */
  sweepMinute(): void;
  /** Run every day: history, stale sessions, expired sign-ins and links. */
  sweepDaily(): void;
}

const logInfo = (msg: string, fields: Record<string, unknown>) => log("info", msg, fields);

/** Wires every piece of Portico together. Used by startServer and by the tests. */
export function createPortico(config: PorticoConfig, opts: PorticoOptions): Portico {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const changes = new Changes();
  const settings = new Settings(db, config);
  const presence = new Presence();
  const agentStreams = new AgentStreams();
  const inboxWaits = new InboxWaits();
  const personStreams = new PersonStreams();
  changes.on((topics) => personStreams.broadcast(topics));

  // Its own IDs: activity rows never shift the IDs tests expect for everything else.
  const activity = new Activity({ db, changes, now });
  const people = new People({ db, changes, signingKey: config.signingKey, now, newId });
  const accounts = new Accounts({ db, people, now, newId });
  const computers = new Computers({ db, changes, activity, now, newId, log: logInfo });
  const agents: Agents = new Agents({
    db,
    computers,
    presence,
    changes,
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
  const desk = new Desk({ streams: agentStreams, now, newNonce: opts.newNonce, log: logInfo });
  agentStreams.onChange((change) => desk.streamChanged(change));

  // Notices are raised as writes commit; their effects (nudges, pop-ups) run in a microtask and never throw.
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
  const handleNotice = (notice: Notice) => {
    const m = notice.message;
    switch (notice.kind) {
      case "message_sent": {
        if (m.status === "pending") wake(m.toId);
        if (m.status !== "held") return;
        const sender = agents.get(m.fromId);
        const receiver = agents.get(m.toId);
        if (!sender || !receiver) return;
        desk.open({
          messageId: m.id,
          ownerId: receiver.ownerId,
          from: agents.display(sender),
          to: agents.display(receiver),
          subject: m.subject,
          text: m.text,
          expiresAt: m.expiresAt,
        });
        return;
      }
      case "message_decided":
        desk.close(m.id, m.status === "declined" ? "declined" : "allowed");
        if (m.status === "pending") wake(m.toId);
        if (m.status === "declined") wake(m.fromId);
        return;
      case "message_expired":
        // The sender hears about it on the next check, held or not.
        if (m.heldAt !== null) desk.close(m.id, "expired");
        wake(m.fromId);
        return;
      case "message_delivered":
        if (m.heldAt !== null) wake(m.fromId);
        return;
    }
  };

  const allowList = new AllowList(db);
  const messages = new Messages({
    db,
    agents,
    alwaysAllows: (agentId, senderId) => allowList.has(agentId, senderId),
    changes,
    waits: inboxWaits,
    now,
    newId,
    notify,
    log: logInfo,
  });
  const tasks = new Tasks({ db, now });
  const approvals = new Approvals({ db, agents, messages, people, allowList, changes, activity, now, notify, log: logInfo });

  const core: Core = {
    config,
    db,
    settings,
    changes,
    people,
    accounts,
    computers,
    agents,
    messages,
    approvals,
    allowList,
    activity,
    tasks,
    presence,
    agentStreams,
    personStreams,
    desk,
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

  return {
    ...core,
    app,
    inboxWaits,
    sweepMinute() {
      sweep("messages_expired", () => messages.expireDue().length);
      sweep("desk", () => desk.sweep());
      sweep("computers_minute", () => computers.sweepMinute());
    },
    sweepDaily() {
      sweep("history", () => messages.prune());
      sweep("runs", () => agents.pruneRuns());
      sweep("activity", () => activity.prune());
      sweep("web_sessions", () => accounts.sweep());
      sweep("people", () => people.sweep());
      sweep("computers", () => computers.sweep());
    },
  };
}
