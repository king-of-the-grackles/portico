// A Portico's page (/p/:id; a workspace, in this code), the Agents page (/agents), and the cards for what an agent
// asked about a Portico.
// Pure: state in, HTML out.
import { agentState, date, esc, expiresIn, ICON, kindInfo, logo, monogram, personColor, plural, porticoHeading, when } from "./common.js";
import { renderTaskRow, taskHead } from "./tasks.js";
import type { AgentView, HomeState, PersonRef, ShareView, WorkspaceForm, WorkspaceView } from "./types.js";

/** The address other people's agents use for a person's agents: the handle, when the person has one. */
function handleOf(p: PersonRef): string {
  return p.handle ? `${p.handle}/` : "";
}

function avatar(p: PersonRef): string {
  return `<span class="av av-round" style="background: ${personColor(p)}" aria-hidden="true">${monogram(p.name)}</span>`;
}

/** The first letters of the other people in a Portico, for its row in the navigation. */
export function initials(w: WorkspaceView, meId: string): string {
  return w.people
    .filter((p) => p.id !== meId)
    .map((p) => Array.from(p.name.trim())[0]?.toUpperCase() ?? "")
    .join("");
}

// ---- forms ----

/** My agents as ticks: `data-action="ws-tick"` flips one in the open form. */
function ticks(s: HomeState, agents: AgentView[], chosen: string[]): string {
  if (agents.length === 0) return `<p class="empty">No agents to add yet.</p>`;
  return `<ul class="ticks">${agents
    .map((a) => {
      const on = chosen.includes(a.id);
      return `<li><button type="button" class="tick${when(on, " is-on")}" role="checkbox" aria-checked="${on}" data-action="ws-tick" data-id="${esc(a.id)}"><span class="tick-box" aria-hidden="true">${when(on, ICON.check(14))}</span>${logo(a.kind, "logo-sm", "")}<span class="tick-name">${esc(a.label)}</span></button></li>`;
    })
    .join("")}</ul>`;
}

function renderNewForm(s: HomeState, f: Extract<WorkspaceForm, { kind: "new" }>): string {
  const mine = s.agents.filter((a) => a.mine);
  return `<form class="sform enter" method="dialog" data-form="ws-create" data-key="ws-new" novalidate>
    ${when(f.thenShare, `<p class="sec-help">Personal Portico can't be shared. Make a new Portico to work with someone else's agents.</p>`)}
    <label for="ws-name" class="lbl">Name</label>
    <input id="ws-name" class="field field-narrow${when(f.error, " is-invalid")}" value="${esc(f.name)}" data-input="ws-name" maxlength="60" autocomplete="off" aria-describedby="ws-name-help" aria-invalid="${Boolean(f.error)}" data-autofocus>
    <span id="ws-name-help" class="help">Optional.</span>
    <span class="lbl" id="ws-agents-lbl">Agents to put in</span>
    <div role="group" aria-labelledby="ws-agents-lbl">${ticks(s, mine, f.agentIds)}</div>
    <span class="help">Everyone in the Portico can message these agents.</span>
    ${when(f.error, `<span role="alert" class="field-error">${esc(f.error)}</span>`)}
    <span class="actions"><button type="button" class="btn btn-link" data-action="ws-form-cancel">Cancel</button><button type="submit" class="btn btn-primary"${when(s.busy === "ws-form", " disabled")}>${f.thenShare ? "Create and share" : "Create Portico"}</button></span>
  </form>`;
}

