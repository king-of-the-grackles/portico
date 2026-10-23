import { bodyLimit } from "hono/body-limit";
import type { PorticoConfig } from "../core/types";

/** The larger text limit, tasks' or messages', in KB: request bodies are sized from it. */
export function maxTextOrMessageKb(config: PorticoConfig): number {
  return Math.max(config.limits.maxTextKb, config.limits.maxMessageKb);
}

/** Rejects request bodies larger than three times the larger text limit with a JSON 413. */
export function jsonBodyLimit(config: PorticoConfig) {
  const maxBodyBytes = maxTextOrMessageKb(config) * 1024 * 3;
  return bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) =>
      c.json({ error: "too_large", message: `Request body is larger than ${maxBodyBytes / 1024} KB.` }, 413),
  });
}
