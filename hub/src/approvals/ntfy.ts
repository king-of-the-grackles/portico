import type { NtfyConfig } from "../core/types";
import { errorName, log } from "../log";

export interface PushAction {
  action: "http" | "view";
  label: string;
  url: string;
  method?: "POST";
  /** Dismiss the notification once the button is tapped. */
  clear?: boolean;
}

export interface PushMessage {
  title: string;
  message: string;
  /** Opened when the notification itself is tapped. */
  click?: string;
  priority: 3 | 4;
  tags: string[];
  actions: PushAction[];
  /** Messages sharing a sequence ID replace each other on clients that support updates. */
  sequenceId?: string;
}

/** Sends a push. Resolves true when ntfy accepted it; never rejects. */
export type Pusher = (message: PushMessage) => Promise<boolean>;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

export function makePusher(
  ntfy: NtfyConfig | null,
  deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<unknown> } = {},
): Pusher {
  if (!ntfy) return async () => false;
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (ntfy.token) headers.authorization = `Bearer ${ntfy.token}`;

  return async (message) => {
    // JSON publishing to the server root carries UTF-8 titles (like "→") that header publishing can't.
    const { sequenceId, ...fields } = message;
    const body = JSON.stringify({
      topic: ntfy.topic,
      ...fields,
      ...(sequenceId !== undefined ? { sequence_id: sequenceId } : {}),
    });
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
      try {
        const res = await doFetch(ntfy.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
        if (res.ok) return true;
        log("warn", "push_rejected", { status: res.status, attempt: attempt + 1 });
        // A 4xx other than 429 (bad token, bad topic) won't succeed on a retry.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (err) {
        log("warn", "push_error", { error: errorName(err), attempt: attempt + 1 });
      }
    }
    log("error", "push_failed", {});
    return false;
  };
}
