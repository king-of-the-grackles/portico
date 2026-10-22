/** One entry of the hub's live directory, as `GET /api/agents` returns it. */
export interface AgentView {
  /** The name to address the agent by: a session's short name when unique, otherwise its full address. */
  name: string;
  address: string;
  kind: string;
  description: string;
  delivery: "push" | "pull";
  machine: string | null;
  repo: string | null;
  branch: string | null;
  /** Null for pull agents. */
  status: "busy" | "idle" | "waiting" | "offline" | null;
  doing: string | null;
  last_seen: string | null;
}

export interface TaskView {
  id: string;
  from_agent: string;
  to_agent: string;
  instructions: string;
  status: string;
  result: string | null;
  reason: string | null;
  parent_task_id: string | null;
  chain_length: number;
  event_id: string | null;
  trigger_name: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface InboxTask extends TaskView {
  /** The task wrapped in the framing from spec §8. */
  framed_message: string;
}

/** How a message or a queued task will arrive. */
export type DeliveryTier = "pushed" | "queued" | "offline";

/** Where and how the owner can approve a task waiting for approval, as send_task's result carries it. */
export interface ApprovalInfo {
  /** The task's hub page, which needs sign-in. */
  url: string;
  /** Machines showing a pop-up for the task. */
  popups: string[];
  /** One sentence for the agent. */
  note: string;
}

export interface MessageView {
  id: string;
  from_agent: string;
  to_agent: string;
  text: string;
  reply_to: string | null;
  created_at: string;
  expires_at: string;
  delivered_at: string | null;
}

export interface Inbox {
  tasks: InboxTask[];
  results: ResultDelivery[];
  messages: MessageDelivery[];
}

export interface ResultDelivery extends TaskView {
  /** The result wrapped in the hub's `<bridge-result>` frame. */
  framed_message: string;
}

export interface MessageDelivery extends MessageView {
  /** The message wrapped in the hub's `<bridge-message>` frame. */
  framed_message: string;
}

/** What `GET /api/deliveries` returns: everything waiting for this session, unclaimed. */
export interface Deliveries {
  tasks: InboxTask[];
  results: ResultDelivery[];
  messages: MessageDelivery[];
}

/** The IDs this session delivered, for `POST /api/deliveries/ack`. */
export interface DeliveryAck {
  tasks: string[];
  results: string[];
  messages: string[];
}

/** What a session's stream open registers, in machine mode (spec §5.2). Only basenames and an HMAC leave the machine. */
export interface StreamRegistration {
  /** The repo basename. */
  repo: string;
  /** HMAC-SHA256 of the folder's real path, keyed with the machine token. */
  folderId: string;
}

/** This session's live status, for `POST /api/status` (spec §5.3). */
export interface StatusReport {
  status: "busy" | "idle" | "waiting";
  doing: string | null;
  repo: string | null;
  branch: string | null;
}

/** A failed hub call. `status` 0 means the hub couldn't be reached. */
export class HubError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HubError";
  }
}

export interface HubClientOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
  /** For ordinary calls. The live stream has no timeout. Default 15 s. */
  timeoutMs?: number;
  /** This session's key in machine mode, sent as X-Bridge-Session on every request and on the stream. */
  sessionKey?: string;
}

/** The hub's web API (spec §9.1), authenticated with this session's agent or machine token. */
export class HubClient {
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HubClientOptions) {
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  listAgents(): Promise<{ agents: AgentView[] }> {
    return this.call("GET", "/api/agents");
  }

  sendTask(body: {
    to: string;
    instructions: string;
    idempotency_key?: string;
  }): Promise<{ task: TaskView; delivery: DeliveryTier | null; approval?: ApprovalInfo | null }> {
    return this.call("POST", "/api/tasks", body);
  }

  sendMessage(body: {
    to?: string;
    text: string;
    reply_to?: string;
  }): Promise<{ message: MessageView; delivery: DeliveryTier }> {
    return this.call("POST", "/api/messages", body);
  }

  checkInbox(): Promise<Inbox> {
    return this.call("GET", "/api/inbox");
  }

  /** Peeks at what is waiting, changing nothing. Push agents only. */
  pendingDeliveries(): Promise<Deliveries> {
    return this.call("GET", "/api/deliveries");
  }

  /** Claims the delivered tasks and marks the delivered results and messages seen. */
  ackDeliveries(ack: DeliveryAck): Promise<{ acked: Record<keyof DeliveryAck, number> }> {
    return this.call("POST", "/api/deliveries/ack", ack);
  }

  finishTask(taskId: string, body: { result?: string; failed_reason?: string }): Promise<{ task: TaskView }> {
    return this.call("POST", `/api/tasks/${encodeURIComponent(taskId)}/finish`, body);
  }

  getTask(taskId: string): Promise<{ task: TaskView }> {
    return this.call("GET", `/api/tasks/${encodeURIComponent(taskId)}`);
  }

  reportEvent(body: { name: string; details?: string }): Promise<{ event: unknown; tasks: TaskView[] }> {
    return this.call("POST", "/api/events", body);
  }

  /** Reports this session's status. Push members only. */
  reportStatus(report: StatusReport): Promise<{ ok: true }> {
    return this.call("POST", "/api/status", report);
  }

  /** A pop-up's answer, with the nonce the request came with. Sessions on a joined machine only. */
  answerApproval(taskId: string, body: { nonce: string; decision: "approve" | "deny"; note?: string }): Promise<{ task: TaskView }> {
    return this.call("POST", `/api/approvals/${encodeURIComponent(taskId)}`, body);
  }

  /**
   * Opens `GET /api/stream`, registering the session when given a registration, and declaring that this session can
   * show approval pop-ups when `popup` is set. Doesn't throw for HTTP errors: the caller checks `status`, reads the
   * body, and aborts with `signal`.
   */
  openStream(signal: AbortSignal, registration?: StreamRegistration, opts: { popup?: boolean } = {}): Promise<Response> {
    const headers = this.headers("text/event-stream");
    let path = "/api/stream";
    if (registration) {
      path += `?repo=${encodeURIComponent(registration.repo)}`;
      headers["x-bridge-folder"] = registration.folderId;
    }
    if (opts.popup) headers["x-bridge-popup"] = "1";
    return this.doFetch(`${this.opts.url}${path}`, { headers, signal });
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.token}`, accept };
    if (this.opts.sessionKey) headers["x-bridge-session"] = this.opts.sessionKey;
    return headers;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers = this.headers("application/json");
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.doFetch(`${this.opts.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "error";
      throw new HubError(0, "unreachable", `The hub at ${this.opts.url} could not be reached (${name}).`);
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
      throw new HubError(
        res.status,
        typeof error.error === "string" ? error.error : "http_error",
        typeof error.message === "string" ? error.message : `The hub answered HTTP ${res.status}.`,
      );
    }
    if (data === null || typeof data !== "object") throw new HubError(res.status, "bad_response", "The hub's answer was not JSON.");
    return data as T;
  }
}
