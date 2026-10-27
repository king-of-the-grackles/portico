import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server";
import { testConfig } from "./helpers";

describe("server", () => {
  test("starts on a free port with a database file, answers health checks, and stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "portico-server-"));
    const running = startServer(testConfig({ dbPath: join(dir, "portico.db"), dataDir: dir }), { port: 0 });
    try {
      const res = await fetch(`http://localhost:${running.port}/healthz`);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      running.stop();
    }
  });
});
