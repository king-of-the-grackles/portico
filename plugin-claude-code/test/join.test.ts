import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultMachineName, JoinError, joinMachine, parseJoinLine } from "../src/join";
import { readMachineFile, writeMachineFile } from "../src/machine";
import { startHub, tempDir, type TestHub } from "./helpers";

const hubs: TestHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.stop();
});

function hub(): TestHub {
  const started = startHub();
  hubs.push(started);
  return started;
}

const configPath = () => join(tempDir(), "machine.json");
const hostname = () => "MacBook-Pro.local";

async function joinError(promise: Promise<unknown>): Promise<JoinError> {
  const err = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(err).toBeInstanceOf(JoinError);
  return err as JoinError;
}

describe("parseJoinLine", () => {
  test("parseJoinLine accepts the whole line, a bare /join#code link, or a hub address plus a code", () => {
    const code = "A".repeat(22);
    expect(parseJoinLine(`Join my agent bridge: https://bridge.example.com/join#${code}`)).toEqual({
      hub: "https://bridge.example.com",
      code,
    });
    expect(parseJoinLine(`https://bridge.example.com/base/join#${code}`)).toEqual({
      hub: "https://bridge.example.com/base",
      code,
    });
    expect(parseJoinLine("https://bridge.example.com", code)).toEqual({ hub: "https://bridge.example.com", code });
    expect(parseJoinLine(`http://localhost:8790/join#${code}`).hub).toBe("http://localhost:8790");
  });

  test("parseJoinLine refuses plain http to a remote host, credentials in the address, and a missing or malformed code", () => {
    for (const bad of [
      "no address here",
      "http://bridge.example.com/join#AAAAAAAAAAAAAAAAAAAAAA",
      "https://u:p@bridge.example.com/join#AAAAAAAAAAAAAAAAAAAAAA",
      "https://bridge.example.com/join",
      "https://bridge.example.com/join#short",
    ]) {
      expect(() => parseJoinLine(bad)).toThrow(JoinError);
    }
  });
});

