import { expect, test } from "bun:test";
import { TOOLS as HUB_TOOLS } from "../../hub/src/ways-in/mcp";
import { inboxText, TOOLS } from "../src/tools";

test("the plugin's tools match the hub's /mcp tools exactly", () => {
  expect(TOOLS).toEqual(HUB_TOOLS as unknown as typeof TOOLS);
});

test("inboxText shows framed tasks and results", () => {
  const task = {
    id: "t1",
    from_agent: "grok-bot",
    to_agent: "claude-code",
    instructions: "Do it",
    status: "working",
    result: null,
    reason: null,
    parent_task_id: null,
    chain_length: 1,
    event_id: null,
    trigger_name: null,
    created_at: "2026-10-20T12:00:00.000Z",
    updated_at: "2026-10-20T12:00:00.000Z",
    expires_at: "2026-10-21T12:00:00.000Z",
  };
  const text = inboxText({
    tasks: [{ ...task, framed_message: "FRAMED t1" }],
    results: [{ ...task, id: "t2", to_agent: "muse", status: "done", result: "42" }],
  });
  expect(text).toBe(
    ["New tasks (1):", "---", "FRAMED t1", "", "Results of tasks you sent (1):", "- Task t2 to muse: done", "  Result: 42"].join(
      "\n",
    ),
  );
  expect(inboxText({ tasks: [], results: [] })).toBe("No new tasks.\n\nNo new results.");
});
