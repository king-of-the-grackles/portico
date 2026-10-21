import { Hono } from "hono";
import { BridgeError } from "../core/errors";
import { joinLine, type NetworkService } from "../core/network";
import type { Presence } from "../core/presence";
import type { BridgeConfig } from "../core/types";
import type { StreamHub } from "../ways-in/stream";
import { connectGuide } from "./connect";
import { sendPage } from "./layout";
import { assistantCreatedView, joinLineView, networkView } from "./network-views";

export interface NetworkRouteDeps {
  network: NetworkService;
  presence: Presence;
  streams: StreamHub;
  config: BridgeConfig;
}

const NETWORK_PATH = "/hub/network";

/**
 * /hub/network: add machines, connect assistants, and remove either. Mounted behind the page's session and
 * same-origin checks. Join lines and tokens appear only in the answer to the post that made them.
 */
export function networkRoutes(deps: NetworkRouteDeps): Hono {
  const { network, presence, streams, config } = deps;
  const app = new Hono();

  const view = (error: string | null = null) =>
    networkView({
      machines: network.listMachines(),
      assistants: network
        .listAssistants()
        .map((assistant) => ({ ...assistant, lastCheckIn: presence.lastCheckIn(assistant.name) })),
      configAgents: config.agents,
      error,
    });

  app.get("/", (c) => sendPage(c, 200, "Network", view(), { nav: true }));

  app.post("/join-codes", (c) => {
    const { code, expiresAt } = network.createJoinCode();
    return sendPage(c, 200, "Add a machine", joinLineView(joinLine(config.publicUrl, code), expiresAt), { nav: true });
  });

  app.post("/assistants", async (c) => {
    const form = await c.req.parseBody();
    const name = typeof form.name === "string" ? form.name.trim() : form.name;
    try {
      const { assistant, token } = network.createAssistant({ kind: form.kind, name, description: form.description });
      const guide = connectGuide(assistant.kind, { publicUrl: config.publicUrl, name: assistant.name, token });
      return sendPage(c, 200, "Assistant connected", assistantCreatedView(assistant, guide), { nav: true });
    } catch (err) {
      if (err instanceof BridgeError) return sendPage(c, 400, "Network", view(err.message), { nav: true });
      throw err;
    }
  });

  app.post("/assistants/:name/remove", (c) => {
    network.removeAssistant(c.req.param("name"));
    return c.redirect(NETWORK_PATH, 303);
  });

  app.post("/machines/:name/remove", (c) => {
    // The rows are gone first, so each closing stream's last-seen write finds nothing to update.
    const { sessionAddresses } = network.removeMachine(c.req.param("name"));
    for (const address of sessionAddresses) streams.close(address);
    return c.redirect(NETWORK_PATH, 303);
  });

  return app;
}
