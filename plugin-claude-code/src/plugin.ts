import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PluginConfig } from "./config";
import { frameNotice, InboxDelivery, stopNotice } from "./delivery";
import type { HubClient, StreamRegistration } from "./hub-client";
import { INSTRUCTIONS } from "./instructions";
import { errorName, type Logger } from "./log";
import { PermissionRelayClient } from "./permissions";
import { type InboxSocket, SocketError } from "./socket";
import type { SessionWatcher } from "./status";
import { StreamClient, type StreamClientOptions, type StreamStop } from "./stream";
import { runTool, TOOLS } from "./tools";

export const SERVER_NAME = "agent-bridge";
export const SERVER_VERSION = "0.2.0";

/** Claude Code's permission prompt, sent to channels that declare claude/channel/permission. */
const PermissionRequestNotification = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    // Relayed even when a field is missing: the hub stores "" and echoes it back.
    description: z.string().default(""),
    input_preview: z.string().default(""),
  }),
});

export interface BridgePluginDeps {
  config: PluginConfig;
  client: HubClient;
  log: Logger;
  /** Claude Code's inbox socket, where tasks, results and notices are posted. */
  socket: Pick<InboxSocket, "post">;
  /** What the stream open registers in machine mode: the repo basename and the folder ID. Called before each open. */
  registration?: () => Promise<StreamRegistration>;
  /** Reports the session's status. Started by the first hello, told to resend on each later one, stopped with the plugin. */
  watcher?: Pick<SessionWatcher, "start" | "stop" | "resend"> | null;
  /** Test override for the pauses before retrying a post the socket didn't take. */
  deliveryRetryMs?: number[];
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

/**
 * The plugin's MCP server: the six bridge tools, delivery through Claude Code's inbox socket, and permission relay
 * (spec §9.5). The Claude Code channel is declared only for permission relay.
 */
export function createBridgePlugin(deps: BridgePluginDeps): BridgePlugin {
  const { config, client, log, socket } = deps;
  const watcher = deps.watcher ?? null;
  let watching = false;
  // Omitted rather than set to false when off: Claude Code before 2.1.234 treated false as declared.
  const capabilities = config.permissionRelay
    ? { tools: {}, experimental: { "claude/channel": {}, "claude/channel/permission": {} } }
    : { tools: {} };
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities, instructions: INSTRUCTIONS });
  addTools(server, client);

  const delivery = new InboxDelivery({
    client,
    socket,
    log,
    retryMs: deps.deliveryRetryMs,
    onFailure: () => stream.reconnect(),
  });
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

  const onHello = (data: unknown) => {
    const address = (data as { address?: unknown } | null)?.address;
    if (typeof address === "string") log("info", "session_registered", { address });
    if (!watcher) return;
    // Status reports start once the hub knows this session: in machine mode its key means nothing before the hello.
    if (watching) watcher.resend();
    else {
      watching = true;
      watcher.start();
    }
  };

  const stream: StreamClient = new StreamClient({
    open: async (signal) => client.openStream(signal, deps.registration ? await deps.registration() : undefined),
    onEvent: (event, data) => {
      if (event === "hello") onHello(data);
      else if (event === "nudge") void delivery.run();
      else if (event === "permission" && config.permissionRelay) permissions.answer(data);
    },
    onStop: (stop) => {
      // Delivery is over for good too: a retry armed by an earlier socket failure must not peek, post or ack now.
      delivery.stop();
      // So are status reports: the hub would refuse them, or they'd speak for the session that took over.
      watcher?.stop();
      if (config.permissionRelay) permissions.disable(stop.reason === "replaced" ? "replaced" : `rejected_${stop.status}`);
      socket
        .post(frameNotice(stopText(stop, config)))
        .catch((err) =>
          log("warn", "notice_failed", err instanceof SocketError ? { code: err.code } : { error: errorName(err) }),
        );
    },
    log,
    ...deps.stream,
  });
  // The stream waits for the MCP handshake: Claude Code drops channel notifications (permission verdicts) sent
  // before it, and the session should be up before anything is posted into its inbox.
  server.oninitialized = () => stream.start();

  return {
    server,
    start: () => stream.start(),
    stop: async () => {
      watcher?.stop();
      delivery.stop();
      await stream.stop();
    },
  };
}

/** In machine mode a 401 means the machine's token is gone, most likely removed on the hub page. */
function stopText(stop: StreamStop, config: PluginConfig): string {
  if (config.source === "machine" && stop.reason === "rejected" && stop.status === 401) {
    return (
      "Bridge delivery is off: the hub no longer accepts this machine's token (the machine may have been removed on " +
      "the hub page). Join again with a new join line, then restart this session."
    );
  }
  return stopNotice(stop);
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
