import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { folderId, readComputerFile, writeComputerFile } from "../src/computer";
import { CommandError } from "../src/computer-api";
import { defaultComputerName, joinComputer, parseJoinLine } from "../src/join";
import { contractPortico, fakePortico, tempDir } from "./helpers";

const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

const TOKEN = "T4mWq8Zr2LpX6Kd1";

function portico(tokens = [TOKEN]) {
  const server = contractPortico(tokens);
  servers.push(server);
  return server;
}

const configPath = () => join(tempDir(), "computer.json");
const hostname = () => "MacBook-Pro.local";

async function commandError(promise: Promise<unknown>): Promise<CommandError> {
  const err = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(err).toBeInstanceOf(CommandError);
  return err as CommandError;
}

describe("parseJoinLine", () => {
  test("accepts the whole line or the bare link", () => {
    expect(parseJoinLine(`Join Portico: https://portico.example.com/join#${TOKEN}`)).toEqual({
      url: "https://portico.example.com",
      token: TOKEN,
    });
    expect(parseJoinLine(`https://portico.example.com/base/join#${TOKEN}`)).toEqual({
      url: "https://portico.example.com/base",
      token: TOKEN,
    });
    expect(parseJoinLine(`http://localhost:8790/join#${TOKEN}`).url).toBe("http://localhost:8790");
    expect(parseJoinLine(`http://127.0.0.1/join#${TOKEN}`).url).toBe("http://127.0.0.1");
  });

  test("refuses plain http to a remote host, credentials in the address, and a missing or malformed token", () => {
    for (const bad of [
      "no address here",
      `http://portico.example.com/join#${TOKEN}`,
      `https://u:p@portico.example.com/join#${TOKEN}`,
      "https://portico.example.com/join",
      "https://portico.example.com/join#short",
      `https://portico.example.com/join#${TOKEN}$(id)`,
    ]) {
      expect(() => parseJoinLine(bad)).toThrow(CommandError);
    }
  });
});

