import { Hono } from "hono";
import { readJson } from "../agent-api/rest";
import type { SignInRequest } from "../core/computers";
import type { Core } from "../core/core";
import type { Person } from "../core/types";
import { type PersonEnv, currentPerson } from "./context";
import { personViews, type SignInView } from "./views";

export function signInView(request: SignInRequest): SignInView {
  return {
    id: request.id,
    kind: request.kind,
    name: request.name,
    code: request.code,
    status: request.status,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
}

/**
 * POST /api/approvals/sign-ins/:id: approve (with a name) or deny an app agent's sign-in request. Only the person who
 * made the join line decides. Answers `{ signIn, agent }`, with the new agent on approval.
 */
export function signInRoutes(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  route.post("/:id", async (c) => {
    const me = currentPerson(c);
    const body = (await readJson(c)) as { decision?: unknown; name?: unknown } | null;
    const { request, agent } = core.computers.decideSignIn(core.agents, me.id, c.req.param("id"), body?.decision, body?.name);
    return c.json({ signIn: signInView(request), agent: agent ? personViews(core, me).agent(agent) : null });
  });

  return route;
}

/** Pending sign-in requests from join lines the person made, oldest first. */
export function pendingSignIns(core: Core, person: Person): SignInView[] {
  return core.computers.pendingSignIns(person.id).map(signInView);
}
