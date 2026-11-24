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
    ${when(decision, () => decideRow(s, decision!))}
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

// A decision card is read and acted on in a few seconds, so it carries four things and no more: one line of who and
// what, the question or the subject, the answers, and one small line of grey text. Everything else is on the full page.
// What an agent wrote never stands as Portico's own words: a subject, a question and what goes with it sit in a quote
// (a rule down the left, as on the full pages), and a task's name inside a heading is in quotation marks.

/**
 * The card's one small line: when the decision lapses, and before that, for an agent its person hasn't confirmed
 * yet, that the agent is new and when it was added. The whole sentence about a new agent is on the full page.
 */
function cardNote(s: HomeState, expiresAt: string, newAgent: { addedAt: string | null } | null): string {
  const expires = expiresIn(expiresAt, s.now).replace(/\.$/, "");
  // With the warning in front, the day is enough: the line stays one line on a phone.
  if (newAgent) return `<p class="dcard-note tnum"><strong>${newAgent.addedAt ? `New agent, added ${esc(date(newAgent.addedAt, s.now))}` : "New agent"}</strong> · ${esc(expires.replace(/ at \d.*$/, ""))}</p>`;
  return `<p class="dcard-note tnum">${esc(expires)}</p>`;
}

/**
 * The two answers to a held message, on one line at one width: Don't allow, then Allow as the one filled button.
 * Allow lets this one message through. Always allow is a tick on the message's own page, where there is room to
 * say what it covers.
 */
export function decideRow(s: HomeState, m: HeldCard): string {
  const busy = s.busy === `decide:${m.id}`;
  const id = esc(m.id);
  return `<div class="actions actions-pair">
      <button type="button" class="btn btn-plain" data-action="decide" data-id="${id}" data-decision="deny"${when(busy, " disabled")}>Don't allow</button>
      <button type="button" class="btn btn-primary" data-action="decide" data-id="${id}" data-decision="allow_once"${when(busy, " disabled")}>Allow</button>
    </div>`;
}

/**
 * A held message: who wants to message whom, the subject, and the two answers. The card itself opens the message's
 * page: the heading is the link and its hit area covers the card, under the two buttons. A message that needs no
 * reply asks for nothing, so its heading calls it a note.
 */
export function renderHeldCard(s: HomeState, m: HeldCard): string {
  const id = esc(m.id);
  // A sender nobody confirmed is always one of the reader's own agents, so the day it was added is in the page's state.
  const isNew = m.facts.heldFor === "new_agent" || (m.facts.heldFor === "outbound" && m.facts.newSender);
  const newAgent = isNew ? { addedAt: s.agents.find((a) => a.id === m.from.id)?.createdAt ?? null } : null;
  return `<article class="dcard dcard-opens" aria-labelledby="dc-${id}" data-key="dc-${id}">
    <div class="dcard-head">${logo(m.from.kind, "", kindInfo(m.from.kind).label)}<div class="grow">
      <h3 id="dc-${id}" class="dcard-title"><a class="dcard-link" href="/held/${encodeURIComponent(m.id)}">${esc(m.from.label)} ${m.noReplyNeeded ? "has a note for" : "wants to message"} ${esc(m.to.label)}</a></h3>
      ${cardNote(s, m.expiresAt, newAgent)}
    </div></div>
    <blockquote class="dcard-quote"><p class="dcard-subject">${esc(m.subject)}</p></blockquote>
    ${decideRow(s, m)}
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
 * The answers to a waiting question, one under another at one width. The agent's choices come first, in the agent's
 * order: one press on a choice sends it. Last, and quieter so nobody takes it for a choice the agent gave, "Other
 * answer…" opens the question's own page, where the person answers in words or skips. A question with no choices has
 * one button, "Answer…", to the same page.
 */
function questionAnswers(s: HomeState, q: QuestionCard): string {
  const id = esc(q.id);
  const off = when(s.busy === `question:${q.id}`, " disabled");
  const options = q.options ?? [];
  const page = `/q/${encodeURIComponent(q.id)}`;
  if (options.length === 0) return `<div class="choices"><a class="btn btn-primary" href="${page}">Answer…</a></div>`;
  return `<div class="choices">${options.map((option, i) => `<button type="button" class="btn btn-choice" data-action="q-answer" data-id="${id}" data-option="${i}"${off}>${esc(option)}</button>`).join("")}<a class="btn btn-other" href="${page}">Other answer…</a></div>`;
}

/**
 * Something one of the person's own agents asked the person. The heading is Portico's; the question, what the agent
 * says about it and the choices are the agent's words.
 */
export function renderQuestionCard(s: HomeState, q: QuestionCard): string {
  const id = esc(q.id);
  return `<article class="dcard qcard" aria-labelledby="di-${id}" data-key="di-${id}">
    <div class="dcard-head">${logo(q.agent.kind, "", kindInfo(q.agent.kind).label)}<div class="grow">
      <h3 id="di-${id}" class="dcard-title">${esc(q.agent.label)} asks you${when(q.task, () => `<span class="dcard-about">“${esc(q.task!.subject)}”</span>`)}</h3>
      ${cardNote(s, q.expiresAt, q.newAgent)}
    </div></div>
    <blockquote class="dcard-quote"><p class="dcard-subject">${esc(q.question)}</p>${when(q.detail, () => `<p class="dcard-detail">${esc(q.detail)}</p>`)}</blockquote>
    ${questionAnswers(s, q)}
  </article>`;
}

/** A question in its task, opened: shown only to the person it was asked, with the answer or the way to give one. */
function renderTaskQuestion(s: HomeState, q: QuestionCard): string {
  const waiting = q.status === "waiting" && s.questions.some((card) => card.id === q.id);
  return `<li class="tmsg tmsg-q" data-key="tq-${esc(q.id)}">
    <div class="tmsg-head">${logo(q.agent.kind, "logo-sm")}<strong>${esc(q.agent.label)}</strong><span class="pill pill-waiting tmsg-tag">Question for ${esc(s.me.name)}</span><span class="tnum tmsg-at">${clock(q.createdAt)}</span></div>
    <p class="tmsg-subject">${esc(q.question)}</p>
    ${when(q.detail, () => `<p class="tmsg-text">${esc(q.detail)}</p>`)}
    ${waiting ? questionAnswers(s, q) : `<p class="tmsg-text q-outcome">${esc(q.status === "waiting" ? "Waiting for an answer." : questionOutcome(q))}</p>`}
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
