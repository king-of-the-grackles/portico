import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ApprovalPanels } from "./approvals";
import type { PluginConfig } from "./config";
import { frameNotice, InboxDelivery, stopNotice } from "./delivery";
import type { HubClient, StreamRegistration } from "./hub-client";
import { INSTRUCTIONS } from "./instructions";
import { errorName, type Logger } from "./log";
import type { DialogRunner } from "./popup";
import { type InboxSocket, SocketError } from "./socket";
import type { SessionWatcher } from "./status";
import { StreamClient, type StreamClientOptions, type StreamStop } from "./stream";
import { runTool, TOOLS } from "./tools";

export const SERVER_NAME = "agent-bridge";
export const SERVER_VERSION = "0.3.0";

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
  /** Shows approval pop-ups. Machine mode only: null or absent, the session never declares pop-ups. */
  popup?: DialogRunner | null;
  /** Test override for the pauses before retrying a pop-up's answer. */
  answerRetryMs?: number[];
  /** Test override for the pauses before retrying a post the socket didn't take. */
  deliveryRetryMs?: number[];
  /** Test overrides for the live stream. */
  stream?: Partial<Pick<StreamClientOptions, "silenceMs" | "initialBackoffMs" | "maxBackoffMs" | "random">>;
}

export interface BridgePlugin {
  server: Server;
  /** Opens the live stream. Runs by itself once the MCP handshake completes. */
  start(): void;
  stop(): Promise<void>;
}

/** The plugin's MCP server: the seven bridge tools, and delivery through Claude Code's inbox socket. */
export function createBridgePlugin(deps: BridgePluginDeps): BridgePlugin {
  const { config, client, log, socket } = deps;
  const watcher = deps.watcher ?? null;
  let watching = false;
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  addTools(server, client);

  const delivery = new InboxDelivery({
    client,
    socket,
    log,
    retryMs: deps.deliveryRetryMs,
    onFailure: () => stream.reconnect(),
  });

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

  const panels = new ApprovalPanels({
    client,
    runner: deps.popup ?? null,
    log,
    retryMs: deps.answerRetryMs,
    // A panel failed to show: reconnect without declaring pop-ups, so the hub hands the request to another session.
    onUnavailable: () => stream.reconnect(),
  });

  const stream: StreamClient = new StreamClient({
    // Pop-ups are declared on each open, so a session whose panel failed stops declaring them on its next connection.
    open: async (signal) =>
      client.openStream(signal, deps.registration ? await deps.registration() : undefined, { popup: panels.available }),
    onEvent: (event, data) => {
      if (event === "hello") onHello(data);
      else if (event === "nudge") void delivery.run();
      else if (event === "approval_request") panels.request(data);
      else if (event === "approval_closed") panels.closed(data);
    },
    // The hub sends open requests again on reconnect, to whichever session it then elects on the machine.
    onDisconnect: () => panels.closeAll(),
    onStop: (stop) => {
      // Delivery is over for good too: a retry armed by an earlier socket failure must not peek, post or ack now.
      delivery.stop();
      // So are status reports: the hub would refuse them, or they'd speak for the session that took over.
      watcher?.stop();
      socket
        .post(frameNotice(stopText(stop, config)))
        .catch((err) =>
          log("warn", "notice_failed", err instanceof SocketError ? { code: err.code } : { error: errorName(err) }),
        );
    },
    log,
    ...deps.stream,
  });
  // The stream waits for the MCP handshake: the session should be up before anything is posted into its inbox.
  server.oninitialized = () => stream.start();

  return {
    server,
    start: () => stream.start(),
    stop: async () => {
      watcher?.stop();
      delivery.stop();
      panels.closeAll();
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
