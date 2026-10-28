// The Codex conversation this bridge serves, found through Codex's shared app-server. Codex starts one bridge per
// conversation but doesn't say which, so the bridge asks the app-server to call portico_identify, with a nonce only
// this process knows, on each conversation in its folder: the call that comes back to this process names its own.
// Knowing it, the bridge follows the conversation's status as Codex reports it, and when Portico has something while
// the conversation is idle, starts a turn with it.
import { realpathSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER } from "../codex-config";
import { errorName, type Logger } from "../log";
import type { ConversationHooks, ConversationLink } from "../plugin";
import type { Inbox, PorticoClient } from "../portico-client";
import type { AppServer } from "./app-server";

/** The tool the app-server calls to find a conversation's bridge. Not listed: the model never sees it. */
export const IDENTIFY_TOOL = "portico_identify";

/** Pauses between searches: a new conversation's bridge can start before the app-server lists the conversation. */
const FIND_RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

/** After a turn that didn't start, the next try. */
const WAKE_RETRY_MS = 30_000;

/** How long the peek at Portico may take before a turn starts. */
const PEEK_MS = 10_000;

type ThreadStatus = { type?: unknown; activeFlags?: unknown };
type Thread = { id: string; cwd?: unknown; source?: unknown; parentThreadId?: unknown; status?: ThreadStatus };

export interface CodexConversationDeps extends ConversationHooks {
  /** The bridge's folder, as Codex started it. */
  cwd: string;
  /** Connects to Codex's app-server. Throws when there's none. */
  connect: () => Promise<AppServer>;
  client: Pick<PorticoClient, "pendingDeliveries" | "ackDeliveries">;
  /** The prompt a woken turn starts with. */
  prompt: (inbox: Inbox) => string;
  log: Logger;
  /** Test overrides. */
  findRetryMs?: number[];
  wakeRetryMs?: number;
  nonce?: string;
}

export class CodexConversation implements ConversationLink {
  private server: AppServer | null = null;
  private threadId: string | null = null;
  private subagent = false;
  private idle = false;
  private started = false;
  private stopped = false;
  /** Portico has something the conversation hasn't been given yet. */
  private wanted = false;
  private waking: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly nonce: string;
  private readonly cwd: string;
  private settle!: () => void;
  private readonly done = new Promise<void>((resolve) => (this.settle = resolve));

  constructor(private readonly deps: CodexConversationDeps) {
    this.nonce = deps.nonce ?? crypto.randomUUID();
    this.cwd = real(deps.cwd);
  }

  get canWake(): boolean {
    return this.server !== null && this.threadId !== null && !this.subagent && !this.stopped;
  }

  get knowsStatus(): boolean {
    return this.canWake;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.server?.close();
    this.settle();
  }

  settled(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([this.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]).finally(() =>
      clearTimeout(timer),
    );
  }

  called(name: string, args: Record<string, unknown>, meta: Record<string, unknown> | undefined): CallToolResult | null {
    if (name !== IDENTIFY_TOOL) return null;
    const mine = args.nonce === this.nonce;
    if (mine && this.threadId === null) {
      const thread = typeof meta?.threadId === "string" ? meta.threadId : typeof args.thread === "string" ? args.thread : null;
      if (thread) this.threadId = thread;
    }
    return { content: [{ type: "text", text: mine ? "This conversation." : "Another conversation." }] };
  }

  nudge(): void {
    this.wanted = true;
    if (this.canWake && this.idle) void this.wake();
  }

  private async run(): Promise<void> {
    try {
      this.server = await this.deps.connect();
    } catch (err) {
      // Codex's desktop app, a `codex` with -c overrides, or an older Codex: messages wait for the Stop hook.
      this.deps.log("info", "codex_app_server_unavailable", { error: errorName(err) });
      this.settle();
      return;
    }
    if (this.stopped) return void this.server.close();
    this.server.onNotification((method, params) => this.notified(method, params));
    this.server.onClose(() => {
      const could = this.canWake;
      this.server = null;
      if (!this.stopped) this.deps.log("warn", "codex_app_server_closed", {});
      if (could) this.deps.wakeChanged();
    });
    try {
      for (const pause of [0, ...(this.deps.findRetryMs ?? FIND_RETRY_MS)]) {
        if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
        if (this.stopped || !this.server) return;
        const thread = await this.find();
        if (thread) return this.adopt(thread);
      }
      this.deps.log("warn", "conversation_not_found", {});
    } catch (err) {
      this.deps.log("warn", "conversation_search_failed", { error: errorName(err) });
    } finally {
      this.settle();
    }
  }

