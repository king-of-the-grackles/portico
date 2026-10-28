import { createHash } from "node:crypto";
import { join } from "node:path";
import { Hono } from "hono";
import { errorName, log } from "../log";
import { CODEX_BRIDGE } from "./codex-bundle.gen";

/** The bridge's entry in the repo, for runs from source. */
export const BRIDGE_ENTRY = join(import.meta.dir, "..", "..", "..", "plugin-claude-code", "src", "codex", "main.ts");

/** The Codex bridge as one file of JavaScript for Bun, its dependencies included. */
export async function buildBridge(entry: string = BRIDGE_ENTRY): Promise<string> {
  const result = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm" });
  if (!result.success || !result.outputs[0]) {
    throw new Error(`The Codex bridge didn't build: ${result.logs.map((entry) => entry.message).join("; ")}`);
  }
  return await result.outputs[0].text();
}

let bridge: Promise<{ body: string; etag: string }> | null = null;

/** The bridge and its ETag: the sha256 of the file, which the bridge compares with its own to see it's out of date. */
function served(): Promise<{ body: string; etag: string }> {
  bridge ??= (async () => {
    const body = CODEX_BRIDGE ?? (await buildBridge());
    return { body, etag: `"${createHash("sha256").update(body).digest("hex")}"` };
  })();
  bridge.catch(() => {
    bridge = null;
  });
  return bridge;
}

/**
 * GET /codex/portico-codex.js: the bridge Codex runs, one conversation per process. Public: the file holds no secrets
 * (the computer's token stays in ~/.portico/computer.json), and the same code is in the repo.
 */
export function codexBridgeRoutes(): Hono {
  const route = new Hono();
  route.get("/portico-codex.js", async (c) => {
    let file: { body: string; etag: string };
    try {
      file = await served();
    } catch (err) {
      log("error", "codex_bridge_build_failed", { error: errorName(err) });
      return c.json({ error: "internal", message: "The Codex bridge isn't available on this Portico." }, 500);
    }
    if (c.req.header("if-none-match") === file.etag) return c.body(null, 304, { ETag: file.etag });
    const headers = { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", ETag: file.etag };
    // HEAD (the bridge's update check) gets the headers alone.
    return c.req.method === "HEAD" ? c.body(null, 200, headers) : c.body(file.body, 200, headers);
  });
  return route;
}
