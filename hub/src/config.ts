import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { unknownPlaceholders } from "./core/templates";
import type { BridgeConfig, Limits, NtfyConfig } from "./core/types";

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

/** Not 8787 (Claude Code's fakechat channel demo) or 8788 (the Channels webhook example). */
export const DEFAULT_PORT = 8790;

export const AGENT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MIN_TOKEN_LENGTH = 24;
const MIN_SECRET_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 12;
const NTFY_TOPIC = /^[A-Za-z0-9_-]{20,64}$/;

const positiveInt = z.number().int().positive();

// Strict objects everywhere: an unknown key (usually a typo) is an error, not silently ignored.
const FileSchema = z.strictObject({
  agents: z
    .array(
      z.strictObject({
        name: z.string(),
        description: z.string(),
        delivery: z.enum(["push", "pull"]),
      }),
    )
    .min(1, "at least one agent is required"),
  rules: z
    .array(z.strictObject({ from: z.string(), to: z.string(), action: z.enum(["allow", "ask", "block"]) }))
    .default([]),
  triggers: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        when: z.strictObject({ agent: z.string(), event: z.string().min(1) }),
        send: z.strictObject({ to: z.string(), instructions: z.string().min(1) }),
      }),
    )
    .default([]),
  limits: z
    .strictObject({
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

function parseNtfy(env: Env, problems: string[]): NtfyConfig | null {
  const topic = env.BRIDGE_NTFY_TOPIC?.trim();
  if (!topic) return null;
  if (!NTFY_TOPIC.test(topic)) {
    problems.push(
      "BRIDGE_NTFY_TOPIC must be 20–64 letters, digits, - or _, because anyone who knows a public topic can read it",
    );
  }
  const url = (env.BRIDGE_NTFY_URL?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      problems.push(`BRIDGE_NTFY_URL "${url}" is not a valid http(s) URL`);
    } else {
      const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      // BRIDGE_NTFY_TOKEN would travel in clear over plain http.
      if (parsed.protocol !== "https:" && !local) {
        problems.push("BRIDGE_NTFY_URL must start with https:// (http:// is allowed only for localhost)");
      }
    }
  } catch {
    problems.push(`BRIDGE_NTFY_URL "${url}" is not a valid http(s) URL`);
  }
  return { url, topic, token: env.BRIDGE_NTFY_TOKEN?.trim() || null };
}

function requireSecret(env: Env, name: string, minLength: number, problems: string[]): string {
  const value = env[name]?.trim() ?? "";
  if (!value) problems.push(`missing ${name}`);
  else if (value.length < minLength) problems.push(`${name} must be at least ${minLength} characters`);
  return value;
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

  const port = env.PORT ? Number(env.PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT "${env.PORT}" is not a valid port`);

  const signingSecret = requireSecret(env, "BRIDGE_SIGNING_SECRET", MIN_SECRET_LENGTH, problems);
  const adminPassword = requireSecret(env, "BRIDGE_ADMIN_PASSWORD", MIN_PASSWORD_LENGTH, problems);
  const ntfy = parseNtfy(env, problems);
  if (signingSecret && (Object.values(tokens).includes(signingSecret) || signingSecret === adminPassword)) {
    problems.push("BRIDGE_SIGNING_SECRET must differ from every agent token and from BRIDGE_ADMIN_PASSWORD");
  }

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
    signingSecret,
    adminPassword,
    ntfy,
  };
}

export async function loadConfig(env: Env = process.env): Promise<BridgeConfig> {
  const path = env.BRIDGE_CONFIG?.trim() || "./bridge.yaml";
  const file = Bun.file(path);
  if (!(await file.exists())) throw new ConfigError([`config file not found: ${path}`]);
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    throw new ConfigError([
      `config file ${path} can't be read (${code}). The hub runs as an unprivileged user in the Docker image; make the file readable to that user.`,
    ]);
  }
  return parseConfig(text, env);
}