  /** Asks each loaded conversation in this folder to call portico_identify; returns this bridge's own once found. */
  private async find(): Promise<Thread | null> {
    const server = this.server!;
    const { data } = await server.request<{ data: string[] }>("thread/loaded/list", {});
    for (const id of data) {
      const { thread } = await server.request<{ thread: Thread }>("thread/read", { threadId: id, includeTurns: false });
      if (typeof thread.cwd !== "string" || real(thread.cwd) !== this.cwd) continue;
      await server
        .request("mcpServer/tool/call", { threadId: id, server: SERVER, tool: IDENTIFY_TOOL, arguments: { nonce: this.nonce, thread: id } })
        .catch(() => {});
      if (this.threadId === id) return thread;
      if (this.threadId !== null) {
        // The app-server named another conversation than the one asked: take its word, and read that one.
        return (await server.request<{ thread: Thread }>("thread/read", { threadId: this.threadId, includeTurns: false })).thread;
      }
    }
    return null;
  }

  private adopt(thread: Thread): void {
    // A subagent Codex spawned has its own bridge, but messages are for the conversation the person works in.
    this.subagent = (typeof thread.source === "object" && thread.source !== null && "subAgent" in thread.source) || typeof thread.parentThreadId === "string";
    this.deps.log("info", "conversation_found", { subagent: this.subagent });
    if (this.subagent) return;
    this.apply(thread.status);
    this.deps.wakeChanged();
  }

  private notified(method: string, params: unknown): void {
    const p = (params ?? {}) as { threadId?: unknown; status?: ThreadStatus };
    if (method !== "thread/status/changed" || p.threadId !== this.threadId || !this.canWake) return;
    this.apply(p.status);
  }

  /** Codex's status, reported to Portico: a turn waiting on a person shows as waiting, any other turn as busy. */
  private apply(status: ThreadStatus | undefined): void {
    const active = status?.type === "active";
    const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
    this.idle = status?.type === "idle";
    this.deps.report(active ? (flags.length > 0 ? "waiting" : "busy") : "idle");
    if (this.idle && this.wanted) void this.wake();
  }

  /**
   * Starts a turn with what's waiting. Peeks, starts the turn, then acks: a turn that didn't start leaves everything for
   * the next try, the Stop hook or check_inbox. A conversation that turned busy meanwhile gets it at the end of the turn.
   */
  private wake(): Promise<void> {
    this.waking ??= (async () => {
      try {
        while (this.wanted && this.canWake) {
          this.wanted = false;
          const server = this.server!;
          const threadId = this.threadId!;
          const { thread } = await server.request<{ thread: Thread }>("thread/read", { threadId, includeTurns: false });
          if (thread.status?.type !== "idle") {
            this.wanted = true;
            this.apply(thread.status);
            return;
          }
          const inbox = await this.deps.client.pendingDeliveries({ timeoutMs: PEEK_MS });
          if (inbox.messages.length === 0 && inbox.updates.length === 0) continue;
          await server.request("turn/start", { threadId, input: [{ type: "text", text: this.deps.prompt(inbox), text_elements: [] }] });
          this.idle = false;
          this.deps.log("info", "conversation_woken", { messages: inbox.messages.length, updates: inbox.updates.length });
          await this.deps.client
            .ackDeliveries({ messages: inbox.messages.map((m) => m.id), updates: inbox.updates.map((u) => u.message_id) })
            .catch((err) => this.deps.log("warn", "wake_ack_failed", { error: errorName(err) }));
        }
      } catch (err) {
        this.deps.log("warn", "wake_failed", { error: errorName(err) });
        this.wanted = true;
        clearTimeout(this.retry);
        this.retry = setTimeout(() => {
          if (this.idle) void this.wake();
        }, this.deps.wakeRetryMs ?? WAKE_RETRY_MS);
        this.retry.unref?.();
      } finally {
        this.waking = null;
      }
    })();
    return this.waking;
  }
}

/** The folder's real path, so /tmp and /private/tmp count as one. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
