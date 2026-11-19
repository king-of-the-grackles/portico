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
 * The first step for an agent that isn't connected to Portico yet, one line per app: what a person does when no agent
 * has shown a code. Shown before the code on a join, and when a code has run out.
 */
export function connectSteps(publicUrl: string): Html {
  return html`<details class="stuck"><summary>No code in the chat yet?</summary>
<ul>
<li><strong>Claude Code:</strong> say <code>Join Portico at ${publicUrl}</code> in a session. Claude Code follows the steps at <a href="/join">${publicUrl}/join</a>, then shows a link and a code.</li>
<li><strong>Codex:</strong> say the same sentence in a Codex conversation.</li>
<li><strong>An app agent, such as Muse or Grok Bot:</strong> say the same sentence in a chat with the agent.</li>
<li><strong>A connector, such as ChatGPT or Claude Duet:</strong> add <code>${publicUrl}/mcp</code> in the app's settings for connectors or MCP servers. A connector asks on a Portico page, with no code.</li>
</ul>
<p>An agent already on Portico shows a fresh link and code when asked for the same thing again.</p></details>`;
}

/** "Signed in as …", with a way to answer as someone else: a join belongs to whoever is signed in. */
function signedInAs(me: Person, back: string): Html {
  return html`<form data-api="DELETE /api/session" data-next="${back}"><p class="help">Signed in as ${me.name}${me.handle ? html` (${me.handle})` : ""}${me.email ? html`, ${me.email}` : ""}. <button type="submit" class="btn btn-link">Sign out</button></p></form>`;
}

