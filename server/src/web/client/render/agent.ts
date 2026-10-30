// An agent's page: who it is and its state, what needs a decision, its tasks, who it works with, then Details and
// Settings folded away. Pure: state in, HTML out.
import { agentState, agentStatusLine, atWhen, clock, date, esc, ICON, kindInfo, logo, longDate, plural, sinceDay, when } from "./common.js";
import { managedBy, OUTCOME_LABEL, OUTCOME_ORDER, renderHeldCard, renderTaskRow, renderWaitingCard, taskHead } from "./tasks.js";
import type { AgentPageData, AgentView, HomeState, RunView } from "./types.js";

function switchButton(on: boolean, action: string, label: string, help: string, busy: boolean): string {
  return `<button type="button" class="switch ${on ? "on" : "off"}" role="switch" aria-checked="${on}" aria-labelledby="${label}" aria-describedby="${help}" data-action="${action}"${when(busy, " disabled")}><span class="knob"></span></button>`;
}

function renderEditForm(s: HomeState, a: AgentView): string {
  const e = s.edit!;
  const count = Array.from(e.description).length;
  return `<form class="edit-form enter" data-form="agent-save" data-key="edit-form" novalidate>
    <label for="ag-name" class="lbl">Name on Portico</label>
    <input id="ag-name" class="field${when(e.error, " is-invalid")}" name="name" value="${esc(e.name)}" data-input="edit-name" aria-describedby="ag-name-help" aria-invalid="${Boolean(e.error)}" autocomplete="off" spellcheck="false" data-autofocus>
    <span id="ag-name-help" class="help">Other agents use this name when sending messages.</span>
    <label for="ag-desc" class="lbl mt8">Job description</label>
    <textarea id="ag-desc" class="field" rows="3" maxlength="500" data-input="edit-desc" aria-describedby="ag-desc-help">${esc(e.description)}</textarea>
    <span id="ag-desc-help" class="help tnum">One line on what ${esc(a.label)} handles, shown to other agents. ${count}/500</span>
    ${when(e.error, `<span role="alert" class="field-error">${esc(e.error)}</span>`)}
    <span class="actions mt8"><button type="button" class="btn btn-link" data-action="edit-cancel">Cancel</button><button type="submit" class="btn btn-primary"${when(s.busy === `save:${a.id}`, " disabled")}>Save</button></span>
  </form>`;
}

/** How the last wake went, in a sentence: "Last woke Grok Bot at 5:09 PM." or why the last one failed. */
export function wakeOutcome(label: string, lastAt: string | null, lastStatus: string | null, now: number): string {
  if (!lastAt || !lastStatus) return "No wakes yet.";
  const at = atWhen(lastAt, now);
  if (lastStatus === "ok") return `Last woke ${label} ${at}.`;
  const http = /^http_(\d{3})$/.exec(lastStatus);
  const why = http
    ? `the address answered ${http[1]}${http[1] === "401" || http[1] === "403" ? ", so check the key" : ""}`
    : lastStatus === "timeout"
      ? "no answer within 10 seconds"
      : lastStatus === "blocked_address"
        ? "the address points to a private network"
        : "the address couldn't be reached";
  return `Last wake failed ${at}: ${why}.`;
}

function renderWakeForm(s: HomeState, a: AgentView): string {
  const w = s.wakeEdit!;
  return `<form class="edit-form enter" data-form="wake-save" data-key="wake-form" novalidate>
    <label for="wk-url" class="lbl">Wake URL</label>
    <input id="wk-url" class="field${when(w.error, " is-invalid")}" value="${esc(w.url)}" data-input="wake-url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://" aria-describedby="wk-url-help" aria-invalid="${Boolean(w.error)}" data-autofocus>
    <span id="wk-url-help" class="help">Where the app's webhook trigger listens. For a Grok Bot routine, the POST to field.</span>
    <label for="wk-key" class="lbl mt8">Key</label>
    <input id="wk-key" type="password" class="field" value="${esc(w.key)}" data-input="wake-key" autocomplete="off" spellcheck="false" aria-describedby="wk-key-help">
    <span id="wk-key-help" class="help">Sent as a bearer token with each wake. Portico doesn't show the key again.</span>
    ${when(w.error, `<span role="alert" class="field-error">${esc(w.error)}</span>`)}
    <span class="actions mt8"><button type="button" class="btn btn-link" data-action="wake-cancel">Cancel</button><button type="submit" class="btn btn-primary"${when(s.busy === `wake:${a.id}`, " disabled")}>Save</button></span>
  </form>`;
}

