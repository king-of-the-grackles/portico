// The navigation beside every control-plane page: Home (with what needs a decision), Activity, the Porticos, Agents
// and Settings. On phones it opens over the page. Pure: state in, HTML out.
import { esc, HOMEMARK, ICON, monogram, personColor, when } from "./common.js";
import { waitingAgents } from "./tasks.js";
import type { HomeState, WorkspaceView } from "./types.js";
import { initials } from "./workspace.js";

/** What needs a decision: held messages, what agents asked, and coding agents with a question. */
export function decisionCount(s: HomeState): number {
  return s.held.length + s.consents.length + waitingAgents(s).length;
}

/** The Porticos: the person's own first, then each shared one with the other people's initials and a dot when something waits. */
function workspacesNav(s: HomeState): string {
  const route = s.route;
  const row = (w: WorkspaceView) => {
    const href = `/p/${encodeURIComponent(w.id)}`;
    const who = initials(w, s.me.id);
    const current = route.page === "workspace" && route.id === w.id;
    return `<li data-key="nw-${esc(w.id)}"><a class="npage" href="${href}" data-action="go" data-href="${href}"${when(current, ` aria-current="page"`)}><span class="nrow-name">${esc(w.name)}</span>${when(who, `<span class="nws-who" aria-label="With ${esc(w.people.filter((p) => p.id !== s.me.id).map((p) => p.name).join(", "))}">${esc(who)}</span>`)}${when(w.needs, `<span class="ndot"><span class="sr">Something here needs a decision</span></span>`)}</a></li>`;
  };
  return `<div class="nav-agents">
      <h2 class="nav-h">Porticos</h2>
      <ul class="nav-list">
        ${s.workspaces.map(row).join("")}
        <li><button type="button" class="npage npage-add" data-action="ws-new-open">${ICON.plus()}New Portico</button></li>
      </ul>
      <ul class="nav-pages">
        <li><a class="npage" href="/agents" data-action="go" data-href="/agents"${when(route.page === "agents", ` aria-current="page"`)}>Agents</a></li>
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
