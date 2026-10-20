import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PluginConfig } from "./config";
import type { HubClient } from "./hub-client";
import type { Logger } from "./log";
import { runTool, TOOLS } from "./tools";

export const SERVER_NAME = "agent-bridge";
export const SERVER_VERSION = "0.1.0";

export interface BridgePluginDeps {
  config: PluginConfig;
  client: HubClient;
  log: Logger;
}

export interface BridgePlugin {
  server: Server;
  /** Opens the live stream (from Task 3). */
  start(): void;
  stop(): Promise<void>;
}

/** The plugin's MCP server: the six bridge tools, and the Claude Code channel (spec §9.5). */
export function createBridgePlugin(deps: BridgePluginDeps): BridgePlugin {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, experimental: { "claude/channel": {} } } },
  );
  addTools(server, deps.client);
  return { server, start: () => {}, stop: async () => {} };
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
