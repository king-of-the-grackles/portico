// Today, Activity, the agent pages and Settings in the browser. The server embeds the first data and the first render; from then on the page
// renders from state with the pure functions in render/, acts only through the person API, and refetches what changed
// when the event stream says so. One delegated listener handles every data-action, data-form and data-input.
import { api, ApiError, firstData } from "./api.js";
import { clock, kindInfo, midnight, plural } from "./render/common.js";
import { homeState, renderHome } from "./render/home.js";
import { renderSettings, settingsState } from "./render/settings.js";
import type {
  ActivityView,
  AddState,
  AgentKind,
  ConsentCard,
  ShareView,
  WorkspaceForm,
  WorkspacePageData,
  WorkspaceView,
  AgentPageData,
  AgentView,
  ClaimView,
  ComputerView,
  HeldCard,
  HomeData,
  HomeState,
  InviteView,
  PasskeyView,
  PersonRow,
  PersonView,
  Route,
  SettingsData,
  SettingsState,
  TaskDetail,
  TaskListData,
  TodayData,
} from "./render/types.js";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---- morph: patch the live DOM to match new HTML, keeping nodes that stay ----

function keyOf(node: Node): string | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  return el.getAttribute("data-key") ?? (el.id || null);
}

function sameKind(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== Node.ELEMENT_NODE) return true;
  return (a as Element).tagName === (b as Element).tagName && keyOf(a) === keyOf(b);
}

function patchNode(from: Node, to: Node): void {
  if (from.nodeType !== Node.ELEMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  const a = from as Element;
  const b = to as Element;
  for (const attr of Array.from(a.attributes)) if (!b.hasAttribute(attr.name)) a.removeAttribute(attr.name);
  for (const attr of Array.from(b.attributes)) if (a.getAttribute(attr.name) !== attr.value) a.setAttribute(attr.name, attr.value);
  // What a person is typing wins over the render; a field not in use takes the rendered value.
  if (a instanceof HTMLInputElement) {
    const value = b.getAttribute("value") ?? "";
    if (a.value !== value && document.activeElement !== a) a.value = value;
    return;
  }
  if (a instanceof HTMLTextAreaElement) {
    const value = b.textContent ?? "";
    if (a.value !== value && document.activeElement !== a) a.value = value;
    return;
  }
  morphChildren(a, b);
  // A select shows its selected attribute's option, unless it's in use.
  if (a instanceof HTMLSelectElement && document.activeElement !== a) {
    const chosen = (b as HTMLSelectElement).querySelector("option[selected]")?.getAttribute("value") ?? "";
    if (a.value !== chosen) a.value = chosen;
  }
}

function morphChildren(from: Node, to: Node): void {
  const keyed = new Map<string, Node>();
  for (const node of Array.from(from.childNodes)) {
    const key = keyOf(node);
    if (key) keyed.set(key, node);
  }
  let cursor: ChildNode | null = from.firstChild;
  for (const next of Array.from(to.childNodes)) {
    const key = keyOf(next);
    let match: Node | null = null;
    if (key) {
      const found = keyed.get(key);
      if (found && sameKind(found, next)) match = found;
    } else if (cursor && keyOf(cursor) === null && sameKind(cursor, next)) {
      match = cursor;
    }
    if (match) {
      if (key) keyed.delete(key);
      if (match === cursor) cursor = cursor.nextSibling;
      else from.insertBefore(match, cursor);
      patchNode(match, next);
    } else {
      from.insertBefore(next, cursor);
    }
  }
  while (cursor) {
    const after: ChildNode | null = cursor.nextSibling;
    from.removeChild(cursor);
    cursor = after;
  }
}

function morph(root: HTMLElement, html: string): void {
  const template = document.createElement("template");
  template.innerHTML = html;
  morphChildren(root, template.content);
}

// ---- a page: state, render, and the shared header, sheet and stream ----

interface Shared {
  now: number;
  me: PersonView;
  publicUrl: string;
  agents: AgentView[];
  add: AddState | null;
  acctOpen: boolean;
  reconnecting: boolean;
}

class Page<S extends Shared> {
  private scheduled = false;
  constructor(
    readonly root: HTMLElement,
    public state: S,
    private readonly view: (s: S) => string,
  ) {}

  set(patch: Partial<S>): void {
    Object.assign(this.state, patch);
    this.schedule();
  }

  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.paint();
    });
  }

  paint(): void {
    // Relative times ("Expires in 10 min.") read the clock at each render.
    this.state.now = Date.now();
    const before = new Set(Array.from(this.root.querySelectorAll("[data-autofocus]")));
    morph(this.root, this.view(this.state));
    const fresh = Array.from(this.root.querySelectorAll<HTMLElement>("[data-autofocus]")).find((el) => !before.has(el));
    fresh?.focus();
  }
}

/** The message to show for a failed call. A signed-out browser goes to sign in. */
function failure(err: unknown): string {
  if (err instanceof ApiError && err.status === 401) {
    location.assign(`/sign-in?next=${encodeURIComponent(location.pathname)}`);
    return "";
  }
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

/** Copies text, falling back to selecting the field it shows in. */
async function copyText(text: string, fieldId: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.getElementById(fieldId) as HTMLInputElement | null;
    field?.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }
}

/** The person event stream. Shows "Updates paused. Reconnecting." while down and refetches everything once back. */
function connectStream(handlers: { changed(topics: string[]): void; down(isDown: boolean): void; back(): void }): void {
  let down = false;
  const open = () => {
    const source = new EventSource("/api/events");
    source.addEventListener("hello", () => {
      if (!down) return;
      down = false;
      handlers.down(false);
      handlers.back();
    });
    source.addEventListener("changed", (event) => {
      try {
        const { topics } = JSON.parse((event as MessageEvent).data) as { topics: string[] };
        handlers.changed(topics);
      } catch {
        // A malformed event: the next one carries the same topics.
      }
    });
    source.onerror = () => {
      if (!down) {
        down = true;
        handlers.down(true);
      }
      // A refused stream (signed out, or Portico restarting) doesn't retry by itself.
      if (source.readyState === EventSource.CLOSED) {
        setTimeout(() => {
          api("GET", "/api/me")
            .then(open)
            .catch((err) => {
              if (err instanceof ApiError && err.status === 401) failure(err);
              else setTimeout(open, 3000);
            });
        }, 2000);
      }
    };
  };
  open();
}

// ---- the Add agent sheet, on both pages ----

function emptyAdd(): AddState {
  return { copied: null, stage: "pick", joined: null, joinedComputer: null };
}

