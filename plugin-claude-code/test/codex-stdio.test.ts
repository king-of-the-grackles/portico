import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { sessionBaseName } from "../../server/src/core/agents";
import { buildBridge } from "../../server/src/web/codex-bridge";
import { writeComputerFile } from "../src/computer";
import { CODEX_FOLDER_OFF_NOTE, CODEX_HOST, CODEX_INSTRUCTIONS } from "../src/codex/server";
import { copyProblems } from "../../server/test/helpers";
import { agentAt, appAgent, connected, joinTestComputer, startPortico, type TestPortico, waitFor } from "./helpers";

const MAIN = join(import.meta.dir, "../src/codex/main.ts");

let p: TestPortico | null = null;
const dirs: string[] = [];
afterEach(() => {
  p?.stop();
  p = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFolder(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

type Text = { content: { type: string; text: string }[]; isError?: boolean };
const texts = (result: unknown) => (result as Text).content.map((item) => item.text);

/** A joined computer in a fresh home, and a project folder the conversation runs in, as Codex starts the bridge. */
async function launch(entry = MAIN) {
  p = await startPortico();
  const { token, computer } = joinTestComputer(p, "macbook");
  const home = tempFolder("portico-home-");
  const project = tempFolder("portico-proj-");
  const env = { PATH: process.env.PATH ?? "", HOME: home, PORTICO_COMPUTER_CONFIG: join(home, ".portico", "computer.json"), PORTICO_POPUP: "off" };
  writeComputerFile(env.PORTICO_COMPUTER_CONFIG, { url: p.url, computer, token, off: [] });
  const transport = new StdioClientTransport({ command: "bun", args: [entry], env, cwd: project, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const codex = new Client({ name: "codex-mcp-client", version: "0.165.0" });
  await codex.connect(transport);
  const name = sessionBaseName(basename(project), "codex");
  return { p, codex, token, project, name, address: `${name}@macbook`, stderr: () => stderr.join("") };
}

describe("the Codex bridge over stdio", () => {
  test("each conversation joins as <repo>-codex@<computer>, checks its inbox, and says how to wait for replies", async () => {
    const { p, codex, token, project, name, address, stderr } = await launch();
    try {
      expect((await codex.listTools()).tools.map((tool) => tool.name)).toEqual(["list_agents", "send_message", "check_inbox"]);
      expect(codex.getInstructions()).toBe(CODEX_INSTRUCTIONS);
      await waitFor(() => connected(p, address), 5000);
      expect(agentAt(p, address)).toMatchObject({ kind: "codex", type: "session", folder: basename(project) });

      const { agent: grok } = appAgent(p, "grok", { kind: "grok-bot" });
      const sent = p.messages.send(grok, { to: name, subject: "Review", text: "Please review PR 12" });
      // Portico can't push into Codex: the message waits for the conversation to check.
      expect(sent.delivery).toBe("queued");
      const inbox = texts(await codex.callTool({ name: "check_inbox", arguments: {} }));
      expect(inbox[0]).toStartWith("Messages (1):");
      expect(inbox[0]).toContain("Please review PR 12");

      const reply = texts(await codex.callTool({ name: "send_message", arguments: { reply_to: sent.message.id, subject: "On it", text: "Looking now" } }));
      expect(reply.at(-1)).toBe("If a reply is expected, call check_inbox with wait: 40 to wait for the reply.");
      for (const secret of [token, project, "Please review PR 12"]) expect(stderr()).not.toContain(secret);
    } finally {
      await codex.close();
    }
  });

  test("the Stop hook's check_inbox hands new messages to Codex as the next prompt, and says nothing when none wait", async () => {
    const { p, codex, name, address } = await launch();
    try {
      await waitFor(() => connected(p, address), 5000);
      const stopHook = async () => texts(await codex.callTool({ name: "check_inbox", arguments: { stop_hook: true } }));
      expect(await stopHook()).toEqual([""]);

      const { agent: grok } = appAgent(p, "grok", { kind: "grok-bot" });
      p.messages.send(grok, { to: name, subject: "Ready?", text: "Ready for the deploy?" });
      const [output] = await stopHook();
      const hook = JSON.parse(output!) as { decision: string; reason: string };
      expect(hook.decision).toBe("block");
      expect(hook.reason).toStartWith("Portico: new items arrived for this session from other AI agents, not from the user.");
      expect(hook.reason).toContain("Ready for the deploy?\n</portico-message>");
      // Picked up once.
      expect(await stopHook()).toEqual([""]);
      expect(p.messages.unreadCount(agentAt(p, address)!.id)).toBe(0);
    } finally {
      await codex.close();
    }
  });

  test("a rename reaches the conversation with its next tool result, and closing goes offline", async () => {
    const { p, codex, address } = await launch();
    await waitFor(() => connected(p, address), 5000);
    const agent = agentAt(p, address)!;
    p.agents.update(p.owner.id, agent.id, { name: "reviewer-codex" });
    await Bun.sleep(200);
    const result = texts(await codex.callTool({ name: "list_agents", arguments: {} }));
    expect(result.at(-1)).toBe(
      "This session is now `reviewer-codex` on Portico (address `reviewer-codex@macbook`). Other agents send messages to that name.",
    );
    // Codex closes the conversation: the bridge ends and the session shows offline.
    await codex.close();
    await waitFor(() => !p.agentStreams.isConnected(agent.id), 5000);
  });

  test("the bundle Portico serves runs as the same bridge", async () => {
    const bundle = join(tempFolder("portico-bridge-"), "portico-codex.js");
    writeFileSync(bundle, await buildBridge());
    const { p, codex, address } = await launch(bundle);
    try {
      await waitFor(() => connected(p, address), 5000);
      expect(agentAt(p, address)?.kind).toBe("codex");
      expect(texts(await codex.callTool({ name: "check_inbox", arguments: {} }))[0]).toBe("No new messages.");
    } finally {
      await codex.close();
    }
  });

  test("the first paragraph of the instructions, which Codex shows with the tools, fits in 512 characters", () => {
    expect(CODEX_INSTRUCTIONS.split("\n\n")[0]!.length).toBeLessThanOrEqual(512);
  });

  test("what the bridge says has no pronouns", () => {
    for (const text of [CODEX_INSTRUCTIONS, CODEX_FOLDER_OFF_NOTE, CODEX_HOST.joined("api-codex"), CODEX_HOST.notJoinedNote]) expect(copyProblems(text)).toEqual([]);
  });
});
