// Pure render helpers shared by Home and Settings: state in, HTML string out, no DOM. Every string an agent or a
// person wrote goes through esc().
import type { AddState, AgentKind, AgentView, PersonView } from "./types.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML content and quoted attribute values. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** `attr` when the condition holds, for boolean attributes and optional classes. */
export function when(condition: unknown, text: string): string {
  return condition ? text : "";
}

// ---- agent kinds ----

export interface KindInfo {
  label: string;
  where: string;
  /** Connectors add Portico's /mcp address in their client instead of pasting a join line. */
  connector: boolean;
  step: string;
  wait: string;
}

export const KINDS: Record<AgentKind, KindInfo> = {
  "claude-code": {
    label: "Claude Code",
    where: "On a computer",
    connector: false,
    step: "Paste this into Claude Code on the computer that should join.",
    wait: "Waiting for Claude Code to connect",
  },
  codex: {
    label: "Codex",
    where: "On a computer",
    connector: false,
    // Codex joins like an app agent in this release: a sign-in request with a code.
    step: "Send this to Codex, then approve the sign in request here.",
    wait: "Waiting for the sign in request from Codex",
  },
  muse: {
    label: "Muse",
    where: "In an app",
    connector: false,
    step: "Send this to Muse in a chat, then approve the sign in request here.",
    wait: "Waiting for the sign in request from Muse",
  },
  "grok-bot": {
    label: "Grok Bot",
    where: "In an app",
    connector: false,
    step: "Send this to Grok Bot in a chat, then approve the sign in request here.",
    wait: "Waiting for the sign in request from Grok Bot",
  },
  dots: {
    label: "dots",
    where: "In ChatGPT",
    connector: true,
    step: "Add this as a connector in ChatGPT. Portico then opens a page to approve the connection.",
    wait: "Waiting for the sign in from ChatGPT",
  },
  "claude-duet": {
    label: "Claude Duet",
    where: "In an app",
    connector: true,
    step: "Add this as a connector in Claude Duet. Portico then opens a page to approve the connection.",
    wait: "Waiting for the sign in from Claude Duet",
  },
  other: {
    label: "Other",
    where: "Any MCP client",
    connector: true,
    step: "Add this server to an MCP client. Portico then opens a page to approve the connection.",
    wait: "Waiting for the sign in",
  },
};

/** The Add agent picker's order. */
export const PICK_ORDER: AgentKind[] = ["claude-code", "codex", "muse", "grok-bot", "dots", "claude-duet", "other"];

export function kindInfo(kind: string): KindInfo {
  return KINDS[kind as AgentKind] ?? KINDS.other;
}

export function iconUrl(kind: string): string {
  return `/assets/icons/${KINDS[kind as AgentKind] ? kind : "other"}.svg`;
}

/** An agent's logo. `alt` is empty where a name sits beside it. */
export function logo(kind: string, cls = "", alt = ""): string {
  return `<img class="logo${cls ? ` ${cls}` : ""}" src="${iconUrl(kind)}" alt="${esc(alt)}">`;
}

// ---- time ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Days from `iso`'s calendar day to now's: 0 today, 1 yesterday. */
function daysAgo(iso: string, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(Date.parse(iso))) / DAY);
}