class AddFlow<S extends Shared> {
  private known = new Set<string>();
  private knownComputers: Set<string> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(
    private readonly page: Page<S>,
    private readonly onDone: (agent: AgentView | null) => void,
  ) {}

  open(): void {
    this.known = new Set(this.page.state.agents.map((a) => a.id));
    this.knownComputers = null;
    this.page.set({ add: emptyAdd(), acctOpen: false } as Partial<S>);
    void this.check();
    this.timer ??= setInterval(() => void this.check(), 4000);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.page.set({ add: null } as Partial<S>);
  }

  private get add(): AddState | null {
    return this.page.state.add;
  }

  async copy(row: string): Promise<void> {
    const add = this.add;
    if (!add) return;
    const field = document.getElementById(`add-${row}`);
    if (!(field instanceof HTMLInputElement)) return;
    await copyText(field.value, `add-${row}`);
    add.copied = row;
    this.page.schedule();
    void this.check();
  }

  another(): void {
    const add = this.add;
    if (!add) return;
    this.known = new Set(this.page.state.agents.map((a) => a.id));
    this.knownComputers = null;
    Object.assign(add, emptyAdd());
    this.page.schedule();
    void this.check();
  }

  done(): void {
    const joined = this.add?.joined ?? null;
    this.close();
    this.onDone(joined);
  }

  /**
   * Looks for what joined since the sheet opened: a new agent of this person's, or a new computer, which has no agent
   * until a session starts there. The join itself is allowed on the consent page, in another tab.
   */
  async check(): Promise<void> {
    const add = this.add;
    if (!add || add.stage === "joined" || this.checking) return;
    this.checking = true;
    try {
      const { agents } = await api<{ agents: AgentView[] }>("GET", "/api/agents");
      this.page.state.agents = agents;
      const fresh = agents.find((a) => a.mine && !this.known.has(a.id));
      if (fresh) {
        Object.assign(add, { stage: "joined", joined: fresh });
        return;
      }
      const { computers } = await api<{ computers: ComputerView[] }>("GET", "/api/computers");
      if (this.knownComputers === null) this.knownComputers = new Set(computers.map((c) => c.id));
      const computer = computers.find((c) => !this.knownComputers!.has(c.id));
      if (computer) Object.assign(add, { stage: "joined", joinedComputer: computer.name });
    } catch (err) {
      // The next check tries again.
      if (err instanceof ApiError && err.status === 401) failure(err);
    } finally {
      this.checking = false;
      this.page.schedule();
    }
  }
}

function nameProblem(name: string): string {
  if (name === "") return "Enter a name.";
  if (name.length > 40) return "40 characters max.";
  if (!NAME.test(name)) return "Lowercase letters, digits and single dashes only.";
  return "";
}

async function signOut(): Promise<void> {
  try {
    await api("DELETE", "/api/session");
  } catch {
    // Signed out either way: the sign-in page checks.
  }
  location.assign("/sign-in?out");
}

/** One delegated listener per event type for the whole page. */
function listen(handlers: {
  action(name: string, el: HTMLElement, event: Event): void;
  form(name: string, form: HTMLFormElement): void;
  input(name: string, value: string): void;
  escape(): void;
  outside(target: Element): void;
}): void {
  document.addEventListener("click", (event) => {
    const target = event.target as Element;
    handlers.outside(target);
    const el = target.closest<HTMLElement>("[data-action]");
    if (!el || (el as HTMLButtonElement).disabled) return;
    event.preventDefault();
    handlers.action(el.dataset.action!, el, event);
  });
  document.addEventListener("submit", (event) => {
    const form = event.target as HTMLFormElement;
    if (!form.dataset.form) return;
    event.preventDefault();
    handlers.form(form.dataset.form, form);
  });
  document.addEventListener("input", (event) => {
    const el = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (el.dataset?.input) handlers.input(el.dataset.input, el.value);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") handlers.escape();
  });
}

// ---- Today, Activity and the agent pages ----

const ROUTES: [RegExp, (m: RegExpExecArray) => Route][] = [
  [/^\/$/, () => ({ page: "today" })],
  [/^\/activity\/?$/, () => ({ page: "activity" })],
  [/^\/a\/([^/]+)\/?$/, (m) => ({ page: "agent", id: decodeURIComponent(m[1]!) })],
  [/^\/p\/([^/]+)\/?$/, (m) => ({ page: "workspace", id: decodeURIComponent(m[1]!) })],
  [/^\/agents\/?$/, () => ({ page: "agents" })],
];

function routeOf(path: string): Route {
  for (const [pattern, make] of ROUTES) {
    const m = pattern.exec(path);
    if (m) return make(m);
  }
  return { page: "today" };
}

function pathOf(route: Route): string {
  switch (route.page) {
    case "today":
      return "/";
    case "activity":
      return "/activity";
    case "agents":
      return "/agents";
    case "workspace":
      return `/p/${encodeURIComponent(route.id)}`;
    case "agent":
      return `/a/${encodeURIComponent(route.id)}`;
  }
}

function query(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) q.set(key, value);
  const text = q.toString();
  return text ? `?${text}` : "";
}

