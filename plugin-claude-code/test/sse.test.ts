import { expect, test } from "bun:test";
import { SseParser } from "../src/sse";

const bytes = (text: string) => new TextEncoder().encode(text);

test("parses events, skips comments, and joins chunks split anywhere", () => {
  const parser = new SseParser();
  expect(parser.push(bytes(": connected\n\nevent: nudge\nda"))).toEqual([]);
  expect(parser.push(bytes("ta: {}\n\n: ping\n\nevent: permission\ndata: {\"request_id\":\"abcde\",\"behavior\":\"allow\"}\n\n"))).toEqual([
    { event: "nudge", data: "{}" },
    { event: "permission", data: '{"request_id":"abcde","behavior":"allow"}' },
  ]);
});

test("joins multi-line data, accepts CRLF, and names data-only messages 'message'", () => {
  const parser = new SseParser();
  expect(parser.push(bytes("data: a\r\ndata: b\r\n\r\nevent: replaced\ndata: {}\n\n"))).toEqual([
    { event: "message", data: "a\nb" },
    { event: "replaced", data: "{}" },
  ]);
});
