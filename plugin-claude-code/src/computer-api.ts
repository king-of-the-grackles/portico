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
 * One call to Portico's computer API: `/api/computer/*`, with the computer token when there is one. A redirect is
 * answered, not followed, so a token goes only to the Portico named in computer.json or the join line. Throws
 * CommandError when Portico can't be reached; any HTTP answer is returned.
 */
export async function callPortico(
  url: string,
  method: "POST" | "PUT" | "DELETE",
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

/** Why Portico refused: its own message, or the HTTP status when it sent none. */
export function refusal(url: string, answer: PorticoAnswer): string {
  const message = typeof answer.body?.message === "string" ? withoutControls(answer.body.message).trim() : "";
  return message || `Portico at ${url} answered HTTP ${answer.status}.`;
}

/** Portico's text without control characters (C0, DEL and C1, ESC included), so it can't drive the terminal. */
export function withoutControls(text: string): string {
  return text.replace(/\p{Cc}/gu, "");
}
