import { Hono } from "hono";
import type { Core } from "../core/core";

/**
 * /api/computer: what a computer does with its own token. POST /join redeems a join line, DELETE / leaves Portico,
 * PUT /folders/:folderId sets a folder's switch. Built by the Onboarding track.
 */
export function computerApi(_core: Core): Hono {
  return new Hono();
}
