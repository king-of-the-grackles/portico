import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { BridgeConfig } from "../core/types";

export type AgentResolver = (authorization: string | undefined) => string | null;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function makeAgentResolver(config: BridgeConfig): AgentResolver {
  // Compare fixed-length digests in constant time, checking every token so timing doesn't reveal which matched.
  const entries = Object.entries(config.tokens).map(([agent, token]) => ({ agent, digest: sha256(token) }));
  return (authorization) => {
    const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "");
    if (!match) return null;
    const presented = sha256(match[1]!.trim());
    let found: string | null = null;
    for (const entry of entries) {
      if (timingSafeEqual(presented, entry.digest)) found = entry.agent;
    }
    return found;
  };
}

export type AgentEnv = { Variables: { agent: string } };

/** Answers 401 without a valid bearer token; otherwise sets c.var.agent to the calling agent. */
export function requireAgent(resolveAgent: AgentResolver): MiddlewareHandler<AgentEnv> {
  return async (c, next) => {
    const agent = resolveAgent(c.req.header("authorization"));
    if (!agent) {
      return c.json({ error: "unauthorized", message: "Missing or invalid bearer token." }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }
    c.set("agent", agent);
    await next();
  };
}
