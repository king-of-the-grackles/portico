import type { EventsView } from "./events";
import { LIMITS } from "./limits";
import type { Agent, AgentKind } from "./types";
import type { WakeUrlView } from "./wake-urls";

/** How an agent learns that a message arrived. */
export type WakeHow = "pushed" | "wake_url" | "events" | "schedule" | "none";

export interface WakeState {
  /** Portico starts the agent the moment a message arrives. */
  on: boolean;
  how: WakeHow;
  /** A wake went through, or the agent is a session, which gets messages pushed. */
  tested: boolean;
  /** The agent said this app can't be woken and checks the inbox on a schedule: the minutes between checks. */
  scheduleMinutes: number | null;
  /** How the last wake failed ("http_401", "timeout"), while that is why wake-ups are off. */
  problem: string | null;
}

/** The least and most minutes between scheduled checks an agent can state. */
export const SCHEDULE_MINUTES = { min: 5, max: 24 * 60 } as const;

const failed = (status: string | null) => status !== null && status !== "ok";

/**
 * Where an agent's wake-ups stand. A wake URL or an event subscription counts as on until a wake fails; a failed one
 * counts as off, with the failure as the problem, so the agent and its person hear about the failure.
 */
export function wakeState(agent: Pick<Agent, "type" | "checkMinutes">, wake: WakeUrlView | null, events: EventsView | null): WakeState {
  if (agent.type === "session") return { on: true, how: "pushed", tested: true, scheduleMinutes: null, problem: null };
  const scheduleMinutes = agent.checkMinutes;
  if (wake && !failed(wake.lastStatus)) return { on: true, how: "wake_url", tested: wake.lastStatus === "ok", scheduleMinutes, problem: null };
  if (events && !failed(events.lastStatus)) return { on: true, how: "events", tested: events.lastStatus === "ok", scheduleMinutes, problem: null };
  const problem = wake?.lastStatus ?? events?.lastStatus ?? null;
  return { on: false, how: scheduleMinutes === null ? "none" : "schedule", tested: false, scheduleMinutes, problem };
}

/** Where an agent's wake-ups stand, read from what Portico holds for the agent. */
export function wakeStateOf(
  core: { wakeUrls: { view(agentId: string): WakeUrlView | null }; events: { view(agentId: string): EventsView | null } },
  agent: Pick<Agent, "id" | "type" | "checkMinutes">,
): WakeState {
  return wakeState(agent, core.wakeUrls.view(agent.id), core.events.view(agent.id));
}

/** What each app's own automations are called, where that helps an agent find them. */
const APP_HINT: Partial<Record<AgentKind, string>> = {
  "grok-bot": "In Grok Bot, a routine with a webhook trigger does this: the trigger gives the URL and the key.",
  dots: "ChatGPT and dots, connected over MCP, watch Portico's message.received event. Connected over HTTP, use a webhook trigger when ChatGPT offers one, or else the scheduled check.",
  muse: "In Muse, an automation with a webhook trigger does this.",
  "claude-duet": "In Claude Duet, a routine or scheduled task with a webhook trigger does this.",
};

/**
 * The last step of joining, in the words for this agent's connection: an app with a token calls the HTTP API, a
 * connector calls the tools. Written so the agent can do every part without its person.
 */
export function wakeSteps(o: { publicUrl: string; kind: AgentKind; type: "app" | "connector" }): string[] {
  const check = o.type === "connector" ? "call check_inbox" : `call GET ${o.publicUrl}/api/agent/inbox (or check_inbox over MCP)`;
  const register =
    o.type === "connector"
      ? "call set_wake_url with the trigger's url and key"
      : `call PUT ${o.publicUrl}/api/agent/wake with the agent's token and {"url": "<trigger URL>", "key": "<trigger key>"} (or set_wake_url over MCP)`;
  const schedule =
    o.type === "connector"
      ? `call set_inbox_schedule with minutes: ${LIMITS.appCheckMinutes}`
      : `call PUT ${o.publicUrl}/api/agent/wake with {"schedule_minutes": ${LIMITS.appCheckMinutes}} (or set_inbox_schedule over MCP)`;
  const hint = APP_HINT[o.kind];
  return [
    ...(o.type === "connector"
      ? [`If this app can watch MCP events, watch Portico's message.received event, with the instruction to ${check} and handle each message. Portico then starts this app the moment a message arrives, and this step is done.`]
      : []),
    `${o.type === "connector" ? "Otherwise create" : "Create"} a routine, automation or task in this app that a webhook can start, with the instruction to ${check} and handle each message as the frame around the message says. Then ${register}. Portico sends one test wake at once, and the answer says whether the test got through: "ok" means wake-ups are on. Never post the key in a chat.${hint ? ` ${hint}` : ""}`,
    `Only when this app has no webhook trigger and can't watch events: create a scheduled task that does the same check every ${LIMITS.appCheckMinutes} minutes, then ${schedule}, so Portico and the person know. Tell the person that messages can arrive up to ${LIMITS.appCheckMinutes} minutes late, and name what the app is missing.`,
    "Tell the person how messages now arrive: right away, or on the schedule.",
  ];
}

/** What a failed wake means, for the agent that has to fix it. */
function problemLine(problem: string): string {
  if (problem === "secret_unreadable") return "Portico can't read the stored key any more: register the wake URL and key again.";
  if (/^http_40[13]$/.test(problem)) return `The last wake was refused (${problem}): the key is wrong or was replaced. Register the trigger's URL and key again.`;
  return `The last wake failed (${problem}): check that the trigger still exists, then register the URL and key again.`;
}

/**
 * What Portico says to an agent whose wake-ups aren't on: in the answer that finishes joining, and with every inbox
 * check and agent list until they are. Null once wake-ups are on, or once the agent said it checks on a schedule.
 */
export function wakeNote(state: WakeState, o: { publicUrl: string; kind: AgentKind; type: "app" | "connector" }): string | null {
  if (state.on) return null;
  if (state.problem !== null) return `Wake-ups are off for this agent, so new messages wait for the next check. ${problemLine(state.problem)} The steps are at ${o.publicUrl}/join#wake.`;
  if (state.how === "schedule") return null;
  const steps = wakeSteps(o)
    .map((step, i) => `${i + 1}. ${step}`)
    .join(" ");
  return (
    "Joining isn't finished: wake-ups aren't on for this agent yet, so new messages wait until this agent next checks the inbox. " +
    `Do this now, without waiting to be asked and without help from the person. ${steps} The same steps are at ${o.publicUrl}/join#wake.`
  );
}
