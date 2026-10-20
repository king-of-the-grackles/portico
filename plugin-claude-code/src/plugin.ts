import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PluginConfig } from "./config";
import { InboxDelivery, type SendChannel, stopNotice } from "./delivery";
import type { HubClient } from "./hub-client";
import { INSTRUCTIONS } from "./instructions";
import { errorName, type Logger } from "./log";
import { PermissionRelayClient } from "./permissions";
import { StreamClient, type StreamClientOptions } from "./stream";
import { runTool, TOOLS } from "./tools";

export const SERVER_NAME = "agent-bridge";
export const SERVER_VERSION = "0.1.0";

/** Claude Code's permission prompt, sent to channels that declare claude/channel/permission. */
const PermissionRequestNotification = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

export interface BridgePluginDeps {
  config: PluginConfig;
  client: HubClient;
  log: Logger;
  /** Test overrides for the live stream. */
  stream?: Partial<Pick<StreamClientOptions, "silenceMs" | "initialBackoffMs" | "maxBackoffMs" | "random">>;
  /** Test override for the pauses between permission relay attempts. */
  relayRetryMs?: number[];
}

export interface BridgePlugin {
  server: Server;
  /** Opens the live stream. Runs by itself once the MCP handshake completes. */
  start(): void;
  stop(): Promise<void>;
}

/** The plugin's MCP server: the six bridge tools, the Claude Code channel, and permission relay (spec §9.5). */
export function createBridgePlugin(deps: BridgePluginDeps): BridgePlugin {
  const { config, client, log } = deps;
  const experimental: Record<string, object> = { "claude/channel": {} };
  // Omitted rather than set to false when off: Claude Code before 2.1.234 treated false as declared.
  if (config.permissionRelay) experimental["claude/channel/permission"] = {};
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, experimental }, instructions: INSTRUCTIONS },
  );
  addTools(server, client);

  const send: SendChannel = (content, meta) =>
    server.notification({ method: "notifications/claude/channel", params: { content, meta } });
  const delivery = new InboxDelivery({ client, send, log, onFailure: () => stream.reconnect() });
  const permissions = new PermissionRelayClient({
    client,
    log,
    retryMs: deps.relayRetryMs,
    sendVerdict: (requestId, behavior) =>
      server.notification({
        method: "notifications/claude/channel/permission",
        params: { request_id: requestId, behavior },
      }),
  });
  if (config.permissionRelay) {
    server.setNotificationHandler(PermissionRequestNotification, ({ params }) => {
      void permissions.relay(params);
    });
  }

  const stream: StreamClient = new StreamClient({
    open: (signal) => client.openStream(signal),
    onEvent: (event, data) => {
      if (event === "nudge") void delivery.run();
      else if (event === "permission" && config.permissionRelay) permissions.answer(data);
    },
    onStop: (stop) => {
      send(stopNotice(stop), { kind: "notice" }).catch((err) => log("warn", "notice_failed", { error: errorName(err) }));
    },
    log,
    ...deps.stream,
  });
  // Claude Code drops channel messages sent before the handshake completes, so the stream waits for it.
  server.oninitialized = () => stream.start();

  return { server, start: () => stream.start(), stop: () => stream.stop() };
}

/** For sessions not on the bridge (BRIDGE_URL and BRIDGE_TOKEN both unset): no tools, no channel. */
export function createIdleServer(): Server {
  return new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: {} });
}

function addTools(server: Server, client: HubClient): void {
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    runTool(client, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>),
  );
}
