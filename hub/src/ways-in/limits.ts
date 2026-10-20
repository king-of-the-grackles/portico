import { bodyLimit } from "hono/body-limit";
import type { BridgeConfig } from "../core/types";

/** Rejects request bodies larger than three times the text limit with a JSON 413. */
export function jsonBodyLimit(config: BridgeConfig) {
  const maxBodyBytes = config.limits.maxTextKb * 1024 * 3;
  return bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) =>
      c.json({ error: "too_large", message: `Request body is larger than ${maxBodyBytes / 1024} KB.` }, 413),
  });
}