/** The wake URL row: off with Add, or the host and the last wake with Remove and Change. */
function renderWakeRow(s: HomeState, data: AgentPageData): string {
  const a = data.agent;
  if (s.wakeEdit) return renderWakeForm(s, a);
  const wake = data.wake;
  const name = esc(a.label);
  const help = wake
    ? `On. When a message arrives, Portico posts to ${esc(wake.host)}. ${esc(wakeOutcome(a.label, wake.lastAt, wake.lastStatus, s.now))}`
    : `Off. ${name} sees new messages on the next check. Add an app's webhook trigger, such as a Grok Bot routine's, and Portico wakes ${name} when a message arrives.`;
  const busy = when(s.busy === `wake:${a.id}`, " disabled");
  const actions = wake
    ? `<button type="button" class="btn btn-text" data-action="wake-remove"${busy}>Remove</button><button type="button" class="btn btn-secondary" data-action="wake-start"${busy}>Change</button>`
    : `<button type="button" class="btn btn-secondary" data-action="wake-start">Add</button>`;
  return `<div class="srow-line" data-key="wake-row"><span class="row-text"><span class="row-title">Wake URL</span><span class="row-help">${help}</span></span><span class="actions">${actions}</span></div>`;
}

function fold(id: string, title: string, open: boolean, action: string, body: () => string): string {
  return `<section class="fold" aria-labelledby="${id}-h" data-key="${id}">
    <h2 id="${id}-h" class="fold-h"><button type="button" class="fold-btn" data-action="${action}" aria-expanded="${open}" aria-controls="${id}-body">${ICON.caret(open ? "is-open" : "")}${title}</button></h2>
    ${when(open, () => `<div id="${id}-body" class="fold-body enter">${body()}</div>`)}
  </section>`;
}

/** "Started 5:09 PM, stopped 5:40 PM", with the day when it wasn't today. */
function runLine(r: RunView, now: number): string {
  const day = (iso: string) => (sinceDay(iso, now) === "today" ? "" : `${date(iso, now)} `);
  const start = `Started ${day(r.startedAt)}${clock(r.startedAt)}`;
  if (r.live) return `${start}, open now`;
  const end = r.endedAt ?? r.lastSeenAt;
  return `${start}, stopped ${day(end) === day(r.startedAt) ? "" : day(end)}${clock(end)}`;
}

function renderDetails(s: HomeState, data: AgentPageData): string {
  const a = data.agent;
  const rows: [string, string][] = [];
  if (a.type === "session") {
    rows.push(["Folder", esc(a.repo ?? a.folder ?? "")]);
    if (a.branch) rows.push(["Branch", esc(a.branch)]);
    rows.push(["Computer", esc(a.computer?.name ?? "")]);
    const open = a.liveRuns > 0 ? `, ${a.liveRuns} open now` : "";
    rows.push(["Sessions", `${plural(data.runCount, "session")} in the last 30 days${open}`]);
  } else {
    rows.push(["Connected as", a.type === "connector" ? "An MCP connector" : "An app with its own key"]);
    rows.push([
      "Checks for messages",
      data.woken
        ? "When a message arrives"
        : a.checkInMinutes !== null
          ? `About every ${a.checkInMinutes} min`
          : `When ${esc(a.label)} runs a task`,
    ]);
    if (data.events) {
      const subs = plural(data.events.count, "subscription");
      const last = data.events.lastAt
        ? data.events.lastStatus === "ok"
          ? `, last event sent ${atWhen(data.events.lastAt, s.now)}`
          : `, last event failed ${atWhen(data.events.lastAt, s.now)}`
        : "";
      rows.push(["Event subscriptions", `${subs} to message.received${last}`]);
    }
  }
  rows.push(["Name on Portico", `<code>${esc(a.address)}</code>`]);
  rows.push(["Kind", esc(kindInfo(a.kind).label)]);
  rows.push(["Joined", esc(longDate(a.createdAt, s.now))]);
  const runs =
    a.type === "session" && data.runs.length > 0
      ? `<h3 class="h-sub mt8">Recent sessions</h3><ul class="runs">${data.runs
          .map((r) => `<li class="tnum" data-key="r-${esc(r.id)}">${esc(runLine(r, s.now))}</li>`)
          .join("")}</ul>`
      : "";
  return `<dl class="facts-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>${runs}`;
}

