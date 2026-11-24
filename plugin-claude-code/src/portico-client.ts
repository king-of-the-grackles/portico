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
  /** The Porticos this agent and the caller are both in. */
  porticos?: PorticoRef[];
}

/** A Portico, the place: a named list of people and agents. Two agents message each other only while both are in one. */
export interface PorticoRef {
  id: string;
  name: string;
}

export type MessageStatus = "held" | "pending" | "delivered" | "declined" | "expired";

/** A file a message carries. `url` answers this agent's token with the file. */
export interface FileView {
  id: string;
  name: string;
  type: string;
  size: number;
  url: string;
}

export interface MessageView {
  id: string;
  thread_id: string;
  from: string;
  /** The name of the person who manages the sender, and whether that person also manages this agent. */
  from_owner?: string;
  from_own_person?: boolean;
  to: string;
  /** The Portico the message went through. */
  portico?: PorticoRef;
  subject: string;
  text: string;
  reply_to: string | null;
  /** The sender needs no reply. Absent from a Portico server older than the flag. */
  no_reply_needed?: boolean;
  status: MessageStatus;
  created_at: string;
  expires_at: string;
  attachments?: FileView[];
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

/**
 * Portico's own notice: who came into or left a Portico this agent is in, or how a question this agent asked its
 * person ended. Never from another agent.
 */
export interface NoticeDelivery {
  id: string;
  at: string;
  text: string;
  /** The notice in Portico's frame: `<portico-answer>` for how a question ended, `<portico-notice>` for anything else. */
  framed_message: string;
  /** Present on the notice that says how a question asked with request_input ended. */
  question?: { id: string; status: string; level: string | null; via: string | null };
}

/** What `POST /api/agent/questions` returns: the question, the line to show the person, and what happens next. */
export interface AskedQuestion {
  question: {
    id: string;
    status: string;
    question: string;
    detail: string | null;
    options: string[] | null;
    task: string | null;
    created_at: string;
    expires_at: string;
    /** The question's own page: the link to show the person as is. */
    link: string;
  };
  show: string;
  note: string;
}

/** How a sent message will arrive. */
export type DeliveryTier = "pushed" | "queued" | "offline" | "held";

/** Where a task stands, as `GET /api/agent/tasks` reports it. */
export type TaskOutcome = "needs_approval" | "in_progress" | "done" | "failed";

/** One of this agent's tasks: a conversation with another agent, sent or received. */
export interface AgentTask {
  id: string;
  subject: string;
  direction: "sent" | "received";
  with: string;
  outcome: TaskOutcome;
  reason: "not_allowed" | "expired" | "no_answer" | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  picked_up_at: string | null;
  answer: { message_id: string; subject: string; summary: string | null; done: boolean; at: string } | null;
  /** The first message said no reply is needed: the task is done once that message is picked up. */
  no_reply_needed?: boolean;
  messages: number;
}

/** A message in `GET /api/agent/tasks/:id`: this agent's own as text, the other agent's framed. */
export interface AgentTaskMessage {
  id: string;
  from: string;
  to: string;
  reply_to: string | null;
  status: MessageStatus;
  created_at: string;
  done: boolean;
  no_reply_needed?: boolean;
  /** Absent when withheld. */
  subject?: string;
  text?: string;
  framed_message?: string;
  /** A message to this agent that a person hasn't allowed yet. */
  withheld?: true;
  /** Each file with a download address that needs no token and works for a few minutes. */
  attachments?: (FileView & { download_url?: string; download_expires_at?: string; unavailable?: string })[];
}

/** The longest Portico holds a check_inbox that waits. */
export const MAX_INBOX_WAIT_SECONDS = 40;

/** What `GET /api/agent/inbox` and `GET /api/agent/deliveries` return. */
export interface Inbox {
  messages: MessageDelivery[];
  updates: UpdateDelivery[];
  /** Portico's own notices. Absent from a Portico server that sends none. */
  notices?: NoticeDelivery[];
  /** How many messages wait for a decision by the person who manages this agent, and the sentence to pass on. */
  held_for_person?: number;
  held_note?: string;
  /** How many of this agent's own questions wait for its person, and the sentence with each one's link. */
  input_needed?: number;
  input_note?: string;
}

/** The IDs this session delivered, for `POST /api/agent/deliveries/ack`. Updates go by their message's ID. */
export interface DeliveryAck {
  messages: string[];
  updates: string[];
  /** Portico's own notices this session was told. */
  notices?: string[];
}

/** What a session's stream open registers. Only a basename and an HMAC leave the computer. */
export interface StreamRegistration {
  /** The repo basename. */
  repo: string;
  /** HMAC-SHA256 of the folder's real path, keyed with the computer token. */
  folderId: string;
  /** Which coding agent the session is. Absent, Portico takes the session for Claude Code. */
  client?: "claude-code" | "codex";
}

/** This session's live status, for `POST /api/agent/status`. */
export interface StatusReport {
  status: "busy" | "idle" | "waiting";
  doing: string | null;
  repo: string | null;
  branch: string | null;
}

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

