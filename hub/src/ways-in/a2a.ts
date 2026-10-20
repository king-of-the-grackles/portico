import { Hono } from "hono";
import type { Context } from "hono";
import { BridgeError } from "../core/errors";
import type { BridgeService } from "../core/service";
import type { AgentConfig, BridgeConfig, Task, TaskStatus } from "../core/types";
import { log } from "../log";
import type { AgentResolver } from "./auth";
import { type JsonRpcId, type JsonRpcRequest, parseRequest, rpcError, rpcResult } from "./jsonrpc";

const A2A_PROTOCOL_VERSION = "0.3.0";

const A2A_STATE: Record<TaskStatus, string> = {
  waiting_approval: "submitted",
  queued: "submitted",
  working: "working",
  done: "completed",
  failed: "failed",
  denied: "rejected",
  expired: "canceled",
};

const TASK_NOT_FOUND = -32001;
const UNSUPPORTED_OPERATION = -32004;
const UNSUPPORTED_METHODS = new Set([
  "tasks/cancel",
  "message/stream",
  "tasks/resubscribe",
  "tasks/pushNotificationConfig/set",
  "tasks/pushNotificationConfig/get",
  "tasks/pushNotificationConfig/list",
  "tasks/pushNotificationConfig/delete",
  "agent/getAuthenticatedExtendedCard",
]);

export function agentCard(config: BridgeConfig, agent: AgentConfig): Record<string, unknown> {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: agent.name,
    description: agent.description,
    url: `${config.publicUrl}/a2a/${agent.name}`,
    preferredTransport: "JSONRPC",
    version: "0.1.0",
    provider: { organization: "agent-bridge", url: config.publicUrl },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer", description: "The sending agent's bridge token." },
    },
    security: [{ bearer: [] }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "handoff",
        name: `Hand a task to ${agent.name}`,
        description: agent.description,
        tags: ["handoff", "agent-bridge"],
        examples: [],
      },
    ],
  };
}

function statusMessage(task: Task, text: string) {
  return {
    kind: "message",
    role: "agent",
    messageId: `${task.id}-status`,
    taskId: task.id,
    contextId: task.id,
    parts: [{ kind: "text", text }],
  };
}

export function toA2ATask(task: Task): Record<string, unknown> {
  const status: Record<string, unknown> = { state: A2A_STATE[task.status], timestamp: task.updatedAt };
  const note = task.status === "waiting_approval" ? "Waiting for the user's approval." : task.reason;
  if (note && task.status !== "done") status.message = statusMessage(task, note);
  const artifacts =
    task.status === "done" && task.result !== null
      ? [{ artifactId: `${task.id}-result`, name: "result", parts: [{ kind: "text", text: task.result }] }]
      : [];
  return {
    kind: "task",
    id: task.id,
    contextId: task.id,
    status,
    artifacts,
    metadata: { from_agent: task.fromAgent, to_agent: task.toAgent, bridge_status: task.status },
  };
}

function textFromParts(parts: unknown[]): string {
  return parts
    .filter(
      (part): part is { kind: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { kind?: unknown }).kind === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n\n");
}

function handle(service: BridgeService, caller: string, target: string, req: JsonRpcRequest) {
  const id: JsonRpcId = req.id ?? null;
  const params = (req.params ?? {}) as Record<string, unknown>;
  try {
    if (req.method === "message/send") {
      const message = params.message as { parts?: unknown; taskId?: unknown } | undefined;
      if (!message || !Array.isArray(message.parts)) return rpcError(id, -32602, "params.message with parts is required.");
      if (message.taskId) {
        return rpcError(id, UNSUPPORTED_OPERATION, "Follow-up messages on an existing task aren't supported; send a new message.");
      }
      const text = textFromParts(message.parts);
      if (!text.trim()) return rpcError(id, -32602, "The message has no text parts.");
      return rpcResult(id, toA2ATask(service.sendTask(caller, { to: target, instructions: text })));
    }
    if (req.method === "tasks/get") {
      if (typeof params.id !== "string") return rpcError(id, -32602, "params.id is required.");
      let task: Task;
      try {
        task = service.getTask(caller, params.id, { expectedReceiver: target });
      } catch (err) {
        if (err instanceof BridgeError && (err.code === "not_found" || err.code === "not_allowed")) {
          return rpcError(id, TASK_NOT_FOUND, "Task not found.");
        }
        throw err;
      }
      return rpcResult(id, toA2ATask(task));
    }
    if (UNSUPPORTED_METHODS.has(req.method)) {
      return rpcError(id, UNSUPPORTED_OPERATION, `${req.method} isn't supported by this bridge.`);
    }
    return rpcError(id, -32601, `Method not found: ${req.method}`);
  } catch (err) {
    if (err instanceof BridgeError) {
      return rpcError(id, err.code === "rate_limited" ? -32000 : -32602, `${err.code}: ${err.message}`);
    }
    throw err;
  }
}

export function a2aRoutes(service: BridgeService, config: BridgeConfig, resolveAgent: AgentResolver): Hono {
  const a2a = new Hono();
  const findAgent = (name: string) => config.agents.find((agent) => agent.name === name);

  const cardHandler = (c: Context) => {
    const agent = findAgent(c.req.param("agent") ?? "");
    if (!agent) return c.json({ error: "not_found", message: "No such agent." }, 404);
    return c.json(agentCard(config, agent));
  };
  a2a.get("/:agent/.well-known/agent-card.json", cardHandler);
  a2a.get("/:agent/.well-known/agent.json", cardHandler);

  a2a.post("/:agent", async (c) => {
    const target = findAgent(c.req.param("agent"));
    if (!target) return c.json({ error: "not_found", message: "No such agent." }, 404);
    const caller = resolveAgent(c.req.header("authorization"));
    if (!caller) {
      return c.json({ error: "unauthorized", message: "Missing or invalid bearer token." }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"));
    }
    const req = parseRequest(body);
    if (!req) return c.json(rpcError(null, -32600, "Invalid request"));
    log("info", "a2a_request", {
      agent: caller,
      target: target.name,
      method: req.method,
      a2a_version: c.req.header("a2a-version") ?? null,
      user_agent: c.req.header("user-agent") ?? null,
    });
    try {
      return c.json(handle(service, caller, target.name, req));
    } catch (err) {
      log("error", "a2a_internal_error", { error: err instanceof Error ? err.message : String(err) });
      return c.json(rpcError(req.id ?? null, -32603, "Internal error"));
    }
  });

  return a2a;
}
