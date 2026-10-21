import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { addressOf } from "../core/directory";
import { hashSecret } from "../core/tokens";
import type { BridgeConfig, Machine } from "../core/types";
import type { NetworkStore } from "../network-store";

/** Who a bearer token (plus, for a machine token, a session key) speaks for. */
export type Principal = { type: "member"; address: string } | { type: "machine"; machine: Machine };
export type PrincipalResolver = (authorization: string | undefined, sessionKey?: string) => Principal | null;
/** The calling member's address, or null. A machine token without a registered session key is no member. */
export type AgentResolver = (authorization: string | undefined, sessionKey?: string) => string | null;

/** A machine's last_seen_at is written at most this often. */
const TOUCH_INTERVAL_MS = 60_000;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * bridge.yaml env tokens first, compared in constant time as in v1. Then minted tokens, looked up by hash on every
 * request, so a removed assistant's or machine's token fails at once.
 */
export function makeResolvers(
  config: BridgeConfig,
  network: NetworkStore,
  opts: { now?: () => Date } = {},
): { principal: PrincipalResolver; agent: AgentResolver } {
  const now = opts.now ?? (() => new Date());
  // Compare fixed-length digests in constant time, checking every token so timing doesn't reveal which matched.
  const entries = Object.entries(config.tokens).map(([agent, token]) => ({ agent, digest: sha256(token) }));
  const configNames = new Set(config.agents.map((agent) => agent.name));
  const touchedAt = new Map<string, number>();

  const touch = (machine: Machine) => {
    const at = now().getTime();
    const last = touchedAt.get(machine.id);
    if (last !== undefined && at - last < TOUCH_INTERVAL_MS) return;
    touchedAt.set(machine.id, at);
    network.touchMachine(machine.id, new Date(at).toISOString());
  };

  const principal: PrincipalResolver = (authorization, sessionKey) => {
    const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "");
    if (!match) return null;
    const token = match[1]!.trim();
    const presented = sha256(token);
    let found: string | null = null;
    for (const entry of entries) {
      if (timingSafeEqual(presented, entry.digest)) found = entry.agent;
    }
    // The session header only means something with a machine token.
    if (found) return { type: "member", address: found };

    const hash = hashSecret(token);
    const assistant = network.assistantByTokenHash(hash);
    // An assistant sharing a bridge.yaml agent's name is shadowed: its token doesn't resolve.
    if (assistant) return configNames.has(assistant.name) ? null : { type: "member", address: assistant.name };

    const machine = network.machineByTokenHash(hash);
    if (!machine) return null;
    touch(machine);
    if (!sessionKey) return { type: "machine", machine };
    const session = network.sessionByKey(machine.id, sessionKey);
    return session ? { type: "member", address: addressOf(session.name, machine.name) } : null;
  };

  const agent: AgentResolver = (authorization, sessionKey) => {
    const resolved = principal(authorization, sessionKey);
    return resolved?.type === "member" ? resolved.address : null;
  };

  return { principal, agent };
}

export type AgentEnv = { Variables: { agent: string } };

/** Answers 401 without a valid bearer token; otherwise sets c.var.agent to the calling member's address. */
export function requireAgent(resolveAgent: AgentResolver): MiddlewareHandler<AgentEnv> {
  return async (c, next) => {
    const agent = resolveAgent(c.req.header("authorization"), c.req.header("x-bridge-session"));
    if (!agent) {
      return c.json({ error: "unauthorized", message: "Missing or invalid bearer token." }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }
    c.set("agent", agent);
    await next();
  };
}
