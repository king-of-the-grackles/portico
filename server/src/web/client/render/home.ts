// The control plane's pages, Today, Activity and each agent's page, around one navigation. Pure: state in, HTML out.
import { renderActivity } from "./activity.js";
import { renderAgent } from "./agent.js";
import { renderAddSheet, renderNotice, renderReconnecting, when } from "./common.js";
import { renderNav, renderPhoneBar } from "./nav.js";
import { renderToday } from "./today.js";
import type { HomeData, HomeState } from "./types.js";
import { renderWorkspace } from "./workspace.js";

function renderPage(s: HomeState): string {
  switch (s.route.page) {
    case "today":
      return renderToday(s);
    case "activity":
      return renderActivity(s);
    case "agent":
      return renderAgent(s, s.route.id);
    case "workspace":
      return renderWorkspace(s, s.route.id);
  }
}

export function renderHome(s: HomeState): string {
  return `<div class="app control${when(s.navOpen, " nav-open")}">
  <a class="skip" href="#main">Skip to content</a>
  ${renderPhoneBar(s)}
  ${renderNav(s)}
  ${when(s.navOpen, `<button type="button" class="nav-scrim phone-only" aria-label="Close navigation" data-action="nav-close" tabindex="-1"></button>`)}
  ${renderAddSheet(s.add, { publicUrl: s.publicUrl, now: s.now })}
  <main id="main" class="control-main">
    ${renderReconnecting(s.reconnecting)}
    ${renderNotice(s.notice)}
    ${renderPage(s)}
  </main>
</div>`;
}

/** A fresh state from the server's first data. */
export function homeState(data: Omit<HomeData, "page"> & { now: number }): HomeState {
  return {
    now: data.now,
    me: data.me,
    publicUrl: data.publicUrl,
    agents: data.agents,
    held: data.approvals.held,
    consents: data.approvals.consents ?? [],
    workspaces: data.workspaces,
    workspacePage: data.workspacePage ?? null,
    wsForm: null,
    peopleOpen: false,
    wsConfirm: null,
    wsCopied: {},
    wsMail: {},
    route: data.route,
    today: data.today,
    tasks: data.tasks,
    filter: { outcome: null, agent: null, project: null },
    showEvents: false,
    events: null,
    agentPage: data.agentPage,
    openTasks: {},
    shownMessages: {},
    detailsOpen: false,
    settingsOpen: false,
    acctOpen: false,
    navOpen: false,
    navFold: {},
    navAll: {},
    notice: null,
    reconnecting: false,
    add: null,
    edit: null,
    wakeEdit: null,
    saved: false,
    confirmRemove: false,
    confirmRevoke: false,
    loadingMore: false,
    busy: null,
  };
}
