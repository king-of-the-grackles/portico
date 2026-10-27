// Settings: People, Computers and Account. Pure: state in, HTML out.
import { ago, clock, date, dayLabel, esc, ICON, monogram, personColor, plural, renderAddSheet, renderHeader, when } from "./common.js";
import type { AgentView, ClaimView, ComputerView, InviteView, PasskeyView, PersonRow, SettingsState } from "./types.js";

function notice(text: string, key: string): string {
  if (!text) return "";
  return `<div role="status" class="settings-notice enter" data-key="${key}">${ICON.check()}<span>${esc(text)}</span></div>`;
}

function agentsLine(n: number): string {
  return n === 0 ? "No agents yet." : `${plural(n, "agent")}.`;
}

function avatar(person: { id: string; name: string; role?: string }): string {
  return `<span class="av av-round" style="background: ${personColor(person)}">${monogram(person.name)}</span>`;
}

function confirmPair(confirming: boolean, name: string, start: string, cancel: string, confirm: string, id: string, busy: boolean): string {
  return confirming
    ? `<span class="actions"><button type="button" class="btn btn-link" data-action="${cancel}">Cancel</button><button type="button" class="btn btn-danger" data-action="${confirm}" data-id="${esc(id)}" data-autofocus${when(busy, " disabled")}>Confirm: remove ${esc(name)}</button></span>`
    : `<span class="actions"><button type="button" class="btn btn-text" data-action="${start}" data-id="${esc(id)}">Remove</button></span>`;
}

// ---- People ----

function personRow(s: SettingsState, p: PersonRow): string {
  if (p.role === "owner") {
    return `<li class="srow" data-key="p-${esc(p.id)}">${avatar(p)}<span class="row-text"><strong>${esc(p.name)}</strong><span class="row-help">Owner. ${agentsLine(p.agentCount)}</span></span></li>`;
  }
  const joined = p.joinedAt ? `Joined ${date(p.joinedAt, s.now)}. ` : "";
  const canRemove = s.me.role === "owner" && !p.isMe;
  return `<li class="srow enter" data-key="p-${esc(p.id)}">${avatar(p)}<span class="row-text"><strong>${esc(p.name)}</strong><span class="row-help tnum">${joined}${agentsLine(p.agentCount)}</span></span>${when(
    canRemove,
    confirmPair(s.confirmMember === p.id, p.name, "member-remove", "member-cancel", "member-confirm", p.id, s.busy === `member:${p.id}`),
  )}</li>`;
}

function claimRow(s: SettingsState, c: ClaimView): string {
  const busy = s.busy === `claim:${c.personId}`;
  return `<li class="srow srow-claim" data-key="c-${esc(c.personId)}"><span class="av av-round av-claim">${monogram(c.name)}</span><span class="row-text"><strong>${esc(c.name)}</strong><span class="row-help claim-help tnum">Claimed the invite for ${esc(c.inviteName)} at ${claimTime(c.claimedAt, s.now)}. Approve to finish joining.</span></span><span class="actions"><button type="button" class="btn btn-text" data-action="claim-decline" data-id="${esc(c.personId)}"${when(busy, " disabled")}>Decline</button><button type="button" class="btn btn-primary" data-action="claim-approve" data-id="${esc(c.personId)}"${when(busy, " disabled")}>Approve</button></span></li>`;
}

/** "10:12" today, otherwise "10:12 on Oct 22". */
function claimTime(iso: string, now: number): string {
  return dayLabel(iso, now) === "Today" ? clock(iso) : `${clock(iso)} on ${date(iso, now)}`;
}

