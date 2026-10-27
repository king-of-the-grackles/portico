import type { Context, MiddlewareHandler } from "hono";
import type { Agents } from "../core/agents";
import type { Computers } from "../core/computers";
import { PorticoError } from "../core/errors";
import type { Agent, Computer } from "../core/types";

/** Who a bearer token (plus, for a computer token, a session key) speaks for. */
export type Principal = { type: "agent"; agent: Agent } | { type: "computer"; computer: Computer };

export interface Resolver {
  /** A computer token without a session key stays a computer, so it can register a new session. */
  principal(authorization: string | undefined, sessionKey?: string): Principal | null;
  agent(authorization: string | undefined, sessionKey?: string): Agent | null;
}

export function bearer(authorization: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization?.trim() ?? "");
  return match ? match[1]! : null;
}

/**
 * Tokens are looked up by hash on every request, so a removed agent's or computer's token fails at once. An app's
 * token and a connector's access token name an agent; a computer token plus a registered session key names a session.
 */
export function makeResolver(agents: Agents, computers: Computers): Resolver {
  const principal: Resolver["principal"] = (authorization, sessionKey) => {
    const token = bearer(authorization);
    if (!token) return null;
    if (token.startsWith("pc_")) {
      const computer = computers.byToken(token);
      if (!computer) return null;
      if (!sessionKey) return { type: "computer", computer };
      const session = agents.sessionByKey(computer.id, sessionKey);
      return session ? { type: "agent", agent: session } : null;
    }
    const agent = agents.byToken(token);
    return agent ? { type: "agent", agent } : null;
  };
  return {
    principal,
    agent: (authorization, sessionKey) => {
      const found = principal(authorization, sessionKey);
      return found?.type === "agent" ? found.agent : null;
    },
  };
}

export type AgentEnv = { Variables: { agent: Agent } };

/** For a computer token whose session key isn't registered: before the first hello, or after a refused registration. */
export const NOT_REGISTERED =
  "This session isn't registered with Portico yet. The session registers when its live stream connects; check the plugin log.";

/** The 401 every agent route answers, with where a connector finds how to sign in. */
export function unauthorized(c: Context, message = "Missing or invalid bearer token."): Response {
  return c.json({ error: "unauthorized", message }, 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", c.req.url).href}"`,
  });
}

/** Answers 401 without a valid bearer token; otherwise sets c.var.agent. */
export function requireAgent(resolver: Resolver): MiddlewareHandler<AgentEnv> {
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    const agent = resolver.agent(authorization, c.req.header("x-portico-session"));
    if (!agent) {
      const computerToken = resolver.principal(authorization)?.type === "computer";
      return unauthorized(c, computerToken ? NOT_REGISTERED : undefined);
    }
    c.set("agent", agent);
    await next();
  };
}

/** Sessions only: deliveries, status reports and pop-up answers. */
export function requireSession(agent: Agent, what: string): void {
  if (agent.type !== "session") throw new PorticoError("not_allowed", `Only sessions on a computer ${what}.`);
}
