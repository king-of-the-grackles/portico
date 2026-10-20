import { describe, expect, test } from "bun:test";
import { linkUrl, signLink, signToken, verifyLink, verifyToken } from "../src/approvals/links";

const SECRET = "test-signing-secret-0123456789abcdef";
const NOW = new Date("2026-10-20T12:00:00.000Z");
const LATER = "2026-10-21T12:00:00.000Z";
const claims = { subject: "task", id: "task-1", action: "approve", expiresAt: LATER } as const;

describe("signed links", () => {
  test("round-trip for tasks and permission prompts", () => {
    expect(verifyLink(SECRET, signLink(SECRET, claims), NOW)).toEqual(claims);
    const perm = { subject: "permission", id: "abcde", agent: "claude-code", action: "deny", expiresAt: LATER } as const;
    expect(verifyLink(SECRET, signLink(SECRET, perm), NOW)).toEqual(perm);
  });

  test("rejects another secret, a changed payload, or a changed signature", () => {
    const token = signLink(SECRET, claims);
    expect(verifyLink("another-secret-0123456789abcdefghij", token, NOW)).toBeNull();
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, id: "task-2" })).toString("base64url");
    expect(verifyLink(SECRET, `${forged}.${signature}`, NOW)).toBeNull();
    // Change the first character: every bit of it is significant (the last one carries padding bits).
    const flipped = `${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`;
    expect(verifyLink(SECRET, `${payload}.${flipped}`, NOW)).toBeNull();
  });

  test("rejects an expired token", () => {
    const token = signLink(SECRET, { ...claims, expiresAt: "2026-10-20T11:59:59.000Z" });
    expect(verifyLink(SECRET, token, NOW)).toBeNull();
  });

  test("a session token is not a link, and the reverse", () => {
    const session = signToken(SECRET, "session", { expiresAt: LATER });
    expect(verifyToken(SECRET, "session", session, NOW)).toEqual({ expiresAt: LATER });
    expect(verifyLink(SECRET, session, NOW)).toBeNull();
    expect(verifyToken(SECRET, "session", signLink(SECRET, claims), NOW)).toBeNull();
  });

  test("rejects malformed tokens and incomplete claims", () => {
    for (const bad of ["", "abc", "a.b.c", "!!!.???", `${Buffer.from("not json").toString("base64url")}.x`]) {
      expect(verifyLink(SECRET, bad, NOW)).toBeNull();
    }
    const noAgent = signToken(SECRET, "link", { subject: "permission", id: "abcde", action: "approve", expiresAt: LATER });
    expect(verifyLink(SECRET, noAgent, NOW)).toBeNull();
    expect(verifyLink(SECRET, signToken(SECRET, "link", { ...claims, action: "maybe" }), NOW)).toBeNull();
    expect(verifyLink(SECRET, signToken(SECRET, "link", { ...claims, expiresAt: undefined }), NOW)).toBeNull();
  });

  test("linkUrl puts the action in the path", () => {
    expect(linkUrl("https://hub.example.com", "tok", "deny")).toBe("https://hub.example.com/deny/tok");
  });
});
