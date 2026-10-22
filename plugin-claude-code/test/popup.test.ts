import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  type ApprovalPrompt, type ChildLike, childEnv, escapeMarkup, linuxNotifyRunner, MAC_PANEL_SCRIPT, macPanelRunner, panelText,
  parseNotifyOutput, parsePanelOutput, popupPlatform, type SpawnLike,
} from "../src/popup";

const PROMPT: ApprovalPrompt = { taskId: "t1", from: "grok-bot", to: "muse", instructions: "Summarize the inbox", expiresAt: "2026-10-21T12:00:00.000Z", slot: 0 };

/** Records each spawn, and lets the test write the child's stdout and end it. */
function fakeSpawn() {
  const calls: { command: string; args: string[]; env: Record<string, string>; stdin: string; killed: string | null; stdout(text: string): void; exit(code: number | null): void }[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    const events = new EventEmitter();
    const out = new EventEmitter();
    const call = {
      command, args, env: options.env, stdin: "", killed: null as string | null,
      stdout: (text: string) => out.emit("data", Buffer.from(text)),
      exit: (code: number | null) => events.emit("close", code),
    };
    calls.push(call);
    return {
      stdin: { end: (chunk?: string) => (call.stdin += chunk ?? ""), on: () => undefined },
      stdout: { on: (event: "data", listener: (chunk: Buffer | string) => void) => out.on(event, listener) },
      on: (event: string, listener: (...args: any[]) => void) => events.on(event, listener),
      kill: (signal?: NodeJS.Signals) => {
        call.killed = signal ?? "SIGTERM";
        events.emit("close", null);
        return true;
      },
    } as unknown as ChildLike;
  };
  return { spawn, calls };
}

describe("where pop-ups run", () => {
  test("on macOS with osascript, and on Linux with a desktop and notify-send; nowhere else", () => {
    const all = () => true;
    const none = () => false;
    expect(popupPlatform("darwin", {}, all)).toBe("macos");
    expect(popupPlatform("darwin", {}, none)).toBeNull();
    expect(popupPlatform("linux", { DISPLAY: ":0" }, all)).toBe("linux");
    expect(popupPlatform("linux", { WAYLAND_DISPLAY: "wayland-0" }, all)).toBe("linux");
    expect(popupPlatform("linux", {}, all)).toBeNull();
    expect(popupPlatform("linux", { DISPLAY: ":0" }, none)).toBeNull();
    expect(popupPlatform("win32", { DISPLAY: ":0" }, all)).toBeNull();
    const checked: string[] = [];
    popupPlatform("linux", { DISPLAY: ":0" }, (path) => (checked.push(path), true));
    popupPlatform("darwin", {}, (path) => (checked.push(path), true));
    expect(checked).toEqual(["/usr/bin/notify-send", "/usr/bin/osascript"]);
  });

  test("the child's environment keeps only what a desktop needs", () => {
    expect(
      childEnv({ HOME: "/h", PATH: "/evil:/usr/bin", BRIDGE_TOKEN: "secret", CLAUDE_CODE_MESSAGING_SOCKET: "/s", DISPLAY: ":0", LANG: "en_US.UTF-8" }),
    ).toEqual({ PATH: "/usr/bin:/bin", HOME: "/h", DISPLAY: ":0", LANG: "en_US.UTF-8" });
  });
});