function inviteRow(s: SettingsState, i: InviteView): string {
  const link = i.link ?? s.links[i.id];
  const field = `invite-${esc(i.id)}`;
  return `<li class="srow srow-stack enter" data-key="i-${esc(i.id)}">
    <div class="srow-line"><span class="av av-round av-invite">${monogram(i.name)}</span><span class="row-text"><strong>Invite for ${esc(i.name)}</strong><span class="row-help tnum">Unclaimed. Single use, expires ${date(i.expiresAt, s.now)}.</span></span><span class="actions"><button type="button" class="btn btn-text" data-action="invite-revoke" data-id="${esc(i.id)}"${when(s.busy === `revoke:${i.id}`, " disabled")}>Revoke</button></span></div>
    ${when(
      link,
      `<div class="link-line"><label for="${field}" class="sr">Invite link for ${esc(i.name)}</label><input id="${field}" class="line-field link-field" readonly value="${esc(link)}"><button type="button" class="btn btn-primary" data-action="invite-copy" data-id="${esc(i.id)}">${ICON.copy()}${s.copied[i.id] ? "Copied" : "Copy link"}</button></div>`,
    )}
  </li>`;
}

function renderInviteForm(s: SettingsState): string {
  const f = s.invite!;
  return `<form class="sform enter" data-form="invite-create" data-key="invite-form" novalidate>
    <label for="invite-name" class="lbl">Name</label>
    <input id="invite-name" class="field field-narrow${when(f.error, " is-invalid")}" value="${esc(f.name)}" data-input="invite-name" aria-describedby="invite-help" aria-invalid="${Boolean(f.error)}" autocomplete="off" data-autofocus>
    <span id="invite-help" class="help">One link per person. Single use, expires in 7 days.</span>
    ${when(f.error, `<span role="alert" class="field-error">${esc(f.error)}</span>`)}
    <span class="actions actions-narrow"><button type="button" class="btn btn-link" data-action="invite-cancel">Cancel</button><button type="submit" class="btn btn-primary"${when(s.busy === "invite", " disabled")}>Create invite link</button></span>
  </form>`;
}

export function renderPeople(s: SettingsState): string {
  const owner = s.me.role === "owner";
  const people = s.people ?? [];
  const sorted = [...people.filter((p) => p.role === "owner"), ...people.filter((p) => p.role !== "owner")];
  const openInvites = s.invites.filter((i) => i.status === "open");
  return `<section id="people" aria-labelledby="people-h" class="ssection">
    <div class="sec-head"><h2 id="people-h" class="h-settings">People</h2>${when(
      owner,
      `<button type="button" class="btn btn-link sec-action" aria-expanded="${s.invite !== null}" data-action="invite-open">${ICON.userPlus()}Invite a person</button>`,
    )}</div>
    <p class="sec-help">Each invited person can add agents to Portico.</p>
    ${notice(s.peopleNotice, "people-notice")}
    ${when(owner && s.invite, s.invite ? renderInviteForm(s) : "")}
    <ul class="rows card-list">${sorted.map((p) => personRow(s, p)).join("")}${s.claims.map((c) => claimRow(s, c)).join("")}${openInvites
      .map((i) => inviteRow(s, i))
      .join("")}</ul>
  </section>`;
}

// ---- Computers ----

function computerSub(c: ComputerView, now: number): string {
  const offline = c.sessions.filter((a: AgentView) => a.status === "offline").length;
  const sessions = c.sessions.length === 0 ? "No sessions" : `${plural(c.sessions.length, "session")}${offline ? `, ${offline} offline` : ""}`;
  const created = (c as ComputerView & { createdAt?: string }).createdAt;
  const when2 = created ? ` Added ${date(created, now)}.` : c.lastSeen ? ` Seen ${ago(c.lastSeen, now)}.` : "";
  return `${sessions}.${when2}`;
}

function computerRow(s: SettingsState, c: ComputerView): string {
  const owner = c.sessions[0] && !c.sessions[0].mine ? c.sessions[0].owner.name : null;
  return `<li class="srow" data-key="m-${esc(c.id)}"><span class="av av-device">${ICON.laptop()}</span><span class="row-text"><span class="comp-name"><strong>${esc(c.name)}</strong>${when(owner, `<span class="owner-chip">${esc(owner)}</span>`)}</span><span class="row-help tnum">${computerSub(c, s.now)}</span></span>${confirmPair(
    s.confirmComputer === c.id,
    c.name,
    "computer-remove",
    "computer-cancel",
    "computer-confirm",
    c.id,
    s.busy === `computer:${c.id}`,
  )}</li>`;
}