/** "10:42", 24-hour local time. */
export function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "Oct 22", with the year when it isn't this year. */
export function date(iso: string, now: number): string {
  const d = new Date(iso);
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day}, ${d.getFullYear()}`;
}

/** A day heading: "Today", "Yesterday" or "Oct 22". */
export function dayLabel(iso: string, now: number): string {
  const days = daysAgo(iso, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date(iso, now);
}

/** A list's time column: "10:42" today, then "Yesterday", then "Oct 22". */
export function shortWhen(iso: string, now: number): string {
  const days = daysAgo(iso, now);
  if (days === 0) return clock(iso);
  if (days === 1) return "Yesterday";
  return date(iso, now);
}

/** "just now", "4 min ago", "today 09:12", "yesterday 18:04", "Oct 22". */
export function ago(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const days = daysAgo(iso, now);
  if (days === 0) return `today ${clock(iso)}`;
  if (days === 1) return `yesterday ${clock(iso)}`;
  return date(iso, now);
}

/** "today" or "Oct 22": since when. */
export function sinceDay(iso: string, now: number): string {
  return daysAgo(iso, now) === 0 ? "today" : date(iso, now);
}

/** "at 10:19" today, otherwise "on Oct 22". */
export function atWhen(iso: string, now: number): string {
  return daysAgo(iso, now) === 0 ? `at ${clock(iso)}` : `on ${date(iso, now)}`;
}

/** "Expires in 24 h." or "Expires in 8 min." */
export function expiresIn(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return "Expired.";
  if (ms >= 3_600_000) return `Expires in ${Math.round(ms / 3_600_000)} h.`;
  return `Expires in ${Math.max(1, Math.ceil(ms / 60_000))} min.`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ---- agents ----

export interface AgentState {
  /** "Working", "Checks in every 10 min", "Offline". */
  label: string;
  dot: string;
  ink: string;
  online: boolean;
  /** "Seen 4 min ago", "Joined just now", or null. */
  seen: string | null;
}

const TEAL = "#1F6F5C";
const MUTED = "#4E625C";
const OCHRE = "#8A4F0E";

/**
 * How an agent shows in the list. Sessions show their reported status while connected. Apps and connectors check in:
 * their rhythm once known, "Waiting to connect" until the first check-in.
 */
export function agentState(agent: AgentView, now: number): AgentState {
  const seen = agent.lastSeen ? `Seen ${ago(agent.lastSeen, now)}` : null;
  if (agent.type === "session") {
    switch (agent.status) {
      case "busy":
        return { label: "Working", dot: "dot-working", ink: TEAL, online: true, seen };
      case "waiting":
        return { label: "Needs input", dot: "dot-input", ink: OCHRE, online: true, seen };
      case "offline":
        return { label: "Offline", dot: "dot-offline", ink: MUTED, online: false, seen };
      default:
        return { label: "Idle", dot: "dot-idle", ink: MUTED, online: true, seen };
    }
  }
  const joined = `Joined ${ago(agent.createdAt, now)}`;
  if (agent.checkInMinutes !== null) {
    return { label: `Checks in every ${agent.checkInMinutes} min`, dot: "dot-checkin", ink: MUTED, online: true, seen: seen ?? joined };
  }
  if (agent.lastSeen) return { label: "Connected", dot: "dot-checkin", ink: MUTED, online: true, seen };
  return { label: "Waiting to connect", dot: "dot-pending", ink: OCHRE, online: true, seen: joined };
}

/** The agents list's second line: "Working on macbook", "Checks in every 10 min", "Seen yesterday 18:04". */
export function agentSub(agent: AgentView, now: number): string {
  const s = agentState(agent, now);
  if (!s.online) return s.seen ?? "Offline";
  if (agent.computer) return `${s.label} on ${agent.computer.name}`;
  return s.label;
}

/** The details panel's status line: "Working", "Checks in every 10 min. Seen 4 min ago", "Offline. Seen yesterday 18:04". */
export function agentStatusLine(agent: AgentView, now: number): string {
  const s = agentState(agent, now);
  if (!s.online) return s.seen ? `Offline. ${s.seen}` : "Offline";
  if (agent.type !== "session" && s.seen) return `${s.label}. ${s.seen}`;
  return s.label;
}

// ---- people ----

/** Person avatars: the owner in ink, everyone else in a steady muted color by ID. No purple. */
const PERSON_COLORS = ["#2E3E5C", "#5C3B2E", "#2E5C4C", "#5C4F2E", "#3F4A4F", "#5C2E3A"];

export function personColor(person: { id: string; role?: string }): string {
  if (person.role === "owner") return "#102B25";
  let hash = 0;
  for (const ch of person.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PERSON_COLORS[hash % PERSON_COLORS.length]!;
}

export function monogram(name: string): string {
  return esc(Array.from(name.trim())[0]?.toUpperCase() ?? "?");
}

/** A small round person avatar. */
export function pav(person: { id: string; name: string; role?: string }): string {
  return `<span class="pav" style="background: ${personColor(person)}" aria-hidden="true">${monogram(person.name)}</span>`;
}

// ---- icons (Phosphor, regular) ----

const svg = (size: number, path: string, extra = "") =>
  `<svg width="${size}" height="${size}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"${extra}><path d="${path}"></path></svg>`;

const P = {
  plus: "M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z",
  x: "M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z",
  caret: "M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z",
  lock: "M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z",
  reply: "M232,200a8,8,0,0,1-16,0,88.1,88.1,0,0,0-88-88H51.31l34.35,34.34a8,8,0,0,1-11.32,11.32l-48-48a8,8,0,0,1,0-11.32l48-48A8,8,0,0,1,85.66,61.66L51.31,96H128A104.11,104.11,0,0,1,232,200Z",
  check: "M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z",
  pencil: "M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z",
  copy: "M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z",
  laptop: "M232,168h-8V72a24,24,0,0,0-24-24H56A24,24,0,0,0,32,72v96H24a8,8,0,0,0-8,8v16a24,24,0,0,0,24,24H216a24,24,0,0,0,24-24V176A8,8,0,0,0,232,168ZM48,72a8,8,0,0,1,8-8H200a8,8,0,0,1,8,8v96H48ZM224,192a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8v-8H224ZM152,88a8,8,0,0,1-8,8H112a8,8,0,0,1,0-16h32A8,8,0,0,1,152,88Z",
  userPlus: "M256,136a8,8,0,0,1-8,8H232v16a8,8,0,0,1-16,0V144H200a8,8,0,0,1,0-16h16V112a8,8,0,0,1,16,0v16h16A8,8,0,0,1,256,136Zm-57.87,58.85a8,8,0,0,1-12.26,10.3C165.75,181.19,138.09,168,108,168s-57.75,13.19-77.87,37.15a8,8,0,0,1-12.25-10.3c14.94-17.78,33.52-30.41,54.17-37.17a68,68,0,1,1,71.9,0C164.6,164.44,183.18,177.07,198.13,194.85ZM108,152a52,52,0,1,0-52-52A52.06,52.06,0,0,0,108,152Z",
  signOut: "M120,216a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V40a8,8,0,0,1,8-8h64a8,8,0,0,1,0,16H56V208h56A8,8,0,0,1,120,216Zm109.66-93.66-40-40a8,8,0,0,0-11.32,11.32L204.69,120H112a8,8,0,0,0,0,16h92.69l-26.35,26.34a8,8,0,0,0,11.32,11.32l40-40A8,8,0,0,0,229.66,122.34Z",
  gear: "M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm109.94-52.79a8,8,0,0,0-3.89-5.4l-29.83-17-.12-33.62a8,8,0,0,0-2.83-6.08,111.91,111.91,0,0,0-36.72-20.67,8,8,0,0,0-6.46.59L128,41.85,97.88,25a8,8,0,0,0-6.47-.6A112.1,112.1,0,0,0,54.73,45.15a8,8,0,0,0-2.83,6.07l-.15,33.65-29.83,17a8,8,0,0,0-3.89,5.4,106.47,106.47,0,0,0,0,41.56,8,8,0,0,0,3.89,5.4l29.83,17,.12,33.62a8,8,0,0,0,2.83,6.08,111.91,111.91,0,0,0,36.72,20.67,8,8,0,0,0,6.46-.59L128,214.15,158.12,231a7.91,7.91,0,0,0,3.9,1,8.09,8.09,0,0,0,2.57-.42,112.1,112.1,0,0,0,36.68-20.73,8,8,0,0,0,2.83-6.07l.15-33.65,29.83-17a8,8,0,0,0,3.89-5.4A106.47,106.47,0,0,0,237.94,107.21Zm-15,34.91-28.57,16.25a8,8,0,0,0-3,3c-.58,1-1.19,2.06-1.81,3.06a7.94,7.94,0,0,0-1.22,4.21l-.15,32.25a95.89,95.89,0,0,1-25.37,14.3L134,199.13a8,8,0,0,0-3.91-1h-.19c-1.21,0-2.43,0-3.64,0a8.08,8.08,0,0,0-4.1,1l-28.84,16.1A96,96,0,0,1,67.88,201l-.11-32.2a8,8,0,0,0-1.22-4.22c-.62-1-1.23-2-1.8-3.06a8.09,8.09,0,0,0-3-3.06l-28.6-16.29a90.49,90.49,0,0,1,0-28.26L61.67,97.63a8,8,0,0,0,3-3c.58-1,1.19-2.06,1.81-3.06a7.94,7.94,0,0,0,1.22-4.21l.15-32.25a95.89,95.89,0,0,1,25.37-14.3L122,56.87a8,8,0,0,0,4.1,1c1.21,0,2.43,0,3.64,0a8.08,8.08,0,0,0,4.1-1l28.84-16.1A96,96,0,0,1,188.12,55l.11,32.2a8,8,0,0,0,1.22,4.22c.62,1,1.23,2,1.8,3.06a8.09,8.09,0,0,0,3,3.06l28.6,16.29A90.49,90.49,0,0,1,222.9,142.12Z",
  arrowLeft: "M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z",
  key: "M216.57,39.43A80,80,0,0,0,83.91,120.78L28.69,176A15.86,15.86,0,0,0,24,187.31V216a16,16,0,0,0,16,16H72a8,8,0,0,0,8-8V208H96a8,8,0,0,0,8-8V184h16a8,8,0,0,0,5.66-2.34l9.56-9.57A79.73,79.73,0,0,0,160,176h.1A80,80,0,0,0,216.57,39.43ZM224,98.1c-1.09,34.09-29.75,61.86-63.89,61.9H160a63.7,63.7,0,0,1-23.65-4.51,8,8,0,0,0-8.84,1.68L116.69,168H96a8,8,0,0,0-8,8v16H72a8,8,0,0,0-8,8v16H40V187.31l58.83-58.82a8,8,0,0,0,1.68-8.84A63.72,63.72,0,0,1,96,95.92c0-34.14,27.81-62.8,61.9-63.89A64,64,0,0,1,224,98.1ZM192,76a12,12,0,1,1-12-12A12,12,0,0,1,192,76Z",
  list: "M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128ZM40,72H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16ZM216,184H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z",
};

export const ICON = {
  plus: (size = 16) => svg(size, P.plus),
  close: (size = 16) => svg(size, P.x),
  caret: (cls = "") => svg(16, P.caret, ` class="caret${cls ? ` ${cls}` : ""}"`),
  lock: (size = 16) => svg(size, P.lock),
  reply: (size = 14) => svg(size, P.reply),
  check: (size = 16) => svg(size, P.check),
  pencil: (size = 16) => svg(size, P.pencil),
  copy: (size = 16) => svg(size, P.copy),
  laptop: (size = 16) => svg(size, P.laptop),
  userPlus: (size = 16) => svg(size, P.userPlus),
  signOut: (size = 16) => svg(size, P.signOut),
  gear: (size = 16) => svg(size, P.gear),
  arrowLeft: (size = 16) => svg(size, P.arrowLeft),
  key: (size = 16) => svg(size, P.key),
  list: (size = 20) => svg(size, P.list),
};

/** The Portico mark, linking Home. */
export const HOMEMARK = `<a class="homemark" href="/" aria-label="Portico home"><svg width="24" height="22" viewBox="0 0 30 26" fill="none" stroke="#1F6F5C" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M2 9 L15 2 L28 9 Z"></path><path d="M6 12 V22 M12 12 V22 M18 12 V22 M24 12 V22"></path><path d="M2 24 H28"></path></svg></a>`;

