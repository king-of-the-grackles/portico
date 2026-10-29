// Tasks and decisions, shared by Today, Activity and the agent pages: one row per task (status, task, who, when) whose
// steps open inside the row, and the cards for what needs a person's decision. Pure: state in, HTML out.
import { agentState, clock, duration, esc, expiresIn, kindInfo, logo, pav, when } from "./common.js";
import type { AgentRef, AgentView, HeldCard, HomeState, MessageView, SignInView, TaskDetail, TaskOutcome, TaskView } from "./types.js";

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

/** The task's second line: the answer's summary when done, otherwise where it stands. */
export function taskLine(t: TaskView): string {
  switch (t.outcome) {
    case "needs_approval":
      return "New contact, waiting for approval.";
    case "in_progress":
      if (t.answer) return `Update from ${t.to.label}: ${t.answer.summary ?? t.answer.subject}`;
      if (t.pickedUpAt) return `Picked up at ${clock(t.pickedUpAt)}, no answer yet.`;
      return `Queued until ${t.to.label} checks for messages.`;
    case "done":
      return t.answer?.summary ?? t.answer?.subject ?? "Answered.";
    case "failed":
      if (t.reason === "not_allowed") {
        const by = t.steps.find((s) => s.kind === "denied")?.by;
        return by ? `Not allowed by ${by.name}.` : "Not allowed.";
      }
      if (t.reason === "expired") {
        return t.heldAt && !t.steps.some((s) => s.kind === "allowed")
          ? `Expired: no decision within ${TASK_WINDOW}.`
          : `Expired before ${t.to.label} checked for messages.`;
      }
      return `No answer within ${TASK_WINDOW}.`;
  }
}

/** The When column: the start time, plus how long it took once done. */
function taskWhen(t: TaskView): string {
  const at = clock(t.startedAt);
  return t.outcome === "done" && t.endedAt ? `${at}, ${duration(t.startedAt, t.endedAt)}` : at;
}

/** "Grok Bot → Codex", or on an agent's own page, "To Codex" or "From Grok Bot". */
function who(t: TaskView, from: AgentRef, to: AgentRef, perspective: string | null): string {
  if (perspective === t.from.id) return `To ${esc(to.label)}`;
  if (perspective === t.to.id) return `From ${esc(from.label)}`;
  return `${esc(from.label)} <span aria-label="to">→</span> ${esc(to.label)}`;
}

const STEP_LABEL = {
  asked: () => "Asked",
  allowed: (_t: TaskView, by: string | null, always: boolean) => `${always ? "Always allowed" : "Allowed once"}${by ? ` by ${by}` : ""}`,
  denied: (_t: TaskView, by: string | null) => `Not allowed${by ? ` by ${by}` : ""}`,
  picked_up: (t: TaskView) => `Picked up by ${t.to.label}`,
  expired: () => "Expired",
  answered: () => "Answered",
} as const;

function renderSteps(t: TaskView): string {
  return `<ol class="steps-row" aria-label="Steps">${t.steps
    .map((step) => {
      const label = STEP_LABEL[step.kind](t, step.by?.name ?? null, step.decision === "always_allow");
      return `<li><span class="step-label">${esc(label)}</span><span class="tnum step-at">${clock(step.at)}</span></li>`;
    })
    .join("")}</ol>`;
}

/** Longer messages show their first lines until opened. */
const LONG_MESSAGE = 600;

function renderMessage(m: MessageView, s: HomeState): string {
  const shown = s.shownMessages[m.id] === true;
  const long = Array.from(m.text).length > LONG_MESSAGE;
  const text = long && !shown ? `${Array.from(m.text).slice(0, LONG_MESSAGE).join("")}…` : m.text;
  return `<li class="tmsg" data-key="tm-${esc(m.id)}">
    <div class="tmsg-head">${logo(m.from.kind, "logo-sm")}<strong>${esc(m.from.label)}</strong><span class="tnum tmsg-at">${clock(m.createdAt)}</span></div>
    <p class="tmsg-subject">${esc(m.subject)}</p>
    <p class="tmsg-text">${esc(text)}</p>
    ${when(long, `<button type="button" class="morebtn" data-action="message-toggle" data-id="${esc(m.id)}" aria-expanded="${shown}">${shown ? "Show less" : "Show all"}</button>`)}
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
    ${when(decision, () => `<div class="actions">${decideButtons(s, decision!)}</div>`)}
  </div>`;
}

