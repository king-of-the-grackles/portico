import { frameTask } from "../core/framing";
import type { PermissionRequest } from "../core/permissions";
import type { AgentConfig, BridgeEvent, Task, TaskStatus } from "../core/types";

export interface TaskView {
  id: string;
  from_agent: string;
  to_agent: string;
  instructions: string;
  status: TaskStatus;
  result: string | null;
  reason: string | null;
  parent_task_id: string | null;
  chain_length: number;
  event_id: string | null;
  trigger_name: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export function taskView(task: Task): TaskView {
  return {
    id: task.id,
    from_agent: task.fromAgent,
    to_agent: task.toAgent,
    instructions: task.instructions,
    status: task.status,
    result: task.result,
    reason: task.reason,
    parent_task_id: task.parentTaskId,
    chain_length: task.chainLength,
    event_id: task.eventId,
    trigger_name: task.triggerName,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    expires_at: task.expiresAt,
  };
}

export function inboxTaskView(task: Task): TaskView & { framed_message: string } {
  return { ...taskView(task), framed_message: frameTask(task) };
}

export function eventView(event: BridgeEvent) {
  return { id: event.id, agent: event.agent, name: event.name, details: event.details, created_at: event.createdAt };
}

export function agentView(agent: AgentConfig) {
  return { name: agent.name, description: agent.description, delivery: agent.delivery };
}

export function permissionView(request: PermissionRequest) {
  return {
    agent: request.agent,
    request_id: request.requestId,
    tool_name: request.toolName,
    description: request.description,
    input_preview: request.inputPreview,
    created_at: request.createdAt,
    expires_at: request.expiresAt,
    answer: request.answer,
  };
}
