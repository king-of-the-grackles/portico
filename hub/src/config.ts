import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { unknownPlaceholders } from "./core/templates";
import type { BridgeConfig, Limits } from "./core/types";

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

export const DEFAULT_LIMITS: Limits = {
  taskExpiryHours: 24,
  tasksPerHourPerAgent: 30,
  eventsPerHourPerAgent: 60,
  maxTextKb: 20,
  maxChainLength: 1,
  historyDays: 30,
};

const AGENT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MIN_TOKEN_LENGTH = 24;

const positiveInt = z.number().int().positive();

const FileSchema = z.object({
  agents: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        delivery: z.enum(["push", "pull"]),
      }),
    )
    .min(1, "at least one agent is required"),
  rules: z
    .array(z.object({ from: z.string(), to: z.string(), action: z.enum(["allow", "ask", "block"]) }))
    .default([]),
  triggers: z
    .array(
      z.object({
        name: z.string().min(1),
        when: z.object({ agent: z.string(), event: z.string().min(1) }),
        send: z.object({ to: z.string(), instructions: z.string().min(1) }),
      }),
    )
    .default([]),
  limits: z
    .object({
      task_expiry_hours: positiveInt.optional(),
      tasks_per_hour_per_agent: positiveInt.optional(),
      events_per_hour_per_agent: positiveInt.optional(),
      max_text_kb: positiveInt.optional(),
      max_chain_length: positiveInt.optional(),
      history_days: positiveInt.optional(),
    })
    .default({}),
});

type Env = Record<string, string | undefined>;

export function tokenEnvName(agent: string): string {
  return `BRIDGE_TOKEN_${agent.toUpperCase().replace(/-/g, "_")}`;
}

export function parseConfig(yamlText: string, env: Env): BridgeConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new ConfigError([`bridge.yaml is not valid YAML: ${(err as Error).message}`]);
  }

  const parsed = FileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  const file = parsed.data;
  const problems: string[] = [];

  const names = new Set<string>();
  for (const agent of file.agents) {
    if (!AGENT_NAME.test(agent.name)) {
      problems.push(`agent name "${agent.name}" must be lowercase letters, digits and hyphens`);
    }
    if (names.has(agent.name)) problems.push(`agent name "${agent.name}" is used more than once`);
    names.add(agent.name);
    if (agent.description.trim() === "") problems.push(`agent "${agent.name}" needs a description`);
  }
  const isAgentOrWildcard = (name: string) => name === "*" || names.has(name);

  for (const rule of file.rules) {
    if (!isAgentOrWildcard(rule.from)) problems.push(`rule from "${rule.from}" is not a configured agent or "*"`);
    if (!isAgentOrWildcard(rule.to)) problems.push(`rule to "${rule.to}" is not a configured agent or "*"`);
  }

  const triggerNames = new Set<string>();
  for (const trigger of file.triggers) {
    const label = `trigger "${trigger.name}"`;
    if (triggerNames.has(trigger.name)) problems.push(`${label} is defined more than once`);
    triggerNames.add(trigger.name);
    if (!names.has(trigger.when.agent)) {
      problems.push(`${label}: when.agent "${trigger.when.agent}" is not a configured agent`);
    }
    if (!names.has(trigger.send.to)) problems.push(`${label}: send.to "${trigger.send.to}" is not a configured agent`);
    if (trigger.when.agent === trigger.send.to) problems.push(`${label}: an agent can't send a task to itself`);
    for (const placeholder of unknownPlaceholders(trigger.send.instructions)) {
      problems.push(`${label}: unknown placeholder {{${placeholder}}}`);
    }
  }

  const tokens: Record<string, string> = {};
  const tokenOwner = new Map<string, string>();
  for (const name of names) {
    const varName = tokenEnvName(name);
    const token = env[varName]?.trim();
    if (!token) {
      problems.push(`missing ${varName} for agent "${name}"`);
      continue;
    }
    if (token.length < MIN_TOKEN_LENGTH) problems.push(`${varName} must be at least ${MIN_TOKEN_LENGTH} characters`);
    const owner = tokenOwner.get(token);
    if (owner) problems.push(`agents "${owner}" and "${name}" share the same token`);
    tokenOwner.set(token, name);
    tokens[name] = token;
  }

  const publicUrl = (env.BRIDGE_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!publicUrl) {
    problems.push("missing BRIDGE_PUBLIC_URL");
  } else {
    try {
      const url = new URL(publicUrl);
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
        problems.push("BRIDGE_PUBLIC_URL must start with https:// (http:// is allowed only for localhost)");
      }
    } catch {
      problems.push(`BRIDGE_PUBLIC_URL "${publicUrl}" is not a valid URL`);
    }
  }

  const port = env.PORT ? Number(env.PORT) : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT "${env.PORT}" is not a valid port`);

  if (problems.length > 0) throw new ConfigError(problems);

  const limits = file.limits;
  return {
    agents: file.agents,
    rules: file.rules,
    triggers: file.triggers,
    limits: {
      taskExpiryHours: limits.task_expiry_hours ?? DEFAULT_LIMITS.taskExpiryHours,
      tasksPerHourPerAgent: limits.tasks_per_hour_per_agent ?? DEFAULT_LIMITS.tasksPerHourPerAgent,
      eventsPerHourPerAgent: limits.events_per_hour_per_agent ?? DEFAULT_LIMITS.eventsPerHourPerAgent,
      maxTextKb: limits.max_text_kb ?? DEFAULT_LIMITS.maxTextKb,
      maxChainLength: limits.max_chain_length ?? DEFAULT_LIMITS.maxChainLength,
      historyDays: limits.history_days ?? DEFAULT_LIMITS.historyDays,
    },
    publicUrl,
    tokens,
    dbPath: env.BRIDGE_DB_PATH?.trim() || "./bridge.db",
    port,
  };
}

export async function loadConfig(env: Env = process.env): Promise<BridgeConfig> {
  const path = env.BRIDGE_CONFIG?.trim() || "./bridge.yaml";
  const file = Bun.file(path);
  if (!(await file.exists())) throw new ConfigError([`config file not found: ${path}`]);
  return parseConfig(await file.text(), env);
}
