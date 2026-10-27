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
    expect(doc.servers).toEqual([{ url: "https://portico.test" }]);
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
      "POST /api/messages",
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

  test("documents sendMessage, and live status on listAgents", () => {
    const doc = openApiDocument(testConfig()) as any;
    expect(doc.paths["/api/messages"].post.operationId).toBe("sendMessage");
    const props = doc.paths["/api/messages"].post.requestBody.content["application/json"].schema.properties;
    expect(Object.keys(props).sort()).toEqual(["reply_to", "text", "to"]);
    expect(props.text.description).toContain("64 KB");
    const items = doc.paths["/api/agents"].get.responses["200"].content["application/json"].schema.properties.agents.items;
    const entry = items.$ref ? doc.components.schemas[items.$ref.split("/").pop()] : items;
    expect(entry.properties).toHaveProperty("status");
    expect(entry.properties).toHaveProperty("doing");
    const sent = doc.paths["/api/tasks"].post.responses["201"].content["application/json"].schema;
    expect(sent.properties).toHaveProperty("delivery");
    const inbox = doc.paths["/api/inbox"].get.responses["200"].content["application/json"].schema;
    expect(inbox.properties).toHaveProperty("messages");
    // Results come framed, like tasks and messages.
    expect(inbox.properties.results.items.$ref).toBe("#/components/schemas/InboxResult");
    expect(doc.components.schemas.InboxResult.allOf[1].required).toEqual(["framed_message"]);
  });

  test("leaves out the plugin-only routes and the join route", () => {
    const paths = Object.keys(openApiDocument(testConfig()).paths);
    for (const path of ["/api/deliveries", "/api/deliveries/ack", "/api/status", "/api/join", "/api/stream", "/api/approvals/{taskId}"]) {
      expect(paths).not.toContain(path);
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
