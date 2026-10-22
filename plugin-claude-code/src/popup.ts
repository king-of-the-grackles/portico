import { spawn as realSpawn } from "node:child_process";

/** Always by absolute path, never a PATH lookup, so an agent can't put a stand-in earlier on the PATH. */
export const OSASCRIPT = "/usr/bin/osascript";
export const NOTIFY_SEND = "/usr/bin/notify-send";
/** The most of a task's instructions a panel shows, in code points. */
export const PANEL_TEXT_MAX = 500;
/** The Linux notification shows less: its body is also visible in the process list. */
const NOTIFY_TEXT_MAX = 200;
const TITLE = "Approval needed";
const NOTE_PLACEHOLDER = "Note for the sender (sent with Deny)";

/** What one panel shows. `slot` offsets each further open panel, so none hides another. */
export interface ApprovalPrompt {
  taskId: string;
  from: string;
  to: string;
  instructions: string;
  expiresAt: string;
  slot: number;
}

export type PanelOutcome =
  | { kind: "answered"; decision: "approve" | "deny"; note: string }
  | { kind: "dismissed" }
  | { kind: "failed"; code: number | null };

export interface RunningPanel {
  result: Promise<PanelOutcome>;
  /** Closes the panel. Its result is then `dismissed`. */
  kill(): void;
}

/** Shows one approval panel. The plugin takes it through its deps, so tests never start a real one. */
export type DialogRunner = (prompt: ApprovalPrompt) => RunningPanel;

export type PopupPlatform = "macos" | "linux";

/** The part of a child process the runners use. */
export interface ChildLike {
  stdin: { end(chunk?: string): unknown; on(event: "error", listener: (err: Error) => void): unknown } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: Record<string, string>; stdio: ["pipe", "pipe", "ignore"] },
) => ChildLike;

const systemSpawn = realSpawn as unknown as SpawnLike;

/** macOS when osascript exists; Linux with a desktop and notify-send; otherwise none. */
export function popupPlatform(
  platform: string,
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): PopupPlatform | null {
  if (platform === "darwin") return exists(OSASCRIPT) ? "macos" : null;
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) return exists(NOTIFY_SEND) ? "linux" : null;
  return null;
}

/** What a desktop needs, and nothing else: the machine token and the inbox socket variables never reach the child. */
const CHILD_VARS = ["HOME", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"];

export function childEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = { PATH: "/usr/bin:/bin" };
  for (const name of CHILD_VARS) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * The hub already defanged the text; this cleans it again for a panel: line separators become newlines, hidden
 * format characters (bidi controls, zero-width), other characters that draw nothing (fillers, variation selectors)
 * and control characters other than newline and tab go, tabs and braille blanks become spaces, lines of nothing but
 * spaces (Unicode spaces too) count as blank, runs of blank lines shrink to one, and the result is clipped with "…".
 * So no run of blank-looking lines can push the rest of the text out of sight.
 */
export function panelText(text: string, max = PANEL_TEXT_MAX): string {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/\p{Cf}/gu, "") // bidi controls, zero-width and other hidden format characters
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "") // Hangul fillers, variation selectors and others that draw nothing
    .replace(/[^\P{Cc}\n\t]/gu, "") // control characters, except newline and tab
    .replace(/[\t\u2800]/g, " ") // tabs, and braille blanks, which draw as spaces
    .replace(/^[^\S\n]+$/gm, "") // a line of only spaces, NBSP and other Unicode spaces included, is blank
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : cleaned;
}

/** Many notification servers read the body as markup. */
export function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lastLine(stdout: string): string {
  return stdout.trim().split("\n").at(-1)?.trim() ?? "";
}

/**
 * The macOS panel writes one JSON line: `{ decision, note }`, or `{ expired: true }` when it closed itself at the
 * deadline, which answers nothing. Anything else is a failure.
 */
export function parsePanelOutput(stdout: string): PanelOutcome {
  try {
    const answer = JSON.parse(lastLine(stdout)) as { decision?: unknown; note?: unknown; expired?: unknown } | null;
    if (answer?.expired === true) return { kind: "dismissed" };
    if (answer && (answer.decision === "approve" || answer.decision === "deny")) {
      return { kind: "answered", decision: answer.decision, note: typeof answer.note === "string" ? answer.note : "" };
    }
  } catch {
    // not JSON
  }
  return { kind: "failed", code: 0 };
}