// ---- the header ----

export interface HeaderState {
  me: PersonView;
  acctOpen: boolean;
  page: "home" | "settings";
}

/** The top bar: the mark, the agents list button on phones (Home), Add agent, and the account menu. */
export function renderHeader(s: HeaderState): string {
  const role = s.me.role === "owner" ? `Signed in as ${esc(s.me.name)}, owner` : `Signed in as ${esc(s.me.name)}`;
  return `<header class="top-bar">
  ${HOMEMARK}
  ${when(s.page === "home", `<button type="button" class="linkbtn phone-only" data-action="agents-open" aria-haspopup="dialog">${ICON.list(16)}Agents</button>`)}
  <div class="top-actions">
    <button type="button" class="addbtn" data-action="add-open" aria-haspopup="dialog">${ICON.plus()}Add agent</button>
    <button type="button" class="acct" data-action="acct-toggle" aria-haspopup="menu" aria-expanded="${s.acctOpen}"><span class="acct-av" style="background: ${personColor(s.me)}">${monogram(s.me.name)}</span><span class="acct-name">${esc(s.me.name)}</span>${ICON.caret(s.acctOpen ? "is-open" : "")}</button>
    ${when(
      s.acctOpen,
      `<div role="menu" aria-label="Account" class="menu enter" data-key="acct-menu">
      <div class="menu-head">${role}</div>
      <a role="menuitem" class="menuitem" href="/settings"${when(s.page === "settings", ` aria-current="page"`)}>${ICON.gear()}Settings</a>
      <button type="button" role="menuitem" class="menuitem menuitem-danger" data-action="sign-out">${ICON.signOut()}Sign out</button>
    </div>`,
    )}
  </div>
</header>`;
}

