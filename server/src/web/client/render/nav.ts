// The navigation beside every control-plane page: Home (with what needs a decision), Activity, the Porticos, each with
// its agents, and Settings. On phones it opens over the page. Pure: state in, HTML out.
import { esc, HOMEMARK, ICON, logo, monogram, personColor, when } from "./common.js";
import { waitingAgents } from "./tasks.js";
import type { AgentView, HomeState, WorkspaceView } from "./types.js";
import { initials } from "./workspace.js";

/** What needs a decision: held messages, what agents asked, coding agents with a question, and the input agents need. */
export function decisionCount(s: HomeState): number {
  return s.held.length + s.consents.length + waitingAgents(s).length + s.questions.length;
}

/** How many agents an open Portico lists in the navigation before "Show all". */
export const NAV_AGENTS = 8;

/** A Portico's short name in the navigation: the person's own is "Personal", the one the person started with "Shared". */
export function navName(w: WorkspaceView): string {
  if (!w.isOwner) return w.name;
  return w.kind === "personal" ? "Personal" : w.starter ? "Shared" : w.name;
}

/** Whether the Portico's agents show: as the person left it, or else while the Portico or one of its agents is being looked at. */
export function porticoOpen(s: HomeState, w: WorkspaceView): boolean {
  const chosen = s.navFold[w.id];
  if (chosen !== undefined) return chosen;
  const route = s.route;
  return (route.page === "workspace" && route.id === w.id) || (route.page === "agent" && w.agentIds.includes(route.id));
}

/** The agents in a Portico, the person's own first, each opening the agent's page. An agent in two Porticos shows under both. */
function navAgents(s: HomeState, w: WorkspaceView): string {
  const route = s.route;
  const inside = s.agents.filter((a) => w.agentIds.includes(a.id));
  const sorted = [...inside.filter((a) => a.mine), ...inside.filter((a) => !a.mine)];
  const shown = s.navAll[w.id] ? sorted : sorted.slice(0, NAV_AGENTS);
  const row = (a: AgentView) => {
    const href = `/a/${encodeURIComponent(a.id)}`;
    const current = route.page === "agent" && route.id === a.id;
    return `<li data-key="na-${esc(w.id)}-${esc(a.id)}"><a class="nagent" href="${href}" data-action="go" data-href="${href}"${when(current, ` aria-current="page"`)}>${logo(a.kind, "logo-xs", "")}<span class="nagent-name">${esc(a.label)}</span>${when(!a.mine, `<span class="nagent-who">${esc(a.owner.name)}</span>`)}</a></li>`;
  };
  return `<ul class="nagents" id="nav-agents-${esc(w.id)}" aria-label="Agents in ${esc(w.name)}">
          ${shown.map(row).join("")}
          ${when(sorted.length === 0, `<li class="nagent-none">No agents here yet</li>`)}
          ${when(sorted.length > shown.length, `<li><button type="button" class="nagent nagent-more" data-action="nav-all" data-id="${esc(w.id)}">Show all ${sorted.length}</button></li>`)}
          <li><button type="button" class="nagent nagent-add" data-action="ws-add-agent" data-id="${esc(w.id)}">${ICON.plus()}Add agent</button></li>
        </ul>`;
}

/**
 * The Porticos: the person's own first, then each shared one with the other people's initials and a dot when something
 * waits. Each opens to show its agents.
 */
function workspacesNav(s: HomeState): string {
  const route = s.route;
  const row = (w: WorkspaceView) => {
    const href = `/p/${encodeURIComponent(w.id)}`;
    const who = initials(w, s.me.id);
    const current = route.page === "workspace" && route.id === w.id;
    const open = porticoOpen(s, w);
    return `<li data-key="nw-${esc(w.id)}">
        <div class="nfold"><button type="button" class="nfold-tog" data-action="nav-fold" data-id="${esc(w.id)}" aria-expanded="${open}" aria-controls="nav-agents-${esc(w.id)}" aria-label="${open ? "Hide" : "Show"} the agents in ${esc(w.name)}">${ICON.caret(open ? "" : "is-shut")}</button><a class="npage" href="${href}" data-action="go" data-href="${href}"${when(current, ` aria-current="page"`)}><span class="nrow-name">${esc(navName(w))}</span>${when(who, `<span class="nws-who" aria-label="With ${esc(w.people.filter((p) => p.id !== s.me.id).map((p) => p.name).join(", "))}">${esc(who)}</span>`)}${when(w.needs, `<span class="ndot"><span class="sr">Something here needs a decision</span></span>`)}</a></div>
        ${when(open, () => navAgents(s, w))}
      </li>`;
  };
  return `<div class="nav-agents">
      <h2 class="nav-h">Porticos</h2>
      <ul class="nav-list">
        ${s.workspaces.map(row).join("")}
        <li><button type="button" class="npage npage-add" data-action="ws-new-open">${ICON.plus()}New Portico</button></li>
      </ul>
    </div>`;
}

export function renderNav(s: HomeState): string {
  const count = decisionCount(s);
  const page = s.route.page;
  return `<nav aria-label="Main" class="nav${when(s.navOpen, " is-open")}" id="nav" data-key="nav">
    <div class="nav-top">${HOMEMARK}<span class="nav-brand">Portico</span><button type="button" class="icon-btn phone-only" aria-label="Close" data-action="nav-close">${ICON.close()}</button></div>
    <ul class="nav-pages">
      <li><a class="npage" href="/" data-action="go" data-href="/"${when(page === "today", ` aria-current="page"`)}>Home${when(count > 0, `<span class="badge tnum">${count}<span class="sr"> waiting for a decision</span></span>`)}</a></li>
      <li><a class="npage" href="/activity" data-action="go" data-href="/activity"${when(page === "activity", ` aria-current="page"`)}>Activity</a></li>
    </ul>
    ${workspacesNav(s)}
    <div class="nav-foot">
      <a class="npage" href="/settings">${ICON.gear()}Settings</a>
      <div class="nav-acct">
        <button type="button" class="acct" data-action="acct-toggle" aria-haspopup="menu" aria-expanded="${s.acctOpen}"><span class="acct-av" style="background: ${personColor(s.me)}">${monogram(s.me.name)}</span><span class="acct-name">${esc(s.me.name)}</span>${ICON.caret(s.acctOpen ? "is-open" : "")}</button>
        ${when(
          s.acctOpen,
          `<div role="menu" aria-label="Account" class="menu menu-up enter" data-key="acct-menu">
          <div class="menu-head">Signed in as ${esc(s.me.name)}</div>
          <button type="button" role="menuitem" class="menuitem menuitem-danger" data-action="sign-out">${ICON.signOut()}Sign out</button>
        </div>`,
        )}
      </div>
    </div>
  </nav>`;
}

/** Phones: a bar with the menu button, since the navigation is hidden until opened. */
export function renderPhoneBar(s: HomeState): string {
  const count = decisionCount(s);
  return `<header class="phone-bar">
    <button type="button" class="icon-btn" aria-label="Open navigation" aria-controls="nav" aria-expanded="${s.navOpen}" data-action="nav-open">${ICON.list()}</button>
    <span class="phone-brand">Portico</span>
    ${when(count > 0, `<a class="badge tnum" href="/" data-action="go" data-href="/">${count}<span class="sr"> waiting for a decision</span></a>`)}
  </header>`;
}
