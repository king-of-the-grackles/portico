import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PluginConfig } from "./config";
import { InboxDelivery, type SendChannel, stopNotice } from "./delivery";
import type { HubClient } from "./hub-client";
import { INSTRUCTIONS } from "./instructions";
import { errorName, type Logger } from "./log";
import { StreamClient, type StreamClientOptions } from "./stream";
import { runTool, TOOLS } from "./tools";

export const SERVER_NAME = "agent-bridge";
export const SERVER_VERSION = "0.1.0";

export interface BridgePluginDeps {
  config: PluginConfig;
  client: HubClient;
  log: Logger;
  /** Test overrides for the live stream. */
  stream?: Partial<Pick<StreamClientOptions, "silenceMs" | "initialBackoffMs" | "maxBackoffMs" | "random">>;
}

export interface BridgePlugin {
  server: Server;
  /** Opens the live stream. Runs by itself once the MCP handshake completes. */
  start(): void;
  stop(): Promise<void>;
}

/** The plugin's MCP server: the six bridge tools, and the Claude Code channel (spec §9.5). */
export function createBridgePlugin(deps: BridgePluginDeps): BridgePlugin {
  const { client, log } = deps;
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, experimental: { "claude/channel": {} } }, instructions: INSTRUCTIONS },
  );
  addTools(server, client);

  const send: SendChannel = (content, meta) =>
    server.notification({ method: "notifications/claude/channel", params: { content, meta } });
  const delivery = new InboxDelivery({ client, send, log, onFailure: () => stream.reconnect() });
  const stream: StreamClient = new StreamClient({
    open: (signal) => client.openStream(signal),
    onEvent: (event) => {
      if (event === "nudge") void delivery.run();
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