function renderSettingsFold(s: HomeState, data: AgentPageData): string {
  const a = data.agent;
  const editable = a.type !== "session";
  const parts: string[] = [];
  if (s.edit) parts.push(renderEditForm(s, a));
  else if (editable) {
    parts.push(`<div class="srow-line"><span class="row-text"><span class="row-title">Name and job</span><span class="row-help">${esc(a.name)}${a.description ? `: ${esc(a.description)}` : ""}</span></span><span class="actions"><button type="button" class="btn btn-secondary" data-action="edit-start">Edit</button></span></div>`);
  }
  const allow = data.allowList ?? [];
  parts.push(`<div class="switch-row">
    <div class="grow"><span id="appr-label" class="row-title">New contacts need approval</span><span id="appr-help" class="row-help">${
      a.approvalRequired
        ? `On. A new conversation with ${esc(a.label)} waits for a decision on Today. Replies to ${esc(a.label)} don't.`
        : `Off. Any agent can send ${esc(a.label)} a task.`
    }</span></div>
    ${switchButton(a.approvalRequired, "toggle-approval", "appr-label", "appr-help", s.busy === `approval:${a.id}`)}
  </div>`);
  if (a.approvalRequired) {
    parts.push(`<div class="allow enter" data-key="allow">
      <h3 class="h-sub">Always allowed</h3>
      ${
        allow.length
          ? `<ul class="allow-list">${allow
              .map(
                (w) => `<li class="allow-row" data-key="w-${esc(w.sender.id)}">${logo(w.sender.kind, "logo-sm")}<span class="allow-name">${esc(w.sender.label)}</span><span class="tnum allow-since">since ${sinceDay(w.addedAt, s.now)}</span><span class="actions"><button type="button" class="btn btn-text" data-action="allow-remove" data-id="${esc(w.sender.id)}">Remove</button></span></li>`,
              )
              .join("")}</ul>`
          : `<p class="row-help">None yet. Choosing Always allow on a decision adds the sender here.</p>`
      }
    </div>`);
  }
  if (a.type !== "session") parts.push(renderWakeRow(s, data));
  if (a.type === "session") {
    const on = a.joinFromFolder !== false;
    const repo = esc(a.repo ?? a.folder ?? "");
    parts.push(`<div class="switch-row">
      <div class="grow"><span id="folder-label" class="row-title">New sessions in ${repo} join Portico</span><span id="folder-help" class="row-help">${
        on
          ? `On. Claude Code or Codex opened in ${repo} on ${esc(a.computer?.name ?? "")} joins as ${esc(a.label)}.`
          : `Off. New sessions in ${repo} stay off Portico.`
      }</span></div>
      ${switchButton(on, "toggle-folder", "folder-label", "folder-help", s.busy === `folder:${a.id}`)}
    </div>`);
  }
  // A session agent comes back the next time Claude Code or Codex opens in the folder, so only one not running is offered.
  const removable = editable || a.liveRuns === 0;
  if (removable) {
    const name = esc(a.label);
    const help = editable
      ? `Signs ${name} out of Portico and deletes ${name}'s tasks.`
      : `Deletes the agent and the agent's tasks. A new session in ${esc(a.repo ?? a.folder ?? "the folder")} adds the agent back.`;
    parts.push(`<div class="srow-line">
      <span class="row-text"><span class="row-title">Remove ${name}</span><span class="row-help">${help}</span></span>
      <span class="actions">${
        s.confirmRemove
          ? `<button type="button" class="btn btn-link" data-action="remove-cancel">Cancel</button><button type="button" class="btn btn-danger" data-action="remove-confirm" data-id="${esc(a.id)}" data-autofocus${when(s.busy === `remove:${a.id}`, " disabled")}>Confirm: remove ${name}</button>`
          : `<button type="button" class="btn btn-text" data-action="remove-start">Remove</button>`
      }</span>
    </div>`);
  }
  return parts.join("");
}

function jobLine(s: HomeState, a: AgentView): string {
  // A session reports what it's doing while busy; any agent can also say so itself with update_profile.
  if (a.doing) return `<p class="job">${esc(a.doing)}</p>`;
  if (a.description) return `<p class="job">${esc(a.description)}</p>`;
  if (a.mine && a.type !== "session") {
    return `<p class="job job-empty">No job description yet. <button type="button" class="inline-link" data-action="edit-start">Add a job description</button> so other agents know what ${esc(a.label)} handles.</p>`;
  }
  return "";
}

