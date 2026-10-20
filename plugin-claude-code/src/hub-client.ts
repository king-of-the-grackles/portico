export interface AgentView {
  name: string;
  description: string;
  delivery: "push" | "pull";
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

export interface Inbox {
  tasks: InboxTask[];
  results: TaskView[];
}

export interface PermissionPrompt {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
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
}

/** The hub's web API (spec §9.1), authenticated with this session's agent token. */
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

  sendTask(body: { to: string; instructions: string; idempotency_key?: string }): Promise<{ task: TaskView }> {
    return this.call("POST", "/api/tasks", body);
  }

  checkInbox(): Promise<Inbox> {
    return this.call("GET", "/api/inbox");
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

  relayPermission(prompt: PermissionPrompt): Promise<unknown> {
    return this.call("POST", "/api/permission-requests", prompt);
  }

  /** Opens `GET /api/stream`. Doesn't throw for HTTP errors: the caller checks `status`, reads the body, and aborts with `signal`. */
  openStream(signal: AbortSignal): Promise<Response> {
    return this.doFetch(`${this.opts.url}/api/stream`, {
      headers: { authorization: `Bearer ${this.opts.token}`, accept: "text/event-stream" },
      signal,
    });
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.token}`, accept: "application/json" };
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
