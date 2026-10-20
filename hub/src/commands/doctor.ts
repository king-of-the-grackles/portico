import { resolve } from "node:path";
import { makePusher, type PushMessage, type Pusher } from "../approvals/ntfy";
import { ConfigError, loadConfig } from "../config";
import type { BridgeConfig } from "../core/types";
import { captureLogs, errorName } from "../log";
import type { CliIo } from "./io";

export interface DoctorDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Defaults to an ntfy pusher built from the config. */
  push?: Pusher;
  timeoutMs?: number;
}

type Mark = "ok" | "warn" | "fail";
const MARKS: Record<Mark, string> = { ok: "✓", warn: "!", fail: "✗" };

function testPush(config: BridgeConfig): PushMessage {
  const open = `${config.publicUrl}/hub`;
  return {
    title: "Test push",
    message: "A test from bridge doctor. Approval requests arrive like this, with Approve and Deny buttons.",
    click: open,
    priority: 3,
    tags: ["white_check_mark"],
    actions: [{ action: "view", label: "Open", url: open }],
  };
}

/** Checks the config, the public URL, each agent's token on the running hub, and a test push (spec §13). */
export async function doctorCommand(args: string[], io: CliIo, deps: DoctorDeps = {}): Promise<number> {
  const unknown = args.find((arg) => arg !== "--no-push");
  if (unknown !== undefined) {
    io.err(`Unknown option: ${unknown}. Usage: bridge doctor [--no-push]`);
    return 1;
  }
  const doFetch = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? 10_000;
  let failed = false;
  const report = (mark: Mark, text: string) => {
    if (mark === "fail") failed = true;
    io.out(`${MARKS[mark]} ${text}`);
  };
  const get = async (url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; error?: string }> => {
    try {
      const res = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      return { status: 0, text: "", error: errorName(err) };
    }
  };

  // 1. Config
  let config: BridgeConfig;
  try {
    config = await loadConfig({ ...io.env, BRIDGE_CONFIG: resolve(io.cwd, io.env.BRIDGE_CONFIG?.trim() || "bridge.yaml") });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    for (const problem of err.problems) report("fail", problem);
    io.out("Fix the config first: the other checks depend on the config.");
    return 1;
  }
  const count = config.agents.length;
  report("ok", `Config: ${count} agents, ${config.rules.length} rules, ${config.triggers.length} triggers.`);
  report("ok", `Tokens are set for all ${count} agents.`);

  // 2. A local address
  const base = config.publicUrl;
  const host = new URL(base).hostname;
  if (host === "localhost" || host === "127.0.0.1") {
    report("warn", `BRIDGE_PUBLIC_URL is ${base}: only this machine can reach the hub there. Agents in the cloud need a public https address.`);
  }

  // 3. Health, and 4. tokens on the running hub
  const health = await get(`${base}/healthz`);
  let healthy = false;
  try {
    healthy = health.status === 200 && (JSON.parse(health.text) as { ok?: unknown }).ok === true;
  } catch {
    healthy = false;
  }
  if (!healthy) {
    const detail = health.error ?? `HTTP ${health.status}`;
    report("fail", `${base}/healthz didn't answer (${detail}). Start the hub with bridge serve, and check the host or tunnel.`);
  } else {
    report("ok", `${base}/healthz answered.`);
    let accepted = 0;
    for (const agent of config.agents) {
      const res = await get(`${base}/api/agents`, { authorization: `Bearer ${config.tokens[agent.name]}` });
      if (res.status === 200) accepted++;
      else if (res.status === 401) {
        report("fail", `The hub at ${base} rejected the token for ${agent.name}. The running hub may use a different .env.`);
      } else {
        report("fail", `The hub at ${base} answered HTTP ${res.status || res.error} for ${agent.name}'s token check.`);
      }
    }
    if (accepted === count) report("ok", `The hub at ${base} accepts the tokens of all ${count} agents.`);
  }

  // 5. Push
  if (!config.ntfy) {
    report("warn", "BRIDGE_NTFY_TOPIC isn't set: approvals happen on the hub page only.");
  } else if (args.includes("--no-push")) {
    report("warn", "Test push skipped.");
  } else {
    const push = deps.push ?? makePusher(config.ntfy);
    captureLogs(() => {}); // the pusher's own log lines would interleave with this report
    let sent: boolean;
    try {
      sent = await push(testPush(config));
    } finally {
      captureLogs(null);
    }
    if (sent) report("ok", "Test push sent. Check that the push arrived on the phone.");
    else report("fail", "The test push failed. Check BRIDGE_NTFY_URL, BRIDGE_NTFY_TOPIC and BRIDGE_NTFY_TOKEN.");
  }

  io.out(failed ? "Some checks failed." : "All checks passed.");
  return failed ? 1 : 0;
}
