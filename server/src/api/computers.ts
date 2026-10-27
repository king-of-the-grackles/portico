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
  return { id: computer.id, name: computer.name, lastSeen: computer.lastSeenAt, sessions: sessions.map(views.agent) };
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
    if (!computer) throw new PorticoError("not_found", "No such computer.");
    if (computer.ownerId !== me.id) throw new PorticoError("not_allowed", "Only the person who added this computer can remove the computer.");
    core.agents.forget(core.computers.remove(computer.id));
    return c.body(null, 204);
  });

  return route;
}
