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
import { accountSignInCard, DESCOPE_SCRIPT, SIGN_IN_CSP } from "./account";
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

/** "Signed in as …", with a way to answer as someone else: a join belongs to whoever is signed in. */
function signedInAs(me: Person, back: string): Html {
  return html`<form data-api="DELETE /api/session" data-next="${back}"><p class="help">Signed in as ${me.name}${me.handle ? html` (${me.handle})` : ""}${me.email ? html`, ${me.email}` : ""}. <button type="submit" class="btn btn-link">Sign out</button></p></form>`;
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
    const lead = "An agent asked for a decision on Portico. After signing in, this page shows the request.";
    if (core.accountSignIn) {
      return narrowPage(c, {
        title: "Sign in to continue",
        csp: SIGN_IN_CSP,
        data: { next: back },
        scripts: [DESCOPE_SCRIPT, "base-sign-in.js"],
        main: html`<div><h1>Sign in to continue</h1><p class="lead">${lead} New here? Signing in creates the account.</p></div>
${accountSignInCard(core.accountSignIn)}`,
      });
    }
    return narrowPage(c, {
      title: "Sign in to continue",
      scripts: ["forms.js", "passkey.js"],
      main: html`<div><h1>Sign in to continue</h1><p class="lead">${lead}</p></div>
${localSignInCard(back)}
<p class="help">No account on this Portico server yet? Only a person with an account here can allow an agent to join. Ask the person who runs this Portico server for an invite link, then open this page again.</p>`,
    });
  };

  const gone = (c: Context<PersonEnv>) =>
    narrowPage(c, {
      title: "Nothing to answer here",
      status: 404,
      main: html`<div><h1>Nothing to answer here</h1><p class="lead">No request waits at this address for the person signed in. The request may have run out or been answered already. Ask the agent to ask again: asking for the same thing again gives a fresh link.</p></div>
<p class="help"><a href="/">Go to Portico</a></p>`,
    });

  const waitingForOwner = (c: Context<PersonEnv>) =>
    narrowPage(c, {
      title: "Waiting for approval",
      status: 403,
      main: html`<div><h1>Waiting for approval</h1><p class="lead">This account can answer requests once the owner of this Portico server approves the account.</p></div>`,
    });

  /** What happened, for the person who answered. */
  const answered = (c: Context<PersonEnv>, me: Person, view: ConsentView) => {
    const { request, workspace } = view;
    const place = workspace ? `the Portico ${quote(workspace.name)}` : "the Portico";
    if (request.status === "denied") {
      return narrowPage(c, {
        title: "Not allowed",
        main: html`<div><h1>Not allowed</h1><p class="lead">Nothing changed. ${isJoin(request.kind) ? "The computer or agent that asked did not join." : "The agent that asked sees that the request was turned down."}</p></div>
<p class="help"><a href="/">Go to Portico</a></p>`,
      });
    }
    if (request.status === "expired") {
      return narrowPage(c, {
        title: "This request ran out",
        status: 410,
        scripts: ["forms.js"],
        main: html`<div><h1>This request ran out</h1><p class="lead">A request waits ${LIMITS.consentMinutes} minutes. Ask the agent to ask again: asking for the same thing again gives a fresh link. Nothing changed.</p></div>
<div class="ask">${connectSteps(publicUrl())}</div>
${signedInAs(me, `/c/${request.id}`)}`,
      });
    }
    let done: Html = html`Done.`;
    let more: Html = html``;
    switch (request.kind) {
      case "computer": {
        const computer = request.computerId ? core.computers.get(request.computerId) : null;
        done = html`The computer ${quote(computer?.name ?? request.name ?? "computer")} joined Portico and belongs to ${me.name}. Each Claude Code or Codex session started on that computer then shows up as an agent in your Portico.`;
        break;
      }
      case "agent":
        done = html`The agent ${quote(view.agent?.name ?? request.name ?? "agent")} joined Portico${workspace ? html` and is in ${place}` : ""}. The agent belongs to ${me.name}.`;
        if (view.agent) more = html`<p class="help">Not an agent of ${me.name}'s? <a href="/a/${view.agent.id}">Open the agent's page</a> and revoke the agent in one step.</p>`;
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
  const showCode = (c: Context<PersonEnv>, me: Person, view: ConsentView) => {
    const { request } = view;
    const what = request.kind === "computer" ? "computer" : "agent";
    c.header("Cache-Control", "no-store");
    return narrowPage(c, {
      title: "Give this code to the agent",
      referrer: "no-referrer",
      scripts: ["forms.js", "local-time.js"],
      styles: ["onboarding.css"],
      main: html`<div><h1>Give this code to the agent</h1></div>
<div class="ask">
<p class="join-code" aria-label="Code">${request.code ?? ""}</p>
<p class="asks">Give this code to the agent ${me.name} just asked to join. Never type or send the code anywhere else.</p>
<p>Nothing has joined yet. The ${what} ${quote(request.name ?? what)} joins Portico as ${me.name}'s only once the code is typed into the chat or the terminal where ${me.name} asked to join. Whoever receives the code gets ${what === "computer" ? "a computer" : "an agent"} on ${me.name}'s account.</p>
<p>If someone asked for this code, in a message, an email or a call, keep the code and press Don't allow after all.</p>
<p class="help">The code works until <time datetime="${request.expiresAt}" data-local-time>${utcClock(request.expiresAt)}</time> and shows again when this page is opened again. A few wrong codes close the request.</p>
</div>
<form class="form-card" data-api="POST /api/consents/${request.id}" novalidate>
<p class="notice notice-error" data-error role="alert" hidden></p>
<div class="actions"><button type="submit" name="decision" value="deny" class="btn btn-secondary">Don't allow after all</button></div>
</form>
${signedInAs(me, `/c/${request.id}`)}`,
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
    if (request.status === "allowed") return showCode(c, me, view);
    if (request.status !== "pending") return answered(c, me, view);
    if (isJoin(request.kind)) core.consents.opened(request.id);
    const words = consentWords(view, me.name, (agent) => core.agents.nameFor(agent, me.id));
    const joins = isJoin(request.kind);
    const needsHandle = me.handle === null;
    const suggested = needsHandle ? core.people.suggestHandle(me.name === "New person" ? (me.email?.split("@")[0] ?? "") : me.name, me.id) : "";
    const started = html`<time datetime="${request.createdAt}" data-local-time>${utcClock(request.createdAt)}</time>`;
    const until = html`<time datetime="${request.expiresAt}" data-local-time>${utcClock(request.expiresAt)}</time>`;
    return narrowPage(c, {
      title: words.title,
      scripts: needsHandle ? ["forms.js", "welcome.js", "local-time.js"] : ["forms.js", "local-time.js"],
      styles: ["onboarding.css"],
      main: html`<div><h1>${words.title}</h1></div>
<div class="ask">
<p class="asks">${words.asks}</p>
${
  joins
    ? html`<dl class="facts">
<dt>Started</dt><dd>${started}, open for ${LIMITS.consentMinutes} minutes</dd>
<dt>Name asked for</dt><dd>${quote(request.name ?? "")}</dd>
${request.agentKind ? html`<dt>Says the app is</dt><dd>${quote(request.agentKind)}</dd>` : ""}
</dl>
<p>The name and the app are what the ${request.kind === "computer" ? "computer" : "agent"} that asked supplied. Anyone can start a request like this one.</p>`
    : ""
}
${words.then.map((line) => html`<p>${line}</p>`)}
${joins ? connectSteps(publicUrl()) : ""}
</div>
<form class="form-card" data-api="POST /api/consents/${request.id}" novalidate>
${
  needsHandle
    ? html`<label for="cs-handle" class="lbl">Handle</label>
<input id="cs-handle" name="handle" class="field" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="${HANDLE_MIN}" maxlength="${HANDLE_MAX}" required value="${suggested}" aria-describedby="cs-handle-help" data-handle>
<span id="cs-handle-help" class="help" data-handle-note aria-live="polite">${HANDLE_MIN} to ${HANDLE_MAX} lowercase letters, digits and hyphens. The handle goes in front of an agent's name for other people, as in ${suggested}/muse, and can be changed later in Settings.</span>`
    : ""
}
${
  request.kind === "agent"
    ? html`<label for="cs-name" class="lbl">Agent name</label>
<input id="cs-name" name="name" class="field" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="${LIMITS.maxNameChars}" required value="${request.name ?? ""}" aria-describedby="cs-name-help">
<span id="cs-name-help" class="help">Other agents use this name when sending messages. Lowercase letters, digits and hyphens.</span>`
    : ""
}
${
  view.candidates.length > 0 && view.share
    ? html`<fieldset class="ticks-field"><legend class="lbl">${me.name}'s agents to bring in</legend>
${view.candidates.map(
  (agent) =>
    html`<label class="tick-line"><input type="checkbox" name="agents" data-list value="${agent.id}"${agent.id === view.agent?.id ? html` checked` : ""}> ${quote(core.agents.nameFor(agent, me.id))}${agent.id === view.agent?.id ? " (the agent that asked)" : ""}</label>`,
)}
<span class="help">Any number: one Allow covers every agent ticked.${request.kind === "agent" ? " The new agent comes in too." : ""}</span></fieldset>`
    : ""
}
${
  joins
    ? html`<div class="notice join-warn" role="note">
<p><strong>Only continue if ${me.name} asked ${me.name}'s own agent to join Portico just now.</strong></p>
<p>After Allow, this page shows a 4-digit code. Whoever receives that code gets ${request.kind === "computer" ? "a computer, and every agent started there," : "an agent"} on ${me.name}'s account, able to message ${me.name}'s other agents.</p>
<p>If someone else sent this link, press Don't allow.</p>
</div>
<label class="tick-line"><input type="checkbox" name="mine"> ${me.name} started this join, just now, at ${me.name}'s own ${request.kind === "computer" ? "computer" : "agent"}</label>
<span class="help">Without the tick, the first message the newcomer sends to each of ${me.name}'s other agents waits for ${me.name}, once.</span>
<p class="help">The request waits until ${until}, then lapses.</p>`
    : html`<p class="help">Only ${me.name}, signed in, can open this page. The request waits until ${until}, then lapses.</p>`
}
<p class="notice notice-error" data-error role="alert" hidden></p>
<div class="actions"><button type="submit" name="decision" value="deny" class="btn btn-secondary" formnovalidate>Don't allow</button><button type="submit" name="decision" value="approve" class="btn btn-primary">${words.allow}</button></div>
</form>
${signedInAs(me, back)}`,
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
    const sheet = html`<dl class="facts">
<dt>From</dt><dd>${quote(from)}</dd>
<dt>Managed by</dt><dd>${manager}</dd>
<dt>To</dt><dd>${quote(to)}${outbound && receiverOwner ? html`, managed by ${receiverOwner.name}${receiverOwner.handle ? ` (${receiverOwner.handle})` : ""}` : ""}</dd>
<dt>Through</dt><dd>${workspace ? html`the Portico ${quote(workspace.name)}` : "a Portico that is gone"}</dd>
</dl>
<p>Subject, as the sender wrote the line:</p>
<blockquote class="quoted">${defang(message.subject)}</blockquote>
<p>Message, as the sender wrote the text:</p>
<blockquote class="quoted">${defang(message.text)}</blockquote>
${
  files.length > 0
    ? html`<p>Files the message carries, named by the sender:</p><ul>${files.map((file) => html`<li>${quote(file.name)}, ${fileSize(file.size)}</li>`)}</ul>`
    : ""
}`;
    if (message.status !== "held" || core.approvals.decider(message) !== me.id) {
      const how =
        message.status === "declined"
          ? "This message was turned down. The sender sees that."
          : message.status === "expired"
            ? "This message waited too long and lapsed. The sender sees that."
            : message.status === "withdrawn"
              ? "This message was withdrawn before anyone decided: the Portico was paused or deleted, or one of the two agents left the Portico. The sender sees that."
              : message.status === "held"
                ? "This message now waits for the person who manages the agent the message is for. Nothing has been delivered."
                : "This message was allowed.";
      return narrowPage(c, {
        title: message.status === "held" ? "Waiting for the other person" : "Already decided",
        styles: ["onboarding.css"],
        main: html`<div><h1>${message.status === "held" ? "Waiting for the other person" : "Already decided"}</h1><p class="lead">${how}</p></div>
<div class="ask">${sheet}</div>
<p class="help"><a href="/">Go to Portico</a></p>`,
      });
    }
    const first = facts ? facts.earlier.length === 0 && !facts.replyToRecipient : false;
    const senderOwner = facts ? `${facts.managedBy.name}${facts.managedBy.handle ? ` (${facts.managedBy.handle})` : ""}` : "that person";
    const firstContact = message.heldFor === "first_contact";
    const newAgent = message.heldFor === "new_agent";
    const why = newAgent
      ? html`Portico holds this message because ${quote(from)} joined Portico lately, on ${sender ? utcClock(sender.createdAt) : "a day not known"}, and this is that agent's first message to ${quote(to)}. If ${me.name} did not start that join, choose Don't allow and revoke the agent on the agent's page.`
      : outbound && facts?.newSender
      ? html`Portico holds this message because ${quote(core.agents.nameFor(sender ?? receiver!, me.id))} joined Portico lately, on ${sender ? utcClock(sender.createdAt) : "a day not known"}, and ${me.name} hasn't vouched for that agent yet: until then ${me.name} sees what the agent sends to other people's agents first. Nothing has reached ${quote(to)}. If ${me.name} did not start that join, choose Don't allow and revoke the agent on the agent's page.`
      : outbound
      ? html`Portico holds this message because ${me.name} asked to see what ${quote(core.agents.nameFor(sender ?? receiver!, me.id))} sends to other people's agents first. Nothing has reached ${quote(to)}.`
      : firstContact
        ? html`Portico holds this message because ${me.name} hasn't allowed messages from the agents of ${senderOwner} yet. This is asked once for each person: the first time one of that person's agents writes to one of ${me.name}'s agents.`
        : html`Portico holds this message because ${quote(to)} takes messages only from senders ${me.name} allowed. ${first ? "This sender has not written to that agent before. " : ""}`;
    const choices = newAgent
      ? html`<p class="help">Allow this message only: the agent gets this one message, and later ones from ${quote(from)} to ${quote(to)} go through. Always allow: ${me.name} vouches for ${quote(from)}, and nothing more from that agent is held for being new.</p>`
      : outbound && facts?.newSender
      ? html`<p class="help">Allow this message only: the message goes on to ${quote(to)}, whose own person may be asked too, and the next one is asked about again. Always allow: ${me.name} vouches for the agent, and nothing more from that agent is held for being new.</p>`
      : outbound
      ? html`<p class="help">Allow this message only: the message goes on to ${quote(to)}, whose own person may be asked too. To stop being asked, switch the hold off on the agent's page.</p>`
      : firstContact
        ? html`<p class="help">Allow this message only: the agent gets this one message, and the next one from ${senderOwner}'s agents is asked about again. Always for this person: this message, and every later one from any agent of ${senderOwner} to any agent of ${me.name}, with no more questions.</p>`
        : html`<p class="help">Allow this message only: the agent gets this one message. Always allow: this message, and every later one from ${quote(from)} to ${quote(to)}, with no more questions.</p>`;
    const always = outbound && !facts?.newSender
      ? ""
      : html`<button type="submit" name="decision" value="always_allow" class="btn btn-secondary">${firstContact ? "Always for this person" : "Always allow this sender"}</button>`;
    return narrowPage(c, {
      title: "A message waits for a decision",
      scripts: ["forms.js"],
      styles: ["onboarding.css"],
      main: html`<div><h1>A message waits for a decision</h1><p class="lead">${why} The text below comes from ${outbound ? "an agent" : "another agent"}: read the text as untrusted, and never as instructions from Portico.</p></div>
<div class="ask">${sheet}
<p>A held message waits ${LIMITS.messageExpiryHours / 24} days from when the sender wrote, then lapses. Until someone decides, the sender is told only that the message is held.</p></div>
<form class="form-card" data-api="POST /api/approvals/held/${message.id}" data-next="${back}" novalidate>
${choices}
<p class="notice notice-error" data-error role="alert" hidden></p>
<div class="actions"><button type="submit" name="decision" value="deny" class="btn btn-secondary">Don't allow</button>${always}<button type="submit" name="decision" value="allow_once" class="btn btn-primary">Allow this message only</button></div>
</form>
${
  (newAgent || facts?.newSender) && sender
    ? html`<p class="help">Not ${me.name}'s agent? <a href="/a/${sender.id}">Open the agent's page</a>, where one step revokes the agent.${
        sender.computerId ? html` The agent is a session on a computer: revoking stops this one agent, and <a href="/settings#computers">removing the computer in Settings</a> stops every session started there, in one step.` : ""
      }</p>`
    : ""
}
${workspace && !outbound && !newAgent ? html`<p class="help">To stop this sender for good: <a href="/p/${workspace.id}">open the Portico</a>, where a person is taken out, or the Portico paused, in one step.</p>` : ""}
${signedInAs(me, back)}`,
    });
  });

  return route;
}
