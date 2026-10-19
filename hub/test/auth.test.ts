import { expect, test } from "bun:test";
import { makeAgentResolver } from "../src/ways-in/auth";
import { TOKENS, testConfig } from "./helpers";

test("resolves agents from bearer tokens", () => {
  const resolve = makeAgentResolver(testConfig());
  expect(resolve(`Bearer ${TOKENS.muse}`)).toBe("muse");
  expect(resolve(`bearer   ${TOKENS["grok-bot"]}  `)).toBe("grok-bot");
  expect(resolve("Bearer wrong-token-0123456789abcdef")).toBeNull();
  expect(resolve(TOKENS.muse)).toBeNull();
  expect(resolve(undefined)).toBeNull();
});
