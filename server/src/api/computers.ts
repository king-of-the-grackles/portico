import { Hono } from "hono";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import type { Computer, Person } from "../core/types";
import { type PersonEnv, currentPerson } from "./context";
import { type ComputerView, personViews } from "./views";

/** A computer with every session on it, by name, as Settings › Computers shows them. */
export function computerView(core: Core, me: Person, computer: Computer): ComputerView {
  const views = personViews(core, me);
  const sessions = core.agents.all().filter((agent) => agent.computerId === computer.id);
  return { id: computer.id, name: computer.name, lastSeen: computer.lastSeenAt, sessions: sessions.map(views.agent), alwaysAllowed: !computer.unproven };
}

/** /api/computers: the signed-in person's computers, and removing one, which signs out every session there. */
export function computerRoutes(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  route.get("/", (c) => {
    const me = currentPerson(c);
    return c.json({ computers: core.computers.list(me.id).map((computer) => computerView(core, me, computer)) });
  });

  route.delete("/:id", (c) => {
    const me = currentPerson(c);
    const computer = core.computers.get(c.req.param("id"));
    // Someone else's computer answers exactly as one that doesn't exist: an ID tells nothing.
    if (!computer || computer.ownerId !== me.id) throw new PorticoError("not_found", "No such computer.");
    core.agents.forget(core.computers.remove(computer.id));
    return c.body(null, 204);
  });

  // "Always allow" for a computer, from Settings: every session there, now and later, is taken as the person's own, and
  // what waits only because a session there is new goes through.
  route.put("/:id/always-allow", (c) => {
    const me = currentPerson(c);
    const computer = core.computers.get(c.req.param("id"));
    if (!computer || computer.ownerId !== me.id) throw new PorticoError("not_found", "No such computer.");
    core.approvals.alwaysAllowComputer(me.id, computer.id);
    return c.json({ computer: computerView(core, me, core.computers.get(computer.id)!) });
  });

  // Takes back "Always allow" for a computer: its sessions are asked about again, once for each agent they write to.
  route.delete("/:id/always-allow", (c) => {
    const me = currentPerson(c);
    const computer = core.computers.get(c.req.param("id"));
    if (!computer || computer.ownerId !== me.id) throw new PorticoError("not_found", "No such computer.");
    core.agents.computerProven(computer.id, false);
    return c.json({ computer: computerView(core, me, core.computers.get(computer.id)!) });
  });

  return route;
}
