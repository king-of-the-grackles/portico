import { frameMessage, frameResult, frameTask } from "../core/framing";
import type { PermissionRequest } from "../core/permissions";
import type { BridgeEvent, Delivery, DirectoryEntry, LiveStatus, Message, Task, TaskStatus } from "../core/types";

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

export function resultDeliveryView(task: Task): TaskView & { framed_message: string } {
  return { ...taskView(task), framed_message: frameResult(task) };
}

export function eventView(event: BridgeEvent) {
  return { id: event.id, agent: event.agent, name: event.name, details: event.details, created_at: event.createdAt };
}

export interface MessageView {
  id: string;
  from_agent: string;
  to_agent: string;
  text: string;
  reply_to: string | null;
  created_at: string;
  expires_at: string;
  delivered_at: string | null;
}

export function messageView(m: Message): MessageView {
  return {
    id: m.id,
    from_agent: m.fromAgent,
    to_agent: m.toAgent,
    text: m.text,
    reply_to: m.replyTo,
    created_at: m.createdAt,
    expires_at: m.expiresAt,
    delivered_at: m.deliveredAt,
  };
}

export function messageDeliveryView(m: Message): MessageView & { framed_message: string } {
  return { ...messageView(m), framed_message: frameMessage(m) };
}

export interface DirectoryEntryView {
  /** The name to address the member by: the short form when unique. */
  name: string;
  address: string;
  kind: string;
  description: string;
  delivery: Delivery;
  machine: string | null;
  repo: string | null;
  branch: string | null;
  status: LiveStatus | null;
  doing: string | null;
  last_seen: string | null;
}

export function directoryEntryView(e: DirectoryEntry): DirectoryEntryView {
  return {
    name: e.display,
    address: e.address,
    kind: e.kind,
    description: e.description,
    delivery: e.delivery,
    machine: e.machine,
    repo: e.repo,
    branch: e.branch,
    status: e.status,
    doing: e.doing,
    last_seen: e.lastSeen,
  };
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
