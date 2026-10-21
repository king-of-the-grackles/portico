import { html } from "hono/html";
import { AGENT_NAME } from "../config";
import { MAX_NAME_LENGTH } from "../core/network";
import { type AgentConfig, type Assistant, ASSISTANT_KINDS, type Machine } from "../core/types";
import { type ConnectGuide, KIND_LABELS, kindLabel } from "./connect";
import { formatTime, type Html } from "./layout";

const NETWORK_PATH = "/hub/network";
const BACK = html`<p><a href="${NETWORK_PATH}">Back to Network</a></p>`;

const removePath = (group: "machines" | "assistants", name: string) =>
  `${NETWORK_PATH}/${group}/${encodeURIComponent(name)}/remove`;

/** The server's name rule, for the browser to check before posting (`pattern` is anchored on its own). */
const NAME_PATTERN = AGENT_NAME.source.slice(1, -1);

/** What was typed into the Connect an assistant form, kept when the post is refused. */
export interface AssistantForm {
  kind: string;
  name: string;
  description: string;
}

const EMPTY_FORM: AssistantForm = { kind: "", name: "", description: "" };

/** Remove opens a confirm step first, so one stray tap removes nothing. Works without scripts. */
const confirmRemove = (path: string, name: string, consequence: string): Html =>
  html`<details class="confirm"><summary>Remove</summary><p class="meta">${consequence}</p><form method="post" action="${path}"><button type="submit" class="danger">Remove ${name}</button></form></details>`;

/** Enough rows to show most of a block without scrolling. */
const rowsFor = (text: string) => Math.min(10, Math.max(2, Math.ceil(text.length / 70) + text.split("\n").length - 1));

const pasteBox = (id: string, text: string): Html =>
  html`<textarea id="${id}" readonly class="paste" rows="${rowsFor(text)}">${text}</textarea>`;

function machinesSection(machines: (Machine & { sessions: number })[]): Html {
  return html`<h2>Machines</h2>
<form method="post" action="${NETWORK_PATH}/join-codes" class="spaced"><button type="submit" class="primary">Add a machine</button></form>
${
  machines.length === 0
    ? html`<p class="meta">No machines yet.</p>`
    : html`<table><thead><tr><th>Machine</th><th>Joined</th><th>Last seen</th><th>Sessions</th><th></th></tr></thead><tbody>${machines.map(
        (machine) =>
          html`<tr><td>${machine.name}</td><td>${formatTime(machine.createdAt)}</td><td>${
            machine.lastSeenAt ? formatTime(machine.lastSeenAt) : "Not yet"
          }</td><td>${machine.sessions}</td><td>${confirmRemove(
            removePath("machines", machine.name),
            machine.name,
            `The sessions on ${machine.name} leave the network, and adding ${machine.name} back needs a new join line.`,
          )}</td></tr>`,
      )}</tbody></table>`
}`;
}

function assistantsSection(assistants: (Assistant & { lastCheckIn: string | null })[], form: AssistantForm): Html {
  return html`<h2>Assistants</h2>
${
  assistants.length === 0
    ? html`<p class="meta">No assistants yet.</p>`
    : html`<table><thead><tr><th>Assistant</th><th>Kind</th><th>Added</th><th>Last checked in</th><th></th></tr></thead><tbody>${assistants.map(
        (assistant) =>
          html`<tr><td>${assistant.name}</td><td>${kindLabel(assistant.kind)}</td><td>${formatTime(assistant.createdAt)}</td><td>${
            assistant.lastCheckIn ? formatTime(assistant.lastCheckIn) : "Not since the last restart"
          }</td><td>${confirmRemove(
            removePath("assistants", assistant.name),
            assistant.name,
            `The token for ${assistant.name} stops working at once.`,
          )}</td></tr>`,
      )}</tbody></table>`
}
<h2>Connect an assistant</h2>
<form method="post" action="${NETWORK_PATH}/assistants" class="card">
<div class="actions fields">
<div><label for="kind">Kind</label><select id="kind" name="kind">${ASSISTANT_KINDS.map(
    (kind) => html`<option value="${kind}"${kind === form.kind ? " selected" : ""}>${KIND_LABELS[kind]}</option>`,
  )}</select></div>
<div class="grow"><label for="name">Name</label><input id="name" name="name" class="full" value="${form.name}" required pattern="${NAME_PATTERN}" maxlength="${MAX_NAME_LENGTH}" autocomplete="off"></div>
</div>
<p class="meta">Lowercase letters, digits and hyphens. Tasks and messages are addressed to this name.</p>
<label for="description">Description (optional)</label><input id="description" name="description" class="full" value="${form.description}" maxlength="500">
<div class="actions"><button type="submit" class="primary">Connect</button></div>
</form>`;
}

function configSection(agents: AgentConfig[]): Html {
  return html`<h2>From bridge.yaml</h2>
<p class="meta">Set in bridge.yaml. Changes need a hub restart.</p>
<table><thead><tr><th>Agent</th><th>Kind</th><th>Delivery</th><th>Description</th></tr></thead><tbody>${agents.map(
    (agent) => html`<tr><td>${agent.name}</td><td>${agent.kind}</td><td>${agent.delivery}</td><td>${agent.description}</td></tr>`,
  )}</tbody></table>`;
}

/** The Network page: joined machines, connected assistants and the bridge.yaml agents. */
export function networkView(input: {
  machines: (Machine & { sessions: number })[];
  assistants: (Assistant & { lastCheckIn: string | null })[];
  configAgents: AgentConfig[];
  error?: string | null;
  /** What was typed, when a post was refused. */
  form?: AssistantForm | null;
}): Html {
  return html`<h1>Network</h1>
${input.error ? html`<div class="card error">${input.error}</div>` : ""}
${machinesSection(input.machines)}
${assistantsSection(input.assistants, input.form ?? EMPTY_FORM)}
${configSection(input.configAgents)}`;
}

/** The one time a join line is shown. */
export function joinLineView(line: string, expiresAt: string): Html {
  return html`<h1>Add a machine</h1>
<p>Send this line to the new machine: paste the line into Claude Code there, or open the link for the steps. One use, expires ${formatTime(expiresAt)}.</p>
<label for="join-line">Join line</label>
${pasteBox("join-line", line)}
<p class="meta">The line is shown once.</p>
${BACK}`;
}

/** The one time an assistant's token is shown, inside the blocks that connect the assistant. */
export function assistantCreatedView(assistant: Assistant, guide: ConnectGuide): Html {
  return html`<h1>Assistant connected: ${assistant.name}</h1>
<div class="card"><strong>The token is shown once. Copy the blocks below now: leaving this page loses the token.</strong></div>
<p>${guide.intro}</p>
${guide.blocks.map((block, i) => html`<label for="block-${i}">${block.label}</label>${pasteBox(`block-${i}`, block.text)}`)}
${BACK}`;
}