describe("joinComputer", () => {
  test("posts the token and the hostname-based name, then writes computer.json with mode 600", async () => {
    const server = portico();
    const path = configPath();
    const joined = await joinComputer({ line: `Join Portico: ${server.url}/join#${TOKEN}` }, { configPath: path, hostname });
    expect(joined).toEqual({ url: server.url, computer: "macbook-pro", path, unsynced: [], attached: false });
    expect(server.requests).toEqual([
      { method: "POST", path: "/api/computer/join", token: null, body: { token: TOKEN, computer: "macbook-pro" } },
    ]);
    expect(readComputerFile(path)).toEqual({ url: server.url, computer: "macbook-pro", token: expect.stringMatching(/^pc_/), off: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("the name Portico answers with is the one written", async () => {
    const server = portico([TOKEN, `${TOKEN}-2`]);
    const first = await joinComputer({ line: `${server.url}/join#${TOKEN}`, name: "studio" }, { configPath: configPath(), hostname });
    const second = await joinComputer({ line: `${server.url}/join#${TOKEN}-2`, name: "studio" }, { configPath: configPath(), hostname });
    expect([first.computer, second.computer]).toEqual(["studio", "studio-2"]);
  });

  test("an existing computer.json is kept unless replace is set; replace switches the folders that were off off again", async () => {
    const server = portico();
    const path = configPath();
    const folder = realpathSync(tempDir());
    writeComputerFile(path, { url: "https://portico.example.com", computer: "studio", token: "pc_old", off: [folder] });
    const before = readFileSync(path, "utf8");

    const err = await commandError(joinComputer({ line: `${server.url}/join#${TOKEN}` }, { configPath: path, hostname }));
    expect(err.message).toBe(
      `${path} already exists (computer "studio" on https://portico.example.com). Nothing was written. Run again with --replace to join again.`,
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(server.requests).toEqual([]); // refused before the token was sent

    const joined = await joinComputer({ line: `${server.url}/join#${TOKEN}`, name: "macbook", replace: true }, { configPath: path, hostname });
    expect(joined).toMatchObject({ computer: "macbook", unsynced: [] });
    const file = readComputerFile(path)!;
    expect(file).toEqual({ url: server.url, computer: "macbook", token: expect.stringMatching(/^pc_/), off: [folder] });
    // The new computer starts with every folder on, so the folder is switched off on Portico again, by its new ID.
    expect(server.folders.get(`${file.token}:${folderId(file.token, folder)}`)).toEqual({ name: expect.any(String), joins: false });
  });

  test("with replace, a folder Portico couldn't be told about is named", async () => {
    const server = fakePortico(({ path }) =>
      path === "/api/computer/join"
        ? Response.json({ computer: { id: "c1", name: "macbook" }, token: "pc_new" }, { status: 201 })
        : Response.json({ error: "internal", message: "Something went wrong." }, { status: 500 }),
    );
    servers.push(server);
    const path = configPath();
    writeComputerFile(path, { url: server.url, computer: "macbook", token: "pc_old", off: ["/work/private"] });
    const joined = await joinComputer({ line: `${server.url}/join#${TOKEN}`, replace: true }, { configPath: path, hostname });
    expect(joined.unsynced).toEqual(["/work/private"]);
    expect(readComputerFile(path)?.off).toEqual(["/work/private"]);
  });

  test("a broken computer.json is reported, and replace writes over the broken file", async () => {
    const server = portico();
    const path = configPath();
    writeFileSync(path, "{ not json");
    await expect(joinComputer({ line: `${server.url}/join#${TOKEN}` }, { configPath: path, hostname })).rejects.toThrow(
      `${path} is not valid JSON.`,
    );
    expect(readFileSync(path, "utf8")).toBe("{ not json");
    await joinComputer({ line: `${server.url}/join#${TOKEN}`, replace: true }, { configPath: path, hostname });
    expect(readComputerFile(path)?.off).toEqual([]);
  });

  test("a refusal becomes a CommandError carrying Portico's message", async () => {
    const server = portico([]);
    const path = configPath();
    const err = await commandError(joinComputer({ line: `${server.url}/join#${TOKEN}` }, { configPath: path, hostname }));
    expect(err.message).toBe("The join line isn't valid any more. Ask for a new one.");
    expect(existsSync(path)).toBe(false);

    // Without a message in the answer, the HTTP status.
    const bare = async () => new Response("Bad gateway", { status: 502 });
    const status = await commandError(
      joinComputer({ line: `https://portico.example.com/join#${TOKEN}` }, { configPath: path, hostname, fetch: bare as unknown as typeof fetch }),
    );
    expect(status.message).toBe("Portico at https://portico.example.com answered HTTP 502.");

    // A 2xx answer that isn't a join result writes nothing.
    const odd = async () => Response.json({ ok: true }, { status: 201 });
    const oddErr = await commandError(
      joinComputer({ line: `https://portico.example.com/join#${TOKEN}` }, { configPath: path, hostname, fetch: odd as unknown as typeof fetch }),
    );
    expect(oddErr.message).toBe("Portico at https://portico.example.com sent an answer that isn't a join result. Nothing was written.");
    expect(existsSync(path)).toBe(false);
  });

  test("control characters from Portico are stripped from its error text and from the computer name", async () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const CSI = String.fromCharCode(0x9b);
    const NEL = String.fromCharCode(0x85);
    const line = `https://portico.example.com/join#${TOKEN}`;
    const path = configPath();
    const refusing = (async () =>
      Response.json({ error: "bad_request", message: `${ESC}[2J${ESC}]0;title${BEL}Bad token${CSI}31m` }, { status: 400 })) as unknown as typeof fetch;
    const err = await commandError(joinComputer({ line }, { configPath: path, hostname, fetch: refusing }));
    expect(err.message).toBe("[2J]0;titleBad token31m");

    const naming = (async () =>
      Response.json({ computer: { id: "c1", name: `studio${ESC}[31m${NEL}` }, token: "pc_x" }, { status: 201 })) as unknown as typeof fetch;
    const joined = await joinComputer({ line }, { configPath: path, hostname, fetch: naming });
    expect(joined.computer).toBe("studio[31m");
    expect(readComputerFile(path)?.computer).toBe("studio[31m");
  });

  test("an unreachable Portico becomes a CommandError, and nothing is written", async () => {
    const path = configPath();
    const err = await commandError(joinComputer({ line: `http://127.0.0.1:1/join#${TOKEN}` }, { configPath: path, hostname }));
    expect(err.message).toBe("Portico at http://127.0.0.1:1 could not be reached.");
    expect(existsSync(path)).toBe(false);
  });

  test("a redirect is refused rather than followed, so the token goes only to the Portico in the line", async () => {
    const server = portico();
    const redirector = Bun.serve({ port: 0, fetch: (req) => Response.redirect(`${server.url}${new URL(req.url).pathname}`, 308) });
    try {
      const path = configPath();
      const err = await commandError(joinComputer({ line: `http://127.0.0.1:${redirector.port}/join#${TOKEN}` }, { configPath: path, hostname }));
      expect(err.message).toBe(`Portico at http://127.0.0.1:${redirector.port} answered HTTP 308.`);
      expect(existsSync(path)).toBe(false);
      expect(server.requests).toEqual([]);
    } finally {
      redirector.stop(true);
    }
  });

  // Root can write anywhere, so the refusal can't be staged there.
  test.skipIf(process.getuid?.() === 0)("a computer file that can't be written says the join line was used", async () => {
    const server = portico();
    const locked = join(tempDir(), "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const path = join(locked, "computer.json");
      const err = await commandError(joinComputer({ line: `${server.url}/join#${TOKEN}` }, { configPath: path, hostname }));
      expect(err.message).toBe(`${path} could not be written (EACCES). The join line is used up: ask for a new one, then join again.`);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("defaultComputerName drops .local and slugs the hostname", () => {
    expect(defaultComputerName("MacBook-Pro.local")).toBe("macbook-pro");
    expect(defaultComputerName("")).toBe("computer");
    expect(defaultComputerName("Studio Mac (2)")).toBe("studio-mac-2");
  });
});
