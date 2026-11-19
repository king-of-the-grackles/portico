import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { helloFor, AgentStreams } from "./agent-api/stream";
import { PersonStreams } from "./api/events";
import { buildApp } from "./app";
import { Accounts } from "./core/accounts";
import { Activity, type ActivityEntry } from "./core/activity";
import { Agents } from "./core/agents";
import { AllowList, Approvals, Contacts } from "./core/approvals";
import { AgentNotices } from "./core/notices";
import { recordWords } from "./core/record-words";
import { DAY_MS, MINUTE_MS } from "./core/limits";
import { Changes } from "./core/changes";
import { Computers } from "./core/computers";
import { consentWords, quote } from "./core/consent-words";
import { Consents } from "./core/consents";
import { Content } from "./core/content";
import { type AccountCheck, accountFrom, Descope } from "./core/descope";
import { EventSubscriptions } from "./core/events";
import { type FileStore, fileStoreFor } from "./core/file-store";
import { Files } from "./core/files";
import { InboxWaits } from "./core/inbox-waits";
import type { Core } from "./core/core";
import { LIMITS } from "./core/limits";
import { ShareMail } from "./core/mail";
import { Messages } from "./core/messages";
import { People } from "./core/people";
import { Presence } from "./core/presence";
import { Settings } from "./core/settings";
import { Shares } from "./core/shares";
import { Tasks } from "./core/tasks";
import type { AccountSignIn, Agent, Message, Notice, Person, PorticoConfig, Workspace } from "./core/types";
import { WakeUrls } from "./core/wake-urls";
import { type WorkspaceEvent, Workspaces } from "./core/workspaces";
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
  /** One line of a Portico's record, in Portico's own words, as one person reads it. Null for a kind the record doesn't show. */
  recordLine(entry: ActivityEntry, reader: Person, workspace: Workspace): string | null;
  /**
   * Emails each person what happened in the Porticos the person is in since the last such email: one email per person
   * and Portico, so several changes in a minute arrive together. Part of the minute sweep; tests await it.
   */
  sweepRecordMail(): Promise<number>;
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
        if (m.status === "held") {
          // The Portico's record says that a message was held, never what the message says.
          activity.record("portico_held", { agentId: m.toId, otherId: m.fromId, workspaceId: m.workspaceId, detail: { for: m.heldFor ?? "approval" } });
          mailHeld(m);
        }
        watchBurst(m);
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
      case "message_withdrawn":
        files.release(m).catch((err) => log("error", "file_release_failed", { message_id: m.id, error: errorName(err) }));
        wake(m.fromId);
        return;
      case "message_delivered":
        if (m.heldAt !== null) wake(m.fromId);
        return;
    }
  };

  const allowList = new AllowList(db);
  const contacts = new Contacts(db);
  const agentNotices = new AgentNotices(db, now);
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
    peopleAllowed: (personId, senderPersonId) => contacts.has(personId, senderPersonId),
    personName: (personId) => people.get(personId)?.name ?? "that agent's person",
    heldLink: (messageId) => `${settings.publicUrl()}/held/${messageId}`,
    onRefused: (refusal) => refused(refusal),
    changes,
    waits: inboxWaits,
    files,
    now,
    newId,
    notify,
    log: logInfo,
  });
  messages.extraUnread = (agentId) => agentNotices.count(agentId);
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
  const shares = new Shares({ db, workspaces, changes, signingKey: config.signingKey, now, newId, log: logInfo });
  // Mail is extra: the page is always reached from the agent's chat or Portico's own pages, so a failed email only logs.
  const mailed = (what: string, send: Promise<unknown>) => void send.catch((err) => log("error", "mail_failed", { what, error: errorName(err) }));
  const consents = new Consents({
    db,
    workspaces,
    shares,
    agents,
    people,
    computers,
    changes,
    activity,
    now,
    newId,
    log: logInfo,
    // The person an agent asked is known, so Portico emails that person the page's link. Never the code.
    onAsked: (request) => {
      const person = request.personId ? people.get(request.personId) : null;
      const view = person ? consents.describe(person, request.id) : null;
      if (!mail.enabled || !person || !view) return;
      const words = consentWords(view, person.name, (agent) => agents.nameFor(agent, person.id));
      mailed(
        "consent",
        mail.notify("consent", request.id, person, {
          subject: `${words.title}: an agent asks`,
          lines: [words.asks, "To answer, open this page and sign in to Portico:"],
          link: `${settings.publicUrl()}/c/${request.id}`,
          after:
            request.kind === "admit_agent"
              ? ["No code is needed: only the owner of the Portico, signed in, can answer on that page."]
              : [
                  "The page asks for the 4-digit code the agent shows in its chat. Portico never emails that code, so nothing happens without the chat.",
                  "Didn't ask an agent for this? Open the page and choose Don't allow, or ignore this email.",
                ],
          // The one-step stop that fits: the agent that asked, or for a request from someone else's agent, the Portico.
          stop:
            request.kind === "admit_agent" && request.workspaceId
              ? { line: "To stop the person who asked, take that person out, or pause the Portico, in one step on the Portico's page:", link: `${settings.publicUrl()}/p/${request.workspaceId}` }
              : request.agentId
                ? { line: "To stop the agent that asked, revoke the agent in one step on the agent's page:", link: `${settings.publicUrl()}/a/${request.agentId}` }
                : undefined,
        }),
      );
    },
  });
  const porticoPage = (workspaceId: string) => `${settings.publicUrl()}/p/${workspaceId}`;
  /** A person as Portico names one in its own sentences: the name someone typed as a quote, then the handle. */
  const personWords = (person: Person) => `${quote(person.name)}${person.handle ? ` (${person.handle})` : ""}`;
  // A held message's page is emailed to the person who decides: the receiver's, or for a message held on its way out,
  // the sender's own. Never the subject or the text.
  const mailHeld = (m: Message) => {
    if (!mail.enabled) return;
    const receiver = agents.get(m.toId);
    const sender = agents.get(m.fromId);
    const outbound = m.heldFor === "outbound";
    const person = outbound ? (sender ? people.get(sender.ownerId) : null) : receiver ? people.get(receiver.ownerId) : null;
    if (!receiver || !sender || !person) return;
    const from = quote(agents.addressFor(sender, person.id));
    const to = quote(agents.addressFor(receiver, person.id));
    const why = outbound
      ? `A message from ${from} to ${to} is held: ${person.name} asked to see what that agent sends to other people's agents first.`
      : m.heldFor === "first_contact"
        ? `A message from ${from} to ${to} is held: ${person.name} hasn't allowed messages from the agents of ${personWords(people.get(sender.ownerId) ?? person)} yet.`
        : `A message from ${from} to ${to} is held: that agent takes messages only once ${person.name} allows each sender.`;
    // Each hold of one message is its own email: a message held on its way out can be held again on arrival.
    mailed(
      "held",
      mail.notify("held", outbound ? `${m.id}:out` : m.id, person, {
        subject: "A message waits for a decision on Portico",
        lines: [why, "To read the message and decide, open this page and sign in to Portico:"],
        link: `${settings.publicUrl()}/held/${m.id}`,
        after: [`The message waits ${LIMITS.messageExpiryHours / 24} days, then lapses.`],
        stop: outbound
          ? { line: "To stop that agent for good, revoke the agent in one step on the agent's page:", link: `${settings.publicUrl()}/a/${sender.id}` }
          : { line: "To stop the sender, take the sender's person out, or pause the Portico, in one step on the Portico's page:", link: porticoPage(m.workspaceId) },
      }),
    );
  };
  const approvals = new Approvals({ agents, workspaces, messages, people, allowList, contacts, changes, activity, now, notify, log: logInfo });

  // ---- alerts: a burst of messages from another person's agent, and repeated refused sends ----

  const alert = (ref: string, person: Person, subject: string, line: string, stop: { line: string; link: string }, page: string) => {
    if (!mail.enabled) return;
    mailed("alert", mail.notify("alert", ref, person, { subject, lines: [line, "Portico's page shows the record:"], link: page, after: [], stop }));
  };
  const day = () => now().toISOString().slice(0, 10);
  /** When each sender last wrote to each other person's agents, within the burst window. */
  const recent = new Map<string, number[]>();
  const watchBurst = (m: Message) => {
    const sender = agents.get(m.fromId);
    const receiver = agents.get(m.toId);
    if (!sender || !receiver || sender.ownerId === receiver.ownerId) return;
    // Counted in memory, as each message is sent: a burst is a matter of minutes, and no database is opened to see one.
    const key = `${sender.id} ${receiver.ownerId}`;
    const from = now().getTime() - LIMITS.burstMinutes * MINUTE_MS;
    const times = [...(recent.get(key) ?? []).filter((at) => at > from), now().getTime()];
    recent.set(key, times);
    if (recent.size > 10_000) for (const [other, list] of recent) if (list.every((at) => at <= from)) recent.delete(other);
    const count = times.length;
    if (count < LIMITS.burstMessages) return;
    const since = new Date(now().getTime() - DAY_MS).toISOString();
    if (activity.count("portico_burst", { otherId: sender.id, subjectId: receiver.ownerId, since }) > 0) return;
    activity.record("portico_burst", { agentId: receiver.id, otherId: sender.id, workspaceId: m.workspaceId, subjectId: receiver.ownerId, detail: { count: String(count) } });
    const person = people.get(receiver.ownerId);
    if (!person) return;
    alert(
      `burst:${sender.id}:${person.id}:${day()}`,
      person,
      "Many messages from one agent on Portico",
      `${quote(agents.addressFor(sender, person.id))} sent ${count} messages to ${person.name}'s agents within ${LIMITS.burstMinutes} minutes.`,
      { line: "To stop the sender, take the sender's person out, or pause the Portico, in one step on the Portico's page:", link: porticoPage(m.workspaceId) },
      porticoPage(m.workspaceId),
    );
  };
  const refused = (refusal: { caller: Agent; receiver: Agent | null; workspace: Workspace | null; code: string }) => {
    const { caller } = refusal;
    const window = new Date(now().getTime() - LIMITS.refusedMinutes * MINUTE_MS).toISOString();
    const before = activity.count("portico_refused", { agentId: caller.id, since: window });
    // A looping agent is refused many times a minute: the record keeps enough to see the pattern, not every one.
    if (before >= LIMITS.refusedSends * 3) return;
    activity.record("portico_refused", { agentId: caller.id, otherId: refusal.receiver?.id ?? null, workspaceId: refusal.workspace?.id ?? null, detail: { reason: refusal.code } });
    if (before + 1 < LIMITS.refusedSends) return;
    if (activity.count("portico_refusals", { agentId: caller.id, since: new Date(now().getTime() - DAY_MS).toISOString() }) > 0) return;
    activity.record("portico_refusals", { agentId: caller.id, workspaceId: refusal.workspace?.id ?? null, subjectId: caller.ownerId, detail: { count: String(before + 1) } });
    const person = people.get(caller.ownerId);
    if (!person) return;
    const page = `${settings.publicUrl()}/a/${caller.id}`;
    alert(
      `refusals:${caller.id}:${day()}`,
      person,
      "An agent keeps being refused on Portico",
      `${quote(agents.nameFor(caller, person.id))} had ${before + 1} sends refused within ${LIMITS.refusedMinutes} minutes. An agent that keeps trying may have been misled by something the agent read.`,
      { line: "To stop the agent, revoke the agent in one step on the agent's page:", link: page },
      page,
    );
  };

  // ---- who is in a Portico changed: the record, the agents there, and what can no longer be delivered ----

  const placeWords = (workspace: Workspace) => `the Portico ${quote(workspace.name)}`;
  /** Tells every agent in the workspace now, but the ones named, in Portico's own words, each by the names that agent uses. */
  const tellAgents = (workspace: Workspace, except: string[], text: (viewer: Agent) => string) => {
    if (workspace.kind !== "shared") return;
    for (const id of workspaces.agentsIn(workspace.id)) {
      if (except.includes(id)) continue;
      const viewer = agents.get(id);
      if (!viewer) continue;
      agentNotices.add(viewer.id, text(viewer));
      wake(viewer.id);
    }
  };
  const tellAgent = (agentId: string, text: string) => {
    const agent = agents.get(agentId);
    if (!agent || agent.revokedAt !== null) return;
    agentNotices.add(agent.id, text);
    wake(agent.id);
  };
  const named = (subject: Agent, viewer: Agent) => `\`${agents.nameFor(subject, viewer.ownerId)}\``;
  const onWorkspaceEvent = (event: WorkspaceEvent) => {
    const { workspace } = event;
    const place = placeWords(workspace);
    const shared = workspace.kind === "shared";
    switch (event.kind) {
      case "person_joined": {
        // The record's line is written by the share that let the person in, with how many agents came along.
        const person = people.get(event.personId);
        if (person) tellAgents(workspace, [], () => `${personWords(person)} came into ${place}.`);
        return;
      }
      case "person_left": {
        const person = people.get(event.personId);
        activity.record("portico_person_left", { personId: event.byId, subjectId: event.personId, workspaceId: workspace.id, detail: { agents: String(event.agentIds.length) } });
        messages.withdraw(workspace.id, event.agentIds);
        if (person) tellAgents(workspace, [], () => `${personWords(person)} left ${place}, with every agent ${quote(person.name)} had there.`);
        for (const id of event.agentIds) tellAgent(id, `This agent is out of ${place}: ${person ? personWords(person) : "the person who manages this agent"} left that Portico or was taken out.`);
        // Someone taken out by the owner is told at once, since the Portico's record no longer reaches that person.
        if (person && event.byId !== event.personId && mail.enabled) {
          mailed(
            "alert",
            mail.notify("alert", `out:${workspace.id}:${person.id}:${now().toISOString()}`, person, {
              subject: "Taken out of a Portico",
              lines: [`${personWords(people.get(event.byId) ?? person)} took ${person.name} out of ${place}, with every agent ${person.name} had there. Those agents no longer reach anyone through that Portico.`, "Portico's page shows the Porticos left:"],
              link: `${settings.publicUrl()}/`,
              after: [],
            }),
          );
        }
        return;
      }
      case "agent_joined": {
        const subject = agents.get(event.agentId);
        if (!shared || !subject) return;
        activity.record("portico_agent_joined", { agentId: subject.id, personId: event.byId, workspaceId: workspace.id, detail: { agent: agents.addressFor(subject, ""), allowed: event.ownerAllowed } });
        tellAgents(workspace, [subject.id], (viewer) => `${named(subject, viewer)} came into ${place}. This agent and ${named(subject, viewer)} can message each other now.`);
        tellAgent(subject.id, `This agent is in ${place} now, and can message the agents there. list_agents shows who.`);
        return;
      }
      case "agent_left": {
        const subject = agents.get(event.agentId);
        messages.withdraw(workspace.id, [event.agentId]);
        if (!shared || !subject) return;
        activity.record("portico_agent_left", { agentId: subject.id, personId: event.byId, workspaceId: workspace.id, detail: { agent: agents.addressFor(subject, ""), revoked: subject.revokedAt !== null } });
        tellAgents(workspace, [subject.id], (viewer) => `${named(subject, viewer)} left ${place}.`);
        tellAgent(subject.id, `This agent is out of ${place}, and reaches nobody through that Portico any more.`);
        return;
      }
      case "paused":
      case "resumed": {
        const owner = people.get(event.byId);
        activity.record(event.kind === "paused" ? "portico_paused" : "portico_resumed", { personId: event.byId, workspaceId: workspace.id });
        if (event.kind === "paused") messages.withdraw(workspace.id, null);
        tellAgents(workspace, [], () =>
          event.kind === "paused"
            ? `${owner ? personWords(owner) : "The owner"} paused ${place}: nothing moves through that Portico until the owner resumes the Portico, and a send through that Portico is refused.`
            : `${owner ? personWords(owner) : "The owner"} resumed ${place}: messages move through that Portico again.`,
        );
        return;
      }
      case "deleted":
        messages.withdraw(workspace.id, null);
        for (const id of event.agentIds) tellAgent(id, `${place.charAt(0).toUpperCase()}${place.slice(1)} was deleted. This agent reaches nobody through that Portico any more.`);
        return;
    }
  };
  workspaces.onEvent = (event) => {
    try {
      onWorkspaceEvent(event);
    } catch (err) {
      log("error", "workspace_event_failed", { kind: event.kind, error: errorName(err) });
    }
  };
  shares.onShared = (share, workspace) => activity.record("portico_shared", { personId: share.createdBy, workspaceId: workspace.id, detail: { policy: share.agentsPolicy } });
  shares.onEnded = (_share, workspace, byId) => activity.record("portico_share_ended", { personId: byId, workspaceId: workspace.id });
  shares.onEntered = (share, workspace, person, entered) =>
    activity.record("portico_person_joined", { personId: person.id, subjectId: person.id, workspaceId: workspace.id, detail: { agents: String(entered.length), share: share.id } });

  /** One line of a Portico's record as one person reads it. */
  const recordLine: Portico["recordLine"] = (entry: Parameters<typeof recordWords>[0], reader: Person, workspace: Workspace) =>
    recordWords(entry, {
      person: (id) => {
        const person = id ? people.get(id) : null;
        return person ? personWords(person) : null;
      },
      agent: (id) => {
        const agent = id ? agents.get(id) : null;
        return agent ? quote(agents.addressFor(agent, reader.id)) : null;
      },
      // Who came in, by name and email: for the owner, who let that person in.
      email: (id) => (id && workspace.ownerId === reader.id ? (people.get(id)?.email ?? null) : null),
    });

  const MAILED_KINDS = ["portico_person_joined", "portico_person_left", "portico_agent_joined", "portico_agent_left", "portico_paused", "portico_resumed"];
  const sweepRecordMail = async () => {
    if (!mail.enabled) return 0;
    let sent = 0;
    try {
      const at = now().toISOString();
      const due = db
        .query(
          `SELECT p.workspace_id AS workspaceId, p.person_id AS personId, p.notified_seq AS since
           FROM workspace_people p JOIN workspaces w ON w.id = p.workspace_id
           WHERE w.kind = 'shared' AND w.archived_at IS NULL AND EXISTS (
             SELECT 1 FROM activity a WHERE a.workspace_id = p.workspace_id AND a.seq > p.notified_seq
               AND a.person_id IS NOT p.person_id AND a.kind IN (${MAILED_KINDS.map((kind) => `'${kind}'`).join(", ")}))`,
        )
        .all() as { workspaceId: string; personId: string; since: number }[];
      const latest = (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM activity").get() as { seq: number }).seq;
      for (const row of due) {
        // Moved on first, so a slow or failed email is never sent twice.
        db.query("UPDATE workspace_people SET notified_seq = $latest WHERE workspace_id = $workspaceId AND person_id = $personId").run({ latest, workspaceId: row.workspaceId, personId: row.personId });
        const person = people.get(row.personId);
        const workspace = workspaces.get(row.workspaceId);
        if (!person || !workspace) continue;
        const entries = activity
          .recordOf(workspace.id, { forPerson: person.id, after: row.since, limit: 200 })
          .filter((entry) => MAILED_KINDS.includes(entry.kind) && entry.personId !== person.id)
          .reverse();
        const lines = entries.map((entry) => recordLine(entry, person, workspace)).filter((line): line is string => line !== null);
        if (lines.length === 0) continue;
        const shown = lines.slice(0, LIMITS.recordMailLines);
        const owner = workspace.ownerId === person.id;
        const outcome = await mail.notify("record", `${workspace.id}:${person.id}:${at}`, person, {
          subject: "Who came into or left a Portico",
          lines: [`In ${placeWords(workspace)}:`, ...shown, ...(lines.length > shown.length ? [`And ${lines.length - shown.length} more.`] : []), "The Portico's page shows the whole record:"],
          link: porticoPage(workspace.id),
          after: [],
          stop: {
            line: owner
              ? "On that page the owner pauses the Portico, or takes a person or an agent out, in one step:"
              : `On that page ${person.name} takes ${person.name}'s own agents out, or leaves the Portico, in one step:`,
            link: porticoPage(workspace.id),
          },
        });
        if (outcome === "sent") sent++;
      }
    } catch (err) {
      log("error", "record_mail_failed", { error: errorName(err) });
    }
    return sent;
  };

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
    consents,
    mail,
    computers,
    agents,
    messages,
    files,
    approvals,
    allowList,
    contacts,
    agentNotices,
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
    sweepRecordMail,
    recordLine,
    close: () => content.close(),
    sweepMinute() {
      // First: the sweeps below open the databases again only for as long as each needs one.
      sweep("content_idle", () => content.sweepIdle());
      void sweepFiles();
      sweep("messages_expired", () => messages.expireDue().length);
      sweep("event_subscriptions", () => events.sweep());
      sweep("oauth_clients", () => computers.sweepUnusedClients());
      sweep("sign_in_limits", () => accounts.sweepLimiters());
      sweep("consent_requests", () => consents.sweepMinute());
      void sweepRecordMail();
    },
    sweepDaily() {
      sweep("history", () => messages.prune());
      void sweepArchived();
      sweep("runs", () => agents.pruneRuns());
      sweep("activity", () => activity.prune());
      sweep("agent_notices", () => agentNotices.prune());
      sweep("web_sessions", () => accounts.sweep());
      sweep("people", () => people.sweep());
      sweep("computers", () => computers.sweep());
      sweep("shares", () => shares.sweep());
      sweep("consents", () => consents.sweep());
      sweep("mails", () => mail.sweep());
    },
  };
}