/** One task: status, task (subject and where it stands), who, when. Opening it shows the steps and messages. */
export function renderTaskRow(s: HomeState, t: TaskView, perspective: string | null = null): string {
  const open = t.id in s.openTasks;
  return `<li class="trow${when(open, " is-open")}" data-key="t-${esc(t.id)}">
    <button type="button" class="trow-main" data-action="task-toggle" data-id="${esc(t.id)}" aria-expanded="${open}">
      <span class="trow-status">${statusPill(t.outcome)}</span>
      <span class="trow-task"><span class="trow-subject">${esc(t.subject)}</span><span class="trow-line">${esc(taskLine(t))}</span></span>
      <span class="trow-who">${who(t, t.from, t.to, perspective)}</span>
      <span class="trow-when tnum">${taskWhen(t)}</span>
    </button>
    ${when(open, () => renderOpened(s, t, s.openTasks[t.id] ?? null))}
  </li>`;
}

/** The column heads above a list of task rows; hidden on phones, where each row stacks. */
export function taskHead(): string {
  return `<li class="trow-head" aria-hidden="true"><span>Status</span><span>Task</span><span>Who</span><span>When</span></li>`;
}

// ---- decisions ----

/** Don't allow, Always allow <sender> and Allow once on a held message: the primary action last, at the right. */
export function decideButtons(s: HomeState, m: HeldCard): string {
  const busy = s.busy === `decide:${m.id}`;
  const id = esc(m.id);
  return `<button type="button" class="btn btn-text" data-action="decide" data-id="${id}" data-decision="deny"${when(busy, " disabled")}>Don't allow</button>
      <button type="button" class="btn btn-secondary" data-action="decide" data-id="${id}" data-decision="always_allow"${when(busy, " disabled")}>Always allow ${esc(m.from.label)}</button>
      <button type="button" class="btn btn-primary" data-action="decide" data-id="${id}" data-decision="allow_once"${when(busy, " disabled")}>Allow once</button>`;
}

/** Why the message waits, in Portico's own words: never anything the sender wrote. */
function heldReason(s: HomeState, m: HeldCard): string {
  const parts: string[] = [];
  if (m.facts.replyToRecipient) parts.push(`Follows a message from ${m.to.label}, but starts a new conversation.`);
  else if (m.facts.earlier.length === 0) parts.push(`First time ${m.from.label} has asked ${m.to.label} for anything, and new contacts need approval.`);
  else parts.push(`New contacts need approval. ${m.from.label} has asked before.`);
  if (m.facts.managedBy.id !== s.me.id) parts.push(`${m.from.label} is managed by ${m.facts.managedBy.name}.`);
  parts.push(expiresIn(m.expiresAt, s.now));
  return parts.join(" ");
}

/** A held message: who wants what, why it waits, and the decision. Show message opens the text. */
export function renderHeldCard(s: HomeState, m: HeldCard): string {
  const shown = s.shownMessages[m.id] === true;
  return `<article class="dcard" aria-labelledby="dc-${esc(m.id)}" data-key="dc-${esc(m.id)}">
    <div class="dcard-head">${logo(m.from.kind, "", kindInfo(m.from.kind).label)}<div class="grow">
      <h3 id="dc-${esc(m.id)}" class="dcard-title">${esc(m.from.label)} wants to ask ${esc(m.to.label)}: ${esc(m.subject)}</h3>
      <p class="dcard-why tnum">${esc(heldReason(s, m))}</p>
    </div></div>
    ${when(shown, () => `<div class="msg-box enter" data-key="dm-${esc(m.id)}"><p class="msg-full">${esc(m.text)}</p></div>`)}
    <div class="actions">
      <button type="button" class="btn btn-link start" data-action="message-toggle" data-id="${esc(m.id)}" aria-expanded="${shown}">${shown ? "Hide message" : "Show message"}</button>
      ${decideButtons(s, m)}
    </div>
  </article>`;
}

/** An app asks to join: compare the 4-digit code with the one in its chat. */
export function renderSignInCard(s: HomeState, r: SignInView): string {
  const kind = kindInfo(r.kind).label;
  const busy = s.busy === `signin:${r.id}`;
  return `<article class="dcard" aria-labelledby="ds-${esc(r.id)}" data-key="ds-${esc(r.id)}">
    <div class="dcard-head">${logo(r.kind, "", kind)}<div class="grow">
      <h3 id="ds-${esc(r.id)}" class="dcard-title">${esc(kind)} wants to join Portico as ${esc(r.name)}</h3>
      <p class="dcard-why tnum">Approve only if ${esc(kind)} shows the code <strong class="code-inline">${esc(r.code)}</strong>. ${expiresIn(r.expiresAt, s.now)}</p>
    </div></div>
    <div class="actions">
      <button type="button" class="btn btn-text" data-action="signin-deny" data-id="${esc(r.id)}"${when(busy, " disabled")}>Don't allow</button>
      <button type="button" class="btn btn-primary" data-action="signin-approve" data-id="${esc(r.id)}"${when(busy, " disabled")}>Approve ${esc(r.name)}</button>
    </div>
  </article>`;
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
