// Home: the agents list, Needs approval and Threads, and the right panel. Pure: state in, HTML out.
import {
  agentState,
  agentStatusLine,
  agentSub,
  atWhen,
  clock,
  date,
  dayLabel,
  esc,
  expiresIn,
  ICON,
  kindInfo,
  logo,
  pav,
  PICK_ORDER,
  renderAddSheet,
  renderHeader,
  renderNotice,
  renderReconnecting,
  shortWhen,
  sinceDay,
  when,
} from "./common.js";
import type {
  AgentData,
  AgentView,
  HeldCard,
  HomeState,
  MessageView,
  PersonView,
  SignInView,
  ThreadData,
  ThreadView,
} from "./types.js";

/** Longer descriptions clamp to three lines behind More. */
const LONG_DESCRIPTION = 200;

function joinNames(list: string[]): string {
  return list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function signInFilter(id: string): string {
  return `signin:${id}`;
}

function filterName(s: HomeState): string | null {
  if (!s.filter) return null;
  if (s.filter.startsWith("signin:")) return s.signIns.find((r) => signInFilter(r.id) === s.filter)?.name ?? null;
  return s.agents.find((a) => a.id === s.filter)?.display ?? null;
}

/** The filter, if it still names something on the page. */
function activeFilter(s: HomeState): string | null {
  return filterName(s) === null ? null : s.filter;
}

function visibleHeld(s: HomeState): HeldCard[] {
  const f = activeFilter(s);
  if (!f) return s.held;
  return s.held.filter((m) => m.from.id === f || m.to.id === f);
}

function visibleSignIns(s: HomeState): SignInView[] {
  const f = activeFilter(s);
  if (!f) return s.signIns;
  return s.signIns.filter((r) => signInFilter(r.id) === f);
}

function visibleThreads(s: HomeState): ThreadView[] {
  const f = activeFilter(s);
  if (!f) return s.threads;
  return s.threads.filter((t) => t.a.id === f || t.b.id === f);
}

// ---- the agents list ----

const LOCK = `<svg width="14" height="14" viewBox="0 0 256 256" fill="#8A4F0E" role="img" aria-label="Approval required" class="lock"><path d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z"></path></svg>`;

function badge(n: number): string {
  return when(n > 0, `<span class="badge tnum">${n}<span class="sr"> waiting for approval</span></span>`);
}

function agentRow(s: HomeState, a: AgentView): string {
  const st = agentState(a, s.now);
  const current = s.open?.kind === "agent" && s.open.id === a.id;
  const waiting = s.held.filter((m) => m.to.id === a.id).length;
  return `<li data-key="a-${esc(a.id)}"><button type="button" class="arow${when(current, " is-current")}${when(!st.online, " is-offline")}" aria-current="${current}" data-action="open-agent" data-id="${esc(a.id)}">
    ${logo(a.kind, "", kindInfo(a.kind).label)}
    <span class="arow-text">
      <span class="arow-name"><strong>${esc(a.display)}</strong>${when(a.approvalRequired, LOCK)}</span>
      <span class="arow-sub"><span class="dot ${st.dot}"></span><span class="tnum" style="color: ${st.online ? st.ink : "#4E625C"}">${esc(agentSub(a, s.now))}</span></span>
    </span>
    ${badge(waiting)}
  </button></li>`;
}

function signInRow(s: HomeState, r: SignInView): string {
  const current = s.open?.kind === "signin" && s.open.id === r.id;
  return `<li data-key="s-${esc(r.id)}"><button type="button" class="arow${when(current, " is-current")}" aria-current="${current}" data-action="open-signin" data-id="${esc(r.id)}">
    ${logo(r.kind, "", kindInfo(r.kind).label)}
    <span class="arow-text">
      <span class="arow-name"><strong>${esc(r.name)}</strong></span>
      <span class="arow-sub"><span class="dot dot-pending"></span><span class="tnum" style="color: #8A4F0E">Sign in request waiting</span></span>
    </span>
    ${badge(1)}
  </button></li>`;
}

function groupRow(owner: { id: string; name: string; role?: string }): string {
  return `<li data-key="g-${esc(owner.id)}"><div class="rail-group">${pav(owner)}${esc(owner.name)}</div></li>`;
}

/** Grouped by person, the signed-in person first; offline agents last, folded. */
export function renderRail(s: HomeState): string {
  const online = s.agents.filter((a) => agentState(a, s.now).online);
  const offline = s.agents.filter((a) => !agentState(a, s.now).online);
  const owners: { id: string; name: string; role?: string }[] = [{ id: s.me.id, name: s.me.name, role: s.me.role }];
  for (const a of online) if (!owners.some((o) => o.id === a.owner.id)) owners.push(a.owner);
  const rows: string[] = [];
  for (const owner of owners) {
    const list = online.filter((a) => a.owner.id === owner.id);
    if (owner.id === s.me.id) {
      rows.push(groupRow(owner), ...list.map((a) => agentRow(s, a)), ...s.signIns.map((r) => signInRow(s, r)));
      rows.push(
        `<li data-key="add-row"><button type="button" class="arow" data-action="add-open" aria-haspopup="dialog"><span class="av av-add">${ICON.plus()}</span><span class="arow-add">Add agent</span></button></li>`,
      );
    } else if (list.length > 0) {
      rows.push(groupRow(owner), ...list.map((a) => agentRow(s, a)));
    }
  }
  if (offline.length > 0) {
    rows.push(
      `<li data-key="offline-toggle"><button type="button" class="arow arow-toggle" aria-expanded="${s.offlineOpen}" data-action="offline-toggle">${ICON.caret(s.offlineOpen ? "is-open" : "")}<span class="tnum">Offline (${offline.length})</span></button></li>`,
    );
    if (s.offlineOpen) rows.push(...offline.map((a) => agentRow(s, a)));
  }
  return `<nav aria-labelledby="agents-h" class="rail">
    <div class="rail-head"><h2 id="agents-h" class="h-rail">Agents</h2><button type="button" class="icon-btn phone-only" aria-label="Close" data-action="agents-close">${ICON.close()}</button></div>
    <ul class="rail-list">${rows.join("")}</ul>
    ${when(s.me.role === "owner", `<a class="linkbtn rail-invite" href="/settings#people">${ICON.userPlus()}Invite a person</a>`)}
  </nav>`;
}

// ---- Needs approval ----

const DECISION_LABEL = { allow_once: "Allowed once", always_allow: "Always allowed", deny: "Denied" } as const;

/** Today: "10:25". Earlier: "Yesterday 22:10" or "Oct 22 22:10". */
function stamp(iso: string, now: number): string {
  const day = dayLabel(iso, now);
  return day === "Today" ? clock(iso) : `${day} ${clock(iso)}`;
}

/** Deny, Always allow and Allow once on a held message: the primary action last, at the right. */
function decideButtons(s: HomeState, id: string): string {
  const busy = s.busy === `decide:${id}`;
  return `<button type="button" class="btn btn-text" data-action="decide" data-id="${esc(id)}" data-decision="deny"${when(busy, " disabled")}>Deny</button>
      <button type="button" class="btn btn-secondary" data-action="decide" data-id="${esc(id)}" data-decision="always_allow"${when(busy, " disabled")}>Always allow</button>
      <button type="button" class="btn btn-primary" data-action="decide" data-id="${esc(id)}" data-decision="allow_once"${when(busy, " disabled")}>Allow once</button>`;
}

/**
 * A held message, top to bottom: the subject; from, to, time and expiry; the facts Portico checks itself; the message
 * under a one-line quote of the message it answers; then View thread at the left and Deny, Always allow, Allow once.
 */
export function renderHeldCard(s: HomeState, m: HeldCard): string {
  const manager = m.facts.managedBy;
  const facts = [
    `<li class="fact">${pav(manager)}Managed by ${esc(manager.name)}</li>`,
    when(m.facts.replyToRecipient, `<li class="fact">${ICON.reply()}Reply to ${esc(m.to.display)}</li>`),
    ...m.facts.earlier.map((e) => `<li class="fact">${ICON.check(14)}${DECISION_LABEL[e.decision]} ${atWhen(e.at, s.now)}</li>`),
  ].join("");
  const quoteTime = m.replyTo?.createdAt;
  const quote = m.replyTo
    ? `<p class="quote"><span class="tnum">${esc(m.replyTo.from.display)}${quoteTime ? `, ${stamp(quoteTime, s.now)}` : ""}:</span> ${esc(m.replyTo.text)}</p>`
    : "";
  return `<article aria-labelledby="held-h-${esc(m.id)}" class="card" data-key="h-${esc(m.id)}">
    <h3 id="held-h-${esc(m.id)}" class="card-title">${esc(m.subject)}</h3>
    <div class="card-route">
      ${logo(m.from.kind, "logo-sm")}<strong>${esc(m.from.display)}</strong><span class="ochre-ink">to</span>${logo(m.to.kind, "logo-sm")}<strong>${esc(m.to.display)}</strong>
      <span class="tnum card-when">${stamp(m.createdAt, s.now)}. ${expiresIn(m.expiresAt, s.now)}</span>
    </div>
    <ul aria-label="Checked by Portico" class="facts">${facts}</ul>
    <div class="msg-box">${quote}<p class="msg-full">${esc(m.text)}</p></div>
    <div class="actions">
      <button type="button" class="btn btn-link start" data-action="open-thread" data-id="${esc(m.threadId)}">View thread</button>
      ${decideButtons(s, m.id)}
    </div>
  </article>`;
}

/** An app agent asks to join: compare the 4-digit code with the one in its chat. */
export function renderSignInCard(s: HomeState, r: SignInView): string {
  const from = kindInfo(r.kind).label;
  const busy = s.busy === `signin:${r.id}`;
  return `<article aria-labelledby="signin-h-${esc(r.id)}" class="card" data-key="si-${esc(r.id)}">
    <h3 id="signin-h-${esc(r.id)}" class="card-title">${esc(from)} asks to join as ${esc(r.name)}</h3>
    <div class="card-route">${logo(r.kind, "logo-sm")}<strong>Sign in request</strong><span class="tnum card-when">${expiresIn(r.expiresAt, s.now)}</span></div>
    <p class="code-line"><span class="code-pair"><span class="code-lbl">Code</span><strong class="tnum code-md">${esc(r.code)}</strong></span><span class="code-help">Approve only if ${esc(from)} shows the same code.</span></p>
    <div class="actions">
      <button type="button" class="btn btn-text" data-action="signin-deny" data-id="${esc(r.id)}"${when(busy, " disabled")}>Deny</button>
      <button type="button" class="btn btn-primary" data-action="signin-approve" data-id="${esc(r.id)}"${when(busy, " disabled")}>Approve</button>
    </div>
  </article>`;
}

export function renderApprovals(s: HomeState): string {
  const signIns = visibleSignIns(s);
  const held = visibleHeld(s);
  const count = signIns.length + held.length;
  if (count === 0) return "";
  return `<section aria-labelledby="appr-h" class="approvals" data-key="approvals">
    <div class="approvals-head">${ICON.lock()}<h2 id="appr-h" class="h-section">Needs approval</h2><span class="badge tnum">${count}</span></div>
    ${signIns.map((r) => renderSignInCard(s, r)).join("")}
    ${held.map((m) => renderHeldCard(s, m)).join("")}
  </section>`;
}

// ---- Threads ----

function threadRow(s: HomeState, t: ThreadView): string {
  const current = s.open?.kind === "thread" && s.open.id === t.id;
  return `<li data-key="t-${esc(t.id)}"><button type="button" class="crow${when(current, " is-current")}" aria-current="${current}" data-action="open-thread" data-id="${esc(t.id)}">
    <span class="crow-top"><span class="pair">${logo(t.a.kind, "logo-sm")}${logo(t.b.kind, "logo-sm pair-b")}</span><strong class="crow-title">${esc(t.a.display)} and ${esc(t.b.display)}</strong><span class="tnum crow-when">${shortWhen(t.lastMessageAt, s.now)}</span></span>
    ${t.last ? `<span class="crow-last">${esc(t.last.from.display)}: ${esc(t.last.text)}</span>` : ""}
    ${when(t.held > 0, `<span class="crow-flag">${t.held} awaiting approval</span>`)}
  </button></li>`;
}

export function renderThreads(s: HomeState): string {
  const threads = visibleThreads(s);
  const name = filterName(s);
  const empty = name ? `No threads with ${esc(name)} yet.` : "No threads yet. Threads show up here when agents message each other.";
  return `<section aria-labelledby="threads-h" class="threads" data-key="threads">
    <div class="threads-head"><h2 id="threads-h" class="h-section">Threads</h2></div>
    <ul class="rows thread-rows">${threads.map((t) => threadRow(s, t)).join("")}</ul>
    ${when(threads.length === 0, `<p class="threads-empty">${empty}</p>`)}
  </section>`;
}

/** No agents of the signed-in person yet: "Add your first agent". */
function renderFirst(s: HomeState): string {
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

// ---- the right panel: a thread ----

interface MessageStatusView {
  text: string;
  tone: "muted" | "ochre" | "danger";
  strong: boolean;
}

/** "Read 10:31", "Unread", "Awaiting approval", "Allowed once, read 10:19", "Declined", "Expired". */
export function messageStatus(m: MessageView, now: number): MessageStatusView {
  const prefix = m.decision === "allow_once" ? "Allowed once" : m.decision === "always_allow" ? "Always allowed" : "";
  const join = (word: string) => (prefix ? `${prefix}, ${word}` : word.charAt(0).toUpperCase() + word.slice(1));
  switch (m.status) {
    case "held":
      return { text: "Awaiting approval", tone: "ochre", strong: true };
    case "pending":
      return { text: join("unread"), tone: "ochre", strong: true };
    case "delivered": {
      const at = m.deliveredAt ? (dayLabel(m.deliveredAt, now) === "Today" ? clock(m.deliveredAt) : date(m.deliveredAt, now)) : "";
      return { text: join(at ? `read ${at}` : "read"), tone: "muted", strong: false };
    }
    case "declined":
      return { text: "Declined", tone: "danger", strong: true };
    default:
      return { text: "Expired", tone: "muted", strong: true };
  }
}

function participantChip(s: HomeState, ref: { id: string; display: string }): string {
  const a = s.agents.find((x) => x.id === ref.id);
  // Only a session that's been offline over a day leaves the agents list.
  if (!a) return `<span class="chip chip-static"><span class="dot dot-offline"></span>${esc(ref.display)}: offline</span>`;
  const st = agentState(a, s.now);
  return `<button type="button" class="chip" data-action="open-agent" data-id="${esc(a.id)}"><span class="dot ${st.dot}"></span>${esc(a.display)}: ${esc(st.label.toLowerCase())}</button>`;
}

/** Who manages one side of the thread. */
function managerOf(t: ThreadView, agentId: string): ThreadView["a"]["owner"] {
  return agentId === t.a.id ? t.a.owner : t.b.owner;
}

/**
 * A held message in the thread: the person who decides gets Deny, Always allow and Allow once, like the card on Home;
 * anyone else sees who it waits for.
 */
function heldActions(s: HomeState, t: ThreadView | null, m: MessageView): string {
  if (m.status !== "held") return "";
  if (s.held.some((h) => h.id === m.id)) return `<div class="actions msg-actions">${decideButtons(s, m.id)}</div>`;
  const manager = t ? managerOf(t, m.to.id) : null;
  return `<p class="msg-waiting">${ICON.clock()}${manager?.name ? `Waiting for ${esc(manager.name)} to approve.` : "Waiting for approval."}</p>`;
}

/**
 * The thread between two agents: one scroll that opens at the newest message. Each message shows its subject; a hairline
 * starts each new conversation (a message that answers nothing). When the two agents have different managers, each
 * message names its sender's manager. Older pages load on request.
 */
export function renderThreadPanel(s: HomeState, id: string, data: ThreadData | null): string {
  const t = data?.thread ?? s.threads.find((x) => x.id === id) ?? null;
  const title = t ? `${esc(t.a.display)} and ${esc(t.b.display)}` : "Thread";
  const managerA = t?.a.owner ?? null;
  const managerB = t?.b.owner ?? null;
  const twoPeople = managerA !== null && managerB !== null && managerA.id !== managerB.id;
  // Each day is its own group, so its pinned label scrolls away with it rather than piling under the next day's.
  const days: { label: string; items: string[] }[] = [];
  for (const m of data?.messages ?? []) {
    const label = dayLabel(m.createdAt, s.now);
    const newDay = days.at(-1)?.label !== label;
    if (newDay) days.push({ label, items: [] });
    const items = days.at(-1)!.items;
    const startsConversation = m.replyTo === null && !newDay;
    const st = messageStatus(m, s.now);
    const manager = twoPeople && t ? managerOf(t, m.from.id) : null;
    items.push(`<li class="msg${when(m.status === "held", " is-held")}${when(startsConversation, " starts-conv")}" data-key="m-${esc(m.id)}">
      ${logo(m.from.kind, "logo-sm msg-logo")}
      <div class="msg-body">
        <span class="msg-meta"><strong>${esc(m.from.display)}</strong>${manager ? `<span class="msg-manager">${pav(manager)}${esc(manager.name)}</span>` : ""}<span class="tnum msg-time">${clock(m.createdAt)}</span><span class="tnum msg-status tone-${st.tone}${when(st.strong, " is-strong")}">${esc(st.text)}</span></span>
        <p class="msg-subject">${esc(m.subject)}</p>
        <p class="msg-text">${esc(m.text)}</p>
        ${heldActions(s, t, m)}
      </div>
    </li>`);
  }
  const top = !data
    ? ""
    : data.more
      ? `<li class="msgs-top" data-key="top-more"><button type="button" class="btn btn-link" data-action="thread-earlier"${when(s.loadingEarlier, " disabled")}>Show earlier messages</button></li>`
      : `<li class="msgs-top" data-key="top-end">Messages older than 30 days are deleted.</li>`;
  return `<div class="thread-head">
      <div class="thread-title">
        ${t ? `<span class="pair">${logo(t.a.kind, "logo-md")}${logo(t.b.kind, "logo-md pair-b")}</span>` : ""}
        <h2 class="panel-title">${title}</h2>
      </div>
      ${twoPeople ? `<p class="thread-people">${pav(managerA!)}${esc(managerA!.name)} and ${pav(managerB!)}${esc(managerB!.name)}</p>` : ""}
      ${t ? `<div class="chips">${participantChip(s, t.a)}${participantChip(s, t.b)}</div>` : ""}
    </div>
    <div class="msgs-scroll" data-key="msgs-scroll">
      <ol class="msgs">${top}${days
        .map((d) => `<li class="msg-group" data-key="d-${esc(d.label)}"><p class="msg-day">${esc(d.label)}</p><ol class="msg-list">${d.items.join("")}</ol></li>`)
        .join("")}</ol>
    </div>
    ${when(s.threadUp, `<button type="button" class="newest-btn" data-action="thread-newest">${ICON.arrowDown()}Newest</button>`)}`;
}

// ---- the right panel: an agent ----

function switchButton(on: boolean, action: string, label: string, help: string, busy: boolean): string {
  return `<button type="button" class="switch ${on ? "on" : "off"}" role="switch" aria-checked="${on}" aria-labelledby="${label}" aria-describedby="${help}" data-action="${action}"${when(busy, " disabled")}><span class="knob"></span></button>`;
}

function renderEditForm(s: HomeState, a: AgentView): string {
  const e = s.edit!;
  const count = Array.from(e.description).length;
  return `<form class="edit-form enter" data-form="agent-save" data-key="edit-form" novalidate>
    <label for="ag-name" class="lbl">Name</label>
    <input id="ag-name" class="field${when(e.error, " is-invalid")}" name="name" value="${esc(e.name)}" data-input="edit-name" aria-describedby="ag-name-help" aria-invalid="${Boolean(e.error)}" autocomplete="off" spellcheck="false" data-autofocus>
    <span id="ag-name-help" class="help">Other agents use this name when sending messages.</span>
    <label for="ag-desc" class="lbl mt8">Description</label>
    <textarea id="ag-desc" class="field" rows="4" maxlength="500" data-input="edit-desc" aria-describedby="ag-desc-help">${esc(e.description)}</textarea>
    <span id="ag-desc-help" class="help tnum">Shown to other agents in the directory. ${count}/500</span>
    ${when(e.error, `<span role="alert" class="field-error">${esc(e.error)}</span>`)}
    <span class="actions mt8"><button type="button" class="btn btn-link" data-action="edit-cancel">Cancel</button><button type="submit" class="btn btn-primary"${when(s.busy === `save:${a.id}`, " disabled")}>Save</button></span>
  </form>`;
}

function renderRemoveRow(s: HomeState, id: string, display: string, action: string): string {
  const name = esc(display);
  return `<div class="box row-box">
    <div class="row-text"><span class="row-title">Remove ${name}</span><span class="row-help">Signs ${name} out of Portico. Adding ${name} back takes a new join line.</span></div>
    <span class="actions">${
      s.confirmRemove
        ? `<button type="button" class="btn btn-link" data-action="remove-cancel">Cancel</button><button type="button" class="btn btn-danger" data-action="${action}" data-id="${esc(id)}" data-autofocus${when(s.busy === `remove:${id}`, " disabled")}>Confirm: remove ${name}</button>`
        : `<button type="button" class="btn btn-text" data-action="remove-start">Remove</button>`
    }</span>
  </div>`;
}

export function renderAgentPanel(s: HomeState, data: AgentData | null): string {
  if (!data) return `<div class="agent-body"><p class="help">Loading.</p></div>`;
  const a = data.agent;
  const st = agentState(a, s.now);
  const editable = a.mine && a.type !== "session";
  const editing = editable && s.edit !== null;
  const desc = a.description;
  const isLong = Array.from(desc).length > LONG_DESCRIPTION;
  const head = `<div class="agent-head">
      ${logo(a.kind, "logo-lg")}
      <div class="agent-id">
        <div class="agent-name-row"><h2 class="agent-name">${esc(a.display)}</h2><span class="agent-kind">${esc(kindInfo(a.kind).label)}</span>${when(
          editable && !editing,
          `<button type="button" class="icon-btn" aria-label="Edit ${esc(a.display)}" data-action="edit-start">${ICON.pencil()}</button>`,
        )}</div>
        <span class="tnum agent-status" style="color: ${st.ink}"><span class="dot ${st.dot}"></span>${esc(agentStatusLine(a, s.now))}</span>
      </div>
    </div>`;
  const parts: string[] = [head];
  if (!editing && desc !== "") {
    parts.push(`<div class="desc-wrap">
      <p class="desc${when(isLong && !s.expanded, " clamped")}">${esc(desc)}</p>
      ${when(isLong, `<button type="button" class="morebtn" aria-expanded="${s.expanded}" data-action="desc-more">${s.expanded ? "Less" : "More"}</button>`)}
      ${when(s.saved, `<span class="saved enter" data-key="saved">Saved.</span>`)}
    </div>`);
  }
  if (editable && !editing && desc === "") {
    parts.push(`<div class="box row-box">
      <p class="row-help grow-text">Add a description so other agents know what ${esc(a.display)} handles.</p>
      <span class="actions"><button type="button" class="btn btn-secondary" data-action="edit-start">Add description</button></span>
    </div>`);
  }
  if (editing) parts.push(renderEditForm(s, a));
  if (a.type === "session") {
    const folder = a.repo ?? a.folder ?? "";
    parts.push(`<dl class="facts-dl">
      <dt>Doing</dt><dd>${esc(a.doing ?? "Nothing in progress")}</dd>
      <dt>Folder</dt><dd>${esc(folder)}${a.branch ? ` on ${esc(a.branch)}` : ""}</dd>
      <dt>Computer</dt><dd class="dd-icon">${ICON.laptop()}${esc(a.computer?.name ?? "")}</dd>
    </dl>`);
  }
  if (!a.mine) parts.push(`<p class="managed">${pav(a.owner)}Managed by ${esc(a.owner.name)}.</p>`);
  if (a.mine && st.online) {
    const allow = data.allowList ?? [];
    parts.push(`<div class="box">
      <div class="switch-row">
        <div class="grow"><span id="appr-label" class="row-title">Approval required</span><span id="appr-help" class="row-help">New conversations with ${esc(a.display)} wait for approval. Replies to ${esc(a.display)}'s messages don't.</span></div>
        ${switchButton(a.approvalRequired, "toggle-approval", "appr-label", "appr-help", s.busy === `approval:${a.id}`)}
      </div>
      ${when(
        a.approvalRequired,
        `<div class="allow enter" data-key="allow">
          <h3 class="h-sub">Always allow</h3>
          <p class="row-help allow-help">These senders skip approval.</p>
          ${
            allow.length
              ? `<ul class="allow-list">${allow
                  .map(
                    (w) => `<li class="allow-row" data-key="w-${esc(w.sender.id)}">${logo(w.sender.kind, "logo-sm")}<span class="allow-name">${esc(w.sender.display)}</span><span class="tnum allow-since">since ${sinceDay(w.addedAt, s.now)}</span><span class="actions"><button type="button" class="btn btn-text" data-action="allow-remove" data-id="${esc(w.sender.id)}">Remove</button></span></li>`,
                  )
                  .join("")}</ul>`
              : `<p class="row-help">None yet. Choosing Always allow on a held message adds the sender here.</p>`
          }
        </div>`,
      )}
    </div>`);
  }
  if (a.mine && a.type === "session" && st.online) {
    const on = a.joinFromFolder !== false;
    const repo = esc(a.repo ?? a.folder ?? "");
    parts.push(`<div class="box">
      <div class="switch-row">
        <div class="grow"><span id="folder-label" class="row-title">Join from the ${repo} folder</span>${
          on
            ? `<span id="folder-help" class="row-help">New sessions in ${repo} on ${esc(a.computer?.name ?? "")} join Portico automatically.</span>`
            : `<span id="folder-help" role="status" class="row-help folder-off enter" data-key="folder-off">Off. New sessions in ${repo} stay off, and this session leaves when done.</span>`
        }</div>
        ${switchButton(on, "toggle-folder", "folder-label", "folder-help", s.busy === `folder:${a.id}`)}
      </div>
      <p class="box-foot">Manage computers in <a href="/settings#computers">Settings</a>.</p>
    </div>`);
  }
  if (!st.online) parts.push(`<p class="help">Offline sessions leave the list after 24 h.</p>`);
  if (editable) parts.push(renderRemoveRow(s, a.id, a.display, "remove-confirm"));
  return `<div class="agent-body">${parts.join("")}</div>`;
}

/** A sign-in request in the agents list: the steps left, and Remove (which denies the request). */
function renderSignInPanel(s: HomeState, r: SignInView | undefined): string {
  if (!r) return `<div class="agent-body"><p class="help">This request has closed.</p></div>`;
  const kind = kindInfo(r.kind).label;
  return `<div class="agent-body">
    <div class="agent-head">${logo(r.kind, "logo-lg")}<div class="agent-id">
      <div class="agent-name-row"><h2 class="agent-name">${esc(r.name)}</h2><span class="agent-kind">${esc(kind)}</span></div>
      <span class="tnum agent-status" style="color: #8A4F0E"><span class="dot dot-pending"></span>Waiting to connect</span>
    </div></div>
    <div class="box">
      <h3 class="h-sub">Finish setup</h3>
      <ol class="steps">
        <li>Send ${esc(kind)} the join line.</li>
        <li>Approve the sign in request under Needs approval.</li>
        <li>${esc(r.name)} shows as connected.</li>
      </ol>
    </div>
    ${renderRemoveRow(s, r.id, r.name, "signin-remove")}
  </div>`;
}

export function renderPanel(s: HomeState): string {
  const open = s.open;
  if (!open) return "";
  let label = "Agent details";
  let body: string;
  if (open.kind === "thread") {
    label = "Thread";
    body = renderThreadPanel(s, open.id, open.data);
  } else if (open.kind === "agent") {
    body = renderAgentPanel(s, open.data);
  } else {
    body = renderSignInPanel(
      s,
      s.signIns.find((r) => r.id === open.id),
    );
  }
  return `<aside aria-label="${label}" class="panel panel-${open.kind} sheet" data-key="panel-${open.kind}-${esc(open.id)}">
    <button type="button" class="icon-btn panel-close" aria-label="Close" data-action="close-panel">${ICON.close()}</button>
    ${body}
  </aside>`;
}

// ---- the page ----

function mineCount(s: HomeState): number {
  return s.agents.filter((a) => a.mine).length + s.signIns.length;
}

export function renderHome(s: HomeState): string {
  const name = filterName(s);
  const filterBar = name
    ? `<div class="filter-bar enter" data-key="filter"><span class="grow">Showing <strong>${esc(name)}</strong></span><button type="button" class="icon-btn" aria-label="Show everything" data-action="clear-filter">${ICON.close()}</button></div>`
    : "";
  const middle = [
    renderReconnecting(s.reconnecting),
    renderNotice(s.notice),
    filterBar,
    when(mineCount(s) === 0 && !name, renderFirst(s)),
    renderApprovals(s),
    renderThreads(s),
  ].join("");
  return `<div class="app home${when(s.agentsOpen, " agents-open")}${when(s.open, " panel-open")}">
  <a class="skip" href="#home-main">Skip to content</a>
  ${renderHeader({ me: s.me, acctOpen: s.acctOpen, page: "home" })}
  ${renderAddSheet(s.add, { publicUrl: s.publicUrl, now: s.now })}
  <main id="home-main" class="home-main">
    <h1 class="sr">Home</h1>
    ${renderRail(s)}
    <div class="middle">${middle}</div>
    ${renderPanel(s)}
  </main>
</div>`;
}

/** A fresh Home state from the server's first data. */
export function homeState(data: {
  me: PersonView;
  publicUrl: string;
  agents: AgentView[];
  approvals: { held: HeldCard[]; signIns: SignInView[] };
  threads: ThreadView[];
  open: HomeState["open"];
  now: number;
}): HomeState {
  return {
    now: data.now,
    me: data.me,
    publicUrl: data.publicUrl,
    agents: data.agents,
    held: data.approvals.held,
    signIns: data.approvals.signIns,
    threads: data.threads,
    open: data.open,
    filter: data.open?.kind === "agent" ? data.open.id : null,
    offlineOpen: data.open?.kind === "agent" && data.open.data !== null && data.open.data.agent.status === "offline",
    acctOpen: false,
    agentsOpen: false,
    notice: null,
    reconnecting: false,
    add: null,
    edit: null,
    saved: false,
    expanded: false,
    confirmRemove: false,
    threadUp: false,
    loadingEarlier: false,
    busy: null,
  };
}
