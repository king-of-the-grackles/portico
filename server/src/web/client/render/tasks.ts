// Tasks and decisions, shared by Today, Activity and the agent pages: one row per task (status, task, who, when) whose
// steps open inside the row, and the cards for what needs a person's decision. Pure: state in, HTML out.
import { agentState, clock, date, duration, esc, expiresIn, kindInfo, logo, pav, when } from "./common.js";
import type { AgentRef, AgentView, ConsentCard, FileView, HeldCard, HomeState, MessageView, QuestionCard, TaskDetail, TaskOutcome, TaskView } from "./types.js";

/** The four outcomes, in plain words. */
export const OUTCOME_LABEL: Record<TaskOutcome, string> = {
  needs_approval: "Needs a decision",
  in_progress: "In progress",
  done: "Done",
  failed: "Didn't go through",
};

export const OUTCOME_ORDER: TaskOutcome[] = ["needs_approval", "in_progress", "done", "failed"];

/** A task's window, as Portico's limits set it: held, unread and unanswered tasks end after this. */
const TASK_WINDOW = "3 days";

export function statusPill(outcome: TaskOutcome): string {
  return `<span class="pill pill-${outcome}">${OUTCOME_LABEL[outcome]}</span>`;
}

/** A task's pill: where it stands, or while one of its agents waits for its own person's answer, whom it waits on. */
function taskPill(t: TaskView): string {
  if (t.waitingOn) return `<span class="pill pill-waiting">Waiting on ${esc(t.waitingOn.person.name || "a person")}</span>`;
  return statusPill(t.outcome);
}

/** The task's second line: the answer's summary when done, otherwise where it stands. */
export function taskLine(t: TaskView): string {
  switch (t.outcome) {
    case "needs_approval":
      return "New contact, waiting for approval.";
    case "in_progress":
      // Who asked whom and when: never what was asked, which is between an agent and its own person.
      if (t.waitingOn) return `${t.waitingOn.agent.label} asked ${t.waitingOn.person.name || "a person"} a question at ${clock(t.waitingOn.askedAt)}. No answer yet.`;
      if (t.answer) return `Update from ${t.to.label}: ${t.answer.summary ?? t.answer.subject}`;
      if (t.pickedUpAt) return `Picked up at ${clock(t.pickedUpAt)}, no answer yet.`;
      return `${when(t.noReplyNeeded, "No reply needed. ")}Queued until ${t.to.label} checks for messages.`;
    case "done":
      // A message that needed no reply is done at pickup, with no answer to show.
      if (!t.answer && t.noReplyNeeded && t.pickedUpAt) return `No reply needed. Picked up at ${clock(t.pickedUpAt)}.`;
      return t.answer?.summary ?? t.answer?.subject ?? "Answered.";
    case "failed":
      if (t.reason === "not_allowed") {
        const by = t.steps.find((s) => s.kind === "denied")?.by;
        return by ? `Not allowed by ${by.name}.` : "Not allowed.";
      }
      if (t.reason === "withdrawn") return "Withdrawn before delivery: the Portico was paused or deleted, or one of the two agents left the Portico.";
      if (t.reason === "expired") {
        return t.heldAt && !t.steps.some((s) => s.kind === "allowed")
          ? `Expired: no decision within ${TASK_WINDOW}.`
          : `Expired before ${t.to.label} checked for messages.`;
      }
      return `No answer within ${TASK_WINDOW}.`;
  }
}

/** The When column: the start time, plus how long the answer took once done. A task done at pickup has no answer to time. */
function taskWhen(t: TaskView): string {
  const at = clock(t.startedAt);
  return t.outcome === "done" && t.endedAt && t.answer ? `${at}, ${duration(t.startedAt, t.endedAt)}` : at;
}

/** "Grok Bot → Codex", or on an agent's own page, "To Codex" or "From Grok Bot". */
function who(t: TaskView, from: AgentRef, to: AgentRef, perspective: string | null): string {
  if (perspective === t.from.id) return `To ${esc(to.label)}`;
  if (perspective === t.to.id) return `From ${esc(from.label)}`;
  return `${esc(from.label)} <span aria-label="to">→</span> ${esc(to.label)}`;
}

