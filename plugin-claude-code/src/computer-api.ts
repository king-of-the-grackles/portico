// Runs before the plugin's dependencies are installed (the join, off, on and leave commands), so it imports only the
// global fetch and nothing else.

/** A command that can't go ahead. The message is for the person running it. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/** How long Portico gets to answer a command. */
const TIMEOUT_MS = 15_000;

export interface PorticoAnswer {
  status: number;
  ok: boolean;
  /** The JSON body, or null when there is none or it isn't an object. */
  body: Record<string, unknown> | null;
}

/**
 * One call to Portico for a computer: `/api/computer/*` with the computer token, or `/api/join` while joining. A redirect is
 * answered, not followed, so a token goes only to the Portico named in computer.json or in the join command. Throws
 * CommandError when Portico can't be reached; any HTTP answer is returned.
 */
export async function callPortico(
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { token?: string; body?: unknown; fetch?: typeof fetch } = {},
): Promise<PorticoAnswer> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${url}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new CommandError(`Portico at ${url} could not be reached.`);
  }
  const data = (await res.json().catch(() => null)) as unknown;
  const body = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  return { status: res.status, ok: res.ok, body };
}

/** The most of a server's own message that is passed on. */
const MAX_REFUSAL_CHARS = 300;

/**
 * Why Portico refused: its own message, or the HTTP status when it sent none. The message is the server's text, and the
 * command's output is read by an agent as much as a person, so it is cut to a length and shown as a quote from that
 * server: never as the command's own words.
 */
export function refusal(url: string, answer: PorticoAnswer): string {
  const message = typeof answer.body?.message === "string" ? withoutControls(answer.body.message).replace(/\s+/g, " ").replace(/"/g, "'").trim() : "";
  if (!message) return `Portico at ${url} answered HTTP ${answer.status}.`;
  const chars = Array.from(message);
  const shown = chars.length > MAX_REFUSAL_CHARS ? `${chars.slice(0, MAX_REFUSAL_CHARS).join("")}…` : message;
  return `Portico at ${url} answered: "${shown}"`;
}

/** A computer's name as Portico makes one: lowercase letters, digits and single hyphens: a slug of at most 40 characters, with room for the ending Portico adds to keep names apart. */
const COMPUTER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Whether a name a server sent is a computer name of the shape Portico makes, and nothing else. */
export function isComputerName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 60 && COMPUTER_NAME.test(value);
}

/** Portico's text without control characters (C0, DEL and C1, ESC included), format characters or line separators, so it can't drive the terminal or reorder what shows. */
export function withoutControls(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");
}
