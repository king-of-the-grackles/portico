// An agent as an app would be one: it asks to join over HTTP, a person allows it on the consent page in a browser,
// and from then on it uses the REST agent API with its token.
import { expect, type Page } from "@playwright/test";
import { BASE_URL } from "./env";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
    where: string,
  ) {
    super(`${where} answered ${status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
}

async function http(method: string, url: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url.startsWith("http") ? url : `${BASE_URL}${url}`, {
    method,
    headers: { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body };
}

// ---- joining ----

export interface Join {
  id: string;
  /** The consent page the person opens. */
  link: string;
  code: string;
  poll_secret: string;
  expires_at: string;
  show: string;
}

/** POST /api/join: counts against the server's limit of 10 starts per address per 15 minutes. */
export async function startJoin(name: string, shareLink?: string): Promise<Join> {
  const { status, body } = await http("POST", "/api/join", { body: { kind: "agent", name, client: "other", ...(shareLink ? { link: shareLink } : {}) } });
  if (status === 429) throw new Error("The server's join limit is used up for this address (10 starts per 15 minutes). Wait, then run with E2E_KEEP=1 so reruns reuse their agents.");
  if (status !== 201) throw new ApiError(status, body, "POST /api/join");
  return body;
}

/**
 * The consent page, as the signed-in person answers it: a handle the first time, the code, Allow. Works for a join
 * and for anything else an agent asks (share, come in with a link, delete).
 */
export async function allowOnConsentPage(page: Page, ask: { link: string; code: string }, opts: { handle?: string } = {}): Promise<void> {
  await page.goto(ask.link);
  const handle = page.getByLabel("Handle");
  if (opts.handle && (await handle.count()) > 0) await handle.fill(opts.handle);
  await page.getByLabel("Code the agent shows").fill(ask.code);
  await page.locator('button[name="decision"][value="approve"]').click();
  await expect(page.getByRole("heading", { level: 1, name: "Allowed" })).toBeVisible();
}

/** A held message's own page, /held/<id>, answered by the signed-in person with the button of that name. */
export async function decideHeld(page: Page, messageId: string, button: "Allow this message only" | "Always allow this sender" | "Always for this person" | "Don't allow"): Promise<void> {
  await page.goto(`/held/${messageId}`);
  await expect(page.getByRole("heading", { level: 1, name: "A message waits for a decision" })).toBeVisible();
  await page.getByRole("button", { name: button }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Already decided" })).toBeVisible();
}

/** GET /api/join/:id until the person has answered. The token comes once. */
export async function pollJoin(join: Join, timeoutMs = 20_000): Promise<string> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { status, body } = await http("GET", `/api/join/${join.id}`, { token: join.poll_secret });
    if (status !== 200) throw new ApiError(status, body, "GET /api/join/:id");
    if (body.status === "approved") {
      if (!body.token) throw new Error("The join was allowed but the token was already handed out.");
      return body.token;
    }
    if (body.status !== "pending") throw new Error(`The join ended as ${body.status}.`);
    if (Date.now() > until) throw new Error("The join stayed pending.");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---- the agent API ----

export interface AgentMessage {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  status: string;
  reply_to: string | null;
  portico: { id: string; name: string };
  attachments: { id: string; name: string; type: string; size: number; url: string }[];
}

export interface SendInput {
  to?: string;
  subject: string;
  text: string;
  reply_to?: string;
  done?: boolean;
  attachments?: string[];
}

export class AgentClient {
  /** Everything the inbox handed over so far: a check takes messages out of the inbox, so they are kept here. */
  private got: AgentMessage[] = [];
  private gotUpdates: { message_id: string; status: string }[] = [];

  constructor(
    readonly owner: string,
    readonly name: string,
    readonly token: string,
  ) {}

  /** Any agent API route, without throwing: `{ status, body }`. For checking refusals. */
  raw(method: string, path: string, body?: unknown) {
    return http(method, path.startsWith("/api/") || path.startsWith("http") ? path : `/api/agent${path}`, { token: this.token, body });
  }

  private async ok(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.raw(method, path, body);
    if (res.status >= 400) throw new ApiError(res.status, res.body, `${this.name}: ${method} ${path}`);
    return res.body;
  }

  /** A Portico tool: list_porticos, create_portico, share_portico, join_portico, … */
  call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.ok("POST", `/portico-tools/${tool}`, args);
  }

  /** list_agents: `{ agents, … }`. */
  agents(portico?: string): Promise<any> {
    return this.ok("GET", `/agents${portico ? `?portico=${encodeURIComponent(portico)}` : ""}`);
  }

  /** send_message: `{ message, delivery, portico, note? }`. */
  send(input: SendInput): Promise<{ message: AgentMessage; delivery: string; portico: { id: string; name: string }; note?: string }> {
    return this.ok("POST", "/messages", input);
  }

  /** check_inbox once: what arrived since the last check. */
  async inbox(waitSeconds = 0): Promise<{ messages: AgentMessage[]; updates: { message_id: string; status: string }[] }> {
    const box = await this.ok("GET", `/inbox${waitSeconds ? `?wait=${waitSeconds}` : ""}`);
    this.got.push(...box.messages);
    this.gotUpdates.push(...box.updates);
    return box;
  }

  /** Checks the inbox until a message with this subject has arrived. */
  async receive(subject: string, timeoutMs = 20_000): Promise<AgentMessage> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = this.got.find((m) => m.subject === subject);
      if (found) return found;
      if (Date.now() > until) throw new Error(`${this.name} never received "${subject}". Received: ${this.got.map((m) => m.subject).join(", ") || "nothing"}.`);
      await this.inbox(3);
    }
  }

  /** Checks the inbox until Portico says what happened to a message this agent sent (delivered, declined, expired). */
  async outcome(messageId: string, timeoutMs = 20_000): Promise<string> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = this.gotUpdates.find((u) => u.message_id === messageId);
      if (found) return found.status;
      if (Date.now() > until) throw new Error(`${this.name} got no update about ${messageId}.`);
      await this.inbox(3);
    }
  }

  /** get_task: the conversation a message belongs to, with a download address for each file. */
  task(messageId: string): Promise<any> {
    return this.ok("GET", `/tasks/${messageId}`);
  }

  /** create_upload: small text goes in the call; bytes are PUT to the address the call answers. Returns the file ID. */
  async upload(name: string, content: string | Uint8Array, type?: string): Promise<string> {
    if (typeof content === "string") return (await this.ok("POST", "/files", { name, text: content, type })).file.id;
    const { file, upload } = await this.ok("POST", "/files", { name, size: content.byteLength, type });
    const put = await fetch(upload.url, { method: upload.method, body: content as unknown as BodyInit });
    if (!put.ok) throw new Error(`Uploading ${name} answered ${put.status}.`);
    return file.id;
  }

  /** The bytes of a file on one of this agent's messages, through the download address get_task gives. */
  async download(messageId: string, fileId: string): Promise<{ bytes: Buffer; url: string }> {
    const { messages } = await this.task(messageId);
    const file = messages.flatMap((m: any) => m.attachments ?? []).find((f: any) => f.id === fileId);
    if (!file) throw new Error(`Message ${messageId} carries no file ${fileId} for ${this.name}.`);
    if (!file.download_url) throw new Error(`No download address for ${file.name}: ${file.unavailable ?? "no reason given"}`);
    const res = await fetch(file.download_url);
    if (!res.ok) throw new Error(`Downloading ${file.name} answered ${res.status}.`);
    return { bytes: Buffer.from(await res.arrayBuffer()), url: file.download_url };
  }
}
