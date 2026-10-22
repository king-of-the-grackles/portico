import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HubClient, HubError } from "../src/hub-client";
import { hubClient, startHub, type TestHub, TOKENS } from "./helpers";

let hub: TestHub;
beforeEach(() => {
  hub = startHub();
});
afterEach(() => hub.stop());

async function hubError(promise: Promise<unknown>): Promise<HubError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HubError) return err;
    throw err;
  }
  throw new Error("expected a HubError");
}

describe("HubClient", () => {
  test("lists the other agents", async () => {
    const { agents } = await hubClient(hub, "claude-code").listAgents();
    expect(agents.map((a) => a.name).sort()).toEqual(["codex", "grok-bot", "muse"]);
  });

  test("a full handoff: send, check the inbox, finish, read the result", async () => {
    const claude = hubClient(hub, "claude-code");
    const grok = hubClient(hub, "grok-bot");
    const { task } = await claude.sendTask({ to: "grok-bot", instructions: "Find the release date", idempotency_key: "k1" });
    expect(task.status).toBe("queued");

    const inbox = await grok.checkInbox();
    expect(inbox.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(inbox.tasks[0]!.framed_message).toContain(`**Task \`${task.id}\` from agent \`claude-code\` via the bridge.**`);

    await grok.finishTask(task.id, { result: "Friday" });
    const read = await claude.getTask(task.id);
    expect(read.task).toMatchObject({ status: "done", result: "Friday" });
  });

  test("turns hub errors into HubError with the hub's code and message", async () => {
    const wrongToken = new HubClient({ url: hub.url, token: "wrong-token-0123456789abcdef" });
    expect(await hubError(wrongToken.listAgents())).toMatchObject({ status: 401, code: "unauthorized" });

    const err = await hubError(hubClient(hub, "claude-code").sendTask({ to: "nobody", instructions: "x" }));
    expect(err).toMatchObject({ status: 400, code: "unknown_agent" });
    expect(err.message).toContain("grok-bot");
  });

  test("reports an unreachable hub as status 0, without the token", async () => {
    const token = TOKENS["claude-code"];
    const err = await hubError(new HubClient({ url: "http://127.0.0.1:1", token }).listAgents());
    expect(err).toMatchObject({ status: 0, code: "unreachable" });
    expect(err.message).not.toContain(token);
  });

  test("reports an answer that isn't JSON", async () => {
    const plain = Bun.serve({ port: 0, fetch: () => new Response("oops") });
    try {
      const err = await hubError(new HubClient({ url: `http://127.0.0.1:${plain.port}`, token: "t" }).listAgents());
      expect(err).toMatchObject({ status: 200, code: "bad_response" });
    } finally {
      plain.stop(true);
    }
  });

  test("opens the live stream", async () => {
    const controller = new AbortController();
    const res = await hubClient(hub, "claude-code").openStream(controller.signal);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    controller.abort();
  });
});