/** notify-send prints the chosen action's name. Nothing (closed without a choice) is a dismissal. */
export function parseNotifyOutput(stdout: string): PanelOutcome {
  const action = lastLine(stdout);
  return action === "approve" || action === "deny" ? { kind: "answered", decision: action, note: "" } : { kind: "dismissed" };
}

/** Runs the child, writes `stdin`, and settles once: on exit, on a spawn error, or on kill. */
function runChild(
  spawnFn: SpawnLike,
  command: string,
  args: string[],
  env: Record<string, string>,
  stdin: string,
  parse: (stdout: string) => PanelOutcome,
): RunningPanel {
  let resolve!: (outcome: PanelOutcome) => void;
  const result = new Promise<PanelOutcome>((r) => (resolve = r));
  let settled = false;
  const settle = (outcome: PanelOutcome) => {
    if (settled) return;
    settled = true;
    resolve(outcome);
  };
  let child: ChildLike;
  try {
    child = spawnFn(command, args, { env, stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    settle({ kind: "failed", code: null });
    return { result, kill: () => {} };
  }
  // Kept as bytes and decoded once at the end, so a character split across chunks reads whole.
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk) => {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });
  child.on("error", () => settle({ kind: "failed", code: null }));
  child.on("close", (code) => settle(code === 0 ? parse(Buffer.concat(chunks).toString("utf8")) : { kind: "failed", code }));
  child.stdin?.on("error", () => {}); // a child that exits early closes the pipe
  child.stdin?.end(stdin);
  return {
    result,
    kill: () => {
      if (settled) return;
      settle({ kind: "dismissed" });
      child.kill("SIGTERM");
    },
  };
}

/**
 * The macOS panel, run by `osascript -l JavaScript`. A titled, utility, non-activating NSPanel at floating level on
 * every Space, with no close button and no key equivalents: it never takes the keyboard by itself, and only a click
 * answers. The body scrolls in a read-only text view, so none of the text is out of sight. The request is read from
 * stdin as JSON, never from argv; the answer is one JSON line on stdout. At the deadline the panel closes itself,
 * answering nothing, so a plugin killed outright never leaves it up.
 * A String.raw template, so its escapes stay escapes; it has no backticks and no template placeholders.
 */