describe("joinMachine", () => {
  test("joinMachine posts the code and the hostname-based name, then writes machine.json with mode 600", async () => {
    const h = hub();
    const { code } = h.networkService.createJoinCode();
    const path = configPath();
    const joined = await joinMachine({ line: `Join my agent bridge: ${h.url}/join#${code}` }, { configPath: path, hostname });
    expect(joined).toEqual({ hub: h.url, machine: "macbook-pro", path });
    expect(readMachineFile(path)).toEqual({ hub: h.url, machine: "macbook-pro", token: expect.stringMatching(/^bm_/), off: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(h.networkService.listMachines().map((machine) => machine.name)).toEqual(["macbook-pro"]);
  });

  test("an existing machine.json is kept unless replace is set, and replace keeps the off list", async () => {
    const h = hub();
    const { code } = h.networkService.createJoinCode();
    const path = configPath();
    writeMachineFile(path, { hub: "https://bridge.example.com", machine: "studio", token: "bm_old", off: ["/work/private"] });
    const before = readFileSync(path, "utf8");

    const err = await joinError(joinMachine({ line: `${h.url}/join#${code}` }, { configPath: path, hostname }));
    expect(err.message).toBe(
      `${path} already exists (machine "studio" on https://bridge.example.com). Nothing was written. Run again with --replace to join again.`,
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(h.networkService.listMachines()).toEqual([]); // refused before the code was sent

    const joined = await joinMachine({ line: `${h.url}/join#${code}`, name: "macbook", replace: true }, { configPath: path, hostname });
    expect(joined.machine).toBe("macbook");
    expect(readMachineFile(path)).toEqual({
      hub: h.url,
      machine: "macbook",
      token: expect.stringMatching(/^bm_/),
      off: ["/work/private"],
    });
  });

  test("a broken machine.json is reported, and replace writes over the broken file", async () => {
    const h = hub();
    const { code } = h.networkService.createJoinCode();
    const path = configPath();
    writeFileSync(path, "{ not json");
    await expect(joinMachine({ line: `${h.url}/join#${code}` }, { configPath: path, hostname })).rejects.toThrow(
      `${path} is not valid JSON.`,
    );
    expect(readFileSync(path, "utf8")).toBe("{ not json");
    await joinMachine({ line: `${h.url}/join#${code}`, replace: true }, { configPath: path, hostname });
    expect(readMachineFile(path)?.off).toEqual([]);
  });

  test("a hub refusal becomes a JoinError carrying the hub's message", async () => {
    const h = hub();
    const path = configPath();
    const err = await joinError(joinMachine({ line: `${h.url}/join#${"B".repeat(22)}` }, { configPath: path, hostname }));
    expect(err.message).toBe("The join code is invalid, expired or already used. Ask for a new join line.");
    expect(existsSync(path)).toBe(false);

    // Without a message in the answer, the HTTP status.
    const bare = async () => new Response("Bad gateway", { status: 502 });
    const status = await joinError(
      joinMachine({ line: `https://bridge.example.com/join#${"B".repeat(22)}` }, { configPath: path, hostname, fetch: bare as unknown as typeof fetch }),
    );
    expect(status.message).toBe("The hub at https://bridge.example.com answered HTTP 502.");

    // A 2xx answer that isn't a join result writes nothing.
    const odd = async () => Response.json({ ok: true }, { status: 201 });
    const oddErr = await joinError(
      joinMachine({ line: `https://bridge.example.com/join#${"B".repeat(22)}` }, { configPath: path, hostname, fetch: odd as unknown as typeof fetch }),
    );
    expect(oddErr.message).toBe("The hub at https://bridge.example.com sent an answer that isn't a join result. Nothing was written.");
    expect(existsSync(path)).toBe(false);
  });

  test("an unreachable hub becomes a JoinError, and nothing is written", async () => {
    const path = configPath();
    const err = await joinError(joinMachine({ line: `http://127.0.0.1:1/join#${"B".repeat(22)}` }, { configPath: path, hostname }));
    expect(err.message).toBe("The hub at http://127.0.0.1:1 could not be reached.");
    expect(existsSync(path)).toBe(false);
  });

  test("a redirect is refused rather than followed, so the code goes only to the hub in the line", async () => {
    const h = hub();
    const { code } = h.networkService.createJoinCode();
    const redirector = Bun.serve({ port: 0, fetch: (req) => Response.redirect(`${h.url}${new URL(req.url).pathname}`, 308) });
    try {
      const path = configPath();
      const err = await joinError(
        joinMachine({ line: `http://127.0.0.1:${redirector.port}/join#${code}` }, { configPath: path, hostname }),
      );
      expect(err.message).toBe(`The hub at http://127.0.0.1:${redirector.port} answered HTTP 308.`);
      expect(existsSync(path)).toBe(false);
      expect(h.networkService.listMachines()).toEqual([]);
    } finally {
      redirector.stop(true);
    }
  });

  // Root can write anywhere, so the refusal can't be staged there.
  test.skipIf(process.getuid?.() === 0)("a machine file that can't be written says the code was used", async () => {
    const h = hub();
    const { code } = h.networkService.createJoinCode();
    const locked = join(tempDir(), "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const path = join(locked, "machine.json");
      const err = await joinError(joinMachine({ line: `${h.url}/join#${code}` }, { configPath: path, hostname }));
      expect(err.message).toBe(
        `${path} could not be written (EACCES). The join code is used up: ask for a new join line, then join again.`,
      );
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("defaultMachineName drops .local and slugs the hostname", () => {
    expect(defaultMachineName("MacBook-Pro.local")).toBe("macbook-pro");
    expect(defaultMachineName("")).toBe("machine");
    expect(defaultMachineName("Studio Mac (2)")).toBe("studio-mac-2");
  });
});
