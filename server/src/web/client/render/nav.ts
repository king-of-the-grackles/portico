// The navigation beside every control-plane page: Today (with what needs a decision), Activity, the agents with their
// state in plain words, Add agent, and Settings. On phones it opens over the page. Pure: state in, HTML out.
import { agentState, esc, HOMEMARK, ICON, kindInfo, logo, monogram, pav, personColor, when } from "./common.js";
import { waitingAgents } from "./tasks.js";
import type { AgentView, HomeState, SignInView } from "./types.js";

/** What needs a decision: held messages, sign-in requests, and coding agents with a question. */
export function decisionCount(s: HomeState): number {
  return s.held.length + s.signIns.length + waitingAgents(s).length;
}

function agentLink(s: HomeState, a: AgentView): string {
  const st = agentState(a, s.now);
  const current = s.route.page === "agent" && s.route.id === a.id;
  const waiting = s.held.filter((m) => m.to.id === a.id).length;
  return `<li data-key="n-${esc(a.id)}"><a class="nrow${when(!st.online, " is-quiet")}" href="/a/${encodeURIComponent(a.id)}" data-action="go" data-href="/a/${encodeURIComponent(a.id)}"${when(current, ` aria-current="page"`)}>
    ${logo(a.kind, "logo-sm", kindInfo(a.kind).label)}
    <span class="nrow-text"><span class="nrow-name">${esc(a.label)}</span><span class="nrow-state"><span class="dot ${st.dot}"></span>${esc(st.label)}</span></span>
    ${when(waiting > 0, `<span class="badge tnum">${waiting}<span class="sr"> waiting for a decision</span></span>`)}
  </a></li>`;
}

function signInLink(r: SignInView): string {
  return `<li data-key="ns-${esc(r.id)}"><a class="nrow" href="/" data-action="go" data-href="/">
    ${logo(r.kind, "logo-sm", kindInfo(r.kind).label)}
    <span class="nrow-text"><span class="nrow-name">${esc(kindInfo(r.kind).label)} (${esc(r.name)})</span><span class="nrow-state"><span class="dot dot-pending"></span>Waiting to join</span></span>
  </a></li>`;
}

export function renderNav(s: HomeState): string {
  const count = decisionCount(s);
  const mine = s.agents.filter((a) => a.mine);
  const others = s.agents.filter((a) => !a.mine);
  const running = mine.filter((a) => agentState(a, s.now).online);
  const quiet = mine.filter((a) => !agentState(a, s.now).online);
  const owners = [...new Map(others.map((a) => [a.owner.id, a.owner])).values()];
  const page = s.route.page;
  return `<nav aria-label="Main" class="nav${when(s.navOpen, " is-open")}" id="nav" data-key="nav">
    <div class="nav-top">${HOMEMARK}<span class="nav-brand">Portico</span><button type="button" class="icon-btn phone-only" aria-label="Close" data-action="nav-close">${ICON.close()}</button></div>
    <ul class="nav-pages">
      <li><a class="npage" href="/" data-action="go" data-href="/"${when(page === "today", ` aria-current="page"`)}>Today${when(count > 0, `<span class="badge tnum">${count}<span class="sr"> waiting for a decision</span></span>`)}</a></li>
      <li><a class="npage" href="/activity" data-action="go" data-href="/activity"${when(page === "activity", ` aria-current="page"`)}>Activity</a></li>
    </ul>
    <div class="nav-agents">
      <h2 class="nav-h">Agents</h2>
      <ul class="nav-list">
        ${running.map((a) => agentLink(s, a)).join("")}
        ${s.signIns.map(signInLink).join("")}
      </ul>
      ${when(
        quiet.length > 0,
        () => `<button type="button" class="nav-fold" data-action="quiet-toggle" aria-expanded="${s.quietOpen}">${ICON.caret(s.quietOpen ? "is-open" : "")}<span>Not running (${quiet.length})</span></button>
      ${when(s.quietOpen, () => `<ul class="nav-list enter" data-key="quiet">${quiet.map((a) => agentLink(s, a)).join("")}</ul>`)}`,
      )}
      <button type="button" class="nrow nrow-add" data-action="add-open" aria-haspopup="dialog">${ICON.plus()}<span>Add agent</span></button>
      ${owners
        .map(
          (owner) => `<h2 class="nav-h nav-person" data-key="np-${esc(owner.id)}">${pav(owner)}${esc(owner.name)}</h2>
      <ul class="nav-list">${others
        .filter((a) => a.owner.id === owner.id)
        .map((a) => agentLink(s, a))
        .join("")}</ul>`,
        )
        .join("")}
    </div>
    <div class="nav-foot">
      <a class="npage" href="/settings">${ICON.gear()}Settings</a>
      <div class="nav-acct">
        <button type="button" class="acct" data-action="acct-toggle" aria-haspopup="menu" aria-expanded="${s.acctOpen}"><span class="acct-av" style="background: ${personColor(s.me)}">${monogram(s.me.name)}</span><span class="acct-name">${esc(s.me.name)}</span>${ICON.caret(s.acctOpen ? "is-open" : "")}</button>
        ${when(
          s.acctOpen,
          `<div role="menu" aria-label="Account" class="menu menu-up enter" data-key="acct-menu">
          <div class="menu-head">${s.me.role === "owner" ? `Signed in as ${esc(s.me.name)}, owner` : `Signed in as ${esc(s.me.name)}`}</div>
          ${when(s.me.role === "owner", `<a role="menuitem" class="menuitem" href="/settings#people">${ICON.userPlus()}Invite a person</a>`)}
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