function startHome(root: HTMLElement, data: HomeData): void {
  const page = new Page<HomeState>(root, homeState({ ...data, now: Date.now() }), renderHome);
  const s = () => page.state;
  const add = new AddFlow(page, (agent) => {
    if (!agent) return;
    go(`/a/${agent.id}`);
    note(agent.computer ? `${agent.label} joined from ${agent.computer.name}.` : `${agent.label} joined.`);
  });

  const note = (text: string, check = false) => page.set({ notice: { text, check } });
  const fail = (err: unknown) => {
    const text = failure(err);
    if (text) page.set({ notice: { text, error: true } });
  };

  // -- fetching: each loader drops its answer if the page moved on meanwhile --
  const loadAgents = async () => page.set({ agents: (await api<{ agents: AgentView[] }>("GET", "/api/agents")).agents });
  const loadApprovals = async () => {
    const r = await api<{ held: HeldCard[]; consents?: ConsentCard[] }>("GET", "/api/approvals");
    page.set({ held: r.held, consents: r.consents ?? [] });
  };
  const loadWorkspaces = async () => {
    page.set({ workspaces: (await api<{ workspaces: WorkspaceView[] }>("GET", "/api/porticos")).workspaces });
  };
  const loadWorkspacePage = async () => {
    const route = s().route;
    if (route.page !== "workspace") return;
    try {
      const workspacePage = await api<WorkspacePageData>("GET", `/api/porticos/${encodeURIComponent(route.id)}`);
      const now = s().route;
      if (now.page === "workspace" && now.id === route.id) page.set({ workspacePage });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        go("/");
        note("That Portico isn't there any more.");
      } else throw err;
    }
  };
  const loadMe = async () => page.set({ me: (await api<{ person: PersonView }>("GET", "/api/me")).person });

  const loadToday = async () => {
    const today = await api<TodayData>("GET", `/api/today${query({ since: midnight(Date.now()) })}`);
    if (s().route.page === "today") page.set({ today });
  };

  let taskTickets = 0;
  /** The tasks for the page: Activity's filters, or the agent's own tasks. `more` adds the next page. */
  const loadTasks = async (more = false) => {
    const route = s().route;
    if (route.page === "today" || route.page === "agents") return;
    const f = s().filter;
    const shown = s().tasks;
    const before = more && shown?.tasks.length ? shown.tasks[shown.tasks.length - 1]!.startedAt : null;
    // A refresh fetches at least as many as already show, so nothing on screen disappears.
    const limit = !more && shown && shown.tasks.length > 50 ? String(shown.tasks.length) : null;
    const path = `/api/tasks${query({
      outcome: f.outcome,
      agent: route.page === "agent" ? route.id : route.page === "workspace" ? null : f.agent,
      project: route.page === "activity" ? f.project : null,
      workspace: route.page === "workspace" ? route.id : null,
      before,
      limit,
    })}`;
    if (more) page.set({ loadingMore: true });
    // Only the latest request's answer is shown: a slow one for earlier filters never replaces a newer list.
    const ticket = ++taskTickets;
    try {
      const list = await api<TaskListData>("GET", path);
      if (ticket !== taskTickets) return;
      const now = s().route;
      if (pathOf(now) !== pathOf(route)) return;
      if (more) {
        const current = s().tasks;
        page.set({ tasks: { ...list, tasks: [...(current?.tasks ?? []), ...list.tasks] } });
      } else page.set({ tasks: list });
    } finally {
      if (more) page.set({ loadingMore: false });
    }
  };

  const loadEvents = async () => {
    if (s().route.page !== "activity" || !s().showEvents) return;
    const agent = s().filter.agent;
    const { entries } = await api<{ entries: ActivityView[] }>("GET", `/api/activity${query({ agent })}`);
    if (s().route.page === "activity" && s().showEvents && s().filter.agent === agent) page.set({ events: entries });
  };

  const loadAgentPage = async () => {
    const route = s().route;
    if (route.page !== "agent") return;
    try {
      const agentPage = await api<AgentPageData>("GET", `/api/agents/${encodeURIComponent(route.id)}`);
      const now = s().route;
      if (now.page === "agent" && now.id === route.id) page.set({ agentPage });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        go("/");
        note("That agent isn't on Portico any more.");
      } else throw err;
    }
  };

  const loadTask = async (id: string) => {
    try {
      const detail = await api<TaskDetail>("GET", `/api/tasks/${encodeURIComponent(id)}`);
      if (id in s().openTasks) page.set({ openTasks: { ...s().openTasks, [id]: detail } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        const { [id]: _gone, ...rest } = s().openTasks;
        page.set({ openTasks: rest });
      } else throw err;
    }
  };

  /** Everything the current page shows. */
  const loadPage = () => {
    const route = s().route;
    const jobs: Promise<unknown>[] = [];
    if (route.page === "today") jobs.push(loadToday());
    else if (route.page !== "agents") jobs.push(loadTasks());
    if (route.page === "activity") jobs.push(loadEvents());
    if (route.page === "agent") jobs.push(loadAgentPage());
    if (route.page === "workspace") jobs.push(loadWorkspacePage());
    for (const id of Object.keys(s().openTasks)) jobs.push(loadTask(id));
    return settle(jobs);
  };

  const settle = (jobs: Promise<unknown>[]) =>
    Promise.all(jobs.map((job) => job.catch((err) => (err instanceof ApiError && err.status === 401 ? failure(err) : fail(err)))));

  const refresh = (topics: string[]) => {
    const t = new Set(topics);
    const jobs: Promise<unknown>[] = [];
    if (t.has("agents") || t.has("people")) jobs.push(loadAgents());
    if (t.has("approvals")) jobs.push(loadApprovals());
    if (t.has("me")) jobs.push(loadMe());
    const route = s().route;
    if (t.has("workspaces") || t.has("people") || t.has("approvals")) jobs.push(loadWorkspaces());
    if (t.has("workspaces")) jobs.push(loadAgents());
    if (route.page === "workspace" && (t.has("workspaces") || t.has("people"))) jobs.push(loadWorkspacePage());
    const tasksChanged = t.has("threads") || t.has("approvals");
    if (route.page === "today" && (tasksChanged || t.has("agents"))) jobs.push(loadToday());
    if (route.page !== "today" && route.page !== "agents" && tasksChanged) jobs.push(loadTasks());
    if (route.page === "activity" && (t.has("activity") || t.has("agents"))) jobs.push(loadEvents());
    if (route.page === "agent" && (tasksChanged || t.has("agents") || t.has("activity"))) jobs.push(loadAgentPage());
    if (tasksChanged) for (const id of Object.keys(s().openTasks)) jobs.push(loadTask(id));
    if (s().add && (t.has("computers") || t.has("approvals") || t.has("agents"))) jobs.push(add.check());
    void settle(jobs);
  };

  // -- routes --
  const applyRoute = () => {
    const route = routeOf(location.pathname);
    const prior = s().route;
    const same = pathOf(prior) === pathOf(route);
    page.set({
      route,
      navOpen: false,
      acctOpen: false,
      edit: null,
      wakeEdit: null,
      saved: false,
      confirmRemove: false,
      wsForm: same ? s().wsForm : null,
      wsConfirm: null,
      peopleOpen: same ? s().peopleOpen : false,
      workspacePage: route.page === "workspace" && s().workspacePage?.workspace.id === route.id ? s().workspacePage : null,
      notice: same ? s().notice : null,
      ...(same
        ? {}
        : {
            tasks: null,
            openTasks: {},
            filter: { outcome: null, agent: null, project: null },
            detailsOpen: false,
            settingsOpen: false,
            agentPage: route.page === "agent" && s().agentPage?.agent.id === route.id ? s().agentPage : null,
          }),
    });
    if (!same) window.scrollTo(0, 0);
    void loadPage();
  };

  const go = (path: string) => {
    if (location.pathname !== path) history.pushState(null, "", path);
    applyRoute();
  };

  // -- actions --
  const pageAgent = () => (s().route.page === "agent" ? s().agentPage?.agent ?? null : null);

  const updateAgent = (agent: AgentView) => {
    const agentPage = s().agentPage;
    page.set({
      agents: s().agents.map((a) => (a.id === agent.id ? agent : a)),
      agentPage: agentPage && agentPage.agent.id === agent.id ? { ...agentPage, agent } : agentPage,
    });
  };

  const patchAgent = async (key: string, changes: Record<string, unknown>) => {
    const agent = pageAgent();
    if (!agent || s().busy) return;
    page.set({ busy: `${key}:${agent.id}` });
    try {
      const r = await api<{ agent: AgentView }>("PATCH", `/api/agents/${encodeURIComponent(agent.id)}`, changes);
      updateAgent(r.agent);
      void settle([loadAgentPage()]);
    } catch (err) {
      fail(err);
    } finally {
      page.set({ busy: null });
    }
  };

  const decide = async (id: string, decision: "allow_once" | "always_allow" | "deny") => {
    const card = s().held.find((m) => m.id === id);
    if (!card || s().busy) return;
    page.set({ busy: `decide:${id}` });
    try {
      await api("POST", `/api/approvals/held/${encodeURIComponent(id)}`, { decision });
      page.set({ held: s().held.filter((m) => m.id !== id) });
      note(
        decision === "allow_once"
          ? `Allowed once. Sent to ${card.to.label}.`
          : decision === "always_allow"
            ? `Sent. ${card.from.label} is always allowed now.`
            : `Not allowed. ${card.from.label} was told.`,
        true,
      );
      refresh(["approvals", "threads", "agents"]);
    } catch (err) {
      fail(err);
      refresh(["approvals"]);
    } finally {
      page.set({ busy: null });
    }
  };

  // -- workspaces --
  const pageWorkspace = (): WorkspaceView | null => {
    const route = s().route;
    if (route.page !== "workspace") return null;
    return s().workspacePage?.workspace.id === route.id ? s().workspacePage!.workspace : (s().workspaces.find((w) => w.id === route.id) ?? null);
  };
  const formError = (err: unknown) => {
    const form = s().wsForm;
    if (form) page.set({ wsForm: { ...form, error: failure(err) } });
  };
  /** Runs one workspace change, then reloads what shows the workspaces. */
  const wsRun = async (busy: string, job: () => Promise<void>, onError: (err: unknown) => void = fail) => {
    if (s().busy) return;
    page.set({ busy });
    try {
      await job();
      await settle([loadWorkspaces(), loadAgents(), loadWorkspacePage()]);
    } catch (err) {
      onError(err);
    } finally {
      page.set({ busy: null });
    }
  };

  const openNewWorkspace = (thenShare: boolean) => {
    const route = s().route;
    // The form shows on the Agents page and on a Portico's own page. The name is optional.
    if (route.page !== "workspace" && route.page !== "agents") go("/agents");
    page.set({ wsForm: { kind: "new", name: "", agentIds: [], thenShare, error: "" }, navOpen: false });
  };

  const createWorkspace = () => {
    const form = s().wsForm;
    if (form?.kind !== "new") return;
    void wsRun(
      "ws-form",
      async () => {
        const { workspace } = await api<{ workspace: WorkspaceView }>("POST", "/api/porticos", { name: form.name, agentIds: form.agentIds });
        page.set({ wsForm: null });
        await loadWorkspaces();
        go(`/p/${workspace.id}`);
        if (form.thenShare) page.set({ wsForm: { kind: "share", email: "", error: "" } });
        else note(`Made ${workspace.phrase}.`, true);
      },
      formError,
    );
  };

  const createShare = () => {
    const form = s().wsForm;
    const w = pageWorkspace();
    if (form?.kind !== "share" || !w) return;
    void wsRun(
      "ws-form",
      async () => {
        const { share } = await api<{ share: ShareView }>("POST", `/api/porticos/${encodeURIComponent(w.id)}/shares`, { email: form.email.trim() || undefined });
        page.set({ wsForm: null, wsMail: share.mail ? { ...s().wsMail, [share.id]: share.mail } : s().wsMail });
        note(share.email && share.mail === "sent" ? `Share link emailed to ${share.email}.` : "Share link made. Copy the link below and send it.", true);
      },
      formError,
    );
  };

  const renameWorkspace = () => {
    const form = s().wsForm;
    const w = pageWorkspace();
    if (form?.kind !== "rename" || !w) return;
    void wsRun(
      "ws-form",
      async () => {
        await api("PATCH", `/api/porticos/${encodeURIComponent(w.id)}`, { name: form.name });
        page.set({ wsForm: null });
      },
      formError,
    );
  };

  const addWorkspaceAgents = () => {
    const form = s().wsForm;
    const w = pageWorkspace();
    if (form?.kind !== "agents" || !w) return;
    void wsRun(
      "ws-form",
      async () => {
        for (const id of form.agentIds) await api("PUT", `/api/porticos/${encodeURIComponent(w.id)}/agents/${encodeURIComponent(id)}`);
        page.set({ wsForm: null });
      },
      formError,
    );
  };

  const setWorkspaceAgent = (workspaceId: string, agentId: string, on: boolean, busy: string) =>
    wsRun(busy, async () => {
      await api(on ? "PUT" : "DELETE", `/api/porticos/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}`);
    });

  const removeWorkspacePerson = (personId: string) => {
    const w = pageWorkspace();
    if (!w) return;
    const leaving = personId === s().me.id;
    const person = w.people.find((p) => p.id === personId);
    void wsRun("ws-confirm", async () => {
      await api("DELETE", `/api/porticos/${encodeURIComponent(w.id)}/people/${encodeURIComponent(personId)}`);
      page.set({ wsConfirm: null });
      if (leaving) {
        await loadWorkspaces();
        go("/");
        note(`Left ${w.phrase}.`);
      } else note(`${person?.name ?? "The person"} removed from ${w.phrase}.`);
    });
  };

  const deleteWorkspace = () => {
    const w = pageWorkspace();
    if (!w) return;
    void wsRun("ws-confirm", async () => {
      await api("DELETE", `/api/porticos/${encodeURIComponent(w.id)}`);
      page.set({ wsConfirm: null });
      await loadWorkspaces();
      go("/");
      note(`Deleted ${w.phrase}.`);
    });
  };

  const endShare = (id: string) =>
    wsRun("ws-confirm", async () => {
      await api("DELETE", `/api/shares/${encodeURIComponent(id)}`);
      page.set({ wsConfirm: null });
      note("Share link ended.");
    });

  const mailShare = async (id: string) => {
    if (s().busy) return;
    page.set({ busy: `ws-mail:${id}` });
    try {
      const { share } = await api<{ share: ShareView }>("POST", `/api/shares/${encodeURIComponent(id)}/mail`);
      if (share.mail) page.set({ wsMail: { ...s().wsMail, [id]: share.mail } });
      await settle([loadWorkspacePage()]);
    } catch (err) {
      fail(err);
    } finally {
      page.set({ busy: null });
    }
  };

  const copyShare = async (id: string) => {
    const link = s().workspacePage?.shares.find((share) => share.id === id)?.link;
    if (!link) return;
    if (await copyText(link, `share-${id}`)) {
      page.set({ wsCopied: { ...s().wsCopied, [id]: true } });
      setTimeout(() => page.set({ wsCopied: { ...s().wsCopied, [id]: false } }), 2000);
    }
  };

  const saveEdit = async () => {
    const agent = pageAgent();
    const edit = s().edit;
    if (!agent || !edit || s().busy) return;
    const name = edit.name.trim();
    const problem = nameProblem(name);
    if (problem) {
      page.set({ edit: { ...edit, error: problem } });
      return;
    }
    const changes: Record<string, unknown> = {};
    if (name !== agent.name) changes.name = name;
    if (edit.description.trim() !== agent.description) changes.description = edit.description.trim();
    if (Object.keys(changes).length === 0) {
      page.set({ edit: null, saved: false });
      return;
    }
    page.set({ busy: `save:${agent.id}` });
    try {
      const r = await api<{ agent: AgentView }>("PATCH", `/api/agents/${encodeURIComponent(agent.id)}`, changes);
      page.set({ edit: null, saved: true });
      updateAgent(r.agent);
    } catch (err) {
      const current = s().edit;
      const error = err instanceof ApiError && err.status === 409 ? "Name already in use." : failure(err);
      if (current) page.set({ edit: { ...current, error } });
    } finally {
      page.set({ busy: null });
    }
  };

  const saveWake = async () => {
    const agent = pageAgent();
    const w = s().wakeEdit;
    if (!agent || !w || s().busy) return;
    const url = w.url.trim();
    const key = w.key.trim();
    if (!/^https?:\/\//i.test(url)) return page.set({ wakeEdit: { ...w, error: "Paste the address, starting with https://." } });
    if (!key) return page.set({ wakeEdit: { ...w, error: "Paste the key as well." } });
    page.set({ busy: `wake:${agent.id}` });
    try {
      await api("PUT", `/api/agents/${encodeURIComponent(agent.id)}/wake`, { url, key });
      page.set({ wakeEdit: null, saved: true });
      await loadAgentPage();
    } catch (err) {
      const current = s().wakeEdit;
      if (current) page.set({ wakeEdit: { ...current, error: failure(err) } });
    } finally {
      page.set({ busy: null });
    }
  };

  const removeWake = async () => {
    const agent = pageAgent();
    if (!agent || s().busy) return;
    page.set({ busy: `wake:${agent.id}` });
    try {
      await api("DELETE", `/api/agents/${encodeURIComponent(agent.id)}/wake`);
      await loadAgentPage();
    } catch (err) {
      fail(err);
    } finally {
      page.set({ busy: null });
    }
  };

  const removeAgent = async (id: string) => {
    const agent = s().agents.find((a) => a.id === id) ?? pageAgent();
    if (!agent || s().busy) return;
    page.set({ busy: `remove:${id}` });
    try {
      await api("DELETE", `/api/agents/${encodeURIComponent(id)}`);
      page.set({ agents: s().agents.filter((a) => a.id !== id), confirmRemove: false });
      go("/");
      note(`${agent.label} removed and signed out.`);
    } catch (err) {
      fail(err);
    } finally {
      page.set({ busy: null });
    }
  };

  const toggleTask = (id: string) => {
    const open = s().openTasks;
    if (id in open) {
      const { [id]: _closed, ...rest } = open;
      page.set({ openTasks: rest });
      return;
    }
    page.set({ openTasks: { ...open, [id]: null } });
    void settle([loadTask(id)]);
  };

  const setFilter = (patch: Partial<HomeState["filter"]>) => {
    page.set({ filter: { ...s().filter, ...patch }, openTasks: {} });
    void settle([loadTasks(), loadEvents()]);
  };

  listen({
    outside(target) {
      if (s().acctOpen && !target.closest(".menu") && !target.closest("[data-action=acct-toggle]")) page.set({ acctOpen: false });
    },
    escape() {
      if (s().acctOpen) page.set({ acctOpen: false });
      else if (s().add) add.close();
      else if (s().navOpen) page.set({ navOpen: false });
      else if (s().edit) page.set({ edit: null });
      else if (s().wakeEdit) page.set({ wakeEdit: null });
      else if (s().wsForm) page.set({ wsForm: null });
      else if (s().wsConfirm) page.set({ wsConfirm: null });
    },
    input(name, value) {
      const edit = s().edit;
      if (name === "edit-name" && edit) page.set({ edit: { ...edit, name: value, error: "" } });
      else if (name === "edit-desc" && edit) page.set({ edit: { ...edit, description: value.slice(0, 500) } });
      else if (name === "wake-url" && s().wakeEdit) page.set({ wakeEdit: { ...s().wakeEdit!, url: value, error: "" } });
      else if (name === "wake-key" && s().wakeEdit) page.set({ wakeEdit: { ...s().wakeEdit!, key: value, error: "" } });
      else if (name === "ws-name" && (s().wsForm?.kind === "new" || s().wsForm?.kind === "rename")) page.set({ wsForm: { ...s().wsForm!, name: value, error: "" } as WorkspaceForm });
      else if (name === "ws-email" && s().wsForm?.kind === "share") page.set({ wsForm: { ...s().wsForm!, email: value, error: "" } as WorkspaceForm });
      else if (name === "filter-agent") setFilter({ agent: value || null });
      else if (name === "filter-project") setFilter({ project: value || null });
    },
    form(name) {
      if (name === "agent-save") void saveEdit();
      else if (name === "wake-save") void saveWake();
      else if (name === "ws-create") createWorkspace();
      else if (name === "ws-share") createShare();
      else if (name === "ws-rename") renameWorkspace();
      else if (name === "ws-agents") addWorkspaceAgents();
    },
    action(name, el, event) {
      const id = el.dataset.id ?? "";
      switch (name) {
        case "ws-new-open":
          return openNewWorkspace(false);
        case "ws-form-cancel":
          return page.set({ wsForm: null });
        case "ws-tick": {
          const form = s().wsForm;
          if (form?.kind !== "new" && form?.kind !== "agents") return;
          const agentIds = form.agentIds.includes(id) ? form.agentIds.filter((x) => x !== id) : [...form.agentIds, id];
          return page.set({ wsForm: { ...form, agentIds, error: "" } });
        }
        case "ws-share-open": {
          const w = pageWorkspace();
          if (!w) return;
          // The person's own Portico can't be shared: sharing from there starts a new Portico first.
          if (w.kind === "personal") return openNewWorkspace(true);
          return page.set({ wsForm: { kind: "share", email: "", error: "" } });
        }
        case "ws-people-toggle":
          return page.set({ peopleOpen: !s().peopleOpen });
        case "ws-agents-open":
          return page.set({ wsForm: { kind: "agents", agentIds: [], error: "" } });
        case "ws-rename-open":
          return page.set({ wsForm: { kind: "rename", name: pageWorkspace()?.named ? pageWorkspace()!.name : "", error: "" } });
        case "ws-agent-add": {
          // Back into the person's own Portico, from its page.
          const w = pageWorkspace();
          if (w) void setWorkspaceAgent(w.id, id, true, `ws-agent:${id}`);
          return;
        }
        case "ws-agent-remove": {
          const w = pageWorkspace();
          if (w) void setWorkspaceAgent(w.id, id, false, `ws-agent:${id}`);
          return;
        }
        case "ws-toggle": {
          const workspaceId = el.dataset.ws ?? "";
          void setWorkspaceAgent(workspaceId, id, el.getAttribute("aria-checked") !== "true", `ws-tick:${workspaceId}:${id}`);
          return;
        }
        case "ws-confirm":
          return page.set({ wsConfirm: id });
        case "ws-confirm-cancel":
          return page.set({ wsConfirm: null });
        case "ws-person-remove":
          return removeWorkspacePerson(id);
        case "ws-delete":
          return deleteWorkspace();
        case "ws-share-end":
          return void endShare(id);
        case "ws-share-mail":
          return void mailShare(id);
        case "ws-share-copy":
          return void copyShare(id);
        case "go": {
          // A modified click opens a new tab, as any link does.
          const mouse = event as MouseEvent;
          if (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.button === 1) {
            window.open(el.dataset.href ?? "/", "_blank");
            return;
          }
          return go(el.dataset.href ?? "/");
        }
        case "acct-toggle":
          return page.set({ acctOpen: !s().acctOpen });
        case "sign-out":
          return void signOut();
        case "nav-open":
          return page.set({ navOpen: true, acctOpen: false });
        case "nav-close":
          return page.set({ navOpen: false });
        case "add-open":
          page.set({ navOpen: false });
          return add.open();
        case "add-close":
          return add.close();
        case "add-copy":
          return void add.copy(id);
        case "add-another":
          return add.another();
        case "add-done":
          return add.done();
        case "open-agent":
          return go(`/a/${encodeURIComponent(id)}`);
        case "task-toggle":
          return toggleTask(id);
        case "message-toggle":
          return page.set({ shownMessages: { ...s().shownMessages, [id]: !s().shownMessages[id] } });
        case "outcome":
          return setFilter({ outcome: (id || null) as HomeState["filter"]["outcome"] });
        case "events-toggle": {
          const showEvents = !s().showEvents;
          page.set({ showEvents, events: showEvents ? s().events : null });
          if (showEvents) void settle([loadEvents()]);
          return;
        }
        case "more":
          return void settle([loadTasks(true)]);
        case "details-toggle":
          return page.set({ detailsOpen: !s().detailsOpen });
        case "settings-toggle":
          return page.set({ settingsOpen: !s().settingsOpen, confirmRemove: false });
        case "decide":
          return void decide(id, el.dataset.decision as "allow_once" | "always_allow" | "deny");
        case "edit-start": {
          const agent = pageAgent();
          if (agent) page.set({ edit: { name: agent.name, description: agent.description, error: "" }, saved: false, settingsOpen: true });
          return;
        }
        case "edit-cancel":
          return page.set({ edit: null });
        case "toggle-approval": {
          const agent = pageAgent();
          if (agent) void patchAgent("approval", { approvalRequired: !agent.approvalRequired });
          return;
        }
        case "toggle-folder": {
          const agent = pageAgent();
          if (agent) void patchAgent("folder", { joinFromFolder: agent.joinFromFolder === false });
          return;
        }
        case "allow-remove": {
          const agent = pageAgent();
          if (!agent) return;
          api("DELETE", `/api/agents/${encodeURIComponent(agent.id)}/allow/${encodeURIComponent(id)}`)
            .then(loadAgentPage)
            .catch(fail);
          return;
        }
        case "wake-start":
          return page.set({ wakeEdit: { url: "", key: "", error: "" }, saved: false, settingsOpen: true });
        case "wake-cancel":
          return page.set({ wakeEdit: null });
        case "wake-remove":
          return void removeWake();
        case "remove-start":
          return page.set({ confirmRemove: true });
        case "remove-cancel":
          return page.set({ confirmRemove: false });
        case "remove-confirm":
          return void removeAgent(id);
      }
    },
  });

  window.addEventListener("popstate", applyRoute);
  connectStream({
    changed: refresh,
    down: (isDown) => page.set({ reconnecting: isDown }),
    back: () => {
      refresh(["agents", "approvals", "me"]);
      void loadPage();
    },
  });
  setInterval(() => page.set({ now: Date.now() }), 30_000);

  // A person whose invite was just approved arrives with ?welcome.
  if (new URLSearchParams(location.search).has("welcome")) {
    history.replaceState(null, "", location.pathname);
    api<{ people: PersonRow[] }>("GET", "/api/people")
      .then((r) => r.people.find((p) => p.role === "owner")?.name ?? null)
      .catch(() => null)
      .then((owner) =>
        note(owner ? `Welcome to Portico. Approved by ${owner} at ${clock(new Date().toISOString())}.` : "Welcome to Portico."),
      );
  }

  page.paint();
  // The server rendered with its own day; Today counts from the browser's midnight.
  void loadPage();
}

// ---- Settings ----

function startSettings(root: HTMLElement, data: SettingsData): void {
  const page = new Page<SettingsState>(root, settingsState({ ...data, now: Date.now() }), renderSettings);
  const s = () => page.state;
  const add = new AddFlow(page, (agent) => {
    if (agent) void loadComputers();
  });

  const loadPeople = async () => {
    try {
      const r = await api<{ people: PersonRow[]; invites: InviteView[]; claims: ClaimView[] }>("GET", "/api/people");
      page.set({ people: r.people, invites: r.invites, claims: r.claims });
    } catch (err) {
      failure(err);
      // Until the people list loads, the signed-in person is listed alone.
      if (s().people === null) page.set({ people: [{ ...s().me, joinedAt: null }] });
    }
  };
  const loadComputers = async () => {
    try {
      page.set({ computers: (await api<{ computers: ComputerView[] }>("GET", "/api/computers")).computers });
    } catch (err) {
      failure(err);
      if (s().computers === null) page.set({ computers: [] });
    }
  };
  const loadPasskeys = async () => {
    if (!s().passwords) return;
    try {
      page.set({ passkeys: (await api<{ passkeys: PasskeyView[] }>("GET", "/api/passkeys")).passkeys });
    } catch (err) {
      // No passkeys endpoint: the Passkeys row stays hidden.
      failure(err);
    }
  };
  const loadAgents = async () => {
    try {
      page.set({ agents: (await api<{ agents: AgentView[] }>("GET", "/api/agents")).agents });
    } catch (err) {
      failure(err);
    }
  };
  const loadMe = async () => {
    try {
      page.set({ me: (await api<{ person: PersonView }>("GET", "/api/me")).person });
    } catch (err) {
      failure(err);
    }
  };

  const refresh = (topics: string[]) => {
    const t = new Set(topics);
    if (t.has("people")) void loadPeople();
    if (t.has("computers") || t.has("agents")) void loadComputers();
    if (t.has("agents")) void loadAgents();
    if (t.has("me")) {
      void loadMe();
      void loadPasskeys();
    }
    if (s().add && (t.has("computers") || t.has("approvals") || t.has("agents"))) void add.check();
  };

  const run = async (busy: string, job: () => Promise<void>, onError: (message: string, err: unknown) => void) => {
    if (s().busy) return;
    page.set({ busy });
    try {
      await job();
    } catch (err) {
      const message = failure(err);
      if (message) onError(message, err);
    } finally {
      page.set({ busy: null });
    }
  };

  const createInvite = () => {
    const form = s().invite;
    if (!form) return;
    const name = form.name.trim();
    const problem = name === "" ? "Enter a name." : Array.from(name).length > 40 ? "40 characters max." : "";
    if (problem) return page.set({ invite: { ...form, error: problem } });
    void run(
      "invite",
      async () => {
        const r = await api<{ invite: InviteView; link: string }>("POST", "/api/invites", { name });
        page.set({
          invites: [r.invite, ...s().invites.filter((i) => i.id !== r.invite.id)],
          links: { ...s().links, [r.invite.id]: r.link },
          invite: null,
          peopleNotice: `Invite for ${name} created. Copy the link to send to ${name}.`,
        });
      },
      (message) => page.set({ invite: { ...form, error: message } }),
    );
  };

  const saveName = () => {
    const form = s().nameForm;
    if (!form) return;
    const name = form.name.trim();
    if (!name) return page.set({ nameForm: { ...form, error: "Enter a name." } });
    void run(
      "name",
      async () => {
        const r = await api<{ person?: PersonView } | null>("PATCH", "/api/me", { name });
        page.set({ nameForm: null, me: r?.person ?? { ...s().me, name } });
      },
      (message, err) =>
        page.set({ nameForm: { ...form, error: err instanceof ApiError && err.status === 409 ? "Name already in use." : message } }),
    );
  };

  const saveHandle = () => {
    const form = s().handleForm;
    if (!form) return;
    const handle = form.handle.trim().toLowerCase();
    if (!handle) return page.set({ handleForm: { ...form, error: "Enter a handle." } });
    void run(
      "handle",
      async () => {
        const r = await api<{ person?: PersonView } | null>("PATCH", "/api/me", { handle });
        page.set({ handleForm: null, me: r?.person ?? { ...s().me, handle } });
      },
      (message) => page.set({ handleForm: { ...form, error: message } }),
    );
  };

  const savePassword = () => {
    const form = s().passwordForm;
    if (!form) return;
    if (!form.current) return page.set({ passwordForm: { ...form, error: "Enter the current password." } });
    if (form.next.length < 12) return page.set({ passwordForm: { ...form, error: "Use at least 12 characters." } });
    void run(
      "password",
      async () => {
        await api("POST", "/api/me/password", { current: form.current, next: form.next });
        // The change removed every passkey; the answer signed this browser back in.
        page.set({ passwordForm: null, passwordChanged: true, passkeys: s().passkeys === null ? null : [] });
      },
      (message) => page.set({ passwordForm: { ...form, current: "", error: message } }),
    );
  };

  const addPasskey = () => {
    const form = s().passkeyForm;
    if (!form) return;
    const name = form.name.trim();
    if (!name) return page.set({ passkeyForm: { ...form, error: "Enter a name." } });
    if (!form.current) return page.set({ passkeyForm: { ...form, error: "Enter the current password." } });
    if (!passkeys || s().busy) return;
    page.set({ busy: "passkey" });
    passkeys
      .addPasskey(name, form.current)
      .then(async () => {
        page.set({ passkeyForm: null });
        await loadPasskeys();
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) return void failure(err);
        const latest = s().passkeyForm;
        if (latest) page.set({ passkeyForm: { ...latest, current: "", error: passkeys!.passkeyProblem(err) } });
      })
      .finally(() => page.set({ busy: null }));
  };

  let passkeys: PasskeyModule | null = null;
  void loadPasskeyModule().then((mod) => {
    passkeys = mod;
    page.set({ passkeysSupported: Boolean(mod?.passkeysSupported()) });
  });

  listen({
    outside(target) {
      if (s().acctOpen && !target.closest(".menu") && !target.closest("[data-action=acct-toggle]")) page.set({ acctOpen: false });
    },
    escape() {
      if (s().acctOpen) page.set({ acctOpen: false });
      else if (s().add) add.close();
    },
    input(name, value) {
      if (name === "invite-name" && s().invite) page.set({ invite: { name: value, error: "" } });
      else if (name === "name-field" && s().nameForm) page.set({ nameForm: { name: value, error: "" } });
      else if (name === "handle-field" && s().handleForm) page.set({ handleForm: { handle: value, error: "" } });
      else if (name === "pw-current" && s().passwordForm) page.set({ passwordForm: { ...s().passwordForm!, current: value, error: "" } });
      else if (name === "pw-next" && s().passwordForm) page.set({ passwordForm: { ...s().passwordForm!, next: value, error: "" } });
      else if (name === "pk-name" && s().passkeyForm) page.set({ passkeyForm: { ...s().passkeyForm!, name: value, error: "" } });
      else if (name === "pk-current" && s().passkeyForm) page.set({ passkeyForm: { ...s().passkeyForm!, current: value, error: "" } });
    },
    form(name) {
      if (name === "invite-create") createInvite();
      else if (name === "name-save") saveName();
      else if (name === "handle-save") saveHandle();
      else if (name === "password-save") savePassword();
      else if (name === "passkey-add") addPasskey();
    },
    action(name, el) {
      const id = el.dataset.id ?? "";
      switch (name) {
        case "acct-toggle":
          return page.set({ acctOpen: !s().acctOpen });
        case "sign-out":
          return void signOut();
        case "add-open":
          return add.open();
        case "add-close":
          return add.close();
        case "add-copy":
          return void add.copy(id);
        case "add-another":
          return add.another();
        case "add-done":
          return add.done();
        case "invite-open":
          return page.set({ invite: s().invite ?? { name: "", error: "" } });
        case "invite-cancel":
          return page.set({ invite: null });
        case "invite-copy": {
          const link = s().invites.find((i) => i.id === id)?.link ?? s().links[id];
          if (link) void copyText(link, `invite-${id}`).then(() => page.set({ copied: { ...s().copied, [id]: true } }));
          return;
        }
        case "invite-revoke": {
          const invite = s().invites.find((i) => i.id === id);
          if (!invite) return;
          return void run(
            `revoke:${id}`,
            async () => {
              await api("DELETE", `/api/invites/${encodeURIComponent(id)}`);
              page.set({
                invites: s().invites.filter((i) => i.id !== id),
                peopleNotice: `Invite for ${invite.name} revoked. The link no longer works.`,
              });
            },
            (message) => page.set({ peopleNotice: message }),
          );
        }
        case "member-remove":
          return page.set({ confirmMember: id });
        case "member-cancel":
          return page.set({ confirmMember: null });
        case "member-confirm": {
          const person = (s().people ?? []).find((p) => p.id === id);
          if (!person) return;
          return void run(
            `member:${id}`,
            async () => {
              await api("DELETE", `/api/people/${encodeURIComponent(id)}`);
              page.set({
                people: (s().people ?? []).filter((p) => p.id !== id),
                confirmMember: null,
                peopleNotice: `${person.name} removed. ${plural(person.agentCount, "agent")} disconnected.`,
              });
              void loadComputers();
            },
            (message) => page.set({ peopleNotice: message }),
          );
        }
        case "claim-approve":
        case "claim-decline": {
          const claim = s().claims.find((c) => c.personId === id);
          if (!claim) return;
          const decision = name === "claim-approve" ? "approve" : "decline";
          return void run(
            `claim:${id}`,
            async () => {
              await api("POST", `/api/claims/${encodeURIComponent(id)}`, { decision });
              page.set({
                claims: s().claims.filter((c) => c.personId !== id),
                peopleNotice:
                  decision === "approve" ? `${claim.name} joined.` : `Declined. The invite for ${claim.inviteName} no longer works.`,
              });
              void loadPeople();
            },
            (message) => page.set({ peopleNotice: message }),
          );
        }
        case "computer-remove":
          return page.set({ confirmComputer: id });
        case "computer-cancel":
          return page.set({ confirmComputer: null });
        case "computer-confirm": {
          const computer = (s().computers ?? []).find((c) => c.id === id);
          if (!computer) return;
          return void run(
            `computer:${id}`,
            async () => {
              await api("DELETE", `/api/computers/${encodeURIComponent(id)}`);
              page.set({
                computers: (s().computers ?? []).filter((c) => c.id !== id),
                confirmComputer: null,
                compNotice: `${computer.name} removed. ${plural(computer.sessions.length, "session")} disconnected.`,
              });
            },
            (message) => page.set({ compNotice: message }),
          );
        }
        case "name-open":
          return page.set({ nameForm: { name: s().me.name, error: "" } });
        case "name-cancel":
          return page.set({ nameForm: null });
        case "handle-open":
          return page.set({ handleForm: { handle: s().me.handle ?? "", error: "" } });
        case "handle-cancel":
          return page.set({ handleForm: null });
        case "password-open":
          return page.set({ passwordForm: { current: "", next: "", error: "" }, passwordChanged: false });
        case "password-cancel":
          return page.set({ passwordForm: null });
        case "passkey-open":
          return page.set({ passkeyForm: { name: "", current: "", error: "" } });
        case "passkey-cancel":
          return page.set({ passkeyForm: null });
        case "passkey-remove":
          return void run(
            `passkey:${id}`,
            async () => {
              await api("DELETE", `/api/passkeys/${encodeURIComponent(id)}`);
              page.set({ passkeys: (s().passkeys ?? []).filter((k) => k.id !== id) });
            },
            (message) => page.set({ accountError: message }),
          );
      }
    },
  });

  connectStream({
    changed: refresh,
    down: (isDown) => page.set({ reconnecting: isDown }),
    back: () => refresh(["people", "computers", "agents", "me"]),
  });
  setInterval(() => page.set({ now: Date.now() }), 30_000);
  page.paint();
  if (data.people === null) void loadPeople();
  if (data.computers === null) void loadComputers();
  if (data.passkeys === null) void loadPasskeys();
}

// ---- passkeys ----

/** The Accounts track's browser module: the WebAuthn ceremony for adding a passkey. */
interface PasskeyModule {
  addPasskey(name: string, current: string): Promise<PasskeyView>;
  passkeysSupported(): boolean;
  passkeyProblem(err: unknown): string;
}

/** Loads passkey.js when Portico serves it; without it, Settings hides Add passkey. */
async function loadPasskeyModule(): Promise<PasskeyModule | null> {
  const path = "./passkey.js";
  try {
    return (await import(path)) as PasskeyModule;
  } catch {
    return null;
  }
}

// ---- start ----

const root = document.getElementById("app");
const data = firstData<HomeData | SettingsData>();
if (root && data?.page === "home") startHome(root, data);
else if (root && data?.page === "settings") startSettings(root, data);
