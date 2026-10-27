import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { copyProblems } from "../../server/test/helpers";
import {
  claudeHome,
  ComputerFileError,
  computerConfigPath,
  folderId,
  isOff,
  readComputerFile,
  removeComputerFile,
  setFolderOff,
  writeComputerFile,
} from "../src/computer";
import { tempDir } from "./helpers";

const FILE = { url: "https://portico.example.com", computer: "macbook", token: "pc_x", off: [] as string[] };

describe("computer.json", () => {
  test("writes computer.json with mode 600 in a folder with mode 700, and reads it back", () => {
    const path = join(tempDir(), "nested", "computer.json");
    writeComputerFile(path, FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(readComputerFile(path)).toEqual(FILE);
  });

  test("an existing .portico folder is tightened to mode 700; any other existing folder is left alone", () => {
    const own = join(tempDir(), ".portico");
    mkdirSync(own);
    chmodSync(own, 0o755);
    writeComputerFile(join(own, "computer.json"), FILE);
    expect(statSync(own).mode & 0o777).toBe(0o700);

    // PORTICO_COMPUTER_CONFIG may point into a shared folder.
    const shared = join(tempDir(), "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    writeComputerFile(join(shared, "computer.json"), FILE);
    expect(statSync(shared).mode & 0o777).toBe(0o755);
    expect(statSync(join(shared, "computer.json")).mode & 0o777).toBe(0o600);
  });

  test("rewriting replaces the file in one step and leaves no temp file behind", () => {
    const dir = tempDir();
    const path = join(dir, "computer.json");
    writeComputerFile(path, FILE);
    writeComputerFile(path, { ...FILE, computer: "studio" });
    expect(readComputerFile(path)?.computer).toBe("studio");
    expect(readdirSync(dir)).toEqual(["computer.json"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a missing file reads as null; a broken one throws ComputerFileError naming the path", () => {
    const dir = tempDir();
    expect(readComputerFile(join(dir, "computer.json"))).toBeNull();

    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");
    expect(() => readComputerFile(broken)).toThrow(ComputerFileError);
    expect(() => readComputerFile(broken)).toThrow(broken);

    const wrongShape = join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ hub: "https://portico.example.com", machine: "macbook", token: "x", off: [] }));
    expect(() => readComputerFile(wrongShape)).toThrow(ComputerFileError);
    // The messages are CLI output: no pronouns (the path itself aside).
    for (const path of [broken, wrongShape]) {
      let message = "";
      try {
        readComputerFile(path);
      } catch (err) {
        message = (err as Error).message.replace(path, "");
      }
      expect(copyProblems(message)).toEqual([]);
    }

    const badOff = join(dir, "bad-off.json");
    writeFileSync(badOff, JSON.stringify({ ...FILE, off: [42] }));
    expect(() => readComputerFile(badOff)).toThrow(ComputerFileError);

    const unreadable = join(dir, "unreadable.json");
    writeFileSync(unreadable, JSON.stringify(FILE));
    chmodSync(unreadable, 0o000);
    try {
      // Root reads anything, so the check only means something for other users.
      if (process.getuid?.() !== 0) expect(() => readComputerFile(unreadable)).toThrow(ComputerFileError);
    } finally {
      chmodSync(unreadable, 0o600);
    }
  });

  test("a file without an off list reads as having none", () => {
    const path = join(tempDir(), "computer.json");
    writeFileSync(path, JSON.stringify({ url: FILE.url, computer: FILE.computer, token: FILE.token }));
    expect(readComputerFile(path)?.off).toEqual([]);
  });

  test("the paths come from PORTICO_COMPUTER_CONFIG and PORTICO_CLAUDE_HOME, defaulting under the home folder", () => {
    expect(computerConfigPath({ PORTICO_COMPUTER_CONFIG: "/x/computer.json" })).toBe("/x/computer.json");
    expect(computerConfigPath({})).toBe(join(homedir(), ".portico", "computer.json"));
    expect(claudeHome({ PORTICO_CLAUDE_HOME: "/x/.claude" })).toBe("/x/.claude");
    expect(claudeHome({ PORTICO_CLAUDE_HOME: "  " })).toBe(join(homedir(), ".claude"));
  });

  test("removeComputerFile removes the file, and the .portico folder once nothing else is in it", () => {
    const home = tempDir();
    const own = join(home, ".portico");
    const path = join(own, "computer.json");
    writeComputerFile(path, FILE);
    expect(removeComputerFile(path)).toBe(true);
    expect(existsSync(own)).toBe(false);
    expect(removeComputerFile(path)).toBe(false);

    // Something else in the folder keeps the folder; another folder is never removed.
    writeComputerFile(path, FILE);
    writeFileSync(join(own, "notes.txt"), "kept");
    expect(removeComputerFile(path)).toBe(true);
    expect(readdirSync(own)).toEqual(["notes.txt"]);
    const shared = join(home, "shared");
    writeComputerFile(join(shared, "computer.json"), FILE);
    expect(removeComputerFile(join(shared, "computer.json"))).toBe(true);
    expect(existsSync(shared)).toBe(true);
  });
});

describe("folders", () => {
  test("folderId is an HMAC of the folder's real path, keyed with the token", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    const id = folderId("pc_x", join(dir, "real"));
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(folderId("pc_x", join(dir, "link"))).toBe(id);
    expect(folderId("pc_y", join(dir, "real"))).not.toBe(id);
    expect(folderId("pc_x", dir)).not.toBe(id);
  });

  test("isOff matches exactly the folder, as Portico keeps the switch per folder", () => {
    const dir = tempDir();
    for (const sub of ["app/src", "app2"]) mkdirSync(join(dir, sub), { recursive: true });
    const file = { off: [join(dir, "app")] };
    expect(isOff(file, join(dir, "app"))).toBe(true);
    expect(isOff(file, join(dir, "app/src"))).toBe(false);
    expect(isOff(file, join(dir, "app2"))).toBe(false);
    expect(isOff({ off: [] }, join(dir, "app"))).toBe(false);
  });

  test("isOff resolves symlinks on both sides, so a link and its target match", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "real"), { recursive: true });
    symlinkSync(join(dir, "real"), join(dir, "link"));
    expect(isOff({ off: [join(dir, "link")] }, join(dir, "real"))).toBe(true);
    expect(isOff({ off: [join(dir, "real")] }, join(dir, "link"))).toBe(true);
    // The system temp folder is itself a symlink on macOS (/var -> /private/var); both spellings match.
    expect(isOff({ off: [realpathSync(dir)] }, dir)).toBe(true);
  });

  test("setFolderOff adds a folder once and removes it, keeping the rest of the file", () => {
    const dir = tempDir();
    const path = join(dir, "computer.json");
    const folder = join(dir, "app");
    mkdirSync(folder);
    writeComputerFile(path, FILE);

    const added = setFolderOff(path, folder, true);
    expect(added.changed).toBe(true);
    expect(added.file.off).toEqual([realpathSync(folder)]);
    expect(readComputerFile(path)?.off).toEqual([realpathSync(folder)]);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(setFolderOff(path, folder, true)).toEqual({ changed: false, file: added.file });

    const removed = setFolderOff(path, folder, false);
    expect(removed).toEqual({ changed: true, file: { ...FILE, off: [] } });
    expect(readComputerFile(path)).toEqual({ ...FILE, off: [] });
    expect(setFolderOff(path, folder, false).changed).toBe(false);
  });

  test("setFolderOff needs a computer file", () => {
    const dir = tempDir();
    expect(() => setFolderOff(join(dir, "computer.json"), dir, true)).toThrow(ComputerFileError);
  });
});
