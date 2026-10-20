import { describe, expect, test } from "bun:test";
import { verifyLink } from "../src/approvals/links";
import { approvalPush, previewText } from "../src/approvals/messages";
import { BASE_YAML, makeService, testConfig } from "./helpers";

function tokenFrom(url: string, action: "approve" | "deny"): string {
  const prefix = `https://bridge.test/${action}/`;
  expect(url.startsWith(prefix)).toBe(true);
  return url.slice(prefix.length);
}

describe("approvalPush", () => {
  test("titles the pair, previews the instructions and carries signed Approve and Deny links", () => {
    const { service, config, clock } = makeService();
    const task = service.sendTask("grok-bot", { to: "muse", instructions: "Summarize the inbox" });
    const push = approvalPush(config, task);
    expect(push.title).toBe("grok-bot → muse");
    expect(push.message).toBe("Summarize the inbox");
    expect(push.click).toBe(`https://bridge.test/hub/tasks/${task.id}`);
    const [approve, deny, open] = push.actions;
    expect(approve).toMatchObject({ action: "http", label: "Approve", method: "POST", clear: true });
    expect(deny).toMatchObject({ action: "http", label: "Deny", method: "POST", clear: true });
    expect(open).toEqual({ action: "view", label: "Open", url: `https://bridge.test/hub/tasks/${task.id}` });
    expect(verifyLink(config.signingSecret, tokenFrom(approve!.url, "approve"), clock.now())).toEqual({
      subject: "task",
      id: task.id,
      action: "approve",
      expiresAt: task.expiresAt,
    });
    expect(verifyLink(config.signingSecret, tokenFrom(deny!.url, "deny"), clock.now())?.action).toBe("deny");
  });

  test("cuts long instructions at 200 characters and marks chained tasks", () => {
    const { service, config } = makeService(testConfig(`${BASE_YAML}\nlimits:\n  max_chain_length: 2\n`));
    service.sendTask("grok-bot", { to: "claude-code", instructions: "start" });
    service.checkInbox("claude-code");
    const chained = service.sendTask("claude-code", { to: "muse", instructions: "x".repeat(250) });
    expect(chained.chainLength).toBe(2);
    expect(approvalPush(config, chained).message).toBe(`${"x".repeat(200)}… (chained)`);
  });

  test("previewText leaves short text alone", () => {
    expect(previewText("short")).toBe("short");
    expect(previewText("y".repeat(200))).toBe("y".repeat(200));
  });
});
