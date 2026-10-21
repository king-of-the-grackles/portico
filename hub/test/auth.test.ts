import { expect, test } from "bun:test";
import { hashSecret } from "../src/core/tokens";
import { openDb } from "../src/db";
import { NetworkStore } from "../src/network-store";
import { makeResolvers } from "../src/ways-in/auth";
import { addSession, makeApp, mintAssistant, T0, TOKENS, testConfig } from "./helpers";

test("resolves agents from bearer tokens", () => {
  const resolve = makeResolvers(testConfig(), new NetworkStore(openDb(":memory:"))).agent;
  expect(resolve(`Bearer ${TOKENS.muse}`)).toBe("muse");
  expect(resolve(`bearer   ${TOKENS["grok-bot"]}  `)).toBe("grok-bot");
  expect(resolve("Bearer wrong-token-0123456789abcdef")).toBeNull();
  expect(resolve(TOKENS.muse)).toBeNull();
  expect(resolve(undefined)).toBeNull();
});

test("an assistant's minted token resolves to its name; once removed, to nothing", () => {
  const ctx = makeApp();
  const { token } = mintAssistant(ctx, "chatgpt", "chatgpt");
  expect(ctx.resolvers.agent(`Bearer ${token}`)).toBe("chatgpt");
  expect(ctx.resolvers.principal(`Bearer ${token}`)).toEqual({ type: "member", address: "chatgpt" });
  ctx.networkService.removeAssistant("chatgpt");
  expect(ctx.resolvers.agent(`Bearer ${token}`)).toBeNull();
  expect(ctx.resolvers.principal(`Bearer ${token}`)).toBeNull();
});

test("a machine token alone is the machine; with a registered key it's that session; with an unknown key it's nothing", () => {
  const ctx = makeApp();
  const { code } = ctx.networkService.createJoinCode();
  const { machine, token } = ctx.networkService.redeemJoinCode(code, "macbook");
  addSession(ctx, { name: "dialog-claude", machine: "macbook", key: "key-12345678" });
  expect(ctx.resolvers.principal(`Bearer ${token}`)).toEqual({ type: "machine", machine: expect.objectContaining({ id: machine.id }) });
  expect(ctx.resolvers.principal(`Bearer ${token}`, "key-12345678")).toEqual({ type: "member", address: "dialog-claude@macbook" });
  expect(ctx.resolvers.agent(`Bearer ${token}`, "key-12345678")).toBe("dialog-claude@macbook");
  expect(ctx.resolvers.agent(`Bearer ${token}`, "unknown-key-1")).toBeNull();
  expect(ctx.resolvers.agent(`Bearer ${token}`)).toBeNull();
  // Removal, not revocation: the machine's token fails at once.
  ctx.networkService.removeMachine("macbook");
  expect(ctx.resolvers.principal(`Bearer ${token}`)).toBeNull();
  expect(ctx.resolvers.agent(`Bearer ${token}`, "key-12345678")).toBeNull();
});

test("a session key only works with its own machine's token", () => {
  const ctx = makeApp();
  const studio = ctx.networkService.redeemJoinCode(ctx.networkService.createJoinCode().code, "studio");
  ctx.networkService.redeemJoinCode(ctx.networkService.createJoinCode().code, "macbook");
  addSession(ctx, { name: "dialog-claude", machine: "macbook", key: "key-12345678" });
  expect(ctx.resolvers.agent(`Bearer ${studio.token}`, "key-12345678")).toBeNull();
});

test("a machine's last_seen_at is written at most once a minute", () => {
  const ctx = makeApp();
  const { token } = ctx.networkService.redeemJoinCode(ctx.networkService.createJoinCode().code, "macbook");
  const lastSeen = () => ctx.network.machineByName("macbook")?.lastSeenAt;
  expect(lastSeen()).toBeNull();
  ctx.resolvers.principal(`Bearer ${token}`);
  expect(lastSeen()).toBe(T0.toISOString());
  ctx.clock.advance(59_000);
  ctx.resolvers.principal(`Bearer ${token}`);
  expect(lastSeen()).toBe(T0.toISOString());
  ctx.clock.advance(1_000);
  ctx.resolvers.principal(`Bearer ${token}`);
  expect(lastSeen()).toBe(new Date(T0.getTime() + 60_000).toISOString());
});

test("the session header is ignored for bridge.yaml and assistant tokens", () => {
  const ctx = makeApp();
  const { token } = mintAssistant(ctx, "chatgpt", "chatgpt");
  addSession(ctx, { name: "dialog-claude", machine: "macbook", key: "key-12345678" });
  expect(ctx.resolvers.agent(`Bearer ${TOKENS.muse}`, "key-12345678")).toBe("muse");
  expect(ctx.resolvers.principal(`Bearer ${TOKENS.muse}`, "key-12345678")).toEqual({ type: "member", address: "muse" });
  expect(ctx.resolvers.agent(`Bearer ${token}`, "key-12345678")).toBe("chatgpt");
  expect(ctx.resolvers.agent(`Bearer ${token}`, "unknown-key-1")).toBe("chatgpt");
});

test("an assistant shadowed by a bridge.yaml agent of the same name doesn't resolve", () => {
  const ctx = makeApp();
  const token = "ba_imposter-token-0123456789abcdefghijklmnopq";
  ctx.network.insertAssistant(
    { id: "a-muse", owner: "owner", name: "muse", kind: "other", description: "Imposter", createdAt: T0.toISOString() },
    hashSecret(token),
  );
  expect(ctx.resolvers.agent(`Bearer ${token}`)).toBeNull();
  expect(ctx.resolvers.principal(`Bearer ${token}`)).toBeNull();
  expect(ctx.resolvers.agent(`Bearer ${TOKENS.muse}`)).toBe("muse");
});

test("REST calls with a machine token act as the session named by X-Bridge-Session", async () => {
  const ctx = makeApp();
  const { token } = ctx.networkService.redeemJoinCode(ctx.networkService.createJoinCode().code, "macbook");
  addSession(ctx, { name: "dialog-claude", machine: "macbook", key: "key-12345678" });
  const agents = (headers: Record<string, string>) =>
    ctx.app.request("/api/agents", { headers: { authorization: `Bearer ${token}`, ...headers } });
  expect((await agents({})).status).toBe(401);
  expect((await agents({ "x-bridge-session": "unknown-key-1" })).status).toBe(401);
  const res = await agents({ "x-bridge-session": "key-12345678" });
  expect(res.status).toBe(200);
  const names = ((await res.json()) as { agents: { name: string }[] }).agents.map((agent) => agent.name);
  expect(names).toEqual(["grok-bot", "claude-code", "muse", "codex"]);
});