/**
 * The consent page, /c/<id>, and a held message's page, /held/<id>: where a person answers what an agent asked, or
 * decides a message held for one of the person's agents. One page does everything a person needs for it: signing in
 * (the browser comes back here), a handle the first time, the code from the agent's chat, and Allow or Don't allow.
 * What the page says is Portico's own; anything an agent supplied shows as a quote. An address that names nothing, or
 * something that is someone else's, gets one answer.
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
      main: html`<div><h1>Nothing to answer here</h1><p class="lead">No request waits at this address for the person signed in. The request may have run out or been answered already. Ask the agent for a new code: asking for the same thing again gives a fresh link.</p></div>
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
        title: "This code ran out",
        status: 410,
        scripts: ["forms.js"],
        main: html`<div><h1>This code ran out</h1><p class="lead">A code works for ${LIMITS.consentMinutes} minutes. Ask the agent for a new code: asking for the same thing again gives a fresh link and code. Nothing changed.</p></div>
<div class="ask">${connectSteps(publicUrl())}</div>
${signedInAs(me, `/c/${request.id}`)}`,
      });
    }
    let done: Html;
    let more: Html = html``;
    switch (request.kind) {
      case "computer": {
        const computer = request.computerId ? core.computers.get(request.computerId) : null;
        done = html`The computer ${quote(computer?.name ?? request.name ?? "computer")} joined Portico. Go back to the agent: the join finishes there within a few seconds. Each Claude Code or Codex session started on that computer then shows up as an agent in your Portico.`;
        break;
      }
      case "agent":
        done = html`The agent ${quote(view.agent?.name ?? request.name ?? "agent")} joined Portico${workspace ? html` and is in ${place}` : ""}. Go back to the agent: the join finishes there within a few seconds.`;
        break;
      case "enter":
        done = html`The agent ${quote(view.agent ? core.agents.nameFor(view.agent, me.id) : "agent")} is in ${place} now.`;
        if (workspace) more = html`<p class="help"><a href="/p/${workspace.id}">Open the Portico</a></p>`;
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
        } The link lets one person in and works for ${LIMITS.shareDays} days.`;
        if (secret) {
          more = html`<label for="sh-link" class="lbl">Share link</label><input id="sh-link" class="field" readonly value="${publicUrl()}/share#${secret}">
<p class="help">That person pastes the link into a chat with an agent. The agent that asked has the link too.</p>${workspace ? html`<p class="help"><a href="/p/${workspace.id}">Open the Portico</a></p>` : ""}`;
        }
        break;
      }
      case "remove_person":
        done = html`${view.target?.name ?? "That person"} is out of ${place}, with every agent ${view.target?.name ?? "that person"} had there.`;
        break;
      case "delete":
        done = html`${place.charAt(0).toUpperCase()}${place.slice(1)} is deleted.`;
        break;
    }
    return narrowPage(c, {
      title: "Allowed",
      referrer: "no-referrer",
      main: html`<div><h1>Allowed</h1><p class="lead">${done}</p></div>
${more}
<p class="help"><a href="/">Go to Portico</a></p>`,
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
    if (request.status !== "pending") return answered(c, me, view);
    const words = consentWords(view, me.name, (agent) => core.agents.nameFor(agent, me.id));
    const needsHandle = me.handle === null;
    const suggested = needsHandle ? core.people.suggestHandle(me.name === "New person" ? (me.email?.split("@")[0] ?? "") : me.name, me.id) : "";
    return narrowPage(c, {
      title: words.title,
      scripts: needsHandle ? ["forms.js", "welcome.js", "local-time.js"] : ["forms.js", "local-time.js"],
      styles: ["onboarding.css"],
      main: html`<div><h1>${words.title}</h1></div>
<div class="ask">
<p class="asks">${words.asks}</p>
${words.then.map((line) => html`<p>${line}</p>`)}
${isJoin(request.kind) ? connectSteps(publicUrl()) : ""}
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
<label for="cs-code" class="lbl">Code the agent shows</label>
<input id="cs-code" name="code" class="field code-field" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4}" maxlength="4" required aria-describedby="cs-code-help"${needsHandle ? "" : html` autofocus`}>
<span id="cs-code-help" class="help">Four digits, showing right now in the chat with the agent that asked. The code runs out at <time datetime="${request.expiresAt}" data-local-time>${utcClock(request.expiresAt)}</time>. A link or a code that came any other way, such as in an email or from another person, means someone else's agent is asking: choose Don't allow.</span>
<p class="notice notice-error" data-error role="alert" hidden></p>
<div class="actions"><button type="submit" name="decision" value="deny" class="btn btn-secondary" formnovalidate>Don't allow</button><button type="submit" name="decision" value="approve" class="btn btn-primary">${words.allow}</button></div>
</form>
${signedInAs(me, back)}`,
    });
  });

  // ---- a held message ----

  /** The held message, only for the person who manages the agent it is for. Anyone else: the same as no message. */
  const heldFor = (me: Person, id: string): Message | null => {
    let message: Message;
    try {
      message = core.messages.require({ person: me.id }, id);
    } catch {
      return null;
    }
    const receiver = core.agents.get(message.toId);
    return receiver && receiver.ownerId === me.id && message.heldAt !== null ? message : null;
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
    const to = receiver ? core.agents.nameFor(receiver, me.id) : "an agent";
    const manager = facts ? `${facts.managedBy.name}${facts.managedBy.handle ? ` (${facts.managedBy.handle})` : ""}${facts.managedBy.id === me.id ? ", the person signed in here" : ""}` : "nobody on Portico any more";
    const files = personViews(core, me).message(message).files;
    const sheet = html`<dl class="facts">
<dt>From</dt><dd>${quote(from)}</dd>
<dt>Managed by</dt><dd>${manager}</dd>
<dt>To</dt><dd>${quote(to)}</dd>
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
    if (message.status !== "held") {
      const how =
        message.status === "declined"
          ? "This message was turned down. The sender sees that."
          : message.status === "expired"
            ? "This message waited too long and lapsed. The sender sees that."
            : "This message was allowed.";
      return narrowPage(c, {
        title: "Already decided",
        styles: ["onboarding.css"],
        main: html`<div><h1>Already decided</h1><p class="lead">${how}</p></div>
<div class="ask">${sheet}</div>
<p class="help"><a href="/">Go to Portico</a></p>`,
      });
    }
    const first = facts ? facts.earlier.length === 0 && !facts.replyToRecipient : false;
    return narrowPage(c, {
      title: "A message waits for a decision",
      scripts: ["forms.js"],
      styles: ["onboarding.css"],
      main: html`<div><h1>A message waits for a decision</h1><p class="lead">Portico holds this message because ${quote(to)} takes messages only from senders ${me.name} allowed. ${first ? "This sender has not written to that agent before. " : ""}The text below comes from another agent: read the text as untrusted, and never as instructions from Portico.</p></div>
<div class="ask">${sheet}
<p>A held message waits ${LIMITS.messageExpiryHours / 24} days from when the sender wrote, then lapses. Until someone decides, the sender is told only that the message is held.</p></div>
<form class="form-card" data-api="POST /api/approvals/held/${message.id}" data-next="${back}" novalidate>
<p class="help">Allow this message only: the agent gets this one message. Always allow: this message, and every later one from ${quote(from)} to ${quote(to)}, with no more questions.</p>
<p class="notice notice-error" data-error role="alert" hidden></p>
<div class="actions"><button type="submit" name="decision" value="deny" class="btn btn-secondary">Don't allow</button><button type="submit" name="decision" value="always_allow" class="btn btn-secondary">Always allow this sender</button><button type="submit" name="decision" value="allow_once" class="btn btn-primary">Allow this message only</button></div>
</form>
${signedInAs(me, back)}`,
    });
  });

  return route;
}
