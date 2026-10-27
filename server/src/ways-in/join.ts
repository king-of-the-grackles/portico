import { Hono } from "hono";
import { z } from "zod";
import { PorticoError } from "../core/errors";
import type { NetworkService } from "../core/network";
import type { PorticoConfig } from "../core/types";
import { joinView } from "../page/join-view";
import { sendPage } from "../page/layout";
import { LoginLimiter } from "../page/session";
import { jsonBodyLimit } from "./limits";
import { handleError, readJson } from "./rest";

const JoinBody = z.object({ code: z.string(), machine: z.string().optional() });

/**
 * Joining needs no token: the one-time code is the credential. `POST /api/join` redeems a code for a machine and its
 * token; `GET /join` is the public page that explains the steps. Ten failed redemptions in 15 minutes lock the route.
 */
export function joinRoutes(deps: { network: NetworkService; config: PorticoConfig; now: () => Date }): Hono {
  const { network, config } = deps;
  const limiter = new LoginLimiter(deps.now);
  const app = new Hono();

  app.post("/api/join", jsonBodyLimit(config), async (c) => {
    const body = JoinBody.parse(await readJson(c));
    // Nothing awaits from this check to recordFailure (bun:sqlite is synchronous), so a burst of concurrent requests
    // can't all pass the check before the first failure is recorded.
    if (limiter.blocked()) throw new PorticoError("rate_limited", "Too many failed join attempts. Try again in 15 minutes.");
    try {
      const { machine, token } = network.redeemJoinCode(body.code, body.machine ?? "machine");
      return c.json({ machine: { name: machine.name }, token }, 201);
    } catch (err) {
      if (err instanceof PorticoError && (err.code === "not_found" || err.code === "bad_request")) limiter.recordFailure();
      throw err;
    }
  });

  app.get("/join", (c) =>
    sendPage(c, 200, "Join a machine", joinView({ publicUrl: config.publicUrl, pluginSource: config.pluginSource })),
  );

  app.onError(handleError);
  return app;
}