function renderShareForm(s: HomeState, w: WorkspaceView, f: Extract<WorkspaceForm, { kind: "share" }>): string {
  // An address binds a link only where signing in verifies addresses. With Portico's own accounts the field is left
  // out: the link is for whoever uses it first, once.
  const byEmail = w.linksByEmail !== false;
  return `<form class="sform enter" method="dialog" data-form="ws-share" data-key="ws-share" novalidate>
    ${
      byEmail
        ? `<label for="ws-email" class="lbl">Email address</label>
    <input id="ws-email" class="field field-narrow${when(f.error, " is-invalid")}" type="email" value="${esc(f.email)}" data-input="ws-email" autocomplete="off" aria-describedby="ws-email-help" aria-invalid="${Boolean(f.error)}" data-autofocus>
    <span id="ws-email-help" class="help">Optional. With an address, only that person can use the link. The link works once, for 7 days.</span>`
        : `<p class="help">The link works once, for 7 days, for whoever uses it first.</p>`
    }
    <span class="lbl" id="ws-policy-lbl">More agents from that person</span>
    <div role="radiogroup" aria-labelledby="ws-policy-lbl" class="ticks">
      <button type="button" class="tick${when(f.agents === "self", " is-on")}" role="radio" aria-checked="${f.agents === "self"}" data-action="ws-policy" data-id="self"><span class="tick-box" aria-hidden="true">${when(f.agents === "self", ICON.check(14))}</span><span class="tick-name">Adds more agents with no further question</span></button>
      <button type="button" class="tick${when(f.agents === "ask", " is-on")}" role="radio" aria-checked="${f.agents === "ask"}" data-action="ws-policy" data-id="ask"><span class="tick-box" aria-hidden="true">${when(f.agents === "ask", ICON.check(14))}</span><span class="tick-name">Asks ${esc(s.me.name)} for each agent added</span></button>
    </div>
    <span class="help">Applies to agents added later. Change it under People.</span>
    <div class="ticks"><button type="button" class="tick${when(f.allow, " is-on")}" role="checkbox" aria-checked="${f.allow}" data-action="ws-share-allow"><span class="tick-box" aria-hidden="true">${when(f.allow, ICON.check(14))}</span><span class="tick-name">Allow messages from this person's agents</span></button></div>
    <span class="help">No question the first time one of those agents writes to yours. Untick to be asked first.</span>
    ${when(f.error, `<span role="alert" class="field-error">${esc(f.error)}</span>`)}
    <span class="actions"><button type="button" class="btn btn-link" data-action="ws-form-cancel">Cancel</button><button type="submit" class="btn btn-primary"${when(s.busy === "ws-form", " disabled")}>Create share link</button></span>
  </form>`;
}

function renderRenameForm(s: HomeState, f: Extract<WorkspaceForm, { kind: "rename" }>): string {
  return `<form class="sform enter" method="dialog" data-form="ws-rename" data-key="ws-rename" novalidate>
    <label for="ws-rename-name" class="lbl">Name</label>
    <input id="ws-rename-name" class="field field-narrow${when(f.error, " is-invalid")}" value="${esc(f.name)}" data-input="ws-name" maxlength="60" autocomplete="off" aria-describedby="ws-rename-help" aria-invalid="${Boolean(f.error)}" data-autofocus>
    <span id="ws-rename-help" class="help">Left empty, the Portico is named after the people in it.</span>
    ${when(f.error, `<span role="alert" class="field-error">${esc(f.error)}</span>`)}
    <span class="actions"><button type="button" class="btn btn-link" data-action="ws-form-cancel">Cancel</button><button type="submit" class="btn btn-primary"${when(s.busy === "ws-form", " disabled")}>Save name</button></span>
  </form>`;
}

function renderAgentsForm(s: HomeState, w: WorkspaceView, f: Extract<WorkspaceForm, { kind: "agents" }>): string {
  const out = s.agents.filter((a) => a.mine && !w.agentIds.includes(a.id));
  return `<form class="sform enter" method="dialog" data-form="ws-agents" data-key="ws-agents" novalidate>
    <span class="lbl" id="ws-add-lbl">Agents to put in ${esc(w.phrase)}</span>
    <div role="group" aria-labelledby="ws-add-lbl">${ticks(s, out, f.agentIds)}</div>
    ${when(f.error, `<span role="alert" class="field-error">${esc(f.error)}</span>`)}
    <span class="actions"><button type="button" class="btn btn-link start" data-action="add-open" aria-haspopup="dialog">${ICON.plus()}Join a new agent</button><button type="button" class="btn btn-link" data-action="ws-form-cancel">Cancel</button><button type="submit" class="btn btn-primary"${when(s.busy === "ws-form" || f.agentIds.length === 0, " disabled")}>Add ${plural(f.agentIds.length, "agent")}</button></span>
  </form>`;
}

// ---- the Portico's page ----

