export type Delivery = "push" | "pull";
export type RuleAction = "allow" | "ask" | "block";
export type TaskStatus =
  | "waiting_approval"
  | "queued"
  | "working"
  | "done"
  | "failed"
  | "denied"
  | "expired";

export const FINAL_STATUSES: readonly TaskStatus[] = ["done", "failed", "denied", "expired"];

export function isFinal(status: TaskStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

export interface AgentConfig {
  name: string;
  description: string;
  delivery: Delivery;
}

export interface RuleConfig {
  from: string;
  to: string;
  action: RuleAction;
}

export interface TriggerConfig {
  name: string;
  when: { agent: string; event: string };
  send: { to: string; instructions: string };
}

export interface Limits {
  taskExpiryHours: number;
  tasksPerHourPerAgent: number;
  eventsPerHourPerAgent: number;
  maxTextKb: number;
  maxChainLength: number;
  historyDays: number;
}

export interface BridgeConfig {
  agents: AgentConfig[];
  rules: RuleConfig[];
  triggers: TriggerConfig[];
  limits: Limits;
  /** Public https base URL, without a trailing slash. */
  publicUrl: string;
  /** Agent name -> token. */
  tokens: Record<string, string>;
  dbPath: string;
  port: number;
}

export interface Task {
  id: string;
  fromAgent: string;
  toAgent: string;
  instructions: string;
  status: TaskStatus;
  result: string | null;
  reason: string | null;
  parentTaskId: string | null;
  chainLength: number;
  eventId: string | null;
  triggerName: string | null;
  senderNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface BridgeEvent {
  id: string;
  agent: string;
  name: string;
  details: string;
  createdAt: string;
}

/** Things the outside world may need to act on. Plan 2 turns these into nudges and pushes. */
export type Notice =
  | { kind: "queued"; task: Task }
  | { kind: "approval_needed"; task: Task }
  | { kind: "result_ready"; task: Task };