export function renderAgent(s: HomeState, id: string): string {
  const data = s.agentPage && s.agentPage.agent.id === id ? s.agentPage : null;
  const known = data?.agent ?? s.agents.find((a) => a.id === id) ?? null;
  if (!known) return `<div class="page" data-key="page-agent"><p class="empty">Loading.</p></div>`;
  const a = known;
  const st = agentState(a, s.now);
  const held = s.held.filter((m) => m.to.id === a.id || m.from.id === a.id);
  const waiting = a.mine && st.label === "Has a question";
  const counts = data?.taskCounts ?? { needs_approval: 0, in_progress: 0, done: 0, failed: 0 };
  const total = OUTCOME_ORDER.reduce((n, o) => n + counts[o], 0);
  const chip = (outcome: (typeof OUTCOME_ORDER)[number] | null, label: string, n: number) => {
    const on = s.filter.outcome === outcome;
    return `<button type="button" class="fchip${when(on, " is-on")}" aria-pressed="${on}" data-action="outcome" data-id="${outcome ?? ""}">${label} <span class="tnum fchip-n">${n}</span></button>`;
  };
  const tasks = s.tasks?.tasks ?? [];
  return `<div class="page agent-page" data-key="page-agent-${esc(a.id)}">
    <header class="agent-head">
      ${logo(a.kind, "logo-lg", kindInfo(a.kind).label)}
      <div class="grow">
        <div class="agent-title"><h1 class="h-page">${esc(a.label)}</h1>${when(!a.mine, () => managedBy(a.owner))}</div>
        <p class="agent-state tnum" style="color: ${st.ink}"><span class="dot ${st.dot}"></span>${esc(agentStatusLine(a, s.now))}</p>
        ${jobLine(s, a)}
        ${when(s.saved, `<span class="saved enter" data-key="saved">Saved.</span>`)}
      </div>
    </header>
    ${when(
      held.length > 0 || waiting,
      () => `<section aria-labelledby="g-decide" class="block">
      <h2 id="g-decide" class="h-section">Needs a decision</h2>
      <div class="dcards">${held.map((m) => renderHeldCard(s, m)).join("")}${when(waiting, () => renderWaitingCard(s, a))}</div>
    </section>`,
    )}
    <section aria-labelledby="g-tasks" class="block">
      <div class="block-head"><h2 id="g-tasks" class="h-section">Tasks</h2>
        <div role="group" aria-label="Filter tasks" class="fchips">
          ${chip(null, "All", total)}
          ${OUTCOME_ORDER.filter((o) => counts[o] > 0).map((o) => chip(o, OUTCOME_LABEL[o], counts[o])).join("")}
        </div>
      </div>
      ${
        tasks.length === 0
          ? `<p class="empty">${s.tasks ? `No tasks with ${esc(a.label)} yet.` : "Loading."}</p>`
          : `<ul class="tlist">${taskHead()}${tasks.map((t) => renderTaskRow(s, t, a.id)).join("")}</ul>`
      }
      ${when(s.tasks?.more, `<div class="more-row"><button type="button" class="btn btn-secondary" data-action="more"${when(s.loadingMore, " disabled")}>Show earlier tasks</button></div>`)}
    </section>
    ${when(
      data && data.worksWith.length > 0,
      () => `<section aria-labelledby="g-with" class="block">
      <h2 id="g-with" class="h-section">Works with</h2>
      <ul class="with">${data!.worksWith
        .map(
          (w) => `<li data-key="ww-${esc(w.agent.id)}"><a class="with-link" href="/a/${encodeURIComponent(w.agent.id)}" data-action="go" data-href="/a/${encodeURIComponent(w.agent.id)}">${logo(w.agent.kind, "logo-sm")}<span>${esc(w.agent.label)}</span><span class="tnum with-n">${plural(w.tasks, "task")}, last ${atWhen(w.lastAt, s.now)}</span></a></li>`,
        )
        .join("")}</ul>
    </section>`,
    )}
    ${when(data, () => fold("details", "Details", s.detailsOpen, "details-toggle", () => renderDetails(s, data!)))}
    ${when(data && a.mine, () => fold("settings", "Settings", s.settingsOpen, "settings-toggle", () => renderSettingsFold(s, data!)))}
  </div>`;
}
