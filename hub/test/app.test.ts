import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { captureLogs } from "../src/log";
import { handleError } from "../src/ways-in/rest";
import { flush, makeApp } from "./helpers";

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

  test("notes, failure reasons and permission prompt text never reach the logs", async () => {
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    try {
      const { call, pushes, app } = makeApp();
      const pathOf = (label: string) =>
        new URL(pushes.at(-1)!.actions.find((action) => action.label === label)!.url).pathname;

      await call("grok-bot", "POST", "/api/tasks", { to: "muse", instructions: "to be denied" });
      await flush();
      await app.request(pathOf("Deny"), { method: "POST", body: new URLSearchParams({ note: "SECRET-NOTE" }) });

      const sent = await (await call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "fails" })).json();
      await call("claude-code", "GET", "/api/inbox");
      await call("claude-code", "POST", `/api/tasks/${sent.task.id}/finish`, { failed_reason: "SECRET-FAILURE" });

      await call("claude-code", "POST", "/api/permission-requests", {
        request_id: "abcde",
        tool_name: "Bash",
        description: "SECRET-DESCRIPTION",
        input_preview: "SECRET-PREVIEW",
      });
      await flush();
      await app.request(pathOf("Allow"), { method: "POST" });
      await flush();
    } finally {
      captureLogs(null);
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toMatch(/SECRET-/);
  });
});
