import { Hono } from "hono";
import { consentWords } from "../core/consent-words";
import type { ConsentKind, ConsentRequest } from "../core/consents";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import type { Person } from "../core/types";
import { log } from "../log";
import { type PersonEnv, currentPerson } from "./context";
import { jsonObject } from "./session";

/** Something an agent of the person's asked that waits on the consent page. */
export interface ConsentCard {
  id: string;
  kind: ConsentKind;
  /** Portico's own heading and sentence for the request. */
  title: string;
  asks: string;
  /** The consent page. */
  link: string;
  /** The Portico the request is about, when it is about one. */
  workspaceId: string | null;
  expiresAt: string;
}

/** What waits for the person on the consent page, oldest first: only what the person's own agents asked. */
export function consentCards(core: Core, me: Person): ConsentCard[] {
  const card = (request: ConsentRequest): ConsentCard | null => {
    const view = core.consents.describe(me, request.id);
    if (!view) return null;
    const words = consentWords(view, me.name, (agent) => core.agents.nameFor(agent, me.id));
    return { id: request.id, kind: request.kind, title: words.title, asks: words.asks, link: `/c/${request.id}`, workspaceId: request.workspaceId, expiresAt: request.expiresAt };
  };
  return core.consents.waitingFor(me.id).map(card).filter((c): c is ConsentCard => c !== null);
}

/**
 * POST /api/consents/:id { decision, name?, handle?, agents? }: the person's answer on the consent page. A person with
 * no handle yet sends one along. Answers `{ status, next }`, where next is the same page, which then shows what
 * happened: for a join that was allowed (`status: "allowed"`), the code to give the computer or agent that asked. The
 * code itself is never in this answer, only on that page.
 *
 * GET /api/consents/:id → `{ status }`, for a person the page would show the request to: the code page asks, to show
 * that the join finished. Anyone else gets 404.
 */
export function consentRoutes(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  route.post("/:id", async (c) => {
    const me = currentPerson(c);
    const body = await jsonObject(c);
    const id = c.req.param("id");
    // The page's ticks arrive as `agents`: one ID, or a list. Absent, the asking agent alone comes in.
    const agents = body.agents === undefined ? undefined : Array.isArray(body.agents) ? body.agents : [body.agents];
    const { request, share } = core.consents.decide(me.id, id, { decision: body.decision, name: body.name, handle: body.handle, person: body.person, allow: body.allow, agents, mine: body.mine });
    log("info", "consent_answered", { request_id: request.id, kind: request.kind, status: request.status });
    // A share made for an address is emailed to that address now. Whatever happens to the email, the link works.
    if (share && share.email !== null) {
      const secret = core.shares.secretFor(me.id, share.id);
      if (secret) await core.mail.send(share, `${core.settings.publicUrl()}/share#${secret}`, core.people.require(me.id), core.workspaces.get(share.workspaceId)?.name ?? "a Portico");
    }
    return c.json({ status: request.status, next: `/c/${id}` });
  });

  route.get("/:id", (c) => {
    const view = core.consents.describe(currentPerson(c), c.req.param("id"));
    if (!view) throw new PorticoError("not_found", "No such request.");
    c.header("Cache-Control", "no-store");
    return c.json({ status: view.request.status });
  });

  return route;
}
