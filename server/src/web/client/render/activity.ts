// Activity: every task, one row each, grouped by day, with status chips, Agent and Project filters, and (when asked)
// joins, sessions and setting changes among them. Pure: state in, HTML out.
import { clock, dayHeading, esc, ICON, sameDay, when } from "./common.js";
import { OUTCOME_LABEL, OUTCOME_ORDER, renderTaskRow, taskHead } from "./tasks.js";
import type { ActivityView, HomeState, TaskView } from "./types.js";

/** An activity entry's tag and line, in plain words. */
export function eventText(e: ActivityView): { tag: string; line: string; who: string } {
  const agent = e.agent?.label ?? (typeof e.detail.name === "string" ? e.detail.name : "An agent");
  const other = e.other?.label ?? "another agent";
  const person = e.person?.name ?? "";
  const onOff = (on: unknown) => (on === true ? "on" : "off");
  switch (e.kind) {
    case "session_started":
      return { tag: "Session", line: `${agent} started`, who: agent };
    case "session_ended":
      return { tag: "Session", line: `${agent} stopped`, who: agent };
    case "agent_joined":
      return { tag: "Joined", line: `${agent} joined Portico`, who: person };
    case "agent_removed":
      return { tag: "Removed", line: `${agent} removed from Portico`, who: person };
    case "computer_joined":
      return { tag: "Joined", line: `Computer ${String(e.detail.computer ?? "")} joined Portico`, who: person };
    case "decision": {
      const choice = e.detail.decision === "deny" ? "Not allowed" : e.detail.decision === "always_allow" ? "Always allowed" : "Allowed once";
      return { tag: "Decision", line: `${choice}: ${other} to ${agent}`, who: person };
    }
    case "sign_in_denied":
      return { tag: "Decision", line: `Not allowed to join: ${String(e.detail.name ?? "")}`, who: person };
    case "renamed":
      return { tag: "Setting", line: `Renamed ${String(e.detail.from ?? "")} to ${String(e.detail.to ?? "")}`, who: person };
    case "description_changed":
      // An agent can write its own description with update_profile; then the agent is the one who changed it.
      return { tag: "Setting", line: `Description of ${agent} changed`, who: e.detail.by === "agent" ? agent : person };
    case "approval_switched":
      return { tag: "Setting", line: `New contacts need approval for ${agent}: ${onOff(e.detail.on)}`, who: person };
    case "folder_switched":
      return { tag: "Setting", line: `New sessions join from the folder for ${agent}: ${onOff(e.detail.on)}`, who: person };
    case "allow_removed":
      return { tag: "Setting", line: `${other} taken off Always allow for ${agent}`, who: person };
    case "wake_set":
      return { tag: "Setting", line: `Wake URL for ${agent} set to ${String(e.detail.host ?? "")}`, who: person };
    case "wake_removed":
      return { tag: "Setting", line: `Wake URL for ${agent} removed`, who: person };
  }
}

function eventRow(e: ActivityView): string {
  const t = eventText(e);
  return `<li class="trow trow-event" data-key="e-${esc(e.id)}"><div class="trow-main">
    <span class="trow-status"><span class="pill pill-event">${esc(t.tag)}</span></span>
    <span class="trow-task"><span class="trow-subject">${esc(t.line)}</span></span>
    <span class="trow-who">${esc(t.who)}</span>
    <span class="trow-when tnum">${clock(e.at)}</span>
  </div></li>`;
}

type Row = { at: string; html: string };

/** Rows in time order, newest first, with a heading at each new day. */
function grouped(rows: Row[], now: number): string {
  const out: string[] = [];
  let last: string | null = null;
  for (const row of rows) {
    if (last === null || !sameDay(last, row.at)) {
      out.push(`<li class="tday" data-key="d-${esc(row.at.slice(0, 10))}-${out.length}"><h3 class="h-day">${esc(dayHeading(row.at, now))}</h3></li>`);
    }
    last = row.at;
    out.push(row.html);
  }
  return out.join("");
}

function filterSelect(id: string, label: string, all: string, value: string | null, options: [string, string][]): string {
  return `<label class="fsel" for="${id}"><span class="lbl">${label}</span><select id="${id}" class="field" data-input="${id}">
    <option value=""${when(value === null, " selected")}>${all}</option>
    ${options.map(([v, text]) => `<option value="${esc(v)}"${when(value === v, " selected")}>${esc(text)}</option>`).join("")}
  </select></label>`;
}

export function renderActivity(s: HomeState): string {
  const list = s.tasks;
  const counts = list?.counts ?? { needs_approval: 0, in_progress: 0, done: 0, failed: 0 };
  const total = OUTCOME_ORDER.reduce((n, o) => n + counts[o], 0);
  const chip = (outcome: (typeof OUTCOME_ORDER)[number] | null, label: string, n: number) => {
    const on = s.filter.outcome === outcome;
    return `<button type="button" class="fchip${when(on, " is-on")}" aria-pressed="${on}" data-action="outcome" data-id="${outcome ?? ""}">${label} <span class="tnum fchip-n">${n}</span></button>`;
  };
  const agentOptions: [string, string][] = s.agents.map((a) => [a.id, a.label]);
  const projectOptions: [string, string][] = (list?.projects ?? []).map((p) => [p, p]);
  const tasks: TaskView[] = list?.tasks ?? [];
  const rows: Row[] = tasks.map((t) => ({ at: t.startedAt, html: renderTaskRow(s, t) }));
  if (s.showEvents && s.events) {
    const oldest = list?.more && tasks.length > 0 ? tasks[tasks.length - 1]!.startedAt : null;
    // A project narrows the entries to its folder's agents, as it narrows the tasks.
    const inProject = s.filter.project
      ? new Set(s.agents.filter((a) => a.folder === s.filter.project).map((a) => a.id))
      : null;
    const shown = s.events.filter((e) => !inProject || (e.agent !== null && inProject.has(e.agent.id)));
    for (const e of shown) if (!oldest || e.at >= oldest) rows.push({ at: e.at, html: eventRow(e) });
    rows.sort((a, b) => b.at.localeCompare(a.at));
  }
  const filtered = s.filter.outcome !== null || s.filter.agent !== null || s.filter.project !== null;
  const empty = !list ? "Loading." : filtered ? "No tasks match these filters." : "No tasks yet. Tasks show up here when agents message each other.";
  return `<div class="page activity" data-key="page-activity">
    <header class="page-head"><div class="page-title"><h1 class="h-page">Activity</h1></div></header>
    <div class="filters">
      <div role="group" aria-label="Filter by status" class="fchips">
        ${chip(null, "All", total)}
        ${OUTCOME_ORDER.map((o) => chip(o, OUTCOME_LABEL[o], counts[o])).join("")}
      </div>
      <div class="fsels">
        ${filterSelect("filter-agent", "Agent", "All agents", s.filter.agent, agentOptions)}
        ${filterSelect("filter-project", "Project", "All projects", s.filter.project, projectOptions)}
      </div>
    </div>
    <button type="button" class="checkline" role="checkbox" aria-checked="${s.showEvents}" data-action="events-toggle"><span class="checkbox">${s.showEvents ? ICON.check(14) : ""}</span>Show joins, sessions and setting changes</button>
    ${
      rows.length === 0
        ? `<p class="empty">${empty}</p>`
        : `<ul class="tlist">${taskHead()}${grouped(rows, s.now)}</ul>`
    }
    ${when(list?.more, `<div class="more-row"><button type="button" class="btn btn-secondary" data-action="more"${when(s.loadingMore, " disabled")}>Show earlier tasks</button></div>`)}
  </div>`;
}
