// Codex's shared app-server: plain `codex` terminals run their conversations in one background process per computer,
// which takes other clients as WebSocket connections on a Unix socket, speaking JSON-RPC 2.0 one message per frame.
// The bridge uses it to find its own conversation, follow its status, and start a turn in it.
import { homedir } from "node:os";
import { join } from "node:path";

/** Where Codex keeps the app-server's control socket, under its home (CODEX_HOME, default ~/.codex). */
export function controlSocketPath(env: Record<string, string | undefined>): string {
  return join(env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");
}

/** A request the app-server refused, or one that never got an answer. */
export class AppServerError extends Error {
  constructor(
    readonly code: number | "timeout" | "closed",
    message: string,
  ) {
    super(message);
    this.name = "AppServerError";
  }
}

export interface AppServer {
  /** Sends a request. Rejects with AppServerError on an error answer, after `timeoutMs`, or once the connection ends. */
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  /** Hears every notification, such as `thread/status/changed`, which the app-server sends to all its clients. */
  onNotification(listener: (method: string, params: unknown) => void): void;
  /** Runs once, when the connection ends however it ends. */
  onClose(listener: () => void): void;
  close(): void;
}

export interface ConnectOptions {
  path: string;
  /** Sent as the client's name and version when connecting. */
  version: string;
  /** How long opening and each request may take. Default 10 s. */
  timeoutMs?: number;
  /** For tests. */
  WebSocket?: typeof WebSocket;
}

type Pending = { resolve: (value: unknown) => void; reject: (err: AppServerError) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Connects and introduces itself. Throws AppServerError when there's no app-server on the socket: Codex's desktop app,
 * a `codex` started with `-c` overrides, and older Codex run their conversations in their own process instead.
 *
 * Requests the app-server sends this client (approvals, sign-in) are never answered: those go to whoever watches the
 * conversation, and this client never watches one.
 */
export async function connectAppServer(opts: ConnectOptions): Promise<AppServer> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const Socket = opts.WebSocket ?? WebSocket;
  const ws = new Socket(`ws+unix://${opts.path}`);
  const pending = new Map<number, Pending>();
  const notificationListeners: ((method: string, params: unknown) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let nextId = 1;
  let closed = false;

  const end = () => {
    if (closed) return;
    closed = true;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new AppServerError("closed", "The Codex app-server connection closed."));
    }
    for (const listener of closeListeners) listener();
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new AppServerError("timeout", "The Codex app-server didn't answer."));
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new AppServerError("closed", "No Codex app-server is running."));
    };
  });

  ws.onerror = () => end();
  ws.onclose = () => end();
  ws.onmessage = (event) => {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (typeof message.method === "string") {
      if (message.id === undefined) for (const listener of notificationListeners) listener(message.method, message.params);
      return;
    }
    const p = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(message.id as number);
    if (message.error) {
      const code = typeof message.error.code === "number" ? message.error.code : -1;
      p.reject(new AppServerError(code, typeof message.error.message === "string" ? message.error.message : "The request failed."));
    } else p.resolve(message.result);
  };

  const server: AppServer = {
    request: <T>(method: string, params: unknown, ms = timeoutMs) =>
      new Promise<T>((resolve, reject) => {
        if (closed) {
          reject(new AppServerError("closed", "The Codex app-server connection closed."));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new AppServerError("timeout", `The Codex app-server didn't answer ${method}.`));
        }, ms);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      }),
    onNotification: (listener) => void notificationListeners.push(listener),
    onClose: (listener) => {
      if (closed) listener();
      else closeListeners.push(listener);
    },
    close: () => {
      ws.close();
      end();
    },
  };

  try {
    await server.request("initialize", {
      clientInfo: { name: "portico-bridge", title: "Portico", version: opts.version },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
  } catch (err) {
    server.close();
    throw err;
  }
  return server;
}
