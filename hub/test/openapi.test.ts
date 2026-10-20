import { describe, expect, test } from "bun:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { openApiDocument } from "../src/ways-in/openapi";
import { makeApp, testConfig } from "./helpers";

describe("OpenAPI document", () => {
  test("is a valid OpenAPI 3.1 document", async () => {
    await SwaggerParser.validate(structuredClone(openApiDocument(testConfig())) as never);
  });

  test("is served without a token, pointing at the public URL", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/openapi.json");
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "https://bridge.test" }]);
  });

  test("every documented operation requires a token", async () => {
    const { app, config } = makeApp();
    const doc = openApiDocument(config);
    const seen: string[] = [];
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const method of Object.keys(operations)) {
        const res = await app.request(path.replace("{id}", "some-id"), { method: method.toUpperCase() });
        expect(`${method.toUpperCase()} ${path} -> ${res.status}`).toBe(`${method.toUpperCase()} ${path} -> 401`);
        seen.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(seen.sort()).toEqual([
      "GET /api/agents",
      "GET /api/inbox",
      "GET /api/tasks/{id}",
      "POST /api/events",
      "POST /api/tasks",
      "POST /api/tasks/{id}/finish",
    ]);
  });

  test("every documented operation is a real route", async () => {
    const { call, config } = makeApp();
    const doc = openApiDocument(config);
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const method of Object.keys(operations)) {
        const res = await call("grok-bot", method.toUpperCase(), path.replace("{id}", "some-id"), method === "post" ? {} : undefined);
        const body = (await res.json()) as { message?: string };
        expect(`${method} ${path}: ${body.message}`).not.toBe(`${method} ${path}: No such endpoint.`);
      }
    }
  });

  test("documents the idempotency key on sendTask", () => {
    const doc = openApiDocument(testConfig()) as unknown as {
      paths: { "/api/tasks": { post: { requestBody: { content: { "application/json": { schema: { properties: Record<string, { maxLength?: number }> } } } } } } };
    };
    const props = doc.paths["/api/tasks"].post.requestBody.content["application/json"].schema.properties;
    expect(props.idempotency_key?.maxLength).toBe(100);
  });
});
