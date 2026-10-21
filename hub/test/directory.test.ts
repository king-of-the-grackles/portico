import { expect, test } from "bun:test";
import { Directory, SESSION_LIST_HOURS } from "../src/core/directory";
import { hashSecret } from "../src/core/tokens";
import { addSession, errorCode, HOUR, makeApp, mintAssistant, T0 } from "./helpers";

test("members are the bridge.yaml agents, the assistants and the recent sessions, each with a kind", () => {
  const ctx = makeApp();
  mintAssistant(ctx, "chatgpt", "chatgpt");
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  const byAddress = Object.fromEntries(ctx.directory.members().map((m) => [m.address, m.kind]));
  expect(byAddress).toMatchObject({
    "claude-code": "claude-code",
    "grok-bot": "grok-bot",
    muse: "muse",
    codex: "codex",
    chatgpt: "chatgpt",
    "dialog-claude@macbook": "claude-code",
  });
  expect(ctx.directory.members().map((m) => m.source)).toEqual(["config", "config", "config", "config", "assistant", "session"]);
  expect(ctx.directory.find("dialog-claude@macbook")).toMatchObject({
    name: "dialog-claude",
    delivery: "push",
    machine: "macbook",
    source: "session",
  });
  expect(ctx.directory.find("chatgpt")).toMatchObject({ delivery: "pull", machine: null, source: "assistant" });
});

test("resolve takes a full address, or a short session name when it's unique", () => {
  const ctx = makeApp();
  mintAssistant(ctx, "chatgpt", "chatgpt");
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(ctx.directory.resolve("dialog-claude@macbook", "muse").address).toBe("dialog-claude@macbook");
  expect(ctx.directory.resolve("dialog-claude", "muse").address).toBe("dialog-claude@macbook");
  expect(ctx.directory.resolve("muse", "grok-bot")).toMatchObject({ address: "muse", source: "config" });
  expect(ctx.directory.resolve("chatgpt", "muse")).toMatchObject({ address: "chatgpt", source: "assistant" });
  expect(errorCode(() => ctx.directory.resolve("dialog-claude@studio", "muse"))).toBe("unknown_agent");
  for (const bad of [undefined, 42, "", "   "]) expect(errorCode(() => ctx.directory.resolve(bad, "muse"))).toBe("bad_request");
});

test("an ambiguous short name lists its candidates", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "studio" });
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(errorCode(() => ctx.directory.resolve("dialog-claude", "muse"))).toBe("unknown_agent");
  expect(() => ctx.directory.resolve("dialog-claude", "muse")).toThrow(
    '"dialog-claude" is on 2 machines. Use one of: dialog-claude@macbook, dialog-claude@studio.',
  );
  expect(ctx.directory.resolve("dialog-claude@studio", "muse").address).toBe("dialog-claude@studio");
});

test("resolve refuses broadcasts", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  for (const to of ["*", "dialog-*", "kind:claude-code", "a?"]) expect(errorCode(() => ctx.directory.resolve(to, "muse"))).toBe("bad_request");
});

test("an unknown name lists the valid names, without the caller", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(() => ctx.directory.resolve("nobody", "dialog-claude@macbook")).toThrow(
    'No agent named "nobody". Valid agents: grok-bot, claude-code, muse, codex.',
  );
  expect(() => ctx.directory.resolve("nobody", "muse")).toThrow(
    'No agent named "nobody". Valid agents: grok-bot, claude-code, codex, dialog-claude.',
  );
});

test("sessions and push agents are push members; assistants and pull agents aren't", () => {
  const ctx = makeApp();
  mintAssistant(ctx, "chatgpt", "chatgpt");
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(ctx.directory.isPush("dialog-claude@macbook")).toBe(true);
  expect(ctx.directory.isPush("claude-code")).toBe(true);
  expect(ctx.directory.isPush("chatgpt")).toBe(false);
  expect(ctx.directory.isPush("muse")).toBe(false);
  expect(ctx.directory.isPush("nobody")).toBe(false);
  expect(ctx.directory.isPush("dialog-claude")).toBe(false); // a short name isn't an address
});

test("a session not seen for 24 hours leaves members() but still resolves by full address", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(SESSION_LIST_HOURS).toBe(24);
  ctx.clock.advance(24 * HOUR);
  expect(ctx.directory.members().map((m) => m.address)).toContain("dialog-claude@macbook");
  ctx.clock.advance(1);
  expect(ctx.directory.members().map((m) => m.address)).not.toContain("dialog-claude@macbook");
  expect(ctx.directory.find("dialog-claude@macbook")).not.toBeNull();
  expect(ctx.directory.resolve("dialog-claude@macbook", "muse").address).toBe("dialog-claude@macbook");
  // A session with an open stream stays listed however long ago its row was written.
  const connected = new Directory({
    config: ctx.config,
    network: ctx.network,
    isConnected: (address) => address === "dialog-claude@macbook",
    presence: ctx.presence,
    now: ctx.clock.now,
  });
  expect(connected.members().map((m) => m.address)).toContain("dialog-claude@macbook");
});

test("displayName is the short form when unique, else the full address", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(ctx.directory.displayName("dialog-claude@macbook")).toBe("dialog-claude");
  expect(ctx.directory.displayName("muse")).toBe("muse");
  addSession(ctx, { name: "dialog-claude", machine: "studio" });
  expect(ctx.directory.displayName("dialog-claude@macbook")).toBe("dialog-claude@macbook");
  expect(ctx.directory.displayName("nobody@nowhere")).toBe("nobody@nowhere");
});

test("ref gives the member's kind, or unknown", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(ctx.directory.ref("dialog-claude@macbook")).toEqual({ address: "dialog-claude@macbook", kind: "claude-code" });
  expect(ctx.directory.ref("muse")).toEqual({ address: "muse", kind: "muse" });
  expect(ctx.directory.ref("nobody")).toEqual({ address: "nobody", kind: "unknown" });
});

test("an assistant named like a bridge.yaml agent is shadowed by it", () => {
  const ctx = makeApp();
  ctx.network.insertAssistant(
    { id: "a-muse", owner: "owner", name: "muse", kind: "other", description: "Imposter", createdAt: T0.toISOString() },
    hashSecret("ba_imposter"),
  );
  expect(ctx.directory.members().filter((m) => m.address === "muse")).toEqual([
    expect.objectContaining({ source: "config", description: "Meta Muse" }),
  ]);
  expect(ctx.directory.find("muse")?.source).toBe("config");
  expect(ctx.directory.resolve("muse", "grok-bot").source).toBe("config");
});
