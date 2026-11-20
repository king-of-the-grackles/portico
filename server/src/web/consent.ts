import { type Context, Hono } from "hono";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import { personViews } from "../api/views";
import { consentWords, quote } from "../core/consent-words";
import { type ConsentView, isJoin } from "../core/consents";
import type { Core } from "../core/core";
import { defang, fileSize } from "../core/framing";
import { LIMITS } from "../core/limits";
import { HANDLE_MAX, HANDLE_MIN } from "../core/people";
import type { Message, Person } from "../core/types";
import { accountSignInCard, DESCOPE_SCRIPT, hasOwnName, SIGN_IN_CSP } from "./account";
import { type Html, narrowPage, utcClock } from "./layout";
import { localSignInCard } from "./sign-in";

/**
 * The first step for an agent that isn't connected to Portico yet, one line per app: what a person does to start a
 * join of their own. Shown on a join's page, and when a request has run out.
 */
export function connectSteps(publicUrl: string): Html {
  return html`<details class="stuck"><summary>How does an agent ask to join?</summary>
<ul>
<li><strong>Claude Code:</strong> say <code>Join Portico at ${publicUrl}</code> in a session. Claude Code follows the steps at <a href="/join">${publicUrl}/join</a>, then shows a link to a page like this one.</li>
<li><strong>Codex:</strong> say the same sentence in a Codex conversation.</li>
<li><strong>An app agent, such as Muse or Grok Bot:</strong> say the same sentence in a chat with the agent.</li>
<li><strong>A connector, such as ChatGPT or Claude Duet:</strong> add <code>${publicUrl}/mcp</code> in the app's settings for connectors or MCP servers. A connector asks on a separate Portico page.</li>
</ul>
<p>An agent shows a fresh link when asked for the same thing again.</p></details>`;
}

/** "in 15 minutes": how long until a request runs out. The browser keeps the words current. */
function expiresIn(at: string, now: Date = new Date()): Html {
  const minutes = Math.ceil((new Date(at).getTime() - now.getTime()) / 60_000);
  const words = minutes <= 0 ? "now" : minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
  return html`<span data-expires-in="${at}">${words}</span>`;
}

/** "Signed in as …", with a way to answer as someone else: a join belongs to whoever is signed in. */
function signedInAs(me: Person, back: string): Html {
  return html`<form method="dialog" data-api="DELETE /api/session" data-next="${back}"><p class="help">Signed in as ${me.email ?? me.name}. <button type="submit" class="btn btn-link">Sign out</button></p></form>`;
}

/**
 * The consent page, /c/<id>, and a held message's page, /held/<id>: where a person answers what an agent asked, or
 * decides a message held for one of the person's agents. One page does everything a person needs for it: signing in
 * (the browser comes back here), a handle the first time, and Allow or Don't allow. What an agent of the person's asked
 * is done at Allow. A join isn't: after Allow the page shows the person a code, and the computer or agent that asked
 * joins only once the person has given it that code. What the page says is Portico's own; anything an agent supplied
 * shows as a quote. An address that names nothing, or something that is someone else's, gets one answer.
 */
