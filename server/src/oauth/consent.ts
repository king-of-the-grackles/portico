import type { Context } from "hono";
import { html } from "hono/html";
import type { AgentKind, Person } from "../core/types";
import { CSP, HOMEMARK, narrowPage, sendPage, utcClock } from "../web/layout";
import type { OAuthClient } from "./store";

/** The kinds a connector can be, as the consent page offers them. */
export const CONNECTOR_CHOICES: { kind: AgentKind; label: string }[] = [
  { kind: "dots", label: "dots" },
  { kind: "claude-duet", label: "Claude Duet" },
  { kind: "other", label: "Other" },
];

/** What the consent form carries back unchanged, so the POST checks the same request again. */
export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  challenge: string;
  resource: string | null;
}

export interface ConsentOptions {
  person: Person;
  client: OAuthClient;
  request: AuthorizeRequest;
  name: string;
  kind: AgentKind;
  requestedAt: Date;
  cancelUrl: string;
}

function initial(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}


/**
 * Where a form on this page may send the browser: Portico itself, and the client's redirect URI, so the plain form
 * post (without JavaScript) can follow its redirect back to the client.
 */
function consentCsp(redirectUri: string): string {
  const target = new URL(redirectUri);
  const source = target.protocol === "https:" || target.protocol === "http:" ? target.origin : target.protocol;
  return CSP.replace("form-action 'self'", `form-action 'self' ${source}`);
}

/** Where approval sends the code: the redirect URI's host, which the client's chosen name can't fake. */
function redirectHost(redirectUri: string): string {
  const url = new URL(redirectUri);
  return url.protocol === "https:" || url.protocol === "http:" ? url.host : url.protocol.replace(/:$/, "");
}

/** The D2 board: "<client> wants to add an agent to Portico", a Name, a kind, then Cancel and Add agent. */
export async function consentPage(c: Context, o: ConsentOptions): Promise<Response> {
  const hidden = (name: string, value: string | null) =>
    value === null ? "" : html`<input type="hidden" name="${name}" value="${value}">`;
  const body = html`<header class="top">${HOMEMARK}<span class="me"><span class="mono" aria-hidden="true">${initial(o.person.name)}</span>${o.person.name}</span></header>
<main class="narrow">
  <div class="consent">
    <div class="consent-head">
      <span class="logo logo-lg logo-tile" aria-hidden="true">${initial(o.client.name)}</span>
      <div>
        <h1>${o.client.name} wants to add an agent to Portico</h1>
        <p class="tnum consent-when">Requested at <time datetime="${o.requestedAt.toISOString()}" data-local-time>${utcClock(o.requestedAt)}</time>.</p>
        <p class="consent-where">Approving sends access to <strong>${redirectHost(o.request.redirectUri)}</strong>. Any app can use the name ${o.client.name}: approve only when ${redirectHost(o.request.redirectUri)} belongs to the app being added.</p>
      </div>
    </div>
    <form method="post" action="/oauth/authorize" data-api="POST /oauth/authorize">
      ${hidden("client_id", o.request.clientId)}${hidden("redirect_uri", o.request.redirectUri)}${hidden("state", o.request.state)}
      ${hidden("code_challenge", o.request.challenge)}${hidden("code_challenge_method", "S256")}${hidden("resource", o.request.resource)}
      <label for="c-name" class="lbl">Name</label>
      <input id="c-name" name="name" class="field" value="${o.name}" aria-describedby="c-name-help" required maxlength="40" autocomplete="off" autocapitalize="none" spellcheck="false">
      <span id="c-name-help" class="help">Other agents use this name when sending messages.</span>
      <fieldset class="kinds">
        <legend class="lbl">Kind</legend>
        ${CONNECTOR_CHOICES.map(
          (choice) =>
            html`<label class="kind"><input type="radio" name="kind" value="${choice.kind}"${choice.kind === o.kind ? html` checked` : ""}>${choice.label}</label>`,
        )}
      </fieldset>
      <p class="note">Once approved, this agent can message every agent on Portico and get replies.</p>
      <p class="notice notice-error" data-error role="alert" hidden></p>
      <span class="actions"><a class="btn btn-link" href="${o.cancelUrl}">Cancel</a><button type="submit" class="btn btn-primary">Add agent</button></span>
    </form>
  </div>
</main>`;
  const res = await sendPage(c, {
    title: "Add an agent",
    body,
    scripts: ["forms.js", "local-time.js"],
    styles: ["onboarding.css"],
  });
  res.headers.set("Content-Security-Policy", consentCsp(o.request.redirectUri));
  return res;
}

/** A request Portico can't send back to the client: an unknown client or a redirect URI it never registered. */
export function badRequestPage(c: Context, reason: string): Response | Promise<Response> {
  return narrowPage(c, {
    title: "Connection not added",
    status: 400,
    main: html`<div><h1>Connection not added</h1><p class="lead">${reason} Add the server address in the app again to start over.</p></div>`,
  });
}

/** A claimed invite still waiting for the owner can't add agents yet. */
export function waitingPage(c: Context): Response | Promise<Response> {
  return narrowPage(c, {
    title: "Waiting for approval",
    status: 403,
    main: html`<div><h1>Waiting for approval</h1><p class="lead">Agents can be added once the owner approves this account.</p></div>`,
  });
}