function agentRow(s: HomeState, w: WorkspaceView, a: AgentView): string {
  const st = agentState(a, s.now);
  const href = `/a/${encodeURIComponent(a.id)}`;
  const sub = a.mine
    ? `<span class="row-help"><span class="dot ${st.dot}"></span> ${esc(st.label)}</span>`
    : `<span class="row-help">${esc(a.owner.name)}${a.owner.handle ? `, <code>${esc(a.address)}</code>` : ""}</span>`;
  // Out of any Portico: the person who manages the agent, or the Portico's owner. Out of the person's own, the agent
  // is reached only through its other Porticos.
  const removable = a.mine || w.isOwner;
  return `<li class="srow" data-key="wa-${esc(a.id)}">${logo(a.kind, "", kindInfo(a.kind).label)}<span class="row-text"><a class="row-link" href="${href}" data-action="go" data-href="${href}"><strong>${esc(a.label)}</strong></a>${sub}</span>${when(
    removable,
    `<span class="actions"><button type="button" class="btn btn-text" data-action="ws-agent-remove" data-id="${esc(a.id)}"${when(s.busy === `ws-agent:${a.id}`, " disabled")}>Take out</button></span>`,
  )}</li>`;
}

/** One of the person's agents taken out of the person's own Portico, with the way back. */
function outRow(s: HomeState, a: AgentView): string {
  const href = `/a/${encodeURIComponent(a.id)}`;
  const elsewhere = s.workspaces.filter((w) => w.kind === "shared" && w.agentIds.includes(a.id)).map((w) => w.name);
  const reach = elsewhere.length === 0 ? "In no Portico: no agent reaches this one." : `Reached only through ${elsewhere.join(", ")}.`;
  return `<li class="srow" data-key="wo-${esc(a.id)}">${logo(a.kind, "", kindInfo(a.kind).label)}<span class="row-text"><a class="row-link" href="${href}" data-action="go" data-href="${href}"><strong>${esc(a.label)}</strong></a><span class="row-help">${esc(reach)}</span></span><span class="actions"><button type="button" class="btn btn-secondary" data-action="ws-agent-add" data-id="${esc(a.id)}"${when(s.busy === `ws-agent:${a.id}`, " disabled")}>Put back</button></span></li>`;
}

function personRow(s: HomeState, w: WorkspaceView, p: PersonRef): string {
  const me = p.id === s.me.id;
  const owner = p.id === w.owner.id;
  const count = s.agents.filter((a) => a.owner.id === p.id && w.agentIds.includes(a.id)).length;
  const key = me ? "leave" : `person:${p.id}`;
  const confirming = s.wsConfirm === key;
  const can = w.kind === "shared" && !owner && (me || w.isOwner);
  const full = w.people.find((x) => x.id === p.id);
  const policy = owner || w.kind !== "shared" ? "" : full?.agents === "ask" ? " Asks the owner for each agent added." : " Adds agents with no further question.";
  const policyButton =
    w.isOwner && !owner && !me
      ? `<button type="button" class="btn btn-text" data-action="ws-person-policy" data-id="${esc(p.id)}" data-policy="${full?.agents === "ask" ? "self" : "ask"}"${when(s.busy === `ws-policy:${p.id}`, " disabled")}>${full?.agents === "ask" ? "Stop asking" : "Ask for each agent"}</button>`
      : "";
  const allowedButton =
    !me && full?.allowed
      ? `<button type="button" class="btn btn-text" data-action="ws-contact-remove" data-id="${esc(p.id)}"${when(s.busy === `ws-contact:${p.id}`, " disabled")}>Ask about messages again</button>`
      : "";
  const contact = me ? "" : full?.allowed ? ` Messages from ${esc(p.name)}'s agents get through.` : ` The first message from ${esc(p.name)}'s agents waits for a decision.`;
  const verb = me ? "Leave" : "Remove";
  const actions = !can
    ? ""
    : confirming
      ? `<span class="actions"><button type="button" class="btn btn-link" data-action="ws-confirm-cancel">Cancel</button><button type="button" class="btn btn-danger" data-action="ws-person-remove" data-id="${esc(p.id)}" data-autofocus${when(s.busy === "ws-confirm", " disabled")}>Confirm: ${me ? `leave ${esc(w.phrase)}` : `remove ${esc(p.name)}`}</button></span>`
      : `<span class="actions">${allowedButton}${policyButton}<button type="button" class="btn btn-text" data-action="ws-confirm" data-id="${esc(key)}">${verb}</button></span>`;
  const shown = !can && (allowedButton || policyButton) ? `<span class="actions">${allowedButton}${policyButton}</span>` : actions;
  return `<li class="srow" data-key="wp-${esc(p.id)}">${avatar(p)}<span class="row-text"><strong>${esc(p.name)}${when(me, " (signed in)")}</strong><span class="row-help">${owner ? "Owner. " : ""}${p.handle ? `<code>${esc(handleOf(p))}</code> ` : ""}${plural(count, "agent")} here.${policy}${contact}</span></span>${shown}</li>`;
}

