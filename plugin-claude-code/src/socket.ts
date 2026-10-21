import { createConnection } from "node:net";
import type { OwnSession } from "./registry";

export type SocketErrorCode = "no_socket" | "connect_failed" | "refused" | "timeout";

/** A post the inbox socket didn't accept. The message never carries the content or the token. */
export class SocketError extends Error {
  constructor(
    readonly code: SocketErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SocketError";
  }
}

export interface InboxSocketDeps {
  /** The socket's path, read on every post. Null when none is known. */
  path: () => string | null;
  /** The auth token, sent first when there is one. */
  token: () => string | null;
  /** How long connecting and writing may take. Default 5 s. */
  connectTimeoutMs?: number;
  /** How long to wait for an error reply after writing before counting the post as accepted. Default 250 ms. */
  settleMs?: number;
}

const ERROR_REPLY = /"type"\s*:\s*"error"|"ok"\s*:\s*false/;

/**
 * Posts into Claude Code's inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`), where a post arrives as a message from another
 * session. One connection per post, opened only once the post is ready: Claude Code closes a connection that sends no
 * complete line within 30 s.
 */
export class InboxSocket {
  constructor(private readonly deps: InboxSocketDeps) {}

  /** Resolves once the post is accepted: both lines written, and no error reply within settleMs. */
  async post(content: string): Promise<void> {
    const path = this.deps.path();
    if (!path) throw new SocketError("no_socket", "No inbox socket is known for this session.");
    const token = this.deps.token();
    const payload = [
      ...(token ? [JSON.stringify({ type: "auth", token })] : []),
      JSON.stringify({ type: "user", message: { role: "user", content } }),
    ]
      .map((line) => `${line}\n`)
      .join("");
    const settleMs = this.deps.settleMs ?? 250;
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection(path);
      let written = false;
      let done = false;
      let reply = "";
      let settle: ReturnType<typeof setTimeout> | undefined;
      const once = (err?: SocketError) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(settle);
        sock.destroy();
        if (err) reject(err);
        else resolve();
      };
      // Covers the write too, so a peer that accepts the connection but never reads can't hold the post forever.
      const timer = setTimeout(
        () => once(new SocketError("timeout", "The inbox socket didn't answer in time.")),
        this.deps.connectTimeoutMs ?? 5_000,
      );
      sock.on("error", () =>
        once(new SocketError(written ? "refused" : "connect_failed", "The inbox socket closed with an error.")),
      );
      // An error reply that arrives just before a close still wins: `data` fires before `close`.
      sock.on("data", (chunk) => {
        reply += chunk.toString("utf8");
        if (ERROR_REPLY.test(reply)) once(new SocketError("refused", "The inbox socket refused the post."));
      });
      sock.on("close", () =>
        once(written ? undefined : new SocketError("refused", "The inbox socket closed before the post was written.")),
      );
      sock.on("connect", () => {
        sock.write(payload, (err) => {
          if (err) return once(new SocketError("refused", "The post couldn't be written."));
          written = true;
          clearTimeout(timer);
          settle = setTimeout(() => once(), settleMs);
        });
      });
    });
  }
}

/**
 * Where this session's inbox socket is: `CLAUDE_CODE_MESSAGING_SOCKET` when Claude Code passed it, otherwise the
 * path in the session's registry file. The token comes only from `CLAUDE_CODE_MESSAGING_TOKEN`.
 */
export function socketTarget(
  env: Record<string, string | undefined>,
  locate: () => OwnSession | null,
): Pick<InboxSocketDeps, "path" | "token"> {
  const envPath = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim() || null;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN?.trim() || null;
  return { path: () => envPath ?? locate()?.messagingSocketPath ?? null, token: () => token };
}