export const MAC_PANEL_SCRIPT = String.raw`
ObjC.import("Cocoa");
ObjC.import("stdlib");

var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
var input = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);

var app = $.NSApplication.sharedApplication;
app.setActivationPolicy(1); // accessory: no Dock icon and no menu bar

var WIDTH = 440;
var HEIGHT = 300;
// Titled, utility window and non-activating panel (1 | 16 | 128): floats without taking the keyboard, with no close button.
var panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, WIDTH, HEIGHT), 1 | 16 | 128, 2, false);
panel.title = input.title;
panel.level = 3; // floating
panel.floatingPanel = true;
panel.becomesKeyOnlyIfNeeded = true; // a button click never takes the keyboard; a click in the note field does
panel.hidesOnDeactivate = false;
panel.collectionBehavior = 1 | 256; // every Space, and over full-screen windows
var view = panel.contentView;

function addLabel(text, y, height, bold) {
  var label = $.NSTextField.wrappingLabelWithString(text);
  label.frame = $.NSMakeRect(20, y, WIDTH - 40, height);
  label.font = bold ? $.NSFont.boldSystemFontOfSize(14) : $.NSFont.systemFontOfSize(12);
  label.selectable = false;
  view.addSubview(label);
}
addLabel(input.heading, HEIGHT - 44, 22, true);

// The body scrolls, so none of the (already clipped) text is ever out of sight. A legacy scroller is always drawn,
// and a knob shorter than its track says there is more. Read-only: the text can be selected and copied, never edited.
// Like the note field, the text view takes the keyboard only when clicked; the panel is never made key on its own.
var scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(20, 100, WIDTH - 40, HEIGHT - 152));
scroll.borderType = 2; // bezel
scroll.scrollerStyle = 0; // legacy: drawn all the time, unlike an overlay scroller
scroll.hasVerticalScroller = true;
scroll.hasHorizontalScroller = false;
scroll.autohidesScrollers = false;
var area = scroll.contentSize;
var body = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, area.width, area.height));
body.editable = false;
body.selectable = true;
body.richText = false;
body.font = $.NSFont.systemFontOfSize(12);
body.minSize = $.NSMakeSize(0, area.height);
body.maxSize = $.NSMakeSize(area.width, 10000000);
body.verticallyResizable = true;
body.horizontallyResizable = false;
body.autoresizingMask = 2; // the width follows the scroll view
body.textContainer.containerSize = $.NSMakeSize(area.width, 10000000);
body.textContainer.widthTracksTextView = true;
body.string = input.body;
scroll.documentView = body;
view.addSubview(scroll);

var note = $.NSTextField.alloc.initWithFrame($.NSMakeRect(20, 60, WIDTH - 40, 24));
note.placeholderString = input.notePlaceholder;
view.addSubview(note);

function reply(answer) {
  var line = JSON.stringify(answer) + "\n";
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding));
  $.exit(0);
}

function finish(decision) {
  reply({ decision: decision, note: note.stringValue.js });
}

ObjC.registerSubclass({
  name: "BridgeApprovalTarget",
  methods: {
    "approve:": { types: ["void", ["id"]], implementation: function () { finish("approve"); } },
    "deny:": { types: ["void", ["id"]], implementation: function () { finish("deny"); } },
    "expire:": { types: ["void", ["id"]], implementation: function () { reply({ expired: true }); } },
  },
});
var target = $.BridgeApprovalTarget.alloc.init;

// At the deadline the panel closes itself and answers nothing, even if the plugin that opened it is gone.
if (typeof input.deadline === "number") {
  var seconds = Math.max(0, input.deadline - Date.now()) / 1000;
  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(seconds, target, "expire:", null, false);
}

// Buttons get no key equivalents and refuse the keyboard focus: only a click answers, so Return typed in a terminal
// can never approve, and neither can Tab then Space with Full Keyboard Access on.
function addButton(title, x, action) {
  var button = $.NSButton.buttonWithTitleTargetAction(title, target, action);
  button.refusesFirstResponder = true;
  button.frame = $.NSMakeRect(x, 16, 100, 32);
  view.addSubview(button);
}
addButton(input.deny, WIDTH - 230, "deny:");
addButton(input.approve, WIDTH - 120, "approve:");

panel.center;
var offset = 24 * (input.slot || 0);
panel.setFrameOrigin($.NSMakePoint(panel.frame.origin.x + offset, panel.frame.origin.y - offset));
panel.orderFrontRegardless;
app.run;
`;

export function macPanelRunner(env: Record<string, string | undefined>, spawnFn: SpawnLike = systemSpawn): DialogRunner {
  return (prompt) =>
    runChild(
      spawnFn,
      OSASCRIPT,
      ["-l", "JavaScript", "-e", MAC_PANEL_SCRIPT],
      childEnv(env),
      JSON.stringify({
        title: TITLE,
        heading: `${prompt.from} → ${prompt.to}`,
        body: panelText(prompt.instructions),
        notePlaceholder: NOTE_PLACEHOLDER,
        approve: "Approve",
        deny: "Deny",
        slot: prompt.slot,
        deadline: Date.parse(prompt.expiresAt),
      }),
      parsePanelOutput,
    );
}

/** notify-send's longest expiry, in milliseconds. */
const MAX_EXPIRE_MS = 2_147_483_647;

export function linuxNotifyRunner(
  env: Record<string, string | undefined>,
  spawnFn: SpawnLike = systemSpawn,
  now: () => number = Date.now,
): DialogRunner {
  return (prompt) => {
    const expireMs = Math.min(MAX_EXPIRE_MS, Math.max(1_000, Date.parse(prompt.expiresAt) - now()));
    // Clipped first, then escaped, so the limit counts characters a reader sees and no entity is cut in half.
    const body = escapeMarkup(`${prompt.from} → ${prompt.to}\n\n${panelText(prompt.instructions, NOTIFY_TEXT_MAX)}`);
    const args = [
      "--urgency=critical",
      "--wait",
      "--action=approve=Approve",
      "--action=deny=Deny",
      `--expire-time=${expireMs}`,
      "--",
      TITLE,
      body,
    ];
    return runChild(spawnFn, NOTIFY_SEND, args, childEnv(env), "", parseNotifyOutput);
  };
}

/** The real runner for the platform. Only main.ts calls this; tests pass a fake runner or a fake spawn. */
export function systemRunner(platform: PopupPlatform, env: Record<string, string | undefined>): DialogRunner {
  return platform === "macos" ? macPanelRunner(env, systemSpawn) : linuxNotifyRunner(env, systemSpawn);
}