  /** The agents this one reaches. With `portico` (an ID or name), only those in that one Portico. Sent as given: Portico checks it. */
  listAgents(portico?: string): Promise<{ agents: AgentEntry[]; portico?: PorticoRef; note?: string }> {
    return this.call("GET", `/api/agent/agents${portico ? `?portico=${encodeURIComponent(portico)}` : ""}`);
  }

  sendMessage(body: {
    to?: string;
    subject: string;
    text: string;
    reply_to?: string;
    summary?: string;
    /** false for an update with more to come. Sent as given: Portico checks the value. */
    done?: unknown;
    /** true for a message that needs no reply. Sent as given: Portico checks the value. */
    no_reply_needed?: unknown;
    key?: string;
    /** File IDs. Sent as given: Portico checks the value. */
    attachments?: unknown;
  }): Promise<{ message: MessageView; delivery: DeliveryTier; portico?: PorticoRef; note?: string }> {
    return this.call("POST", "/api/agent/messages", body);
  }

  /** Starts a file to attach: ready at once with `text`, otherwise with an address to PUT the bytes to. */
  createUpload(body: { name: unknown; type?: unknown; size?: unknown; text?: unknown }): Promise<{
    file: FileView & { status: "uploading" | "ready" };
    upload?: { method: "PUT"; url: string; expires_at: string };
  }> {
    return this.call("POST", "/api/agent/files", body);
  }

  /** This agent's tasks, newest first; open ones unless `outcome` says otherwise. Portico checks every value. */
  listTasks(
    filter: { outcome?: string; with?: string; since?: string; before?: string; limit?: string } = {},
  ): Promise<{ tasks: AgentTask[]; more: boolean }> {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(filter)) if (value !== undefined) query.set(name, value);
    const qs = query.toString();
    return this.call("GET", `/api/agent/tasks${qs ? `?${qs}` : ""}`);
  }

  /** One of this agent's tasks, by its ID or any of its messages' IDs, with every message. */
  getTask(id: string): Promise<{ task: AgentTask; messages: AgentTaskMessage[] }> {
    return this.call("GET", `/api/agent/tasks/${encodeURIComponent(id)}`);
  }

  /** This agent's own description and doing line. Values go as given: Portico checks them. */
  updateProfile(body: { description?: unknown; doing?: unknown }): Promise<{ agent: AgentEntry }> {
    return this.call("PATCH", "/api/agent/profile", body);
  }

  /** Files feedback about Portico. Values go as given: Portico checks them. */
  submitFeedback(body: { kind?: unknown; title?: unknown; details?: unknown }): Promise<{ feedback: { id: string; status: string }; note: string }> {
    return this.call("POST", "/api/agent/feedback", body);
  }

  /**
   * Asks the person who manages this agent a question. Values go as given: Portico checks them. Portico has no call
   * that answers one: the answer comes back as a notice.
   */
  requestInput(body: { question?: unknown; detail?: unknown; options?: unknown; task?: unknown; expires_in_minutes?: unknown }): Promise<AskedQuestion> {
    return this.call("POST", "/api/agent/questions", body);
  }

  /** Runs one of the Portico tools (list_porticos and the rest): the arguments go as given, and Portico checks them. */
  porticoTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.call("POST", `/api/agent/portico-tools/${encodeURIComponent(name)}`, args);
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
  pendingDeliveries(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Inbox> {
    return this.call("GET", "/api/agent/deliveries", undefined, opts);
  }

  /** Marks the posted messages delivered and the posted updates reported. */
  ackDeliveries(ack: DeliveryAck, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ acked: { messages: number; updates: number; notices?: number } }> {
    return this.call("POST", "/api/agent/deliveries/ack", ack, opts);
  }

  reportStatus(report: StatusReport): Promise<{ ok: true }> {
    return this.call("POST", "/api/agent/status", report);
  }

  /**
   * Opens `GET /api/agent/stream`, registering the session with the registration, and declaring that this session can
   * start a turn when a message arrives when `wake` is set. Doesn't throw for HTTP errors: the caller checks `status`,
   * reads the body, and aborts with `signal`.
   */
  openStream(signal: AbortSignal, registration?: StreamRegistration, opts: { wake?: boolean } = {}): Promise<Response> {
    const headers = this.headers("text/event-stream");
    let path = "/api/agent/stream";
    if (registration) {
      path += `?repo=${encodeURIComponent(registration.repo)}`;
      headers["x-portico-folder"] = registration.folderId;
      if (registration.client) headers["x-portico-client"] = registration.client;
    }
    if (opts.wake) headers["x-portico-wake"] = "1";
    // A redirect is an error, never followed: this session talks only to the Portico named in computer.json.
    return this.doFetch(`${this.opts.url}${path}`, { headers, signal, redirect: "error" });
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.token}`, accept };
    if (this.opts.sessionKey) headers["x-portico-session"] = this.opts.sessionKey;
    return headers;
  }

  /** With `signal`, the request also ends when the signal aborts, e.g. a cancelled tool call. */
  private async call<T>(
    method: "GET" | "POST" | "PATCH",
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
        // Never followed: a message's text and this session's key go only to the Portico named in computer.json.
        redirect: "error",
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