/** How an email went, in plain words. */
export function mailNote(mail: string, email: string): string {
  switch (mail) {
    case "sent":
      return `Emailed to ${email}.`;
    case "off":
      return "Email isn't set up on this Portico server: copy the link and send the link by hand.";
    case "blocked":
      return `${email} takes no email from Portico: copy the link and send the link by hand.`;
    case "too_soon":
      return "The email went out less than an hour ago. Try again later.";
    case "resend_limit":
      return "The email went out three times already. Copy the link and send the link by hand.";
    case "recipient_limit":
      return `${email} got as many emails from Portico today as one address can. Copy the link and send the link by hand.`;
    case "daily_limit":
    case "person_limit":
    case "workspace_limit":
      return "Today's limit for emails is used up. Copy the link and send the link by hand.";
    default:
      return "The email didn't go out. Copy the link and send the link by hand.";
  }
}

function shareRow(s: HomeState, sh: ShareView): string {
  const field = `share-${esc(sh.id)}`;
  const confirming = s.wsConfirm === `share:${sh.id}`;
  const mail = s.wsMail[sh.id] ?? sh.mail ?? null;
  const who = `${sh.email ? `For ${esc(sh.email)} only.` : "For one person: whoever uses the link first."} Works once. ${sh.agents === "ask" ? "That person asks the owner for each agent added later." : "That person adds more agents with no further question."}`;
  const mailLine = !sh.email || mail === null ? "" : ` ${esc(mailNote(mail, sh.email))}`;
  return `<li class="srow srow-stack enter" data-key="ws-${esc(sh.id)}">
    <div class="srow-line"><span class="row-text"><strong>${sh.email ? `Link for ${esc(sh.email)}` : "Share link"}</strong><span class="row-help tnum">${who} Made by ${esc(sh.createdBy.name)}, expires ${date(sh.expiresAt, s.now)}.${mailLine}</span></span>${
      confirming
        ? `<span class="actions"><button type="button" class="btn btn-link" data-action="ws-confirm-cancel">Cancel</button><button type="button" class="btn btn-danger" data-action="ws-share-end" data-id="${esc(sh.id)}" data-autofocus${when(s.busy === "ws-confirm", " disabled")}>Confirm: end link</button></span>`
        : `<span class="actions">${when(sh.email && sh.link && sh.mails > 0 && sh.mails < 3, `<button type="button" class="btn btn-secondary" data-action="ws-share-mail" data-id="${esc(sh.id)}"${when(s.busy === `ws-mail:${sh.id}`, " disabled")}>Send again</button>`)}<button type="button" class="btn btn-text" data-action="ws-confirm" data-id="share:${esc(sh.id)}">End link</button></span>`
    }</div>
    ${when(!sh.link, `<p class="row-help link-flush">This link can't be shown again. To hand one over, end it and make a new one.</p>`)}
    ${when(
      sh.link,
      () => `<div class="link-line link-flush"><label for="${field}" class="sr">Share link</label><input id="${field}" class="line-field link-field" readonly value="${esc(sh.link)}"><button type="button" class="btn btn-primary" data-action="ws-share-copy" data-id="${esc(sh.id)}">${ICON.copy()}${s.wsCopied[sh.id] ? "Copied" : "Copy link"}</button></div>
    <p class="row-help link-flush">The other person gives this link to an agent.</p>`,
    )}
  </li>`;
}

/** The one-step stop for a whole Portico: its owner pauses and resumes. */
function pauseRow(s: HomeState, w: WorkspaceView): string {
  const paused = w.pausedAt !== null;
  return `<li class="srow"><span class="row-text"><strong>${paused ? "Paused" : "Pause"}</strong><span class="row-help">${
    paused
      ? `Nothing moves through ${esc(w.phrase)}. Resuming lets messages through again; what was withdrawn stays withdrawn.`
      : `One step stops everything: nothing moves through ${esc(w.phrase)}, messages on the way are withdrawn, and everyone stays in. History is kept.`
  }</span></span><span class="actions"><button type="button" class="btn ${paused ? "btn-secondary" : "btn-danger"}" data-action="${paused ? "ws-resume" : "ws-pause"}"${when(s.busy === "ws-pause", " disabled")}>${paused ? "Resume" : "Pause now"}</button></span></li>`;
}

export function renderWorkspace(s: HomeState, id: string): string {
  const data = s.workspacePage?.workspace.id === id ? s.workspacePage : null;
  const w = data?.workspace ?? s.workspaces.find((x) => x.id === id) ?? null;
  if (!w) return `<div class="page" data-key="page-ws-${esc(id)}"><p class="empty">Loading.</p></div>`;
  const inside = s.agents.filter((a) => w.agentIds.includes(a.id));
  const mine = inside.filter((a) => a.mine);
  const others = inside.filter((a) => !a.mine);
  const outside = s.agents.filter((a) => a.mine && !w.agentIds.includes(a.id));
  const shared = w.kind === "shared";
  const f = s.wsForm;
  const lead = shared
    ? `Made by ${w.isOwner ? esc(s.me.name) : esc(w.owner.name)}, with ${plural(w.people.length - 1, "other person", "other people")}. Agents here can message each other.`
    : `${esc(s.me.name)}'s own agents, which can all message each other. Each new agent joins here. An agent taken out is reached only through the other Porticos the agent is in.`;
  const tasks = s.tasks?.tasks ?? null;
  const paused = w.pausedAt !== null;
  const record = data?.record ?? [];
  const asks = data?.asks ?? [];
  return `<div class="page workspace" data-key="page-ws-${esc(id)}">
    <header class="page-head">
      <div class="block-head ws-head">
        <div class="page-title"><h1 class="h-page">${esc(porticoHeading(w.name))}</h1></div>
        <span class="actions ws-actions">
          ${when(shared, `<button type="button" class="btn btn-secondary" data-action="ws-people-toggle" aria-expanded="${s.peopleOpen}">People (${w.people.length})</button>`)}
          ${when(!shared || w.isOwner, `<button type="button" class="btn btn-primary" data-action="ws-share-open">${ICON.userPlus()}Share</button>`)}
        </span>
      </div>
      <p class="sec-help">${lead}${when(shared && !w.isOwner, ` Only ${esc(w.owner.name)}, who made the Portico, brings another person in.`)}</p>
      ${when(paused, `<p class="notice notice-error" role="status">Paused${w.isOwner ? "" : ` by ${esc(w.owner.name)}`}: no messages move through ${esc(w.phrase)}.${when(w.isOwner, ` <button type="button" class="btn btn-secondary" data-action="ws-resume"${when(s.busy === "ws-pause", " disabled")}>Resume</button>`)}</p>`)}
    </header>
    ${when(
      asks.length > 0,
      () => `<section aria-labelledby="h-ws-asks" class="block">
      <h2 id="h-ws-asks" class="h-section">Waiting for ${esc(s.me.name)}</h2>
      <ul class="rows card-list">${asks.map((a) => `<li class="srow" data-key="wk-${esc(a.id)}"><span class="row-text"><strong>${esc(a.text)}</strong><span class="row-help tnum">Waits until ${date(a.expiresAt, s.now)}.</span></span><span class="actions"><a class="btn btn-primary" href="${esc(a.link)}">Decide</a></span></li>`).join("")}</ul>
    </section>`,
    )}
    ${when(f?.kind === "share", () => renderShareForm(s, w, f as Extract<WorkspaceForm, { kind: "share" }>))}
    ${when(f?.kind === "new", () => renderNewForm(s, f as Extract<WorkspaceForm, { kind: "new" }>))}
    ${when(
      (data?.shares.length ?? 0) > 0,
      () => `<section aria-labelledby="h-ws-shares" class="block">
      <h2 id="h-ws-shares" class="h-section">Share links</h2>
      <ul class="rows card-list">${data!.shares.map((sh) => shareRow(s, sh)).join("")}</ul>
    </section>`,
    )}
    ${when(
      shared && s.peopleOpen,
      () => `<section aria-labelledby="h-ws-people" class="block enter" data-key="ws-people">
      <h2 id="h-ws-people" class="h-section">People</h2>
      <ul class="rows card-list">${w.people.map((p) => personRow(s, w, p)).join("")}</ul>
    </section>`,
    )}
    <section aria-labelledby="h-ws-mine" class="block">
      <div class="block-head"><h2 id="h-ws-mine" class="h-section">${esc(s.me.name)}'s agents</h2>${
        `<button type="button" class="linkbtn" data-action="ws-add-agent" data-id="${esc(w.id)}" aria-haspopup="dialog">${ICON.plus()}Add agent</button>`
      }</div>
      ${when(f?.kind === "agents", () => renderAgentsForm(s, w, f as Extract<WorkspaceForm, { kind: "agents" }>))}
      ${mine.length === 0 ? `<p class="empty">${shared ? `None of ${esc(s.me.name)}'s agents are in ${esc(w.phrase)} yet.` : "No agents here yet."}</p>` : `<ul class="rows card-list">${mine.map((a) => agentRow(s, w, a)).join("")}</ul>`}
    </section>
    ${when(
      !shared && outside.length > 0,
      () => `<section aria-labelledby="h-ws-out" class="block">
      <h2 id="h-ws-out" class="h-section">Taken out</h2>
      <p class="sec-help">Kept apart from your other agents.</p>
      <ul class="rows card-list">${outside.map((a) => outRow(s, a)).join("")}</ul>
    </section>`,
    )}
    ${when(
      shared,
      () => `<section aria-labelledby="h-ws-others" class="block">
      <h2 id="h-ws-others" class="h-section">Other people's agents</h2>
      ${others.length === 0 ? `<p class="empty">Nobody else's agents are here yet. Share ${esc(w.phrase)} to bring someone in.</p>` : `<ul class="rows card-list">${others.map((a) => agentRow(s, w, a)).join("")}</ul>`}
    </section>`,
    )}
    <section aria-labelledby="h-ws-tasks" class="block">
      <h2 id="h-ws-tasks" class="h-section">Conversations</h2>
      ${
        tasks === null
          ? `<p class="empty">Loading conversations.</p>`
          : tasks.length === 0
            ? `<p class="empty">No conversations in ${esc(w.phrase)} yet.</p>`
            : `<ul class="tlist">${taskHead()}${tasks.map((t) => renderTaskRow(s, t)).join("")}</ul>`
      }
      ${when(s.tasks?.more, `<button type="button" class="morebtn" data-action="more"${when(s.loadingMore, " disabled")}>Show more</button>`)}
    </section>
    <section aria-labelledby="h-ws-record" class="block">
      <h2 id="h-ws-record" class="h-section">Record</h2>
      <p class="sec-help">Joins, shares and held messages. Never what a message says.</p>
      ${record.length === 0 ? `<p class="empty">Nothing recorded yet.</p>` : `<ul class="rows card-list">${record.map((r) => `<li class="srow" data-key="wr-${esc(r.id)}"><span class="row-text"><span class="row-help">${esc(r.text)}</span></span><span class="tnum row-help">${date(r.at, s.now)}</span></li>`).join("")}</ul>`}
    </section>
    ${when(
      !shared && w.isOwner,
      () => `<section aria-labelledby="h-ws-stop" class="block">
      <h2 id="h-ws-stop" class="h-section">Stop</h2>
      <ul class="rows card-list">${pauseRow(s, w)}</ul>
    </section>`,
    )}
    ${when(
      shared && w.isOwner,
      () => `<section aria-labelledby="h-ws-manage" class="block">
      <h2 id="h-ws-manage" class="h-section">Manage ${esc(w.phrase)}</h2>
      ${when(f?.kind === "rename", () => renderRenameForm(s, f as Extract<WorkspaceForm, { kind: "rename" }>))}
      <ul class="rows card-list">
        ${pauseRow(s, w)}
        <li class="srow"><span class="row-text"><strong>Name</strong><span class="row-help">${w.named ? esc(w.name) : w.starter ? `${esc(w.name)}: every person starts with one.` : `No name yet: named after the people here, ${esc(w.name)}.`}</span></span><span class="actions"><button type="button" class="btn btn-secondary" data-action="ws-rename-open">Rename</button></span></li>
        <li class="srow"><span class="row-text"><strong>Delete</strong><span class="row-help">Agents that only meet here stop reaching each other. Conversations stay readable.</span></span>${
          s.wsConfirm === "delete"
            ? `<span class="actions"><button type="button" class="btn btn-link" data-action="ws-confirm-cancel">Cancel</button><button type="button" class="btn btn-danger" data-action="ws-delete" data-autofocus${when(s.busy === "ws-confirm", " disabled")}>Confirm: delete ${esc(w.phrase)}</button></span>`
            : `<span class="actions"><button type="button" class="btn btn-text" data-action="ws-confirm" data-id="delete">Delete</button></span>`
        }</li>
      </ul>
    </section>`,
    )}
  </div>`;
}
