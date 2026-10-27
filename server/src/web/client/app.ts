// Home and Settings in the browser. The server embeds the first data and the first render; from then on the page
// renders from state with the pure functions in render/, acts only through the person API, and refetches what changed
// when the event stream says so. One delegated listener handles every data-action, data-form and data-input.
import { api, ApiError, firstData } from "./api.js";
import { addLine, clock, kindInfo, plural } from "./render/common.js";
import { homeState, renderHome } from "./render/home.js";
import { renderSettings, settingsState } from "./render/settings.js";
import type {
  AddState,
  AgentData,
  AgentKind,
  AgentView,
  ClaimView,
  ComputerView,
  HeldCard,
  HomeData,
  HomeState,
  InviteView,
  MessageView,
  NewJoinLine,
  PasskeyView,
  PersonRow,
  PersonView,
  SettingsData,
  SettingsState,
  SignInView,
  ThreadData,
  ThreadView,
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

interface JoinLineDetail {
  id: string;
  kind: AgentKind;
  expiresAt: string;
  usedAt: string | null;
  agent: { id: string } | null;
  signIn: SignInView | null;
}

function emptyAdd(pick: AgentKind = "claude-code"): AddState {
  return { pick, lines: {}, lineError: "", copied: false, stage: "pick", signIn: null, reqName: "", reqError: "", joined: null, busy: false };
}

class AddFlow<S extends Shared> {
  private known = new Set<string>();
  private creating = new Set<AgentKind>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(
    private readonly page: Page<S>,
    private readonly onDone: (agent: AgentView | null) => void,
  ) {}

  open(): void {
    this.known = new Set(this.page.state.agents.map((a) => a.id));
    this.page.set({ add: emptyAdd(), acctOpen: false } as Partial<S>);
    void this.ensureLine("claude-code");
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

  async ensureLine(kind: AgentKind): Promise<void> {
    const add = this.add;
    if (!add || kindInfo(kind).connector || add.lines[kind] || this.creating.has(kind)) return;
    this.creating.add(kind);
    try {
      const { joinLine } = await api<{ joinLine: NewJoinLine }>("POST", "/api/join-lines", { kind });
      const now = this.add;
      if (now) {
        now.lines[kind] = joinLine;
        now.lineError = "";
      }
    } catch (err) {
      if (this.add) this.add.lineError = failure(err);
    } finally {
      this.creating.delete(kind);
      this.page.schedule();
    }
  }

  pick(kind: AgentKind): void {
    const add = this.add;
    if (!add) return;
    Object.assign(add, { pick: kind, copied: false, stage: "pick", signIn: null, reqError: "", lineError: "" });
    this.page.schedule();
    void this.ensureLine(kind);
  }

  async copy(): Promise<void> {
    const add = this.add;
    if (!add) return;
    const line = addLine(add, this.page.state.publicUrl);
    if (!line) return;
    await copyText(line, "add-line");
    add.copied = true;
    this.page.schedule();
    void this.check();
  }

  /** A used line can't be pasted again: drop it and make a fresh one. */
  private freshLine(add: AddState): void {
    delete add.lines[add.pick];
    void this.ensureLine(add.pick);
  }

  another(): void {
    const add = this.add;
    if (!add) return;
    this.known = new Set(this.page.state.agents.map((a) => a.id));
    Object.assign(add, { stage: "pick", copied: false, joined: null, signIn: null, reqError: "" });
    this.freshLine(add);
    this.page.schedule();
  }

  done(): void {
    const joined = this.add?.joined ?? null;
    this.close();
    this.onDone(joined);
  }

  setName(value: string): void {
    if (!this.add) return;
    this.add.reqName = value;
    this.add.reqError = "";
    this.page.schedule();
  }

  async decide(decision: "approve" | "deny"): Promise<void> {
    const add = this.add;
    if (!add?.signIn || add.busy) return;
    const name = add.reqName.trim();
    if (decision === "approve") {
      const problem = nameProblem(name);
      if (problem) {
        add.reqError = problem;
        this.page.schedule();
        return;
      }
    }
    add.busy = true;
    this.page.schedule();
    try {
      const answer = await api<{ agent?: { id: string } } | null>("POST", `/api/approvals/sign-ins/${encodeURIComponent(add.signIn.id)}`, {
        decision,
        ...(decision === "approve" ? { name } : {}),
      });
      if (decision === "deny") {
        Object.assign(add, { stage: "pick", copied: false, signIn: null, busy: false });
        this.freshLine(add);
      } else {
        await this.check(answer?.agent?.id);
      }
    } catch (err) {
      add.busy = false;
      add.reqError = err instanceof ApiError && err.status === 409 ? "Name already in use." : failure(err);
    }
    this.page.schedule();
  }

  /** Looks for the agent the line brought in, or a sign-in request waiting on it. */
  async check(agentId?: string): Promise<void> {
    const add = this.add;
    if (!add || add.stage === "joined" || this.checking) return;
    this.checking = true;
    try {
      if (kindInfo(add.pick).connector) {
        const { agents } = await api<{ agents: AgentView[] }>("GET", "/api/agents");
        this.page.state.agents = agents;
        const fresh = agents.find((a) => a.mine && a.type === "connector" && !this.known.has(a.id));
        if (fresh) this.joined(fresh);
        return;
      }
      let id = agentId ?? null;
      let signIn: SignInView | null = null;
      const line = add.lines[add.pick];
      if (!id && line) {
        const { joinLine } = await api<{ joinLine: JoinLineDetail }>("GET", `/api/join-lines/${encodeURIComponent(line.id)}`);
        id = joinLine.agent?.id ?? null;
        signIn = joinLine.signIn;
      }
      if (id) {
        let agent = this.page.state.agents.find((a) => a.id === id);
        if (!agent) {
          const { agents } = await api<{ agents: AgentView[] }>("GET", "/api/agents");
          this.page.state.agents = agents;
          agent = agents.find((a) => a.id === id);
        }
        if (agent) this.joined(agent);
      } else if (signIn?.status === "pending" && add.stage === "pick") {
        Object.assign(add, { stage: "request", signIn, reqName: signIn.name, reqError: "" });
      } else if (signIn && signIn.status !== "pending" && signIn.status !== "approved" && add.stage === "request") {
        Object.assign(add, { stage: "pick", copied: false, signIn: null, busy: false });
        this.freshLine(add);
      }
    } catch (err) {
      // The line may be gone (expired) or the endpoint busy; the next check tries again.
      if (err instanceof ApiError && err.status === 401) failure(err);
    } finally {
      this.checking = false;
      this.page.schedule();
    }
  }

  private joined(agent: AgentView): void {
    const add = this.add;
    if (!add) return;
    Object.assign(add, { stage: "joined", joined: agent, busy: false, signIn: null });
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
  location.assign("/sign-in");
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

// ---- Home ----

function startHome(root: HTMLElement, data: HomeData): void {
  const page = new Page<HomeState>(root, homeState({ ...data, now: Date.now() }), renderHome);
  const s = () => page.state;
  const add = new AddFlow(page, (agent) => {
    if (!agent) return;
    go(`/a/${agent.id}`);
    page.set({ notice: { text: agent.computer ? `${agent.display} joined from ${agent.computer.name}.` : `${agent.display} joined.` } });
  });

  const note = (text: string, check = false) => page.set({ notice: { text, check } });
  const fail = (err: unknown) => {
    const text = failure(err);
    if (text) page.set({ notice: { text, error: true } });
  };

  // -- fetching --
  const loadAgents = async () => page.set({ agents: (await api<{ agents: AgentView[] }>("GET", "/api/agents")).agents });
  const loadApprovals = async () => {
    const r = await api<{ held: HeldCard[]; signIns: SignInView[] }>("GET", "/api/approvals");
    page.set({ held: r.held, signIns: r.signIns });
    void loadQuoteTimes();
  };
  const loadThreads = async () => page.set({ threads: (await api<{ threads: ThreadView[] }>("GET", "/api/threads")).threads });
  const loadMe = async () => page.set({ me: (await api<{ person: PersonView }>("GET", "/api/me")).person });

  const rememberTimes = (messages: MessageView[]) => {
    const times = { ...s().quoteTimes };
    for (const m of messages) times[m.id] = m.createdAt;
    page.set({ quoteTimes: times });
  };

  /** A held card quotes the message it answers with that message's time, read from the thread. */
  const loadQuoteTimes = async () => {
    const threads = new Set(s().held.filter((m) => m.replyTo && !s().quoteTimes[m.replyTo.id]).map((m) => m.threadId));
    for (const id of threads) {
      try {
        rememberTimes((await api<ThreadData>("GET", `/api/threads/${encodeURIComponent(id)}`)).messages);
      } catch {
        // The quote shows without a time.
      }
    }
  };

  const loadOpen = async () => {
    const open = s().open;
    if (!open || open.kind === "signin") return;
    try {
      if (open.kind === "thread") {
        const data = await api<ThreadData>("GET", `/api/threads/${encodeURIComponent(open.id)}`);
        const now = s().open;
        if (now?.kind === "thread" && now.id === open.id) page.set({ open: { ...now, data } });
        rememberTimes(data.messages);
      } else {
        const data = await api<AgentData>("GET", `/api/agents/${encodeURIComponent(open.id)}`);
        const now = s().open;
        if (now?.kind === "agent" && now.id === open.id) page.set({ open: { ...now, data } });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        if (location.pathname !== "/") history.replaceState(null, "", "/");
        page.set({ open: null, filter: s().filter === open.id ? null : s().filter });
      } else fail(err);
    }
  };

  const refresh = (topics: string[]) => {
    const t = new Set(topics);
    const jobs: Promise<unknown>[] = [];
    if (t.has("agents") || t.has("people")) jobs.push(loadAgents());
    if (t.has("approvals")) jobs.push(loadApprovals());
    if (t.has("threads") || t.has("approvals")) jobs.push(loadThreads());
    if (t.has("me")) jobs.push(loadMe());
    const open = s().open;
    if (open?.kind === "thread" && (t.has("threads") || t.has("approvals"))) jobs.push(loadOpen());
    if (open?.kind === "agent" && (t.has("agents") || t.has("approvals"))) jobs.push(loadOpen());
    if (s().add && (t.has("join-lines") || t.has("approvals") || t.has("agents"))) jobs.push(add.check());
    void Promise.all(jobs.map((job) => job.catch((err) => (err instanceof ApiError && err.status === 401 ? failure(err) : null))));
  };

  // -- routes --
  const routeOf = (path: string): { kind: "thread" | "agent"; id: string } | null => {
    const m = /^\/(c|a)\/([^/]+)\/?$/.exec(path);
    if (!m) return null;
    return { kind: m[1] === "c" ? "thread" : "agent", id: decodeURIComponent(m[2]!) };
  };

  const applyRoute = () => {
    const route = routeOf(location.pathname);
    // Opening something new clears what the last action said, as the boards do.
    const reset = { edit: null, saved: false, expanded: false, confirmRemove: false, acctOpen: false, agentsOpen: false, notice: null };
    if (!route) {
      page.set({ open: null, ...reset });
      return;
    }
    const prior = s().open;
    if (route.kind === "thread") {
      const data = prior?.kind === "thread" && prior.id === route.id ? prior.data : null;
      page.set({ open: { kind: "thread", id: route.id, data }, ...reset });
    } else {
      const agent = s().agents.find((a) => a.id === route.id);
      const keep = prior?.kind === "agent" && prior.id === route.id ? prior.data : null;
      const data = keep ?? (agent ? { agent, allowList: null } : null);
      page.set({
        open: { kind: "agent", id: route.id, data },
        filter: route.id,
        offlineOpen: s().offlineOpen || agent?.status === "offline",
        ...reset,
      });
    }
    void loadOpen();
  };

  const go = (path: string) => {
    if (location.pathname !== path) history.pushState(null, "", path);
    applyRoute();
  };

  // -- actions --
  const openAgent = () => (s().open?.kind === "agent" ? (s().open as { data: AgentData | null }).data?.agent ?? null : null);

  const updateAgent = (agent: AgentView) => {
    const open = s().open;
    page.set({
      agents: s().agents.map((a) => (a.id === agent.id ? agent : a)),
      open: open?.kind === "agent" && open.id === agent.id ? { ...open, data: { agent, allowList: open.data?.allowList ?? null } } : open,
    });
  };

  const patchAgent = async (key: string, changes: Record<string, unknown>) => {
    const agent = openAgent();
    if (!agent || s().busy) return;
    page.set({ busy: `${key}:${agent.id}` });
    try {
      const r = await api<{ agent: AgentView }>("PATCH", `/api/agents/${encodeURIComponent(agent.id)}`, changes);
      updateAgent(r.agent);
      void loadOpen();
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
          ? `Delivered to ${card.to.display}.`
          : decision === "always_allow"
            ? `Delivered. ${card.from.display} is now always allowed.`
            : `Declined. ${card.from.display} was notified.`,
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

  const decideSignIn = async (id: string, decision: "approve" | "deny") => {
    const request = s().signIns.find((r) => r.id === id);
    if (!request || s().busy) return;
    page.set({ busy: `signin:${id}` });
    try {
      const answer = await api<{ agent?: { id: string } } | null>("POST", `/api/approvals/sign-ins/${encodeURIComponent(id)}`, {
        decision,
        ...(decision === "approve" ? { name: request.name } : {}),
      });
      page.set({ signIns: s().signIns.filter((r) => r.id !== id) });
      if (s().open?.kind === "signin" && s().open!.id === id) page.set({ open: null });
      if (s().filter === `signin:${id}`) page.set({ filter: null });
      if (decision === "deny") {
        note("Sign in request declined.");
        return;
      }
      await loadAgents();
      const agent =
        s().agents.find((a) => a.id === answer?.agent?.id) ?? s().agents.find((a) => a.mine && a.name === request.name);
      if (agent) go(`/a/${agent.id}`);
      note(`${request.name} joined.`);
    } catch (err) {
      fail(err);
    } finally {
      page.set({ busy: null });
    }
  };

  const saveEdit = async () => {
    const agent = openAgent();
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

  const removeAgent = async (id: string) => {
    const agent = s().agents.find((a) => a.id === id) ?? openAgent();
    if (!agent || s().busy) return;
    page.set({ busy: `remove:${id}` });
    try {
      await api("DELETE", `/api/agents/${encodeURIComponent(id)}`);
      page.set({ agents: s().agents.filter((a) => a.id !== id), filter: null, confirmRemove: false });
      go("/");
      note(`${agent.display} removed and signed out.`);
    } catch (err) {
      fail(err);
    } finally {
      page.set({ busy: null });
    }
  };

  listen({
    outside(target) {
      if (s().acctOpen && !target.closest(".menu") && !target.closest("[data-action=acct-toggle]")) page.set({ acctOpen: false });
    },
    escape() {
      if (s().acctOpen) page.set({ acctOpen: false });
      else if (s().add) add.close();
      else if (s().agentsOpen) page.set({ agentsOpen: false });
      else if (s().open) {
        if (s().open!.kind === "signin") page.set({ open: null });
        else go("/");
      }
    },
    input(name, value) {
      const edit = s().edit;
      if (name === "edit-name" && edit) page.set({ edit: { ...edit, name: value, error: "" } });
      else if (name === "edit-desc" && edit) page.set({ edit: { ...edit, description: value.slice(0, 500) } });
      else if (name === "add-req-name") add.setName(value);
    },
    form(name) {
      if (name === "agent-save") void saveEdit();
      else if (name === "add-approve") void add.decide("approve");
    },
    action(name, el) {
      const id = el.dataset.id ?? "";
      switch (name) {
        case "acct-toggle":
          return page.set({ acctOpen: !s().acctOpen });
        case "sign-out":
          return void signOut();
        case "agents-open":
          return page.set({ agentsOpen: true, acctOpen: false });
        case "agents-close":
          return page.set({ agentsOpen: false });
        case "add-open":
          page.set({ agentsOpen: false });
          return add.open();
        case "add-close":
          return add.close();
        case "add-pick":
          return add.pick(id as AgentKind);
        case "add-copy":
          return void add.copy();
        case "add-deny":
          return void add.decide("deny");
        case "add-another":
          return add.another();
        case "add-done":
          return add.done();
        case "offline-toggle":
          return page.set({ offlineOpen: !s().offlineOpen });
        case "open-agent":
          return go(`/a/${encodeURIComponent(id)}`);
        case "open-thread":
          return go(`/c/${encodeURIComponent(id)}`);
        case "open-signin":
          if (location.pathname !== "/") history.pushState(null, "", "/");
          return page.set({ open: { kind: "signin", id }, filter: `signin:${id}`, agentsOpen: false, confirmRemove: false, edit: null });
        case "close-panel":
          if (s().open?.kind === "signin") return page.set({ open: null, confirmRemove: false });
          return go("/");
        case "clear-filter":
          return page.set({ filter: null });
        case "decide":
          return void decide(id, el.dataset.decision as "allow_once" | "always_allow" | "deny");
        case "signin-approve":
          return void decideSignIn(id, "approve");
        case "signin-deny":
        case "signin-remove":
          return void decideSignIn(id, "deny");
        case "edit-start": {
          const agent = openAgent();
          if (agent) page.set({ edit: { name: agent.name, description: agent.description, error: "" }, saved: false });
          return;
        }
        case "edit-cancel":
          return page.set({ edit: null });
        case "desc-more":
          return page.set({ expanded: !s().expanded });
        case "toggle-approval": {
          const agent = openAgent();
          if (agent) void patchAgent("approval", { approvalRequired: !agent.approvalRequired });
          return;
        }
        case "toggle-folder": {
          const agent = openAgent();
          if (agent) void patchAgent("folder", { joinFromFolder: agent.joinFromFolder === false });
          return;
        }
        case "allow-remove": {
          const agent = openAgent();
          if (!agent) return;
          api("DELETE", `/api/agents/${encodeURIComponent(agent.id)}/allow/${encodeURIComponent(id)}`)
            .then(loadOpen)
            .catch(fail);
          return;
        }
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
    back: () => refresh(["agents", "approvals", "threads", "me", "join-lines"]),
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
  void loadQuoteTimes();
  if (s().open && s().open!.kind !== "signin" && !(s().open as { data: unknown }).data) void loadOpen();
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
    if (s().add && (t.has("join-lines") || t.has("approvals") || t.has("agents"))) void add.check();
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

  const savePassword = () => {
    const form = s().passwordForm;
    if (!form) return;
    if (!form.current) return page.set({ passwordForm: { ...form, error: "Enter the current password." } });
    if (form.next.length < 12) return page.set({ passwordForm: { ...form, error: "Use at least 12 characters." } });
    void run(
      "password",
      async () => {
        await api("POST", "/api/me/password", { current: form.current, next: form.next });
        page.set({ passwordForm: null, passwordChanged: true });
      },
      (message) => page.set({ passwordForm: { ...form, current: "", error: message } }),
    );
  };

  const addPasskey = () => {
    const form = s().passkeyForm;
    if (!form) return;
    const name = form.name.trim();
    if (!name) return page.set({ passkeyForm: { ...form, error: "Enter a name." } });
    if (!passkeys || s().busy) return;
    page.set({ busy: "passkey" });
    passkeys
      .addPasskey(name)
      .then(async () => {
        page.set({ passkeyForm: null });
        await loadPasskeys();
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) return void failure(err);
        const current = s().passkeyForm;
        if (current) page.set({ passkeyForm: { ...current, error: passkeys!.passkeyProblem(err) } });
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
      else if (name === "pw-current" && s().passwordForm) page.set({ passwordForm: { ...s().passwordForm!, current: value, error: "" } });
      else if (name === "pw-next" && s().passwordForm) page.set({ passwordForm: { ...s().passwordForm!, next: value, error: "" } });
      else if (name === "pk-name" && s().passkeyForm) page.set({ passkeyForm: { name: value, error: "" } });
      else if (name === "add-req-name") add.setName(value);
    },
    form(name) {
      if (name === "invite-create") createInvite();
      else if (name === "name-save") saveName();
      else if (name === "password-save") savePassword();
      else if (name === "passkey-add") addPasskey();
      else if (name === "add-approve") void add.decide("approve");
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
        case "add-pick":
          return add.pick(id as AgentKind);
        case "add-copy":
          return void add.copy();
        case "add-deny":
          return void add.decide("deny");
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
        case "password-open":
          return page.set({ passwordForm: { current: "", next: "", error: "" }, passwordChanged: false });
        case "password-cancel":
          return page.set({ passwordForm: null });
        case "passkey-open":
          return page.set({ passkeyForm: { name: "", error: "" } });
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
  void loadPeople();
  void loadComputers();
  void loadPasskeys();
}

// ---- passkeys ----

/** The Accounts track's browser module: the WebAuthn ceremony for adding a passkey. */
interface PasskeyModule {
  addPasskey(name: string): Promise<PasskeyView>;
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
