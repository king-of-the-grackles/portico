import { html } from "hono/html";
import type { PermissionRequest } from "../core/permissions";
import { type AgentConfig, type BridgeEvent, TASK_STATUSES, type Task, type TaskStatus } from "../core/types";
import { formatTime, type Html, STATUS_WORDS } from "./layout";

const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const taskPath = (task: Task) => `/hub/tasks/${encodeURIComponent(task.id)}`;

export function loginView(error: string | null, next = "/hub"): Html {
  return html`<h1>Sign in</h1>
${error ? html`<div class="card error">${error}</div>` : ""}
<form method="post" action="/hub/login" class="card">
${next !== "/hub" ? html`<input type="hidden" name="next" value="${next}">` : ""}
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<div class="actions"><button type="submit" class="primary">Sign in</button></div>
</form>`;
}

function decisionForms(task: Task): Html {
  return html`<div class="actions">
<form method="post" action="${taskPath(task)}/approve"><button type="submit" class="primary">Approve</button></form>
<form method="post" action="${taskPath(task)}/deny" class="grow"><label for="note-${task.id}">Note for the sender (optional)</label><textarea id="note-${task.id}" name="note"></textarea><button type="submit" class="danger">Deny</button></form>
</div>`;
}

function chainBlock(chain: Task[]): Html {
  return chain.length > 0
    ? html`<h2>Chain</h2><p class="meta">Each task below was being worked on when the next one was sent.</p>${chain.map(
        (link) =>
          html`<div class="card"><div class="meta">${link.fromAgent} → ${link.toAgent} · ${STATUS_WORDS[link.status]} · <a href="${taskPath(link)}">details</a></div><pre>${clipText(link.instructions, 300)}</pre></div>`,
      )}`
    : html``;
}

function waitingTask({ task, chain }: { task: Task; chain: Task[] }): Html {
  return html`<div class="card"><div class="meta">${task.fromAgent} → ${task.toAgent}${task.chainLength > 1 ? " · chained" : ""}${
    task.triggerName ? html` · trigger ${task.triggerName}` : ""
  } · expires ${formatTime(task.expiresAt)} · <a href="${taskPath(task)}">details</a></div>
<pre>${task.instructions}</pre>${chainBlock(chain)}${decisionForms(task)}</div>`;
}

function waitingPermission(request: PermissionRequest): Html {
  const base = `/hub/permissions/${encodeURIComponent(request.agent)}/${encodeURIComponent(request.requestId)}`;
  return html`<div class="card"><div class="meta">${request.agent} wants to use <strong>${request.toolName}</strong> · expires ${formatTime(request.expiresAt)}</div>
${request.description ? html`<p>${request.description}</p>` : ""}${request.inputPreview ? html`<pre>${request.inputPreview}</pre>` : ""}
<div class="actions"><form method="post" action="${base}/allow"><button type="submit" class="primary">Allow</button></form><form method="post" action="${base}/deny"><button type="submit" class="danger">Deny</button></form></div></div>`;
}

export interface AgentRow {
  agent: AgentConfig;
  lastCheckIn: string | null;
  connected: boolean;
}

export function homeView(waiting: { task: Task; chain: Task[] }[], permissions: PermissionRequest[], agents: AgentRow[], moreWaiting = false): Html {
  return html`<h1>Waiting</h1>
${waiting.length === 0 && permissions.length === 0 ? html`<p class="meta">Nothing waiting.</p>` : ""}
${permissions.length > 0 ? html`<h2>Permission prompts</h2>${permissions.map(waitingPermission)}` : ""}
${waiting.length > 0 ? html`<h2>Tasks waiting for approval</h2>${waiting.map(waitingTask)}${moreWaiting ? html`<p class="meta">Showing the oldest ${waiting.length} tasks. More are waiting.</p>` : ""}` : ""}
<h2>Agents</h2>
<table><thead><tr><th>Agent</th><th>Delivery</th><th>Last checked in</th><th>Description</th></tr></thead><tbody>
${agents.map(
  ({ agent, lastCheckIn, connected }) =>
    html`<tr><td>${agent.name}</td><td>${agent.delivery}${
      agent.delivery === "push" ? html` · ${connected ? "connected" : "not connected"}` : ""
    }</td><td>${lastCheckIn ? formatTime(lastCheckIn) : "Not since the last restart"}</td><td>${agent.description}</td></tr>`,
)}
</tbody></table>`;
}

function historyRow(task: Task): Html {
  return html`<tr><td>${formatTime(task.createdAt)}</td><td>${task.fromAgent} → ${task.toAgent}</td><td><span class="status">${STATUS_WORDS[task.status]}</span></td><td><a href="${taskPath(task)}">${clipText(task.instructions, 80)}</a></td></tr>`;
}

export function historyView(
  tasks: Task[],
  events: BridgeEvent[],
  filter: { agent?: string; status?: TaskStatus },
  agentNames: string[],
): Html {
  return html`<h1>History</h1>
<form method="get" action="/hub/history" class="actions">
<div><label for="agent">Agent</label><select id="agent" name="agent"><option value="">All agents</option>${agentNames.map(
    (name) => html`<option value="${name}"${name === filter.agent ? " selected" : ""}>${name}</option>`,
  )}</select></div>
<div><label for="status">Status</label><select id="status" name="status"><option value="">All statuses</option>${TASK_STATUSES.map(
    (status) => html`<option value="${status}"${status === filter.status ? " selected" : ""}>${STATUS_WORDS[status]}</option>`,
  )}</select></div>
<button type="submit">Filter</button></form>
<h2>Tasks</h2>
${
  tasks.length === 0
    ? html`<p class="meta">No tasks.</p>`
    : html`<table><thead><tr><th>Created</th><th>From → to</th><th>Status</th><th>Instructions</th></tr></thead><tbody>${tasks.map(historyRow)}</tbody></table>`
}
<h2>Events</h2>
${
  events.length === 0
    ? html`<p class="meta">No events.</p>`
    : html`<table><thead><tr><th>Reported</th><th>Agent</th><th>Event</th><th>Details</th></tr></thead><tbody>${events.map(
        (event) =>
          html`<tr><td>${formatTime(event.createdAt)}</td><td>${event.agent}</td><td>${event.name}</td><td>${clipText(event.details, 80)}</td></tr>`,
      )}</tbody></table>`
}`;
}

export function taskDetailView(task: Task, chain: Task[]): Html {
  return html`<h1>Task</h1>
<div class="card"><div class="meta">${task.fromAgent} → ${task.toAgent} · <span class="status">${STATUS_WORDS[task.status]}</span> · created ${formatTime(task.createdAt)} · expires ${formatTime(task.expiresAt)}${
    task.triggerName ? html` · trigger ${task.triggerName}` : ""
  }</div>
<h2>Instructions</h2><pre>${task.instructions}</pre>
${task.result !== null ? html`<h2>Result</h2><pre>${task.result}</pre>` : ""}
${task.reason !== null ? html`<h2>Reason</h2><p>${task.reason}</p>` : ""}
${task.status === "waiting_approval" ? decisionForms(task) : ""}</div>
${chainBlock(chain)}`;
}
