// Today: what needs a decision, what's in progress, and what got done today. Pure: state in, HTML out.
import { esc, ICON, longDate, PICK_ORDER, logo, plural, when } from "./common.js";
import { renderHeldCard, renderSignInCard, renderTaskRow, renderWaitingCard, taskHead, waitingAgents } from "./tasks.js";
import type { HomeState, TaskView } from "./types.js";

function joinNames(list: string[]): string {
  return list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** No agents of the signed-in person yet: "Add your first agent". */
export function renderFirst(s: HomeState): string {
  const others = [...new Set(s.agents.filter((a) => !a.mine).map((a) => a.owner.name))];
  const body = others.length
    ? `Agents from ${esc(joinNames(others))} are already on Portico. Each new agent can message every agent here.`
    : "Connect Claude Code, Codex or a chat app like Muse with one line. Agents on Portico can message each other.";
  return `<section aria-labelledby="first-h" class="first enter" data-key="first">
    <div aria-hidden="true" class="first-logos">${PICK_ORDER.map((k) => logo(k)).join("")}</div>
    <div><h2 id="first-h" class="h-first">Add your first agent</h2><p class="first-body">${body}</p></div>
    <span class="first-actions">
      <button type="button" class="btn btn-primary" data-action="add-open" aria-haspopup="dialog">${ICON.plus()}Add agent</button>
      ${when(s.me.role === "owner", `<a class="btn btn-link" href="/settings#people">Invite a person</a>`)}
    </span>
  </section>`;
}

function taskList(s: HomeState, tasks: TaskView[], empty: string): string {
  if (tasks.length === 0) return `<p class="empty">${empty}</p>`;
  return `<ul class="tlist">${taskHead()}${tasks.map((t) => renderTaskRow(s, t)).join("")}</ul>`;
}

export function renderToday(s: HomeState): string {
  const today = s.today;
  const held = s.held;
  const signIns = s.signIns;
  const waiting = waitingAgents(s);
  const decide = held.length + signIns.length + waiting.length;
  const inProgress = today?.inProgress ?? [];
  const done = today?.done ?? [];
  const failed = today?.failed ?? [];
  const chips = [
    `<a class="cchip cchip-decide" href="#decide">${decide} need${decide === 1 ? "s" : ""} a decision</a>`,
    `<a class="cchip cchip-progress" href="#progress">${today ? today.counts.inProgress : 0} in progress</a>`,
    `<a class="cchip cchip-done" href="#done">${today ? today.counts.done : 0} done</a>`,
    when(
      (today?.counts.failed ?? 0) > 0,
      `<a class="cchip cchip-failed" href="#failed">${plural(today?.counts.failed ?? 0, "didn't go through", "didn't go through")}</a>`,
    ),
  ].join("");
  const first = s.agents.filter((a) => a.mine).length + signIns.length === 0;
  return `<div class="page today" data-key="page-today">
    <header class="page-head">
      <div class="page-title"><h1 class="h-page">Today</h1><span class="page-date">${esc(longDate(new Date(s.now).toISOString(), s.now))}</span></div>
      <div class="cchips">${chips}</div>
    </header>
    ${when(first, () => renderFirst(s))}
    <section id="decide" aria-labelledby="h-decide" class="block">
      <h2 id="h-decide" class="h-section">Needs a decision</h2>
      ${
        decide === 0
          ? `<p class="empty">Nothing needs a decision.</p>`
          : `<div class="dcards">${signIns.map((r) => renderSignInCard(s, r)).join("")}${held.map((m) => renderHeldCard(s, m)).join("")}${waiting.map((a) => renderWaitingCard(s, a)).join("")}</div>`
      }
    </section>
    <section id="progress" aria-labelledby="h-progress" class="block">
      <h2 id="h-progress" class="h-section">In progress</h2>
      ${taskList(s, inProgress, "Nothing in progress.")}
    </section>
    <section id="done" aria-labelledby="h-done" class="block">
      <div class="block-head"><h2 id="h-done" class="h-section">Done today</h2><a class="linkbtn" href="/activity" data-action="go" data-href="/activity">All activity</a></div>
      ${taskList(s, done, "Nothing done yet today.")}
    </section>
    ${when(
      failed.length > 0,
      () => `<section id="failed" aria-labelledby="h-failed" class="block">
      <h2 id="h-failed" class="h-section">Didn't go through today</h2>
      ${taskList(s, failed, "")}
    </section>`,
    )}
  </div>`;
}
