import { bodyLimit } from "hono/body-limit";
import { MAX_BODY_BYTES } from "../core/limits";

/** Rejects request bodies larger than three times the message limit with a JSON 413. */
export function jsonBodyLimit() {
  return bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json({ error: "too_large", message: `The request body is larger than ${MAX_BODY_BYTES / 1024} KB.` }, 413),
  });
}
