import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { captureLogs } from "../src/log";
import { handleError } from "../src/ways-in/rest";
import { flush, makeApp, signIn } from "./helpers";

describe("app shell", () => {
  test("answers 200 at / without a token, revealing nothing", async () => {
    const { app } = makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ openapi: "/api/openapi.json", health: "/healthz" });
  });

  test("an unexpected error gives a generic 500 and logs only the error's class name", async () => {
    const app = new Hono();
    app.get("/boom", () => {
      throw new Error("SECRET-INSTRUCTIONS");
    });
    app.onError(handleError);
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    try {
      const res = await app.request("/boom");
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal", message: "Something went wrong." });
    } finally {
      captureLogs(null);
    }
    expect(lines.join("\n")).not.toContain("SECRET-INSTRUCTIONS");
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "error", msg: "unhandled_error", error: "Error" });
  });

  test("task text never reaches the logs", async () => {
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    try {
      const { call } = makeApp();
      const sent = await (
        await call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "SECRET-INSTRUCTIONS" })
      ).json();
      await call("claude-code", "GET", "/api/inbox");
      await call("claude-code", "POST", `/api/tasks/${sent.task.id}/finish`, { result: "SECRET-RESULT" });
      await call("muse", "POST", "/api/events", { name: "bug_report_received", details: "SECRET-DETAILS" });
      await flush();
    } finally {
      captureLogs(null);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/SECRET-/);
  });

  test("notes and failure reasons never reach the logs", async () => {
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    try {
      const { call, app, service } = makeApp();
      const cookie = await signIn(app);
      const ask = service.sendTask("grok-bot", { to: "muse", instructions: "to be denied" });
      const denied = await app.request(`/hub/tasks/${ask.id}/deny`, {
        method: "POST",
        headers: { cookie },
        body: new URLSearchParams({ note: "SECRET-NOTE" }),
      });
      // The note was stored, so a log that echoed it would show here.
      expect(denied.status).toBe(200);
      expect(service.findTask(ask.id)).toMatchObject({ status: "denied", reason: "SECRET-NOTE" });

      const sent = await (await call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "fails" })).json();
      await call("claude-code", "GET", "/api/inbox");
      await call("claude-code", "POST", `/api/tasks/${sent.task.id}/finish`, { failed_reason: "SECRET-FAILURE" });
      await flush();
    } finally {
      captureLogs(null);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/SECRET-/);
  });
});