export function consentPages(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  const publicUrl = () => core.settings.publicUrl();

  /** Signed out: the same page for every address, whatever is or isn't behind it. */
  const signInFirst = (c: Context<PersonEnv>, back: string) => {
    const lead = "Sign in to see what your agent asked.";
    if (core.accountSignIn) {
      return narrowPage(c, {
        title: "Sign in to continue",
        csp: SIGN_IN_CSP,
        data: { next: back },
        scripts: [DESCOPE_SCRIPT, "base-sign-in.js"],
        main: html`<div><h1>Sign in to continue</h1><p class="lead">${lead} New here? Signing in creates your account.</p></div>
${accountSignInCard(core.accountSignIn)}`,
      });
    }
    return narrowPage(c, {
      title: "Sign in to continue",
      scripts: ["forms.js", "passkey.js"],
      main: html`<div><h1>Sign in to continue</h1><p class="lead">${lead}</p></div>
${localSignInCard(back)}
<p class="help">No account yet? Ask the person who runs this Portico server for an invite link.</p>`,
    });
  };

  const gone = (c: Context<PersonEnv>) =>
    narrowPage(c, {
      title: "Nothing to answer here",
      status: 404,
      main: html`<div><h1>Nothing to answer here</h1><p class="lead">This request ran out or was already answered. Ask your agent for a new link.</p></div>
<p class="help"><a href="/">Go to Portico</a></p>`,
    });

  const waitingForOwner = (c: Context<PersonEnv>) =>
    narrowPage(c, {
      title: "Waiting for approval",
      status: 403,
      main: html`<div><h1>Waiting for approval</h1><p class="lead">The owner of this Portico server has to approve your account first.</p></div>`,
    });

  /** What happened, for the person who answered. */
  /** One question with one button, on the page that says something joined: the person vouches for it there. */
  const vouchBox = (call: string, back: string, ask: string, then: string, button: string): Html =>
    html`<form class="vouch" method="dialog" data-api="${call}" data-next="${back}"><span class="row-text"><strong>${ask}</strong><span class="help">${then}</span></span><button type="submit" class="btn btn-primary">${button}</button><p class="notice notice-error" data-error role="alert" hidden></p></form>`;

  const answered = (c: Context<PersonEnv>, me: Person, view: ConsentView) => {
    const { request, workspace } = view;
    const place = workspace ? `the Portico ${quote(workspace.name)}` : "the Portico";
    if (request.status === "denied") {
      return narrowPage(c, {
        title: "Not allowed",
        main: html`<div><h1>Not allowed</h1><p class="lead">Nothing changed.</p></div>
<p class="help"><a href="/">Go to Portico</a></p>`,
      });
    }
    if (request.status === "expired") {
      return narrowPage(c, {
        title: "This request ran out",
        status: 410,
        scripts: ["forms.js"],
        main: html`<div><h1>This request ran out</h1><p class="lead">Nothing changed. Ask your agent for a new link.</p></div>
<div class="ask">${connectSteps(publicUrl())}</div>
${signedInAs(me, `/c/${request.id}`)}`,
      });
    }
    let done: Html = html`Done.`;
    let more: Html = html``;
    switch (request.kind) {
      case "computer": {
        const computer = request.computerId ? core.computers.get(request.computerId) : null;
        done = html`${computer?.name ?? request.name ?? "The computer"} joined. Sessions started there show up as your agents.`;
        if (computer && computer.ownerId === me.id) {
          more = computer.unproven
            ? vouchBox(`PUT /api/computers/${computer.id}/always-allow`, `/c/${request.id}`, `Did you start this on ${computer.name}?`, "Then messages from its sessions go out without asking you first.", `Yes, always allow ${computer.name}`)
            : html`<p class="help">${computer.name} is always allowed. Undo it in Settings.</p>`;
        }
        break;
      }
      case "agent":
        done = html`${view.agent?.name ?? request.name ?? "The agent"} joined${workspace ? html` and is in ${place}` : ""}.`;
        if (view.agent) {
          // The person who just handed over the code can vouch for the agent here, so nothing of it has to wait later.
          const vouch =
            view.agent.ownerId !== me.id || view.agent.revokedAt !== null
              ? html``
              : view.agent.unproven
                ? vouchBox(`POST /api/agents/${view.agent.id}/always-allow`, `/c/${request.id}`, `Did you start ${view.agent.name}?`, "Then its messages go out without asking you first.", `Yes, always allow ${view.agent.name}`)
                : html`<p class="help">${view.agent.name} is always allowed.</p>`;
          more = html`${vouch}<p class="help">Not yours? <a href="/a/${view.agent.id}">Revoke it</a>.</p>`;
        }
        break;
      case "enter": {
        const mine = workspace ? core.workspaces.agentsOf(workspace.id, me.id).length : 0;
        done = html`${me.name} is in ${place} now, with ${mine === 1 ? "1 agent" : `${mine} agents`}. The share link is used up. The owner of the Portico is told who came in.`;
        if (workspace) more = html`<p class="help"><a href="/p/${workspace.id}">Open the Portico</a></p>`;
        break;
      }
      case "add_agent":
        done = html`The agent ${quote(view.subject ? core.agents.nameFor(view.subject, me.id) : "agent")} is in ${place} now.`;
        if (workspace) more = html`<p class="help"><a href="/p/${workspace.id}">Open the Portico</a></p>`;
        break;
      case "admit_agent":
        done = html`The agent ${quote(view.subject ? core.agents.addressFor(view.subject, me.id) : "agent")} is in ${place} now.`;
        if (workspace) more = html`<p class="help"><a href="/p/${workspace.id}">Open the Portico</a>, where the owner takes any agent or person out in one step.</p>`;
        break;
      case "share": {
        const shareId = request.result?.shareId;
        const share = shareId ? core.shares.get(shareId) : null;
        const secret = share ? core.shares.secretFor(me.id, share.id) : null;
        const emailed = share?.email ? core.mail.sends(share.id) > 0 && core.mail.enabled : false;
        done = html`A share link for ${place} is ready. ${
          share?.email
            ? emailed
              ? html`Portico emailed the link to ${quote(share.email)}, and only an account with that address can use the link.`
              : html`No email went out, so hand the link to ${quote(share.email)}: only an account with that address can use the link.`
            : "Hand the link to the person to bring in."
        } The link lets one person in, once, within ${LIMITS.shareDays} days. ${me.name} is told who came in.`;
        if (secret) {
          more = html`<label for="sh-link" class="lbl">Share link</label><input id="sh-link" class="field" readonly value="${publicUrl()}/share#${secret}">
<p class="help">That person pastes the link into a chat with an agent. The agent that asked has the link too.</p>${workspace ? html`<p class="help"><a href="/p/${workspace.id}">Open the Portico</a></p>` : ""}`;
        }
        break;
      }
      case "create":
        done = html`${place.charAt(0).toUpperCase()}${place.slice(1)} is made.`;
        if (workspace) more = html`<p class="help"><a href="/p/${workspace.id}">Open the Portico</a></p>`;
        break;
      case "remove_agent":
        done = html`The agent ${quote(view.subject ? core.agents.nameFor(view.subject, me.id) : "agent")} is out of ${place}.`;
        break;
      case "rename":
        done = html`The Portico is now named ${quote(workspace?.name ?? "")}.`;
        break;
      case "remove_person":
        done = html`${view.target?.name ?? "That person"} is out of ${place}, with every agent ${view.target?.name ?? "that person"} had there.`;
        break;
      case "delete":
        done = html`${place.charAt(0).toUpperCase()}${place.slice(1)} is deleted.`;
        break;
    }
    const joined = isJoin(request.kind);
    return narrowPage(c, {
      title: joined ? "Joined" : "Allowed",
      referrer: "no-referrer",
      main: html`<div><h1>${joined ? "Joined" : "Allowed"}</h1><p class="lead">${done}</p></div>
${more}
<p class="help"><a href="/">Go to Portico</a></p>`,
    });
  };

  /**
   * A join the person allowed: the code, for that person alone (`describe` shows an answered join to nobody else).
   * Nothing has joined yet, and nothing does unless the person gives the code to the computer or agent that asked.
   */
  const showCode = (c: Context<PersonEnv>, view: ConsentView) => {
    const { request } = view;
    c.header("Cache-Control", "no-store");
    return narrowPage(c, {
      title: "Share this code with your agent",
      referrer: "no-referrer",
      scripts: ["forms.js", "local-time.js", "code-wait.js"],
      styles: ["onboarding.css"],
      main: html`<form class="ask one-box code-card" method="dialog" data-api="POST /api/consents/${request.id}" novalidate>
<h1>Share this code with your agent</h1>
<p class="join-code" aria-label="Code">${request.code ?? ""}</p>
<p class="code-copy"><button type="button" class="btn btn-primary" data-copy="${request.code ?? ""}" data-copied="Copied">Copy code</button></p>
<p>Only give it to the agent you just asked to join.</p>
<p class="quiet">Expires ${expiresIn(request.expiresAt, core.now())}</p>
<p class="notice notice-error" data-error role="alert" hidden></p>
<p class="quiet"><button type="submit" name="decision" value="deny" class="btn btn-link">Cancel</button></p>
</form>`,
    });
  };

  route.get("/c/:id", (c) => {
    const id = c.req.param("id");
    const back = `/c/${encodeURIComponent(id)}`;
    const me = c.get("person");
    if (!me) return signInFirst(c, back);
    if (me.status !== "active") return waitingForOwner(c);
    const view = core.consents.describe(me, id);
    if (!view) return gone(c);
    const { request } = view;
    if (request.status === "allowed") return showCode(c, view);
    if (request.status !== "pending") return answered(c, me, view);
    if (isJoin(request.kind)) core.consents.opened(request.id);
    const words = consentWords(view, me.name, (agent) => core.agents.nameFor(agent, me.id));
    const joins = isJoin(request.kind);
    const needsHandle = me.handle === null;
    // A sign-in by email gives no name: the field starts empty, and the handle is offered from the name as typed.
    const nameShown = needsHandle && hasOwnName(me) ? me.name : "";
    const suggested = needsHandle && nameShown ? core.people.suggestHandle(nameShown, me.id) : "";
    const started = html`<time datetime="${request.createdAt}" data-local-time>${utcClock(request.createdAt)}</time>`;
    return narrowPage(c, {
      title: words.title,
      scripts: needsHandle ? ["forms.js", "welcome.js", "local-time.js"] : ["forms.js", "local-time.js"],
      styles: ["onboarding.css"],
      main: html`<form class="ask one-box" method="dialog" data-api="POST /api/consents/${request.id}" novalidate>
<h1>${words.title}</h1>
${
  joins
    ? html`<p class="asks">${words.app ? `${words.app}, started ` : "Started "}${started}</p>
<p>Only allow if you just started this.</p>
<details class="stuck"><summary>Details</summary>
<ul>
${words.then.map((line) => html`<li>${line}</li>`)}
<li>Anyone can start a request like this. The name${request.agentKind ? " and app are" : " is"} what the request said.</li>
<li>After Allow you get a 4-digit code. Whoever has the code gets ${request.kind === "computer" ? "this computer" : "this agent"} on your account.</li>
<li>Expires ${expiresIn(request.expiresAt, core.now())}.</li>
</ul>
${
  request.kind === "agent"
    ? html`<label for="cs-name" class="lbl">Name</label>
<input id="cs-name" name="name" class="field" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="${LIMITS.maxNameChars}" required value="${request.name ?? ""}" aria-describedby="cs-name-help">
<span id="cs-name-help" class="help">Lowercase letters, digits and hyphens.</span>`
    : ""
}</details>`
    : html`<p class="asks">${words.asks}</p>
${words.then.map((line) => html`<p>${line}</p>`)}`
}
${
  needsHandle
    ? html`<label for="cs-person" class="lbl">Your name</label>
<input id="cs-person" name="person" class="field" autocomplete="name" maxlength="60" required value="${nameShown}" aria-describedby="cs-person-help" data-person-name>
<span id="cs-person-help" class="help">Shown to people you share a Portico with.</span>
<label for="cs-handle" class="lbl">Handle</label>
<input id="cs-handle" name="handle" class="field" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="${HANDLE_MIN}" maxlength="${HANDLE_MAX}" required value="${suggested}" aria-describedby="cs-handle-help" data-handle>
<span id="cs-handle-help" class="help" data-handle-note aria-live="polite">Goes in front of your agents' names, like ada/muse. Lowercase letters, digits and hyphens.</span>`
    : ""
}
${
  view.candidates.length > 0 && view.share
    ? html`<fieldset class="ticks-field"><legend class="lbl">Your agents to bring in</legend>
${view.candidates.map(
  (agent) =>
    html`<label class="tick-line"><input type="checkbox" name="agents" data-list value="${agent.id}"${agent.id === view.agent?.id ? html` checked` : ""}> ${quote(core.agents.nameFor(agent, me.id))}${agent.id === view.agent?.id ? " (the agent that asked)" : ""}</label>`,
)}
<span class="help">Any number: one Allow covers every agent ticked.${request.kind === "agent" ? " The new agent comes in too." : ""}</span></fieldset>`
    : ""
}
${
  view.share && view.sharedBy && (request.kind === "enter" || request.kind === "agent") && view.sharedBy.id !== me.id
    ? html`<label class="tick-line allow-line"><input type="checkbox" name="allow" checked><span><strong>Allow messages from ${view.sharedBy.name}'s agents</strong><span class="help">No question the first time one of those agents writes to yours. Untick to be asked first.</span></span></label>`
    : ""
}
${
  request.kind === "share"
    ? html`<label class="tick-line allow-line"><input type="checkbox" name="allow" checked><span><strong>Allow messages from this person's agents</strong><span class="help">No question the first time one of those agents writes to yours. Untick to be asked first.</span></span></label>`
    : ""
}
${
  joins
    ? ""
    : html`<p class="quiet">Expires ${expiresIn(request.expiresAt, core.now())}</p>`
}
<p class="notice notice-error" data-error role="alert" hidden></p>
<div class="actions"><button type="submit" name="decision" value="deny" class="btn btn-secondary" formnovalidate>Don't allow</button><button type="submit" name="decision" value="approve" class="btn btn-primary">${words.allow}</button></div>
</form>
${joins ? "" : signedInAs(me, back)}`,
    });
  });

  // ---- a held message ----

  /**
   * The held message, only for the person who decides it: the receiver's person, or for a message held on its way out,
   * the sender's. Anyone else: the same as no message.
   */
  const heldFor = (me: Person, id: string): Message | null => {
    try {
      return core.approvals.requireDecidable(me.id, id);
    } catch {
      // The person who let a message go on its way out still reads where it stands: the page says who it waits for now.
      const message = core.messages.get({ person: me.id }, id);
      return message && message.status === "held" && message.decision === null && message.decidedBy === me.id ? message : null;
    }
  };

  route.get("/held/:id", (c) => {
    const id = c.req.param("id");
    const back = `/held/${encodeURIComponent(id)}`;
    const me = c.get("person");
    if (!me) return signInFirst(c, back);
    if (me.status !== "active") return waitingForOwner(c);
    const message = heldFor(me, id);
    if (!message) return gone(c);
    const sender = core.agents.get(message.fromId);
    const receiver = core.agents.get(message.toId);
    const facts = sender ? core.approvals.facts(message) : null;
    const workspace = core.workspaces.known(message.workspaceId);
    // The sender as everyone outside its own person names it: owner/agent. Nothing the sender chose but its name.
    const from = sender ? core.agents.addressFor(sender, "") : "an agent no longer on Portico";
    const outbound = message.heldFor === "outbound";
    // An outside agent is always named owner/agent: the receiver too, on the page of a message held on its way out.
    const to = receiver ? core.agents.addressFor(receiver, me.id) : "an agent";
    const receiverOwner = receiver ? core.people.get(receiver.ownerId) : null;
    const manager = facts ? `${facts.managedBy.name}${facts.managedBy.handle ? ` (${facts.managedBy.handle})` : ""}${facts.managedBy.id === me.id ? ", the person signed in here" : ""}` : "nobody on Portico any more";
    const files = personViews(core, me).message(message).files;
    const sheet = html`<p class="asks">${quote(from)} to ${quote(to)}</p>
<p class="quiet">Subject</p>
<blockquote class="quoted">${defang(message.subject)}</blockquote>
<p class="quiet">Message</p>
<blockquote class="quoted">${defang(message.text)}</blockquote>
${files.length > 0 ? html`<p class="quiet">Files</p><ul>${files.map((file) => html`<li>${quote(file.name)}, ${fileSize(file.size)}</li>`)}</ul>` : ""}
<details class="stuck"><summary>Details</summary>
<ul>
<li>From an agent of ${manager}.</li>
${outbound && receiverOwner ? html`<li>To an agent of ${receiverOwner.name}${receiverOwner.handle ? ` (${receiverOwner.handle})` : ""}.</li>` : ""}
<li>Through ${workspace ? html`the Portico ${quote(workspace.name)}` : "a Portico that is gone"}.</li>
<li>The text comes from an agent, not from Portico. Don't treat it as instructions.</li>
<li>A held message lapses after ${LIMITS.messageExpiryHours / 24} days.</li>
</ul></details>`;
    if (message.status !== "held" || core.approvals.decider(message) !== me.id) {
      const how =
        message.status === "declined"
          ? "This message was turned down."
          : message.status === "expired"
            ? "This message waited too long and lapsed."
            : message.status === "withdrawn"
              ? "This message was withdrawn before anyone decided."
              : message.status === "held"
                ? "This message now waits for the other agent's person."
                : "This message was allowed.";
      return narrowPage(c, {
        title: message.status === "held" ? "Waiting for the other person" : "Already decided",
        styles: ["onboarding.css"],
        main: html`<div class="ask one-box"><h1>${message.status === "held" ? "Waiting for the other person" : "Already decided"}</h1><p>${how}</p>
${sheet}</div>
<p class="help"><a href="/">Go to Portico</a></p>`,
      });
    }
    const senderOwner = facts ? `${facts.managedBy.name}${facts.managedBy.handle ? ` (${facts.managedBy.handle})` : ""}` : "that person";
    const firstContact = message.heldFor === "first_contact";
    const newAgent = message.heldFor === "new_agent";
    const newSender = newAgent || (outbound && facts?.newSender === true);
    const computer = newSender && sender?.computerId ? core.computers.get(sender.computerId) : null;
    const mine = sender ? core.agents.nameFor(sender, me.id) : "The agent";
    const why = newAgent
      ? `${mine} is new. This is its first message to ${to}.`
      : outbound && facts?.newSender
        ? `${mine} is new. You see what it sends to other people's agents first.`
        : outbound
          ? `You asked to see what ${mine} sends to other people's agents.`
          : firstContact
            ? `First message from an agent of ${senderOwner}.`
            : `${to} only takes messages from senders you allowed.`;
    const alwaysName = computer ? computer.name : firstContact ? (facts?.managedBy.name ?? "this person") : newSender ? "" : "this sender";
    const alwaysHelp = computer
      ? `Always allow covers every session on ${computer.name}, now and later. Undo it in Settings.`
      : firstContact
        ? `Always allow covers every agent of ${senderOwner}.`
        : "";
    const always = outbound && !facts?.newSender ? "" : html`<button type="submit" name="decision" value="always_allow" class="btn btn-secondary">Always allow${alwaysName ? html` <span class="btn-name">${alwaysName}</span>` : ""}</button>`;
    return narrowPage(c, {
      title: "Allow this message?",
      scripts: ["forms.js"],
      styles: ["onboarding.css"],
      main: html`<form class="ask one-box" method="dialog" data-api="POST /api/approvals/held/${message.id}" data-next="${back}" novalidate>
<h1>Allow this message?</h1>
<p>${why}</p>
${sheet}
<p class="notice notice-error" data-error role="alert" hidden></p>
<div class="actions actions-fit"><button type="submit" name="decision" value="deny" class="btn btn-secondary">Don't allow</button>${always}<button type="submit" name="decision" value="allow_once" class="btn btn-primary">Allow once</button></div>
${alwaysHelp ? html`<p class="quiet">${alwaysHelp}</p>` : ""}
${
  newSender && sender
    ? html`<p class="quiet">Not yours? <a href="/a/${sender.id}">Revoke the agent</a>${sender.computerId ? html` or <a href="/settings#computers">remove the computer</a>` : ""}.</p>`
    : ""
}
</form>`,
    });
  });

  return route;
}