/** The notice strip above Home's lists: what just happened, or what went wrong. */
export function renderNotice(notice: { text: string; check?: boolean; error?: boolean } | null): string {
  if (!notice?.text) return "";
  const cls = notice.error ? " notice-error-strip" : notice.check ? " notice-check" : "";
  return `<div role="${notice.error ? "alert" : "status"}" class="notice-strip${cls} enter" data-key="notice">${when(notice.check, ICON.check())}<span>${esc(notice.text)}</span></div>`;
}

export function renderReconnecting(on: boolean): string {
  return when(
    on,
    `<div role="status" class="reconnecting enter" data-key="reconnecting"><span class="dot dot-pending"></span>Updates paused. Reconnecting.</div>`,
  );
}

// ---- the Add agent sheet ----

/** The line the sheet shows: a join line, or Portico's /mcp address for connectors. */
export function addLine(add: AddState, publicUrl: string): string {
  if (kindInfo(add.pick).connector) return `${publicUrl}/mcp`;
  return add.lines[add.pick]?.line ?? "";
}

/** Add agent: pick, copy the line, wait, then the sign-in request (app agents) and "<name> joined". */
export function renderAddSheet(add: AddState | null, ctx: { publicUrl: string; now: number }): string {
  if (!add) return "";
  const info = kindInfo(add.pick);
  const line = addLine(add, ctx.publicUrl);
  const picker = `<div role="radiogroup" aria-labelledby="add-pick-label" class="pick">
    <span id="add-pick-label" class="lbl">Pick an agent</span>
    <div class="pick-grid">${PICK_ORDER.map((kind) => {
      const k = KINDS[kind];
      const on = kind === add.pick;
      return `<button type="button" role="radio" aria-checked="${on}" class="tile${when(on, " is-selected")}" data-action="add-pick" data-id="${kind}">${logo(kind)}<span class="tile-text"><span class="tile-label">${esc(k.label)}</span><span class="tile-where">${esc(k.where)}</span></span></button>`;
    }).join("")}</div>
  </div>`;
  const lineBox = `<div class="add-box">
    <p class="add-step">${esc(info.step)}</p>
    <label for="add-line" class="sr">${info.connector ? "Server address" : "Join line"}</label>
    <input id="add-line" class="line-field" readonly value="${esc(line)}">
    ${when(add.lineError, `<span role="alert" class="field-error">${esc(add.lineError)}</span>`)}
    <button type="button" class="btn btn-primary btn-lg add-copy" data-action="add-copy"${when(!line, " disabled")}>${ICON.copy()}${add.copied ? "Copied" : "Copy"}</button>
    <p class="add-note">${info.connector ? "Works only after approval." : "Single use. Expires in 24 h."}</p>
    ${when(
      add.stage === "pick" && add.copied,
      `<div role="status" class="waiting enter" data-key="add-waiting"><span class="dot dot-wait"></span><span>${esc(info.wait)}</span></div>`,
    )}
  </div>`;
  let request = "";
  if (add.stage === "request" && add.signIn) {
    const from = kindInfo(add.signIn.kind).label;
    request = `<section aria-labelledby="req-h" class="req-card enter" data-key="add-request">
      <div class="req-head">${logo(add.signIn.kind)}<div class="grow"><h3 id="req-h" class="req-title">Sign in request from ${esc(from)}</h3><span class="tnum req-exp">${expiresIn(add.signIn.expiresAt, ctx.now)}</span></div></div>
      <div class="req-code"><span class="code-lbl">Code</span><strong class="tnum code-lg">${esc(add.signIn.code)}</strong></div>
      <p class="req-match">Approve only if ${esc(from)} shows the same code.</p>
      <form class="req-form" data-form="add-approve">
        <label for="req-name" class="lbl">Name</label>
        <input id="req-name" class="field${when(add.reqError, " is-invalid")}" name="name" value="${esc(add.reqName)}" data-input="add-req-name" aria-describedby="req-name-help" aria-invalid="${Boolean(add.reqError)}" autocomplete="off">
        <span id="req-name-help" class="req-help">Other agents use this name when sending messages.</span>
        ${when(add.reqError, `<span role="alert" class="field-error">${esc(add.reqError)}</span>`)}
        <span class="actions"><button type="button" class="btn btn-text" data-action="add-deny"${when(add.busy, " disabled")}>Deny</button><button type="submit" class="btn btn-primary"${when(add.busy, " disabled")}>Approve</button></span>
      </form>
    </section>`;
  }
  let joined = "";
  if (add.stage === "joined" && add.joined) {
    const a = add.joined;
    const sub = a.computer
      ? `From ${esc(a.computer.name)}. Other ${esc(kindInfo(a.kind).label)} sessions started there join automatically.`
      : `${esc(agentState(a, ctx.now).label)}.`;
    joined = `<div role="status" class="joined-card enter" data-key="add-joined">
      <div class="req-head">${logo(a.kind, "logo-lg")}<div class="grow"><strong class="joined-title">${esc(a.display)} joined.</strong><span class="joined-sub">${sub}</span></div></div>
      <span class="actions"><button type="button" class="btn btn-link" data-action="add-another">Add another agent</button><button type="button" class="btn btn-primary" data-action="add-done" data-autofocus>Done</button></span>
    </div>`;
  }
  return `<div class="sheet-wrap" data-key="add-sheet">
  <button type="button" class="scrim" aria-label="Close" data-action="add-close" tabindex="-1"></button>
  <section role="dialog" aria-modal="true" aria-labelledby="add-title" class="sheet add-sheet">
    <div class="sheet-head">
      <div class="grow"><h2 id="add-title" class="sheet-title">Add agent</h2><p class="sheet-sub">One line connects any agent to Portico.</p></div>
      <button type="button" class="icon-btn" aria-label="Close" data-action="add-close">${ICON.close(20)}</button>
    </div>
    ${when(add.stage === "pick", picker)}
    ${when(add.stage !== "joined", lineBox)}
    ${request}
    ${joined}
  </section>
</div>`;
}
