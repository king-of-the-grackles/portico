import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { makeApp, TOKENS, type TestAgent } from "../../hub/test/helpers";
import { HubClient } from "../src/hub-client";
import type { Logger } from "../src/log";

export { TOKENS };

/** A real hub (in-memory database, fake clock, recorded pushes, 50 ms heartbeats) on a random local port. */
export function startHub() {
  const hub = makeApp();
  const server = Bun.serve({ port: 0, fetch: hub.app.fetch, idleTimeout: 60 });
  return { ...hub, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export type TestHub = ReturnType<typeof startHub>;

export function hubClient(hub: TestHub, agent: TestAgent): HubClient {
  return new HubClient({ url: hub.url, token: TOKENS[agent] });
}

export interface LogLine {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

export function captureLog(): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    log: (level, msg, fields = {}) => {
      lines.push({ level, msg, fields });
    },
  };
}

export const ChannelNotification = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
});

const PermissionVerdict = z.object({
  method: z.literal("notifications/claude/channel/permission"),
  params: z.object({ request_id: z.string(), behavior: z.enum(["allow", "deny"]) }),
});

export interface ChannelMessage {
  content: string;
  meta: Record<string, string>;
}

export interface PermissionAsk {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

/** Stands in for Claude Code: connects to the plugin's MCP server and records what the plugin sends. */
export async function fakeHost(plugin: { server: Server }) {
  const [hostSide, pluginSide] = InMemoryTransport.createLinkedPair();
  const host = new Client({ name: "fake-claude-code", version: "1.0.0" });
  const channel: ChannelMessage[] = [];
  const verdicts: { request_id: string; behavior: "allow" | "deny" }[] = [];
  host.setNotificationHandler(ChannelNotification, ({ params }) => {
    channel.push({ content: params.content, meta: params.meta ?? {} });
  });
  host.setNotificationHandler(PermissionVerdict, ({ params }) => {
    verdicts.push(params);
  });
  await plugin.server.connect(pluginSide);
  await host.connect(hostSide);
  // The SDK's types know only the standard client notifications; Claude Code's channel ones are custom.
  const notify = host.notification.bind(host) as (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
  return {
    host,
    channel,
    verdicts,
    askPermission: (params: PermissionAsk) =>
      notify({ method: "notifications/claude/channel/permission_request", params: { ...params } }),
    close: () => host.close(),
  };
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}
