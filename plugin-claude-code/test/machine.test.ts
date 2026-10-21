import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  claudeHome,
  isOff,
  machineConfigPath,
  MachineFileError,
  readMachineFile,
  setFolderOff,
  writeMachineFile,
} from "../src/machine";
import { tempDir } from "./helpers";

const FILE = { hub: "https://bridge.example.com", machine: "macbook", token: "bm_x", off: [] as string[] };
const PRONOUNS = /\b(i|me|my|we|us|our|you|your|it|its|they|them|their)\b/i;

describe("machine.json", () => {
  test("writes machine.json with mode 600 in a folder with mode 700, and reads it back", () => {
    const path = join(tempDir(), "nested", "machine.json");
    writeMachineFile(path, { hub: "https://bridge.example.com", machine: "macbook", token: "bm_x", off: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(readMachineFile(path)).toEqual({ hub: "https://bridge.example.com", machine: "macbook", token: "bm_x", off: [] });
  });

  test("an existing .agent-bridge folder is tightened to mode 700; any other existing folder is left alone", () => {
    const own = join(tempDir(), ".agent-bridge");
    mkdirSync(own);
    chmodSync(own, 0o755);
    writeMachineFile(join(own, "machine.json"), FILE);
    expect(statSync(own).mode & 0o777).toBe(0o700);

    // BRIDGE_MACHINE_CONFIG may point into a shared folder.
    const shared = join(tempDir(), "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    writeMachineFile(join(shared, "machine.json"), FILE);
    expect(statSync(shared).mode & 0o777).toBe(0o755);
    expect(statSync(join(shared, "machine.json")).mode & 0o777).toBe(0o600);
  });

  test("rewriting replaces the file in one step and leaves no temp file behind", () => {
    const dir = tempDir();
    const path = join(dir, "machine.json");
    writeMachineFile(path, FILE);
    writeMachineFile(path, { ...FILE, machine: "studio" });
    expect(readMachineFile(path)?.machine).toBe("studio");
    expect(readdirSync(dir)).toEqual(["machine.json"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a missing file reads as null; a broken one throws MachineFileError naming the path", () => {
    const dir = tempDir();
    expect(readMachineFile(join(dir, "machine.json"))).toBeNull();

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    expect(() => readMachineFile(broken)).toThrow(MachineFileError);
    expect(() => readMachineFile(broken)).toThrow(broken);

    const wrongShape = join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ hub: "https://bridge.example.com", machine: "macbook", off: [] }));
    expect(() => readMachineFile(wrongShape)).toThrow(MachineFileError);
    // The messages are CLI output: no pronouns (the path itself aside).
    for (const path of [broken, wrongShape]) {
      let message = "";
      try {
        readMachineFile(path);
      } catch (err) {
        message = (err as Error).message.replace(path, "");
      }
      expect(message).not.toMatch(PRONOUNS);
    }

    const badOff = join(dir, "bad-off.json");
    writeFileSync(badOff, JSON.stringify({ ...FILE, off: [42] }));
    expect(() => readMachineFile(badOff)).toThrow(MachineFileError);

    const unreadable = join(dir, "unreadable.json");
    writeFileSync(unreadable, JSON.stringify(FILE));
    chmodSync(unreadable, 0o000);
    try {
      // Root reads anything, so the check only means something for other users.
      if (process.getuid?.() !== 0) expect(() => readMachineFile(unreadable)).toThrow(MachineFileError);
    } finally {
      chmodSync(unreadable, 0o600);
    }
  });

  test("a file without an off list reads as having none", () => {
    const path = join(tempDir(), "machine.json");
    writeFileSync(path, JSON.stringify({ hub: FILE.hub, machine: FILE.machine, token: FILE.token }));
    expect(readMachineFile(path)?.off).toEqual([]);
  });

  test("the paths come from BRIDGE_MACHINE_CONFIG and BRIDGE_CLAUDE_HOME, defaulting under the home folder", () => {
    expect(machineConfigPath({ BRIDGE_MACHINE_CONFIG: "/x/machine.json" })).toBe("/x/machine.json");
    expect(machineConfigPath({})).toBe(join(homedir(), ".agent-bridge", "machine.json"));
    expect(claudeHome({ BRIDGE_CLAUDE_HOME: "/x/.claude" })).toBe("/x/.claude");
    expect(claudeHome({ BRIDGE_CLAUDE_HOME: "  " })).toBe(join(homedir(), ".claude"));
  });
});

describe("the off list", () => {
  test("isOff matches the folder and anything inside it, but not a sibling with a shared prefix", () => {
    const dir = tempDir();
    for (const sub of ["app/src", "app2"]) mkdirSync(join(dir, sub), { recursive: true });
    const file = { off: [join(dir, "app")] };
    expect(isOff(file, join(dir, "app"))).toBe(true);
    expect(isOff(file, join(dir, "app/src"))).toBe(true);
    expect(isOff(file, join(dir, "app2"))).toBe(false);
    expect(isOff({ off: [] }, join(dir, "app"))).toBe(false);
  });

  test("isOff resolves symlinks on both sides, so a link and its target match", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "real/src"), { recursive: true });
    symlinkSync(join(dir, "real"), join(dir, "link"));
    expect(isOff({ off: [join(dir, "link")] }, join(dir, "real/src"))).toBe(true);
    expect(isOff({ off: [join(dir, "real")] }, join(dir, "link"))).toBe(true);
    // The system temp folder is itself a symlink on macOS (/var -> /private/var); both spellings match.
    expect(isOff({ off: [realpathSync(dir)] }, join(dir, "real"))).toBe(true);
    // A folder that no longer exists still compares by its absolute path.
    expect(isOff({ off: [join(dir, "gone")] }, join(dir, "gone/deeper"))).toBe(true);
  });

  test("setFolderOff adds a folder once and removes it", () => {
    const dir = tempDir();
    const path = join(dir, "machine.json");
    const folder = join(dir, "app");
    mkdirSync(folder);
    writeMachineFile(path, FILE);

    const added = setFolderOff(path, folder, true);
    expect(added.changed).toBe(true);
    expect(added.file.off).toEqual([realpathSync(folder)]);
    expect(readMachineFile(path)?.off).toEqual([realpathSync(folder)]);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(setFolderOff(path, folder, true)).toEqual({ changed: false, file: added.file });

    const removed = setFolderOff(path, folder, false);
    expect(removed).toEqual({ changed: true, file: { ...FILE, off: [] } });
    expect(readMachineFile(path)).toEqual({ ...FILE, off: [] });
    expect(setFolderOff(path, folder, false).changed).toBe(false);
    // The rest of the file is kept.
    expect(readMachineFile(path)).toMatchObject({ hub: FILE.hub, machine: FILE.machine, token: FILE.token });
  });

  test("setFolderOff needs a machine file", () => {
    const dir = tempDir();
    expect(() => setFolderOff(join(dir, "machine.json"), dir, true)).toThrow(MachineFileError);
  });
});
