import { describe, expect, test } from "bun:test";
import { renderTemplate, unknownPlaceholders } from "../src/core/templates";

const event = { agent: "muse", name: "bug_report_received", details: "Login page 500s. Cost: $5" };

describe("renderTemplate", () => {
  test("fills the three placeholders, with or without spaces", () => {
    expect(renderTemplate("{{event.agent}} said {{ event.name }}: {{event.details}}", event)).toBe(
      "muse said bug_report_received: Login page 500s. Cost: $5",
    );
  });

  test("leaves unknown placeholders alone", () => {
    expect(renderTemplate("x {{event.other}} y", event)).toBe("x {{event.other}} y");
  });
});

describe("unknownPlaceholders", () => {
  test("lists placeholders that aren't allowed", () => {
    expect(unknownPlaceholders("{{event.details}} {{ user.email }} {{event.other}}")).toEqual([
      "user.email",
      "event.other",
    ]);
    expect(unknownPlaceholders("plain text")).toEqual([]);
  });
});
