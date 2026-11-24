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
  poll_secret: string;
  expires_at: string;
  /** The sentence the agent shows its person. */
  show: string;
}

/** POST /api/join: counts against the server's limit of starts per address per 15 minutes (10, unless the deployment raised it). */
export async function startJoin(name: string, shareLink?: string): Promise<Join> {
  const { status, body } = await http("POST", "/api/join", { body: { kind: "agent", name, client: "other", ...(shareLink ? { link: shareLink } : {}) } });
  if (status === 429) throw new Error("The server's join limit is used up for this address (starts per 15 minutes). On a test deployment, raise PORTICO_JOIN_STARTS_PER_ADDRESS (e2e/README.md); otherwise wait, then run with E2E_KEEP=1 so reruns reuse their agents.");
  if (status !== 201) throw new ApiError(status, body, "POST /api/join");
  return body;
}

/** GET /api/join/:id with the poll secret: the status and nothing else (pending, allowed, approved, denied, expired). */
export async function joinStatus(join: Join): Promise<any> {
  const { status, body } = await http("GET", `/api/join/${join.id}`, { token: join.poll_secret });
  if (status !== 200) throw new ApiError(status, body, "GET /api/join/:id");
  return body;
}

/** POST /api/join/:id/code: the agent hands in the code its person read on the page. `{ status, body }`, never throws. */
export function submitJoinCode(join: Join, code: string) {
  return http("POST", `/api/join/${join.id}/code`, { token: join.poll_secret, body: { code } });
}

export interface AllowOptions {
  /** A handle for a person who has none yet: the page asks with the first Allow. */
  handle?: string;
  /**
   * On a join: say "started this join myself". Default true; without it the newcomer's first messages are held once.
   * The page no longer asks; the person API still takes the field, and the suite sends it as a shortcut, so that a
   * spec about something else isn't stopped by a held first message.
   */
  mine?: boolean;
}

/**
 * The consent page, as the signed-in person answers it: a handle the first time, the "started this myself" tick on a
 * join, Allow. Works for a join and for anything an agent the person already has asks (share, come in with a link,
 * delete): those end on "Allowed". A join ends on the page that shows the code, and the code is returned.
 */
export async function allowOnConsentPage(page: Page, ask: { link: string }, opts: AllowOptions = {}): Promise<string | null> {
  await page.goto(ask.link);
  const handle = page.getByLabel("Handle");
  if (opts.handle && (await handle.count()) > 0) await handle.fill(opts.handle);
  if (opts.mine !== false) await sayStartedThisJoin(page);
  await page.locator('button[name="decision"][value="approve"]').click();
  const heading = page.getByRole("heading", { level: 1, name: /^(Allowed|Joined|Share this code with your agent)$/ });
  await expect(heading).toBeVisible();
  if ((await heading.innerText()).trim() !== "Share this code with your agent") return null;
  return readJoinCode(page);
}

/**
 * Adds "started this join myself" to the consent page's form. The page no longer asks, and the person API still takes
 * the field: with it the newcomer isn't held for being new, so a spec about something else isn't stopped by that.
 */
export async function sayStartedThisJoin(page: Page): Promise<void> {
  await page.locator("form[data-api]").first().evaluate((form) => {
    const tick = document.createElement("input");
    Object.assign(tick, { type: "checkbox", name: "mine", checked: true, hidden: true });
    form.append(tick);
  });
}

/** The 4-digit code on the page a join shows after Allow. */
export async function readJoinCode(page: Page): Promise<string> {
  const shown = (await page.locator(".join-code").innerText()).replace(/\D/g, "");
  expect(shown, "the code the page shows after Allow").toMatch(/^\d{4}$/);
  return shown;
}

/**
 * A whole join: the person presses Allow on the page, the page shows a code, and the agent hands the code in with its
 * poll secret and gets its token. The one place to change when the join flow changes.
 */
export async function joinThroughPage(page: Page, join: Join, opts: AllowOptions = {}): Promise<string> {
  const code = await allowOnConsentPage(page, join, opts);
  if (code === null) throw new Error("The consent page showed no code after Allow.");
  const { status, body } = await submitJoinCode(join, code);
  if (status >= 400 || !body?.token) throw new ApiError(status, body, "POST /api/join/:id/code");
  return body.token;
}

/**
 * A held message's own page, /held/<id>, answered by the signed-in person: Allow (this message), Always allow (the
 * tick on the page, then Allow) or Don't allow.
 */
export async function decideHeld(page: Page, messageId: string, choice: "Allow" | "Always allow" | "Don't allow"): Promise<void> {
  await page.goto(`/held/${messageId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Allow this message?" })).toBeVisible();
  if (choice === "Always allow") await page.getByRole("checkbox", { name: /^Always allow / }).check();
  await page.getByRole("button", { name: choice === "Don't allow" ? "Don't allow" : "Allow", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Already decided" })).toBeVisible();
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
  /** The sender needs no reply. */
  no_reply_needed: boolean;
  /** From the inbox: the message inside Portico's frame. */
  framed_message?: string;
  portico: { id: string; name: string };
  attachments: { id: string; name: string; type: string; size: number; url: string }[];
}

export interface SendInput {
  to?: string;
  subject: string;
  text: string;
  reply_to?: string;
  done?: boolean;
  no_reply_needed?: boolean;
  attachments?: string[];
}

/** One of Portico's own notices, as the inbox hands it over. `question` is set on the one about how a question ended. */
export interface AgentNotice {
  id: string;
  text: string;
  framed_message: string;
  question?: { id: string; status: string; level: string | null; via: string | null };
}

/** What request_input answers: the question, with the link the agent shows its person. */
export interface AskedQuestion {
  question: { id: string; status: string; question: string; options: string[] | null; task: string | null; expires_at: string; link: string };
  show: string;
  note: string;
}

export class AgentClient {
  /** Everything the inbox handed over so far: a check takes messages out of the inbox, so they are kept here. */
  private got: AgentMessage[] = [];
  private gotUpdates: { message_id: string; status: string }[] = [];
  private gotNotices: AgentNotice[] = [];

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
  async inbox(waitSeconds = 0): Promise<{ messages: AgentMessage[]; updates: { message_id: string; status: string }[]; notices: AgentNotice[]; input_needed?: number; input_note?: string }> {
    const box = await this.ok("GET", `/inbox${waitSeconds ? `?wait=${waitSeconds}` : ""}`);
    this.got.push(...box.messages);
    this.gotUpdates.push(...box.updates);
    this.gotNotices.push(...(box.notices ?? []));
    return box;
  }

  /** request_input: asks this agent's own person a question. `{ question, show, note }`. */
  requestInput(input: { question: string; detail?: string; options?: string[]; task?: string; expires_in_minutes?: number }): Promise<AskedQuestion> {
    return this.ok("POST", "/questions", input);
  }

  /** Checks the inbox until Portico's notice about how a question ended has arrived. */
  async answerTo(questionId: string, timeoutMs = 20_000): Promise<AgentNotice> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const found = this.gotNotices.find((n) => n.question?.id === questionId);
      if (found) return found;
      if (Date.now() > until) throw new Error(`${this.name} got no notice about the question ${questionId}.`);
      await this.inbox(3);
    }
  }

  /** How many notices about the question the inbox has handed over so far: one, however often the inbox is checked. */
  noticesAbout(questionId: string): number {
    return this.gotNotices.filter((n) => n.question?.id === questionId).length;
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
