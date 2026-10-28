/** One entry of Portico's live agent list, as `GET /api/agent/agents` returns it. */
export interface AgentEntry {
  /** The name to address the agent by: a session's short name when unique, otherwise its full address. */
  name: string;
  address: string;
  kind: string;
  type: "session" | "app" | "connector";
  description: string;
  /** The name of the person who manages the agent. */
  owner: string;
  computer: string | null;
  repo: string | null;
  branch: string | null;
  /** Null for apps and connectors. */
  status: "busy" | "idle" | "waiting" | "offline" | null;
  doing: string | null;
  last_seen: string | null;
  approval_required: boolean;
}

export type MessageStatus = "held" | "pending" | "delivered" | "declined" | "expired";

export interface MessageView {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  reply_to: string | null;
  status: MessageStatus;
  created_at: string;
  expires_at: string;
}

export interface MessageDelivery extends MessageView {
  /** The message wrapped in Portico's `<portico-message>` frame. */
  framed_message: string;
}

/** What happened to a held message this agent sent: delivered, declined or expired. */
export interface UpdateDelivery {
  message_id: string;
  to: string;
  subject: string;
  status: MessageStatus;
  at: string;
  /** The outcome wrapped in Portico's `<portico-update>` frame. */
  framed_message: string;
}

/** How a sent message will arrive. */
export type DeliveryTier = "pushed" | "queued" | "offline" | "held";

/** The longest Portico holds a check_inbox that waits. */
export const MAX_INBOX_WAIT_SECONDS = 40;

/** What `GET /api/agent/inbox` and `GET /api/agent/deliveries` return. */
export interface Inbox {
  messages: MessageDelivery[];
  updates: UpdateDelivery[];
}

/** The IDs this session delivered, for `POST /api/agent/deliveries/ack`. Updates go by their message's ID. */
export interface DeliveryAck {
  messages: string[];
  updates: string[];
}

/** What a session's stream open registers. Only a basename and an HMAC leave the computer. */
export interface StreamRegistration {
  /** The repo basename. */
  repo: string;
  /** HMAC-SHA256 of the folder's real path, keyed with the computer token. */
  folderId: string;
}

/** This session's live status, for `POST /api/agent/status`. */
export interface StatusReport {
  status: "busy" | "idle" | "waiting";
  doing: string | null;
  repo: string | null;
  branch: string | null;
}

/** A desktop pop-up's answer to a held message. */
export type Decision = "allow_once" | "always_allow" | "deny";

/** A failed call to Portico. `status` 0 means Portico couldn't be reached. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface PorticoClientOptions {
  url: string;
  /** The computer token. */
  token: string;
  fetch?: typeof fetch;
  /** For ordinary calls. The live stream has no timeout. Default 15 s. */
  timeoutMs?: number;
  /** This session's key, sent as X-Portico-Session on every request and on the stream. */
  sessionKey?: string;
}

/** The agent API under `/api/agent`, as this session: the computer token plus the session key. */
export class PorticoClient {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: PorticoClientOptions) {
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  listAgents(): Promise<{ agents: AgentEntry[] }> {
    return this.call("GET", "/api/agent/agents");
  }

  sendMessage(body: {
    to?: string;
    subject: string;
    text: string;
    reply_to?: string;
  }): Promise<{ message: MessageView; delivery: DeliveryTier; note?: string }> {
    return this.call("POST", "/api/agent/messages", body);
  }

  /**
   * Picks up new messages and outcomes, marking them delivered and reported. With `wait` (seconds), Portico answers as
   * soon as something arrives, or after the wait (capped by Portico) with nothing; Portico checks the value.
   */
  checkInbox(wait?: number | string, signal?: AbortSignal): Promise<Inbox> {
    if (wait === undefined || wait === "") return this.call("GET", "/api/agent/inbox", undefined, { signal });
    const seconds = Math.min(Math.max(Number(wait) || 0, 0), MAX_INBOX_WAIT_SECONDS);
    return this.call("GET", `/api/agent/inbox?wait=${encodeURIComponent(String(wait))}`, undefined, {
      timeoutMs: this.timeoutMs + seconds * 1000,
      signal,
    });
  }

  /** Peeks at what is waiting for this session, changing nothing. */
  pendingDeliveries(): Promise<Inbox> {
    return this.call("GET", "/api/agent/deliveries");
  }

  /** Marks the posted messages delivered and the posted updates reported. */
  ackDeliveries(ack: DeliveryAck): Promise<{ acked: { messages: number; updates: number } }> {
    return this.call("POST", "/api/agent/deliveries/ack", ack);
  }

  reportStatus(report: StatusReport): Promise<{ ok: true }> {
    return this.call("POST", "/api/agent/status", report);
  }

  /** A pop-up's answer to a held message, with the nonce the request came with. */
  answerApproval(messageId: string, body: { nonce: string; decision: Decision }): Promise<{ message: MessageView }> {
    return this.call("POST", `/api/agent/approvals/${encodeURIComponent(messageId)}`, body);
  }

  /**
   * Opens `GET /api/agent/stream`, registering the session with the registration, and declaring that this session can
   * show pop-ups when `popup` is set. Doesn't throw for HTTP errors: the caller checks `status`, reads the body, and
   * aborts with `signal`.
   */
  openStream(signal: AbortSignal, registration?: StreamRegistration, opts: { popup?: boolean } = {}): Promise<Response> {
    const headers = this.headers("text/event-stream");
    let path = "/api/agent/stream";
    if (registration) {
      path += `?repo=${encodeURIComponent(registration.repo)}`;
      headers["x-portico-folder"] = registration.folderId;
    }
    if (opts.popup) headers["x-portico-popup"] = "1";
    return this.doFetch(`${this.opts.url}${path}`, { headers, signal });
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.token}`, accept };
    if (this.opts.sessionKey) headers["x-portico-session"] = this.opts.sessionKey;
    return headers;
  }

  /** With `signal`, the request also ends when the signal aborts, e.g. a cancelled tool call. */
  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs);
    const headers = this.headers("application/json");
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.doFetch(`${this.opts.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "error";
      throw new ApiError(0, "unreachable", `Portico at ${this.opts.url} could not be reached (${name}).`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON; handled below
    }
    if (!res.ok) {
      const error = (data ?? {}) as { error?: unknown; message?: unknown };
      throw new ApiError(
        res.status,
        typeof error.error === "string" ? error.error : "http_error",
        typeof error.message === "string" ? error.message : `Portico answered HTTP ${res.status}.`,
      );
    }
    if (data === null || typeof data !== "object") throw new ApiError(res.status, "bad_response", "The answer from Portico was not JSON.");
    return data as T;
  }
}
