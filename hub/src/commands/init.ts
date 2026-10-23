import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { AGENT_NAME, DEFAULT_PORT, tokenEnvName } from "../config";
import type { CliIo } from "./io";
import { STARTER_YAML } from "./starter";

export class InitError extends Error {
  override name = "InitError";
}

export interface Secrets {
  publicUrl: string;
  signingSecret: string;
  adminPassword: string;
  /** Agent name → token. */
  tokens: Record<string, string>;
}

export function generateSecrets(agents: string[]): Secrets {
  return {
    publicUrl: `http://localhost:${DEFAULT_PORT}`,
    signingSecret: randomBytes(32).toString("hex"),
    adminPassword: randomBytes(18).toString("base64url"),
    tokens: Object.fromEntries(agents.map((name) => [name, randomBytes(24).toString("hex")])),
  };
}

/** The agent names in a portico.yaml, so init can make a token for each. */
export function agentNames(yamlText: string): string[] {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch {
    throw new InitError("portico.yaml is not valid YAML. Fix the file, or move the file aside to start from the example.");
  }
  const agents = (raw as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new InitError("portico.yaml lists no agents. Add at least one under agents:, or move the file aside to start from the example.");
  }
  const names = agents.map((agent) => (agent as { name?: unknown } | null)?.name);
  for (const name of names) {
    if (typeof name !== "string" || !AGENT_NAME.test(name)) {
      throw new InitError(`Agent name ${JSON.stringify(name ?? null)} must be lowercase letters, digits and hyphens.`);
    }
  }
  return [...new Set(names as string[])];
}

function secretLines(secrets: Secrets): [string, string][] {
  return [
    ["PORTICO_PUBLIC_URL", secrets.publicUrl],
    ["PORTICO_SIGNING_SECRET", secrets.signingSecret],
    ["PORTICO_ADMIN_PASSWORD", secrets.adminPassword],
    ...Object.entries(secrets.tokens).map(([name, token]): [string, string] => [tokenEnvName(name), token]),
  ];
}

function render(secrets: Secrets, shell: boolean): string {
  const header = [
    "# Written by portico init. Every secret the hub uses is in this file: keep it private and out of git.",
    "# Change PORTICO_PUBLIC_URL to the hub's public https address before agents connect.",
  ];
  const lines = secretLines(secrets).map(([key, value]) => (shell ? `export ${key}='${value}'` : `${key}=${value}`));
  return `${[...header, ...lines].join("\n")}\n`;
}

export async function initCommand(args: string[], io: CliIo): Promise<number> {
  const unknown = args.find((arg) => arg !== "--shell");
  if (unknown !== undefined) {
    io.err(`Unknown option: ${unknown}. Usage: portico init [--shell]`);
    return 1;
  }
  const shell = args.includes("--shell");
  const secretsName = shell ? "portico-secrets.sh" : ".env";
  const secretsPath = resolve(io.cwd, secretsName);
  const configPath = resolve(io.cwd, io.env.PORTICO_CONFIG?.trim() || "portico.yaml");
  const configName = basename(configPath);

  if (existsSync(secretsPath)) {
    io.err(`${secretsName} already exists. Nothing was written. Move ${secretsName} aside to generate new secrets.`);
    return 1;
  }

  const configExists = existsSync(configPath);
  let names: string[];
  try {
    names = agentNames(configExists ? readFileSync(configPath, "utf8") : STARTER_YAML);
  } catch (err) {
    if (err instanceof InitError) {
      io.err(`${err.message} Nothing was written.`);
      return 1;
    }
    throw err;
  }

  if (!configExists) writeFileSync(configPath, STARTER_YAML, { flag: "wx" });
  writeFileSync(secretsPath, render(generateSecrets(names), shell), { mode: 0o600, flag: "wx" });

  io.out(
    configExists
      ? `Using ${configName} (${names.length} agents: ${names.join(", ")}).`
      : `Wrote ${configName}: a starter config with ${names.length} agents (${names.join(", ")}).`,
  );
  io.out(`Wrote ${secretsName} (mode 600): a signing secret, an admin password and a token for each agent.`);
  io.out("");
  io.out("Next:");
  const steps = [
    ...(configExists ? [] : [`Edit ${configName}: agents, rules and triggers.`]),
    `Set PORTICO_PUBLIC_URL in ${secretsName} to the hub's public https address.`,
    ...(shell ? ["Run: source portico-secrets.sh (the hub loads .env automatically, but not this file)."] : []),
    "Run: portico doctor, then portico serve.",
  ];
  steps.forEach((step, i) => io.out(`  ${i + 1}. ${step}`));
  return 0;
}