export function renderComputers(s: SettingsState): string {
  const list = s.computers ?? [];
  return `<section id="computers" aria-labelledby="computers-h" class="ssection">
    <h2 id="computers-h" class="h-settings">Computers</h2>
    <p class="sec-help">Claude Code and Codex sessions join Portico from these computers. Removing a computer signs out every session on that computer.</p>
    ${notice(s.compNotice, "comp-notice")}
    <ul class="rows card-list">${list.map((c) => computerRow(s, c)).join("")}${when(
      s.computers !== null && list.length === 0,
      `<li class="srow"><span class="row-help">No computers yet.</span></li>`,
    )}</ul>
  </section>`;
}

// ---- Account ----

function passkeyRow(s: SettingsState, k: PasskeyView): string {
  const used = k.lastUsedAt ? ` Used ${ago(k.lastUsedAt, s.now).replace(/^today \d\d:\d\d$/, "today")}.` : "";
  return `<div class="inner-row" data-key="k-${esc(k.id)}"><span class="row-text"><span class="strong">${esc(k.name)}</span><span class="row-help tnum">Added ${date(k.createdAt, s.now)}.${used}</span></span><span class="actions"><button type="button" class="btn btn-text" data-action="passkey-remove" data-id="${esc(k.id)}"${when(s.busy === `passkey:${k.id}`, " disabled")}>Remove</button></span></div>`;
}

export function renderAccount(s: SettingsState): string {
  const nameRow = s.nameForm
    ? `<li class="srow srow-stack" data-key="acct-name"><form class="sform-inline" data-form="name-save" novalidate>
        <label for="acct-name" class="lbl">Name</label>
        <input id="acct-name" class="field field-narrow${when(s.nameForm.error, " is-invalid")}" value="${esc(s.nameForm.name)}" data-input="name-field" aria-invalid="${Boolean(s.nameForm.error)}" autocomplete="name" data-autofocus>
        ${when(s.nameForm.error, `<span role="alert" class="field-error">${esc(s.nameForm.error)}</span>`)}
        <span class="actions actions-narrow"><button type="button" class="btn btn-link" data-action="name-cancel">Cancel</button><button type="submit" class="btn btn-primary"${when(s.busy === "name", " disabled")}>Save</button></span>
      </form></li>`
    : `<li class="srow" data-key="acct-name"><span class="row-text"><strong>Name</strong><span class="row-help">${esc(s.me.name)}</span></span><span class="actions"><button type="button" class="btn btn-link" data-action="name-open">Change name</button></span></li>`;
  const pw = s.passwordForm;
  const passwordRow = pw
    ? `<li class="srow srow-stack" data-key="acct-password"><form class="sform-inline" data-form="password-save" novalidate>
        <label for="pw-current" class="lbl">Current password</label>
        <input id="pw-current" type="password" class="field field-narrow" value="${esc(pw.current)}" data-input="pw-current" autocomplete="current-password" data-autofocus>
        <label for="pw-next" class="lbl mt8">New password</label>
        <input id="pw-next" type="password" class="field field-narrow${when(pw.error, " is-invalid")}" value="${esc(pw.next)}" data-input="pw-next" autocomplete="new-password" aria-describedby="pw-help" aria-invalid="${Boolean(pw.error)}">
        <span id="pw-help" class="help">At least 12 characters. Every other browser signs out.</span>
        ${when(pw.error, `<span role="alert" class="field-error">${esc(pw.error)}</span>`)}
        <span class="actions actions-narrow"><button type="button" class="btn btn-link" data-action="password-cancel">Cancel</button><button type="submit" class="btn btn-primary"${when(s.busy === "password", " disabled")}>Change password</button></span>
      </form></li>`
    : `<li class="srow" data-key="acct-password"><span class="row-text"><strong>Password</strong><span class="row-help">${
        s.passwordChanged ? "Changed just now." : "Changing the password signs out other browsers."
      }</span></span><span class="actions"><button type="button" class="btn btn-link" data-action="password-open">Change password</button></span></li>`;
  const pk = s.passkeyForm;
  const passkeys =
    s.passkeys === null
      ? ""
      : `<li class="srow srow-stack" data-key="acct-passkeys">
      <div class="srow-line"><span class="row-text"><strong>Passkeys</strong><span class="row-help">Sign in without a password.</span></span>${when(
        !pk && s.passkeysSupported,
        `<span class="actions"><button type="button" class="btn btn-link" data-action="passkey-open">${ICON.plus()}Add passkey</button></span>`,
      )}</div>
      ${
        pk
          ? `<form class="sform-inline inner-form" data-form="passkey-add" novalidate>
        <label for="pk-name" class="lbl">Passkey name</label>
        <input id="pk-name" class="field field-narrow${when(pk.error, " is-invalid")}" value="${esc(pk.name)}" data-input="pk-name" aria-describedby="pk-help" autocomplete="off" data-autofocus>
        <span id="pk-help" class="help">Shown in this list, such as MacBook Touch ID.</span>
        ${when(pk.error, `<span role="alert" class="field-error">${esc(pk.error)}</span>`)}
        <span class="actions actions-narrow"><button type="button" class="btn btn-link" data-action="passkey-cancel">Cancel</button><button type="submit" class="btn btn-primary"${when(s.busy === "passkey", " disabled")}>Add passkey</button></span>
      </form>`
          : ""
      }
      ${s.passkeys.map((k) => passkeyRow(s, k)).join("")}
    </li>`;
  return `<section id="account" aria-labelledby="account-h" class="ssection">
    <h2 id="account-h" class="h-settings mb12">Account</h2>
    ${when(s.accountError, `<p role="alert" class="field-error mb12">${esc(s.accountError)}</p>`)}
    <ul class="rows card-list">
      ${nameRow}
      ${passwordRow}
      ${passkeys}
      <li class="srow" data-key="acct-signout"><span class="row-text"><strong>Sign out</strong><span class="row-help">Ends the Portico session in this browser.</span></span><span class="actions"><button type="button" class="btn btn-text" data-action="sign-out">${ICON.signOut()}Sign out</button></span></li>
    </ul>
  </section>`;
}