describe("panel text", () => {
  test("drops hidden, bidi and control characters, keeps line breaks, and is clipped", () => {
    expect(panelText("Run\u202E this\u200B\u0007 now\r\nok\u2028done")).toBe("Run this now\nok\ndone");
    expect(panelText("a\n\n\n\nb\tc")).toBe("a\n\nb c");
    expect(panelText("x".repeat(600))).toBe(`${"x".repeat(500)}…`);
    expect(panelText("\u{1F642}".repeat(501))).toBe(`${"\u{1F642}".repeat(500)}…`);
  });

  test("markup characters are escaped for the notification body", () => {
    expect(escapeMarkup("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });
});

describe("the macOS panel", () => {
  test("the script parses, reads the request from stdin, never takes the keyboard by itself, and has no key equivalents", () => {
    expect(() => new Function(MAC_PANEL_SCRIPT)).not.toThrow();
    expect(MAC_PANEL_SCRIPT).toContain("fileHandleWithStandardInput");
    expect(MAC_PANEL_SCRIPT).toContain("1 | 16 | 128"); // titled, utility, non-activating
    expect(MAC_PANEL_SCRIPT).not.toContain("keyEquivalent");
  });

  test("runs /usr/bin/osascript with the fixed script and passes the request on stdin only", async () => {
    const fake = fakeSpawn();
    const panel = macPanelRunner({ HOME: "/h", BRIDGE_TOKEN: "secret", PATH: "/evil" }, fake.spawn)(PROMPT);
    const call = fake.calls[0]!;
    expect(call.command).toBe("/usr/bin/osascript");
    expect(call.args).toEqual(["-l", "JavaScript", "-e", MAC_PANEL_SCRIPT]);
    expect(call.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/h" });
    expect(JSON.parse(call.stdin)).toEqual({
      title: "Approval needed", heading: "grok-bot → muse", body: "Summarize the inbox",
      notePlaceholder: "Note for the sender (sent with Deny)", approve: "Approve", deny: "Deny", slot: 0,
    });
    call.stdout('{"decision":"deny","note":"Not now"}\n');
    call.exit(0);
    expect(await panel.result).toEqual({ kind: "answered", decision: "deny", note: "Not now" });
  });

  test("a kill stops the child and counts as dismissed; a failing child is failed", async () => {
    const fake = fakeSpawn();
    const runner = macPanelRunner({}, fake.spawn);
    const killed = runner(PROMPT);
    killed.kill();
    expect(fake.calls[0]!.killed).toBe("SIGTERM");
    expect(await killed.result).toEqual({ kind: "dismissed" });
    const broken = runner(PROMPT);
    fake.calls[1]!.exit(1);
    expect(await broken.result).toEqual({ kind: "failed", code: 1 });
    expect(parsePanelOutput("garbage")).toEqual({ kind: "failed", code: 0 });
  });
});

describe("the Linux notification", () => {
  test("runs /usr/bin/notify-send with Approve and Deny actions and an escaped, clipped body", async () => {
    const fake = fakeSpawn();
    const env = { DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", BRIDGE_TOKEN: "secret" };
    const runner = linuxNotifyRunner(env, fake.spawn, () => Date.parse(PROMPT.expiresAt) - 60_000);
    const panel = runner({ ...PROMPT, instructions: `Fix <b>this</b> & ${"x".repeat(300)}` });
    const call = fake.calls[0]!;
    expect(call.command).toBe("/usr/bin/notify-send");
    expect(call.args.slice(0, 7)).toEqual([
      "--urgency=critical", "--wait", "--action=approve=Approve", "--action=deny=Deny", "--expire-time=60000", "--", "Approval needed",
    ]);
    expect(call.args[7]).toStartWith("grok-bot → muse\n\nFix &lt;b&gt;this&lt;/b&gt; &amp; xxx");
    expect(call.args[7]).toEndWith("…");
    expect(call.env).toEqual({ PATH: "/usr/bin:/bin", DISPLAY: ":0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" });
    call.stdout("approve\n");
    call.exit(0);
    expect(await panel.result).toEqual({ kind: "answered", decision: "approve", note: "" });
  });

  test("the body clips the instructions to 200 characters before escaping, so no entity is cut", () => {
    const fake = fakeSpawn();
    linuxNotifyRunner({ DISPLAY: ":0" }, fake.spawn, () => Date.parse(PROMPT.expiresAt) - 60_000)({
      ...PROMPT,
      instructions: "&".repeat(300),
    });
    expect(fake.calls[0]!.args[7]).toBe(`grok-bot → muse\n\n${"&amp;".repeat(200)}…`);
  });

  test("the expiry time is clamped to the range notify-send takes", () => {
    const fake = fakeSpawn();
    const expiry = Date.parse(PROMPT.expiresAt);
    linuxNotifyRunner({ DISPLAY: ":0" }, fake.spawn, () => expiry + 5_000)(PROMPT);
    linuxNotifyRunner({ DISPLAY: ":0" }, fake.spawn, () => expiry - 90 * 86_400_000)(PROMPT);
    expect(fake.calls.map((call) => call.args[4])).toEqual(["--expire-time=1000", "--expire-time=2147483647"]);
  });

  test("a notification closed without an action is dismissed", () => {
    expect(parseNotifyOutput("")).toEqual({ kind: "dismissed" });
    expect(parseNotifyOutput("deny\n")).toEqual({ kind: "answered", decision: "deny", note: "" });
  });
});
