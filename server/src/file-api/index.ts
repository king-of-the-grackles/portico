import { Hono } from "hono";
import { handleError } from "../agent-api/rest";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import { downloadDisposition } from "../core/file-store";

/**
 * /files/:id, for a Portico that keeps files in the data folder: the upload and download addresses Portico signs. The
 * signature is the whole permission, as with a bucket's addresses: each names one file and one use, and works for a few
 * minutes. A download address also names the workspace whose copy is read (`w`), under the same signature, so the route
 * opens that one workspace's content and never looks through others; an address with no `w` is an upload no message
 * carries yet. With a bucket these routes answer 404, since no address points here.
 */
export function fileRoutes(core: Core): Hono {
  const route = new Hono();
  const { files } = core;

  const requireSigned = (op: "put" | "get", workspaceId: string | null, id: string, exp: string | undefined, sig: string | undefined) => {
    if (!files.signed(op, workspaceId, id, exp, sig)) {
      throw new PorticoError("not_found", "This file address doesn't work, or stopped working. Ask Portico for a new one.");
    }
  };

  // The bytes go from the request straight to disk: nothing is held in memory, and nothing is parsed.
  route.put("/:id", async (c) => {
    const id = c.req.param("id");
    requireSigned("put", null, id, c.req.query("exp"), c.req.query("sig"));
    const file = await files.receive(id, c.req.raw.body);
    return c.json({ file: { id: file.id, name: file.name, type: file.type, size: file.size, status: file.status } });
  });

  // Always a download, never a page: no type a browser would render, no sniffing, and no scripts if it rendered anyway.
  route.get("/:id", (c) => {
    const id = c.req.param("id");
    const workspaceId = c.req.query("w") || null;
    requireSigned("get", workspaceId, id, c.req.query("exp"), c.req.query("sig"));
    const stored = files.stored(workspaceId, id);
    if (!stored) throw new PorticoError("not_found", "No such file.");
    return new Response(Bun.file(stored.path), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(stored.file.size),
        "Content-Disposition": downloadDisposition(stored.file.name),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
      },
    });
  });

  route.onError(handleError);
  return route;
}
