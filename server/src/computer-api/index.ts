import { Hono } from "hono";
import type { Context } from "hono";
import { bearer } from "../agent-api/auth";
import { jsonBodyLimit } from "../agent-api/limits";
import { handleError, readJson } from "../agent-api/rest";
import { requireSetupDone } from "../api";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import { defang } from "../core/framing";
import type { Computer } from "../core/types";
import { clientIp } from "../client-ip";
import { limitedRedeem, WindowLimiter } from "./limiter";

const FOLDER_ID = /^[a-f0-9]{64}$/;
const MAX_FOLDER_NAME = 100;

/** A folder's name as sent: cleaned like a session's repo, and only its last path segment. */
function folderName(raw: unknown): string {
  if (raw !== undefined && typeof raw !== "string") throw new PorticoError("bad_request", "name must be a string.");
  const cleaned = typeof raw === "string" ? defang(raw).replace(/\s+/g, " ").trim() : "";
  const segment = cleaned.split(/[\\/]/).filter(Boolean).pop()?.trim() ?? "";
  return (segment || "folder").slice(0, MAX_FOLDER_NAME);
}

/** The computer behind the request's bearer token, or a 401. */
function currentComputer(core: Core, c: Context): Computer {
  const token = bearer(c.req.header("authorization"));
  const computer = token?.startsWith("pc_") ? core.computers.byToken(token) : null;
  if (!computer) throw new PorticoError("unauthorized", "Missing or invalid computer token.");
  return computer;
}

/**
 * /api/computer: what a computer does with its own token. POST /join redeems a join line, POST /lines uses another
 * line on a computer that already joined, DELETE / leaves Portico, PUT /folders/:folderId sets a folder's switch.
 * snake_case JSON, like the agent API.
 */
export function computerApi(core: Core): Hono {
  const route = new Hono();
  const limiter = new WindowLimiter(core.now);

  route.use("*", requireSetupDone(core));
  route.use("*", jsonBodyLimit());

  // The join line is the credential: no token yet. Ten unknown lines in 15 minutes from one address close the route to that address for a while.
  route.post("/join", async (c) => {
    const body = (await readJson(c)) as { token?: unknown; computer?: unknown } | null;
    const { computer, token, joinLine } = limitedRedeem(limiter, clientIp(c), () =>
      core.computers.redeem(body?.token, body?.computer),
    );
    return c.json({ computer: { id: computer.id, name: computer.name }, token, kind: joinLine.kind }, 201);
  });

  // A join line used on a computer that already joined, e.g. Codex on a computer where Claude Code joined first.
  route.post("/lines", async (c) => {
    const computer = currentComputer(core, c);
    const body = (await readJson(c)) as { token?: unknown } | null;
    const joinLine = limitedRedeem(limiter, clientIp(c), () => core.computers.attach(computer, body?.token));
    return c.json({ computer: { id: computer.id, name: computer.name }, kind: joinLine.kind });
  });

  // `portico leave`: the computer, its sessions and its folders go, and the sessions' streams close.
  route.delete("/", (c) => {
    const computer = currentComputer(core, c);
    core.agents.forget(core.computers.remove(computer.id));
    return c.body(null, 204);
  });

  // /portico:off and /portico:on: new sessions in the folder join, or stay off with `folder_off`.
  route.put("/folders/:folderId", async (c) => {
    const computer = currentComputer(core, c);
    const folderId = c.req.param("folderId");
    if (!FOLDER_ID.test(folderId)) throw new PorticoError("bad_request", "The folder ID must be 64 lowercase hex characters.");
    const body = (await readJson(c)) as { joins?: unknown; name?: unknown } | null;
    if (typeof body?.joins !== "boolean") throw new PorticoError("bad_request", "joins must be true or false.");
    const name = folderName(body.name);
    core.computers.setFolder(computer.id, folderId, name, body.joins);
    return c.json({ folder: { folder_id: folderId, name, joins: body.joins } });
  });

  route.onError(handleError);
  return route;
}