export function renderSettings(s: SettingsState): string {
  return `<div class="app settings">
  <a class="skip" href="#settings-main">Skip to content</a>
  ${renderHeader({ me: s.me, acctOpen: s.acctOpen, page: "settings" })}
  ${renderAddSheet(s.add, { publicUrl: s.publicUrl, now: s.now })}
  <main id="settings-main" class="settings-main">
    <a class="linkbtn back" href="/">${ICON.arrowLeft()}Home</a>
    <h1 class="h-page">Settings</h1>
    ${when(s.reconnecting, `<div role="status" class="reconnecting enter" data-key="reconnecting"><span class="dot dot-pending"></span>Updates paused. Reconnecting.</div>`)}
    <div class="settings-cols">
      <nav aria-label="Settings sections" class="side"><ul class="side-list">
        <li><a class="sidelink" href="#people">People</a></li>
        <li><a class="sidelink" href="#computers">Computers</a></li>
        <li><a class="sidelink" href="#account">Account</a></li>
      </ul></nav>
      <div class="sections">
        ${renderPeople(s)}
        ${renderComputers(s)}
        ${renderAccount(s)}
      </div>
    </div>
  </main>
</div>`;
}

/** A fresh Settings state from the server's first data. */
export function settingsState(data: {
  me: SettingsState["me"];
  publicUrl: string;
  agents: AgentView[];
  people: { people: PersonRow[]; invites: InviteView[]; claims: ClaimView[] } | null;
  computers: ComputerView[] | null;
  passkeys: PasskeyView[] | null;
  now: number;
}): SettingsState {
  return {
    now: data.now,
    me: data.me,
    publicUrl: data.publicUrl,
    agents: data.agents,
    people: data.people?.people ?? null,
    invites: data.people?.invites ?? [],
    claims: data.people?.claims ?? [],
    computers: data.computers,
    passkeys: data.passkeys,
    acctOpen: false,
    add: null,
    reconnecting: false,
    links: {},
    copied: {},
    invite: null,
    peopleNotice: "",
    compNotice: "",
    confirmMember: null,
    confirmComputer: null,
    nameForm: null,
    passwordForm: null,
    passwordChanged: false,
    passkeyForm: null,
    passkeysSupported: false,
    accountError: "",
    busy: null,
  };
}