const STEP_LABEL: Record<TaskView["steps"][number]["kind"], (t: TaskView, by: string | null, always: boolean, agent: string | null) => string> = {
  // A message that needs no reply asks for nothing.
  asked: (t) => (t.noReplyNeeded ? "Sent" : "Asked"),
  allowed: (_t, by, always) => `${always ? "Always allowed" : "Allowed once"}${by ? ` by ${by}` : ""}`,
  denied: (_t, by) => `Not allowed${by ? ` by ${by}` : ""}`,
  picked_up: (t) => `Picked up by ${t.to.label}`,
  expired: () => "Expired",
  withdrawn: () => "Withdrawn",
  answered: () => "Answered",
  // A question one of the two agents asked its own person: who and when, never what.
  input_asked: (_t, by, _always, agent) => `${agent ?? "An agent"} asked ${by ?? "a person"}`,
  input_answered: (_t, by) => `Answered by ${by ?? "a person"}`,
  input_skipped: (_t, by) => `Skipped by ${by ?? "a person"}`,
  input_expired: (_t, by) => `No answer from ${by ?? "a person"}`,
  input_withdrawn: () => "Question withdrawn",
};

function renderSteps(t: TaskView): string {
  return `<ol class="steps-row" aria-label="Steps">${t.steps
    .map((step) => {
      const label = STEP_LABEL[step.kind](t, step.by?.name || null, step.decision === "always_allow", step.agent?.label ?? null);
      return `<li><span class="step-label">${esc(label)}</span><span class="tnum step-at">${clock(step.at)}</span></li>`;
    })
    .join("")}</ol>`;
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** The files a message carries: each name downloads the file. Files come from an agent, so they never open in the page. */
export function renderFiles(files: FileView[]): string {
  if (files.length === 0) return "";
  return `<ul class="files" aria-label="Files">${files
    .map(
      (f) =>
        `<li class="file"><a href="/api/files/${encodeURIComponent(f.id)}" download="${esc(f.name)}">${esc(f.name)}</a><span class="file-size tnum">${fileSize(f.size)}</span></li>`,
    )
    .join("")}</ul>`;
}

/** Longer messages show their first lines until opened. */
const LONG_MESSAGE = 600;

function renderMessage(m: MessageView, s: HomeState): string {
  const shown = s.shownMessages[m.id] === true;
  const long = Array.from(m.text).length > LONG_MESSAGE;
  const text = long && !shown ? `${Array.from(m.text).slice(0, LONG_MESSAGE).join("")}…` : m.text;
  return `<li class="tmsg" data-key="tm-${esc(m.id)}">
    <div class="tmsg-head">${logo(m.from.kind, "logo-sm")}<strong>${esc(m.from.label)}</strong>${when(m.noReplyNeeded, `<span class="pill pill-event tmsg-tag">No reply needed</span>`)}<span class="tnum tmsg-at">${clock(m.createdAt)}</span></div>
    <p class="tmsg-subject">${esc(m.subject)}</p>
    <p class="tmsg-text">${esc(text)}</p>
    ${when(long, `<button type="button" class="morebtn" data-action="message-toggle" data-id="${esc(m.id)}" aria-expanded="${shown}">${shown ? "Show less" : "Show all"}</button>`)}
    ${renderFiles(m.files)}
  </li>`;
}

/** A task row opened: its steps, then every message in it, oldest first. */
function renderOpened(s: HomeState, t: TaskView, detail: TaskDetail | null): string {
  const messages = detail
    ? `<ol class="tmsgs" aria-label="Messages">${detail.messages.map((m) => renderMessage(m, s)).join("")}</ol>`
    : `<p class="help">Loading the messages.</p>`;
  const decision = t.heldMessageId ? s.held.find((m) => m.id === t.heldMessageId) : undefined;
  return `<div class="trow-open enter" data-key="to-${esc(t.id)}">
    ${renderSteps(t)}
    ${messages}
    ${when(t.questions.length > 0, () => `<ol class="tmsgs" aria-label="Questions">${t.questions.map((q) => renderTaskQuestion(s, q)).join("")}</ol>`)}
    ${when(decision, () => decideRows(s, decision!))}
  </div>`;
}

/** One task: status, task (subject and where it stands), who, when. Opening it shows the steps and messages. */
export function renderTaskRow(s: HomeState, t: TaskView, perspective: string | null = null): string {
  const open = t.id in s.openTasks;
  return `<li class="trow${when(open, " is-open")}" data-key="t-${esc(t.id)}">
    <button type="button" class="trow-main" data-action="task-toggle" data-id="${esc(t.id)}" aria-expanded="${open}">
      <span class="trow-status">${taskPill(t)}</span>
      <span class="trow-task"><span class="trow-subject">${esc(t.subject)}</span><span class="trow-line">${esc(taskLine(t))}${when(t.readOnly, () => ` ${esc(readOnlyLine(t))}`)}</span></span>
      <span class="trow-who">${who(t, t.from, t.to, perspective)}</span>
      <span class="trow-when tnum">${taskWhen(t)}</span>
    </button>
    ${when(open, () => renderOpened(s, t, s.openTasks[t.id] ?? null))}
  </li>`;
}

/** Why nothing new goes in a conversation: its Portico stopped joining the two agents. */
export function readOnlyLine(t: TaskView): string {
  return `Read-only: ${t.portico || "a deleted Portico"} no longer joins ${t.from.label} and ${t.to.label}.`;
}

/** The column heads above a list of task rows; hidden on phones, where each row stacks. */
export function taskHead(): string {
  return `<li class="trow-head" aria-hidden="true"><span>Status</span><span>Task</span><span>Who</span><span>When</span></li>`;
}

// ---- decisions ----

/** Don't allow, Always allow <sender> and Allow once on a held message: the primary action last, at the right. */
/**
 * What Always allow covers, as the held message's own page names it: the sender's computer (every session there), the
 * other person for a first contact, or the sender.
 */
function alwaysName(s: HomeState, m: HeldCard): string {
  if (m.facts.heldFor === "first_contact") return m.facts.managedBy.name;
  return s.agents.find((a) => a.id === m.from.id)?.computer?.name ?? m.from.label;
}

/**
 * The decision on a held message, laid out as every decision is: the row that lets the message through first, Allow
 * once as the one filled button with Always allow beside it, then a quieter row under a rule. That row starts with
 * the way out, Don't allow, and ends with `links`, the ways to look closer. The page reads and tabs in that order.
 */
export function decideRows(s: HomeState, m: HeldCard, links = ""): string {
  const busy = s.busy === `decide:${m.id}`;
  const id = esc(m.id);
  return `<div class="actions">
      ${when(m.facts.heldFor !== "outbound" || m.facts.newSender, () => `<button type="button" class="btn btn-secondary" data-action="decide" data-id="${id}" data-decision="always_allow"${when(busy, " disabled")}>Always allow <span class="btn-name">${esc(alwaysName(s, m))}</span></button>`)}
      <button type="button" class="btn btn-primary" data-action="decide" data-id="${id}" data-decision="allow_once"${when(busy, " disabled")}>Allow once</button>
    </div>
    <div class="actions-quiet">
      <button type="button" class="btn btn-deny" data-action="decide" data-id="${id}" data-decision="deny"${when(busy, " disabled")}>Don't allow</button>
      ${when(links, `<span class="actions-links">${links}</span>`)}
    </div>`;
}

/** Why the message waits, in Portico's own words: never anything the sender wrote. */
function heldReason(s: HomeState, m: HeldCard): string {
  const parts: string[] = [];
  // A sender nobody confirmed is always one of the reader's own agents, so the day it was added is in the page's state.
  const added = s.agents.find((a) => a.id === m.from.id)?.createdAt;
  const newAgent = `${added ? `New agent, added ${date(added, s.now)}.` : "New agent."} You haven't confirmed this agent yet.`;
  if (m.facts.heldFor === "outbound" && m.facts.newSender) return `${newAgent} ${s.me.name} sees what ${m.from.label} sends to other people's agents first. Nothing has reached ${m.to.label}. Always allow confirms ${m.from.label}. Not started by ${s.me.name}? Choose Don't allow, then revoke ${m.from.label} on the agent's page.`;
  if (m.facts.heldFor === "outbound") return `${m.from.label} sends to other people's agents only once ${s.me.name} has seen each message. Nothing has reached ${m.to.label}.`;
  if (m.facts.heldFor === "new_agent") return `${newAgent} This is the first message from ${m.from.label} to ${m.to.label}. Not started by ${s.me.name}? Choose Don't allow, then revoke ${m.from.label} on the agent's page.`;
  if (m.facts.heldFor === "first_contact") parts.push(`${s.me.name} hasn't allowed messages from ${m.facts.managedBy.name}'s agents yet.`);
  if (m.facts.replyToRecipient) parts.push(`Follows a message from ${m.to.label}, but starts a new conversation.`);
  else if (m.facts.earlier.length === 0) parts.push(`First time ${m.from.label} has asked ${m.to.label} for anything, and new contacts need approval.`);
  else parts.push(`New contacts need approval. ${m.from.label} has asked before.`);
  if (m.facts.managedBy.id !== s.me.id) parts.push(`${m.from.label} is managed by ${m.facts.managedBy.name}.`);
  parts.push(expiresIn(m.expiresAt, s.now));
  return parts.join(" ");
}

/**
 * A held message: who wants what, why it waits, and the decision. Show message opens the text. A message that needs
 * no reply asks for nothing, so its heading calls it a note.
 */
export function renderHeldCard(s: HomeState, m: HeldCard): string {
  const shown = s.shownMessages[m.id] === true;
  return `<article class="dcard" aria-labelledby="dc-${esc(m.id)}" data-key="dc-${esc(m.id)}">
    <div class="dcard-head">${logo(m.from.kind, "", kindInfo(m.from.kind).label)}<div class="grow">
      <h3 id="dc-${esc(m.id)}" class="dcard-title">${esc(m.from.label)} ${m.noReplyNeeded ? "has a note for" : "wants to ask"} ${esc(m.to.label)}: ${esc(m.subject)}</h3>
      <p class="dcard-why tnum">${esc(heldReason(s, m))}</p>
      ${when(m.noReplyNeeded, `<p class="dcard-why">No reply needed.</p>`)}
    </div></div>
    ${when(shown, () => `<div class="msg-box enter" data-key="dm-${esc(m.id)}"><p class="msg-full">${esc(m.text)}</p></div>`)}
    ${renderFiles(m.files)}
    ${decideRows(
      s,
      m,
      `<button type="button" class="btn btn-link" data-action="message-toggle" data-id="${esc(m.id)}" aria-expanded="${shown}">${shown ? "Hide message" : "Show message"}</button><a class="btn btn-link" href="/held/${encodeURIComponent(m.id)}">Open the page</a>`,
    )}
  </article>`;
}

/**
 * An agent asked the person for something only the person can allow. The answer is given on the consent page, with
 * Allow or Don't allow: this card only leads there.
 */
export function renderConsentCard(s: HomeState, r: ConsentCard): string {
  return `<article class="dcard" aria-labelledby="dq-${esc(r.id)}" data-key="dq-${esc(r.id)}">
    <div class="dcard-head"><div class="grow">
      <h3 id="dq-${esc(r.id)}" class="dcard-title">${esc(r.title)}</h3>
      <p class="dcard-why tnum">${esc(r.asks)} ${expiresIn(r.expiresAt, s.now)}</p>
    </div></div>
    <div class="actions"><a class="btn btn-primary" href="${esc(r.link)}">Open the page</a></div>
  </article>`;
}

// ---- input needed ----

/** How a question that no longer waits ended, for the person it was asked: the person's own answer included. */
function questionOutcome(q: QuestionCard): string {
  if (q.status === "answered" && q.answer) {
    const parts = [q.answer.option, q.answer.text].filter((part): part is string => part !== null && part !== "");
    return `Answered at ${clock(q.answer.at)}: ${parts.join(". ")}`;
  }
  if (q.status === "skipped") return `Skipped${q.endedAt ? ` at ${clock(q.endedAt)}` : ""}.`;
  if (q.status === "expired") return "No answer in time: the question lapsed.";
  if (q.status === "withdrawn") return "Withdrawn: the agent was revoked or removed.";
  return "";
}

/**
 * How a waiting question is answered, laid out as every decision is. The choices come first, stacked at one width in
 * the order the agent gave them: one press on a choice sends it, so on a question with choices they are the main
 * action and nothing beside them looks like a button. A question with no choices starts with the text box and Send
 * answer, the one filled button; "Answer in your own words" opens the same box under the choices. Then a quieter row
 * under a rule: Skip, which tells the agent there is no answer and stops nothing, and the ways to look closer.
 */
function questionActions(s: HomeState, q: QuestionCard, slot: "card" | "task"): string {
  const id = esc(q.id);
  // The same question can show on its card and in its task: each text box needs an ID of its own.
  const box = `qa-${slot}-${id}`;
  const busy = s.busy === `question:${q.id}`;
  const off = when(busy, " disabled");
  const options = q.options ?? [];
  const typing = options.length === 0 || s.answerOpen[q.id] === true;
  const text = s.answerText[q.id] ?? "";
  return `${when(
    options.length > 0,
    () => `<div class="choices" role="group" aria-label="Choices">${options.map((option, i) => `<button type="button" class="btn btn-choice" data-action="q-answer" data-id="${id}" data-option="${i}"${off}>${esc(option)}</button>`).join("")}</div>`,
  )}
    ${when(
      typing,
      () => `<label class="sr" for="${box}">Your answer to ${esc(q.agent.label)}</label><textarea id="${box}" class="field q-text" rows="2" maxlength="1000" placeholder="Your answer to ${esc(q.agent.label)}" data-input="q-text:${id}">${esc(text)}</textarea>
    <div class="actions"><button type="button" class="btn btn-primary" data-action="q-send" data-id="${id}"${off}>Send answer</button></div>`,
    )}
    <div class="actions-quiet">
      <button type="button" class="btn btn-quiet" data-action="q-skip" data-id="${id}"${off}>Skip</button>
      <span class="actions-links">${when(options.length > 0 && !typing, `<button type="button" class="btn btn-link" data-action="q-open" data-id="${id}">Answer in your own words</button>`)}<a class="btn btn-link" href="/q/${encodeURIComponent(q.id)}">Open the page</a></span>
    </div>`;
}

/** The warning on a question from an agent its person hasn't confirmed yet: the words a held message's card says. */
function newAgentWarning(s: HomeState, q: QuestionCard): string {
  return when(q.newAgent, () => `<p class="dcard-why q-new"><strong>New agent, added ${esc(date(q.newAgent!.addedAt, s.now))}.</strong> You haven't confirmed this agent yet.</p>`);
}

/**
 * Something one of the person's own agents asked the person. The heading and the line under it are Portico's; the
 * question, the background and the choices are the agent's words, in a box of their own.
 */
export function renderQuestionCard(s: HomeState, q: QuestionCard): string {
  const id = esc(q.id);
  return `<article class="dcard qcard" aria-labelledby="di-${id}" data-key="di-${id}">
    <div class="dcard-head">${logo(q.agent.kind, "", kindInfo(q.agent.kind).label)}<div class="grow">
      <h3 id="di-${id}" class="dcard-title">${esc(q.agent.label)} needs your input</h3>
      <p class="dcard-why tnum">${when(q.task, () => `For the task “${esc(q.task!.subject)}”. `)}Only you can answer. ${expiresIn(q.expiresAt, s.now)}</p>
      ${newAgentWarning(s, q)}
    </div></div>
    <div class="msg-box"><p class="q-question">${esc(q.question)}</p>${when(q.detail, () => `<p class="msg-full">${esc(q.detail)}</p>`)}</div>
    ${questionActions(s, q, "card")}
  </article>`;
}

/** A question in its task, opened: shown only to the person it was asked, with the answer or the way to give one. */
function renderTaskQuestion(s: HomeState, q: QuestionCard): string {
  const waiting = q.status === "waiting" && s.questions.some((card) => card.id === q.id);
  return `<li class="tmsg tmsg-q" data-key="tq-${esc(q.id)}">
    <div class="tmsg-head">${logo(q.agent.kind, "logo-sm")}<strong>${esc(q.agent.label)}</strong><span class="pill pill-waiting tmsg-tag">Question for ${esc(s.me.name)}</span><span class="tnum tmsg-at">${clock(q.createdAt)}</span></div>
    <p class="tmsg-subject">${esc(q.question)}</p>
    ${when(q.detail, () => `<p class="tmsg-text">${esc(q.detail)}</p>`)}
    ${waiting ? questionActions(s, q, "task") : `<p class="tmsg-text q-outcome">${esc(q.status === "waiting" ? "Waiting for an answer." : questionOutcome(q))}</p>`}
  </li>`;
}

/** A coding agent stopped to ask something in its own terminal: the answer goes there, not through Portico. */
export function renderWaitingCard(s: HomeState, a: AgentView): string {
  const where = a.computer ? ` on ${a.computer.name}` : "";
  return `<article class="dcard" aria-labelledby="dw-${esc(a.id)}" data-key="dw-${esc(a.id)}">
    <div class="dcard-head">${logo(a.kind, "", kindInfo(a.kind).label)}<div class="grow">
      <h3 id="dw-${esc(a.id)}" class="dcard-title">${esc(a.label)} has a question</h3>
      <p class="dcard-why">${a.doing ? `${esc(a.doing)}. ` : ""}Answer in the terminal${esc(where)}.</p>
    </div></div>
    <div class="actions"><button type="button" class="btn btn-secondary" data-action="open-agent" data-id="${esc(a.id)}">Open ${esc(a.label)}</button></div>
  </article>`;
}

/** The person avatar beside a name managed by someone else. */
export function managedBy(owner: { id: string; name: string }): string {
  return `<span class="managed">${pav(owner)}Managed by ${esc(owner.name)}</span>`;
}

/** The signed-in person's coding agents stopped on a question in their terminal. */
export function waitingAgents(s: HomeState): AgentView[] {
  return s.agents.filter((a) => a.mine && a.type === "session" && agentState(a, s.now).label === "Has a question");
}
