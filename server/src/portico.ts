import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { helloFor, AgentStreams } from "./agent-api/stream";
import { PersonStreams } from "./api/events";
import { buildApp } from "./app";
import { Accounts } from "./core/accounts";
import { Activity, type ActivityEntry } from "./core/activity";
import { Analytics } from "./core/analytics";
import { Agents } from "./core/agents";
import { AllowList, Approvals, Contacts } from "./core/approvals";
import { AgentNotices } from "./core/notices";
import { recordWords } from "./core/record-words";
import { DAY_MS, MINUTE_MS } from "./core/limits";
import { Changes, type Topic } from "./core/changes";
import { Computers } from "./core/computers";
import { consentWords, newAgentWords, quote } from "./core/consent-words";
import { Consents } from "./core/consents";
import { Content } from "./core/content";
import { type AccountCheck, accountFrom, Descope } from "./core/descope";
import { EventSubscriptions, NOTICE_WAITING } from "./core/events";
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
import { neverSent, Tasks } from "./core/tasks";
import type { AccountSignIn, Agent, Message, Notice, Person, PorticoConfig, Workspace } from "./core/types";
import { WakeUrls } from "./core/wake-urls";
import { Feedback } from "./core/feedback";
import { type Question, Questions, waitWords } from "./core/questions";
import { type WorkspaceEvent, Workspaces } from "./core/workspaces";
import { safePost, type WebhookPost } from "./core/webhooks";
import { ConfigError } from "./config";
import { SECRETS_KEY_MISSING, Secrets } from "./core/secrets";
import { encryptStoredLinkSecrets, encryptStoredSecrets, hashStoredSessionKeys } from "./core/stored-secrets";
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
  /** Where analytics events are posted; tests pass a fake. */
  analyticsPost?: WebhookPost;
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
  /** Done once every stored wake URL key and event secret is under the current secrets key. Never rejects. */
  secretsReady: Promise<void>;
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
  if (config.secretsKey === null) throw new ConfigError([SECRETS_KEY_MISSING]);
  const secrets = Secrets.from(config.secretsKey, config.secretsKeyOld);
  hashStoredSessionKeys(db);
  encryptStoredLinkSecrets({ db, secrets, signingKey: config.signingKey, log: (msg, fields) => log("info", msg, fields) });
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
  const analytics = new Analytics({
    config: config.analytics,
    post: opts.analyticsPost ?? safePost({ timeoutMs: 5000 }),
    now,
    log,
    // The people whose browser said Do Not Track or Global Privacy Control, as one JSON list among the settings.
    optOuts: {
      load: () => {
        const ids: unknown = JSON.parse(settings.get("analytics_opt_out") ?? "[]");
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
      },
      save: (ids) => settings.set("analytics_opt_out", JSON.stringify(ids)),
    },
  });
  const presence = new Presence();
  const agentStreams = new AgentStreams();
  const inboxWaits = new InboxWaits();
  const personStreams = new PersonStreams();
  // Each person's pages hear only what concerns that person: the people a change names, the people who manage the
  // agents it names, the people in the Porticos it names, and whoever shares a Portico with any of them (their lists
  // show each other's agents). A change nobody narrowed goes to everyone.
  changes.on((topics, batch) => {
    const audience = new Map<Topic, Set<string> | null>();
    for (const topic of topics) {
      const about = batch.get(topic) ?? null;
      if (about === null) {
        audience.set(topic, null);
        continue;
      }
      const named = new Set(about.people);
      for (const id of about.agents) {
        const owner = agents.get(id)?.ownerId;
        if (owner) named.add(owner);
      }
      for (const id of about.workspaces) for (const personId of workspaces.peopleIn(id)) named.add(personId);
      const all = new Set(named);
      for (const personId of named) for (const w of workspaces.forPerson(personId)) for (const other of workspaces.peopleIn(w.id)) all.add(other);
      audience.set(topic, all);
    }
    personStreams.broadcast(topics, (personId) => topics.filter((topic) => audience.get(topic) === null || audience.get(topic)!.has(personId)));
  });

  // Two ways to sign in, one Portico after that: an outside account (Descope) where a project is configured, otherwise
  // this server's own passwords, passkeys, setup link and invites.
  const check = opts.accountCheck ?? (config.descopeProjectId ? new Descope(config.descopeProjectId, { now }) : null);

  // Its own IDs: activity rows never shift the IDs tests expect for everything else.
  const activity = new Activity({ db, changes, now });
  const people = new People({ db, changes, content, secrets, signInByName: check === null, now, newId });
  const accounts = new Accounts({ db, people, now, newId });
  // A Portico that was made is an analytics event. The core only logs it, possibly inside a transaction still open:
  // the microtask runs once that transaction has committed or rolled back, and looks for what is really there.
  const workspaceLog = (msg: string, fields: Record<string, unknown>) => {
    logInfo(msg, fields);
    if (msg !== "workspace_created" || !analytics.on) return;
    queueMicrotask(() =>
      analytics.track((a) => {
        const made = workspaces.get(String(fields.workspace_id));
        if (made) a.capture("portico_created", made.ownerId, { kind: made.kind, via: typeof fields.via === "string" ? fields.via : "auto", portico_id: made.id });
      }),
    );
  };
  const workspaces = new Workspaces({ db, changes, now, newId, log: workspaceLog });
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
  const hooks = { db, post: webhookPost, secrets, changes, allowPrivate: config.webhooksAllowPrivate, now, schedule: opts.schedule, log: logInfo };
  const wakeUrls = new WakeUrls({ ...hooks, activity });
  const feedback = new Feedback({ db, handleOf: (id) => people.get(id)?.handle ?? null, reviewToken: config.feedbackReviewToken, now, newId });
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
      analytics.track(() => captureNotice(notice));
    });
  };

  // ---- analytics: what a notice says happened, as IDs and kinds only ----

  /** A set that forgets its oldest entry beyond 10,000, so it can't grow for as long as the process runs. */
  const remember = (set: Set<string>, id: string) => {
    if (set.size >= 10_000) set.delete(set.values().next().value!);
    set.add(id);
  };
  /** People this process has seen send, so the search for an earlier message runs once per person. */
  const senders = new Set<string>();
  /** Tasks this process has counted as completed, to save the look at what is stored: that look is what decides. */
  const completed = new Set<string>();
  const taskCompleted = (first: Message, byId: string) => {
    const starter = agents.get(first.fromId);
    const by = agents.get(byId);
    if (!starter || !by || completed.has(first.id)) return;
    remember(completed, first.id);
    analytics.capture("task_completed", starter.ownerId, {
      task_id: first.id,
      by_agent_id: by.id,
      cross_owner: starter.ownerId !== by.ownerId,
      minutes: Math.max(0, Math.floor((now().getTime() - Date.parse(first.createdAt)) / MINUTE_MS)),
    });
  };
  const captureNotice = (notice: Notice) => {
    const m = notice.message;
    const sender = agents.get(m.fromId);
    const receiver = agents.get(m.toId);
    if (!sender || !receiver) return;
    // Only the send itself: a message let go by the sender's person and held again for the receiver's comes through
    // as message_sent a second time, with who let it go.
    if (notice.kind === "message_sent" && m.decidedBy === null) {
      const properties = {
        agent_id: sender.id,
        to_agent_id: receiver.id,
        portico_id: m.workspaceId,
        delivery: m.status === "held" ? "held" : agents.tier(receiver),
        held_for: m.status === "held" ? (m.heldFor ?? "approval") : undefined,
        is_reply: m.replyTo !== null,
        cross_owner: sender.ownerId !== receiver.ownerId,
        has_files: files.of(m).length > 0,
        no_reply_needed: m.noReplyNeeded,
      };
      analytics.capture("message_sent", sender.ownerId, properties);
      if (!senders.has(sender.ownerId)) {
        remember(senders, sender.ownerId);
        if (!messages.sentBefore(sender.ownerId, m.id)) analytics.capture("first_message_sent", sender.ownerId, properties);
      }
    }
    // A task's outcome is worked out from its messages, never stored, so the step that completes one is seen here: a
    // final answer that went through, from the agent the task's first message was sent to.
    const through = (notice.kind === "message_sent" || notice.kind === "message_decided") && (m.status === "pending" || m.status === "delivered");
    if (through && m.final && m.replyTo !== null && m.rootId !== m.id) {
      const first = messages.get({ agent: m.fromId, workspace: m.workspaceId }, m.rootId);
      // Once per task: a later final answer, in this process or after a restart, finds the earlier one stored.
      if (first && first.toId === m.fromId && !messages.answeredBefore(first, m.id, { earlierOnly: notice.kind === "message_sent" })) taskCompleted(first, m.fromId);
    }
    // Or a first message that needs no reply, picked up.
    if (notice.kind === "message_delivered" && m.rootId === m.id && m.noReplyNeeded) taskCompleted(m, m.toId);
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
  // One of Portico's own notices is waiting for an app agent: the agent is woken through its wake URL, and through
  // its subscription to notice.waiting when it has one. For any feature whose notice should start an app's run (the
  // answer to a question, and whatever comes later): the caller names the notice and its kind. Messages keep wakeApp,
  // and a subscription to message.received never gets a notice.
  const wakeAppForNotice = (agentId: string, noticeId: string, kind: string) => {
    if (!wakeUrls.has(agentId) && !events.has(agentId, NOTICE_WAITING)) return;
    const agent = agents.get(agentId);
    if (!agent || agent.revokedAt !== null) return;
    const info = { agentName: agents.display(agent), noticeId, kind, waiting: messages.unreadCount(agent.id) };
    wakeUrls.kick(agent.id, { ...info, lastCheckIn: presence.lastCheckIn(agent.id) });
    events.deliverNotice(agent.id, info);
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
          activity.record("portico_held", {
            agentId: m.toId,
            otherId: m.fromId,
            workspaceId: m.workspaceId,
            subjectId: m.heldFor === "outbound" ? (agents.get(m.fromId)?.ownerId ?? null) : null,
            detail: { for: m.heldFor ?? "approval" },
          });
          mailHeld(m);
        }
        // A message still on its sender's side has reached nobody: it counts once it is let go (held again for the
        // receiving side, which comes through here once more, or released, below).
        if (!neverSent(m)) watchBurst(m);
        return;
      }
      case "message_decided":
        if (m.status === "declined") {
          files.release(m).catch((err) => log("error", "file_release_failed", { message_id: m.id, error: errorName(err) }));
        }
        if (m.status === "pending") {
          wake(m.toId);
          wakeApp(m);
          // Let go by the sender's own person, straight through: now the message counts as sent.
          if (m.heldFor === "outbound") watchBurst(m);
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
    // A name a person typed reaches an agent only as a quote.
    personName: (personId) => {
      const name = people.get(personId)?.name;
      return name ? quote(name) : "that agent's person";
    },
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
  const tasks = new Tasks({ content, now, questions: { ofTask: (id) => questions.ofTask(id), byTask: () => questions.byTask() } });
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
  // A link can be for one address only where the sign-in service verifies addresses: with Portico's own accounts nobody has one.
  const shares = new Shares({ db, workspaces, changes, secrets, bindsEmail: check !== null, now, newId, log: logInfo });
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
    // The person an agent asked is known, so Portico emails that person the page's link, which only that person can open.
    onAsked: (request) => {
      const person = request.personId ? people.get(request.personId) : null;
      const view = person ? consents.describe(person, request.id) : null;
      if (!mail.enabled || !person || !view) return;
      const words = consentWords(view, person.name, (agent) => agents.nameFor(agent, person.id), now());
      mailed(
        "consent",
        mail.notify("consent", request.id, person, {
          subject: `${words.title}: an agent asks`,
          lines: [words.asks, "To answer, open this page and sign in to Portico:"],
          link: `${settings.publicUrl()}/c/${request.id}`,
          after:
            request.kind === "admit_agent"
              ? ["Only the owner of the Portico, signed in, can answer on that page."]
              : [`Only ${person.name}, signed in, can answer on that page.`, "Didn't ask an agent for this? Open the page and choose Don't allow, or ignore this email."],
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
    const why = m.heldFor === "new_agent"
      ? `A message from ${from} to ${to} is held. ${newAgentWords(sender, now())} This is that agent's first message to ${to}.`
      : outbound && sender.unproven
      ? `A message from ${from} to ${to} is held. ${newAgentWords(sender, now())}`
      : outbound
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
        after: [
          `The message waits ${LIMITS.messageExpiryHours / 24} days, then lapses.`,
          // Revoking a session stops one agent; the computer's token could start another from a different folder.
          ...((outbound || m.heldFor === "new_agent") && sender.computerId
            ? [`That agent is a session on a computer. To stop every session started there, remove the computer in one step in Settings: ${settings.publicUrl()}/settings`]
            : []),
        ],
        stop: outbound || m.heldFor === "new_agent"
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

  // ---- a new agent or computer on a person's account: the person is told at once, with the way to undo it ----

  agents.onJoined = (agent) => {
    const person = people.get(agent.ownerId);
    if (!person || !mail.enabled) return;
    const page = `${settings.publicUrl()}/a/${agent.id}`;
    mailed(
      "alert",
      mail.notify("alert", `joined:${agent.id}`, person, {
        subject: "A new agent joined Portico",
        lines: [
          `An agent named ${quote(agent.name)} joined Portico as one of ${person.name}'s agents just now, allowed in a browser signed in as ${person.name}. That agent can message ${person.name}'s other agents.`,
          "The agent's page:",
        ],
        link: page,
        after: [`Nobody at ${person.name}'s end asked an agent to join? Someone else may have sent the link and asked for the code that Portico's page showed.`],
        stop: { line: "To stop the agent at once, revoke the agent in one step on that page:", link: page },
      }),
    );
  };
  computers.onJoined = (computer) => {
    const person = people.get(computer.ownerId);
    if (!person || !mail.enabled) return;
    const page = `${settings.publicUrl()}/settings`;
    mailed(
      "alert",
      mail.notify("alert", `joined:${computer.id}`, person, {
        subject: "A new computer joined Portico",
        lines: [
          `A computer named ${quote(computer.name)} joined Portico on ${person.name}'s account just now, allowed in a browser signed in as ${person.name}. Each Claude Code or Codex session started there becomes one of ${person.name}'s agents.`,
          "Settings lists the computers:",
        ],
        link: page,
        after: [`Nobody at ${person.name}'s end asked a computer to join? Someone else may have sent the link and asked for the code that Portico's page showed.`],
        stop: { line: "To stop the computer at once, remove the computer in one step in Settings:", link: page },
      }),
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
  /**
   * Tells one agent in Portico's own words: the notice waits for the agent's next check, a session's stream is nudged
   * and a waiting check_inbox returns. With `wakeKind`, an app agent is woken for the notice as well, as for a
   * message: for a notice the agent is waiting on. Returns the notice's ID, or null when nothing was saved. A revoked
   * agent is told nothing.
   */
  const tellAgent = (agentId: string, text: string, opts: { wakeKind?: string } = {}): string | null => {
    const agent = agents.get(agentId);
    if (!agent || agent.revokedAt !== null) return null;
    const noticeId = agentNotices.add(agent.id, text);
    wake(agent.id);
    if (opts.wakeKind !== undefined) wakeForNotice(agent.id, noticeId, opts.wakeKind);
    return noticeId;
  };
  /**
   * A saved notice the agent is waiting on: an app agent is woken for it, as for a message, once the write that made
   * the notice is done. Never throws, and does nothing for an agent that is gone or revoked.
   */
  const wakeForNotice = (agentId: string, noticeId: string, kind: string) => {
    queueMicrotask(() => {
      try {
        wakeAppForNotice(agentId, noticeId, kind);
      } catch (err) {
        log("error", "notice_wake_failed", { kind, error: errorName(err) });
      }
    });
  };

  // ---- questions an agent asks its own person ----

  // The question's page is emailed to the person, once: who asks, never what. The page needs sign-in.
  const mailQuestion = (q: Question) => {
    if (!mail.enabled) return;
    const agent = agents.get(q.agentId);
    const person = people.get(q.personId);
    if (!agent || !person) return;
    const name = agents.nameFor(agent, person.id);
    mailed(
      "question",
      // The mails table lists its kinds, and a question's email is a link to a page only its person can answer on, as
      // a consent request's is: the same kind, with a reference of its own.
      mail.notify("consent", `question:${q.id}`, person, {
        subject: `${name} needs input on Portico`,
        lines: [
          `${quote(name)}, one of ${person.name}'s agents, asked ${person.name} a question and waits for the answer.${agent.unproven ? ` ${newAgentWords(agent, now())}` : ""}`,
          "To read the question and answer, open this page and sign in to Portico:",
        ],
        link: questions.link(q.id),
        after: [
          `Only ${person.name}, signed in, can answer on that page. The question waits ${waitWords(Date.parse(q.expiresAt) - Date.parse(q.createdAt))}, then lapses, and the agent is told that no answer came.`,
        ],
        stop: { line: "To stop the agent that asked, revoke the agent in one step on the agent's page:", link: `${settings.publicUrl()}/a/${agent.id}` },
      }),
    );
  };
  const questions: Questions = new Questions({
    db,
    agents,
    people,
    activity,
    changes,
    publicUrl: () => settings.publicUrl(),
    // The notice is saved inside the transaction that ends the question, also for a revoked agent: the record of what
    // Portico said. Once that is done the agent is woken, when it can still be reached: a session's stream is nudged,
    // a waiting check_inbox returns, and an app agent is woken as for a message.
    saveNotice: (agentId, text) => agentNotices.add(agentId, text),
    wake: (agentId, noticeId, kind) => {
      const agent = agents.get(agentId);
      if (!agent || agent.revokedAt !== null) return;
      wake(agent.id);
      wakeForNotice(agent.id, noticeId, kind);
    },
    taskAgents: (q) => {
      const found = q.taskId ? tasks.get({ agent: q.agentId }, q.taskId) : null;
      return found ? [found.task.fromId, found.task.toId] : [];
    },
    onAsked: mailQuestion,
    now,
    newId,
    log: logInfo,
  });
  // The notices an agent is waiting on: how its questions ended. This list is what marks a notice as one that wakes
  // a stopped session and keeps it in every batch; a later feature adds its own notices' IDs here.
  agentNotices.waking = (agentId) => questions.noticesOf(agentId);
  // Every way an agent goes or is revoked withdraws what it asked that still waits, in the same step and never left
  // to the sweep: one agent removed or revoked, a computer removed with its sessions, a person removed with every
  // agent that person had. A failure here never stops the removal itself: the sweep and the answer route's own check
  // then withdraw what is left.
  const withdrawQuestions = (agentIds: string[]) => {
    try {
      questions.withdrawFor(agentIds);
    } catch (err) {
      log("error", "questions_withdraw_failed", { error: errorName(err) });
    }
  };
  agents.onGone = withdrawQuestions;
  computers.onRemoving = withdrawQuestions;
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
        activity.record("portico_person_left", { personId: event.byId, subjectId: event.personId, workspaceId: workspace.id, detail: { agents: String(event.agentIds.length), name: person?.name ?? "" } });
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
  // A person's account is about to be removed: the person leaves each Portico of someone else's first, as if taken
  // out, so the record says so, the agents there are told, and what was on its way is withdrawn.
  people.onRemoving = (personId) => {
    // A removed person's ID isn't kept on the opt-out list.
    analytics.setOptOut(personId, false);
    withdrawQuestions(agents.ownedBy(personId).map((agent) => agent.id));
    for (const workspace of workspaces.forPerson(personId)) {
      if (workspace.kind !== "shared" || workspace.ownerId === personId) continue;
      try {
        workspaces.removePerson(personId, workspace.id, personId);
      } catch (err) {
        log("error", "workspace_event_failed", { kind: "person_removed", error: errorName(err) });
      }
    }
  };
  // A person's account was removed: each Portico that person owned went too, as if deleted.
  people.onWorkspacesGone = (gone) => {
    for (const { workspaceId, agentIds } of gone) {
      try {
        messages.withdraw(workspaceId, null);
        const workspace = workspaces.known(workspaceId);
        const place = workspace ? placeWords(workspace) : "a Portico";
        for (const id of agentIds) tellAgent(id, `${place.charAt(0).toUpperCase()}${place.slice(1)} was deleted: the owner's account was removed. This agent reaches nobody through that Portico any more.`);
      } catch (err) {
        log("error", "workspace_event_failed", { kind: "owner_removed", error: errorName(err) });
      }
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
  shares.allowPeople = (personId, senderPersonId) => contacts.add(personId, senderPersonId, now().toISOString());
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
  // One run at a time: a second sweep that starts while a slow one still sends would read the same record again.
  let recordMailing: Promise<number> | null = null;
  const sweepRecordMail = (): Promise<number> => {
    if (recordMailing) return recordMailing;
    recordMailing = mailRecords().finally(() => (recordMailing = null));
    return recordMailing;
  };
  const mailRecords = async () => {
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

  // Old rows come under the secrets key in the background: reads meanwhile take a row either way.
  const secretsReady = encryptStoredSecrets({ db, secrets, wakeUrls, events, notices: agentNotices, log: logInfo }).then(() => undefined);

  const core: Core = {
    config,
    analytics,
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
    feedback,
    questions,
    events,
    accountSignIn,
    now,
    newId,
  };
  const app = buildApp(core, { heartbeatMs: opts.heartbeatMs, retiredHosts: config.retiredHosts, commit: config.commit });

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
    secretsReady,
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
      sweep("questions_expired", () => questions.expireDue());
      sweep("questions_withdrawn", () => questions.withdrawOrphans());
      void sweepRecordMail();
    },
    sweepDaily() {
      sweep("history", () => messages.prune());
      void sweepArchived();
      sweep("runs", () => agents.pruneRuns());
      sweep("activity", () => activity.prune());
      sweep("agent_notices", () => agentNotices.prune());
      sweep("questions", () => questions.prune());
      sweep("web_sessions", () => accounts.sweep());
      sweep("people", () => people.sweep());
      sweep("computers", () => computers.sweep());
      sweep("shares", () => shares.sweep());
      sweep("consents", () => consents.sweep());
      sweep("mails", () => mail.sweep());
    },
  };
}
