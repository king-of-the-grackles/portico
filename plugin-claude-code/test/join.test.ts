import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { folderId, readComputerFile, writeComputerFile } from "../src/computer";
import { CommandError } from "../src/computer-api";
import { defaultComputerName, joinComputer, type JoinDeps, JoinWaiting, parseServerAddress, pendingJoinPath } from "../src/join";
import { contractPortico, fakePortico, tempDir } from "./helpers";

const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function portico(person: Parameters<typeof contractPortico>[0] = "allow") {
  const server = contractPortico(person);
  servers.push(server);
  return server;
}

const configPath = () => join(tempDir(), "computer.json");
const hostname = () => "MacBook-Pro.local";

/** What a join needs from outside, with the printed lines kept and no real waiting between polls. */
function deps(path: string, over: Partial<JoinDeps> = {}): JoinDeps & { lines: string[] } {
  const lines: string[] = [];
  return { configPath: path, hostname, out: (line) => lines.push(line), pollMs: 1, lines, ...over };
}

async function commandError(promise: Promise<unknown>): Promise<CommandError> {
  const err = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(err).toBeInstanceOf(CommandError);
  return err as CommandError;
}

describe("parseServerAddress", () => {
  test("accepts the server's address alone, with /join, a trailing slash, or the sentence a person says", () => {
    expect(parseServerAddress("https://portico.example.com")).toBe("https://portico.example.com");
    expect(parseServerAddress("https://portico.example.com/")).toBe("https://portico.example.com");
    expect(parseServerAddress("https://portico.example.com/join")).toBe("https://portico.example.com");
    expect(parseServerAddress("https://portico.example.com/base/join/")).toBe("https://portico.example.com/base");
    expect(parseServerAddress("Join Portico at https://portico.example.com.")).toBe("https://portico.example.com");
    expect(parseServerAddress("http://localhost:8790/join")).toBe("http://localhost:8790");
    expect(parseServerAddress("http://127.0.0.1")).toBe("http://127.0.0.1");
  });

  test("refuses plain http to a remote host, credentials in the address, and anything after ? or #", () => {
    for (const bad of [
      "no address here",
      "http://portico.example.com",
      "https://u:p@portico.example.com",
      "https://portico.example.com/join#T4mWq8Zr2LpX6Kd1",
      "https://portico.example.com/?next=x",
      "https://[bad",
    ]) {
      expect(() => parseServerAddress(bad)).toThrow(CommandError);
    }
  });
});

describe("joinComputer", () => {
  test("asks with the hostname-based name, prints the link and the code, polls until Allow, then writes computer.json with mode 600", async () => {
    const server = portico();
    const path = configPath();
    const d = deps(path);
    const joined = await joinComputer({ address: server.url, client: "claude-code" }, d);
    expect(joined).toEqual({ url: server.url, computer: "macbook-pro", path, unsynced: [], already: false });
    expect(server.requests[0]).toEqual({ method: "POST", path: "/api/join", token: null, body: { kind: "computer", name: "macbook-pro", client: "claude-code" } });
    expect(server.requests[1]).toMatchObject({ method: "GET", path: "/api/join/r1", token: expect.stringMatching(/^ps_/) });
    // The lines a person acts on: the page, the code, and when the code runs out. Nothing else is printed here.
    expect(d.lines).toEqual([
      "A person allows this computer on one Portico page:",
      `  1. Open ${server.url}/c/r1 in a browser and sign in.`,
      "  2. Type the code 4821 there and press Allow.",
      expect.stringMatching(/^The code runs out at \d{4}-\d\d-\d\dT[\d:.]+Z\. Type the code only on that page\.$/),
    ]);
    expect(readComputerFile(path)).toEqual({ url: server.url, computer: "macbook-pro", token: expect.stringMatching(/^pc_/), off: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The poll secret is kept only while the join waits.
    expect(existsSync(pendingJoinPath(path))).toBe(false);
    expect(d.lines.join("\n")).not.toMatch(/ps_|pc_/);
  });

  test("the name Portico answers with is the one written", async () => {
    const server = portico();
    const first = await joinComputer({ address: server.url, name: "studio" }, deps(configPath()));
    const second = await joinComputer({ address: `${server.url}/join`, name: "studio" }, deps(configPath()));
    expect([first.computer, second.computer]).toEqual(["studio", "studio-2"]);
  });

  test("the wait can end before the person answers: the request is kept, and the next run picks the same link and code up", async () => {
    const server = portico("wait");
    const path = configPath();
    const first = deps(path);
    const waiting = await joinComputer({ address: server.url, waitSeconds: 0 }, first).then(
      () => null,
      (err: unknown) => err,
    );
    expect(waiting).toBeInstanceOf(JoinWaiting);
    expect(existsSync(path)).toBe(false);
    const pending = pendingJoinPath(path);
    expect(statSync(pending).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(pending, "utf8"))).toMatchObject({ url: server.url, id: "r1", code: "4821", link: `${server.url}/c/r1` });

    server.state.person = "allow";
    const second = deps(path);
    const joined = await joinComputer({ address: server.url, waitSeconds: 100 }, second);
    expect(joined.computer).toBe("macbook-pro");
    // No second request was made, and the person saw the same link and code both times.
    expect(server.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(second.lines).toEqual(first.lines);
    expect(existsSync(pending)).toBe(false);
  });

  test("a code that ran out: the join says so, and running again asks for a fresh link and code in place of the old request", async () => {
    const server = portico("late");
    const path = configPath();
    const err = await commandError(joinComputer({ address: server.url }, deps(path)));
    expect(err.message).toBe("The code ran out before anyone allowed the join. Run the command again for a fresh link and code.");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(pendingJoinPath(path))).toBe(false);

    // A request still on file whose time has passed is replaced, not left waiting beside the new one.
    server.state.person = "wait";
    let clock = Date.now();
    await joinComputer({ address: server.url, waitSeconds: 0 }, deps(path, { now: () => clock })).catch(() => {});
    clock += 16 * 60_000;
    server.state.person = "allow";
    const fresh = deps(path, { now: () => clock });
    const joined = await joinComputer({ address: server.url }, fresh);
    expect(joined.already).toBe(false);
    const posts = server.requests.filter((r) => r.method === "POST");
    expect(posts.at(-1)!.body).toMatchObject({ kind: "computer", replaces: { id: "r2", poll_secret: expect.stringMatching(/^ps_/) } });
    expect(fresh.lines[1]).toBe(`  1. Open ${server.url}/c/r3 in a browser and sign in.`);
    expect(server.asked.get("r2")!.closed).toBe(true);
  });

  test("a join the person turns down writes nothing", async () => {
    const server = portico("deny");
    const path = configPath();
    const err = await commandError(joinComputer({ address: server.url }, deps(path)));
    expect(err.message).toBe("The join wasn't allowed on Portico. Nothing was written.");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(pendingJoinPath(path))).toBe(false);
  });

  test("a computer that joined the same Portico already needs nothing allowed; a removed one is told to replace", async () => {
    const server = portico();
    const path = configPath();
    await joinComputer({ address: server.url, name: "studio" }, deps(path));
    const before = readFileSync(path, "utf8");
    const again = deps(path);
    expect(await joinComputer({ address: server.url, client: "codex" }, again)).toEqual({ url: server.url, computer: "studio", path, unsynced: [], already: true });
    expect(again.lines).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(server.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/computer", token: expect.stringMatching(/^pc_/) });
    expect(server.requests.filter((r) => r.path === "/api/join")).toHaveLength(1);

    server.computers.clear();
    const err = await commandError(joinComputer({ address: server.url }, deps(path)));
    expect(err.message).toBe(
      "Portico no longer accepts this computer's token (the computer may have been removed in Settings). Run again with --replace to join as a new computer.",
    );
  });

  test("an existing computer.json for another Portico is kept unless replace is set; replace switches the folders that were off off again", async () => {
    const server = portico();
    const path = configPath();
    const folder = realpathSync(tempDir());
    writeComputerFile(path, { url: "https://portico.example.com", computer: "studio", token: "pc_old", off: [folder] });
    const before = readFileSync(path, "utf8");

    const err = await commandError(joinComputer({ address: server.url }, deps(path)));
    expect(err.message).toBe(
      `${path} already exists (computer "studio" on https://portico.example.com). Nothing was written. Run again with --replace to join again.`,
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(server.requests).toEqual([]); // refused before anything was asked

    const joined = await joinComputer({ address: server.url, name: "macbook", replace: true }, deps(path));
    expect(joined).toMatchObject({ computer: "macbook", unsynced: [] });
    const file = readComputerFile(path)!;
    expect(file).toEqual({ url: server.url, computer: "macbook", token: expect.stringMatching(/^pc_/), off: [folder] });
    // The new computer starts with every folder on, so the folder is switched off on Portico again, by its new ID.
    expect(server.folders.get(`${file.token}:${folderId(file.token, folder)}`)).toEqual({ name: expect.any(String), joins: false });
  });

  test("with replace, a folder Portico couldn't be told about is named", async () => {
    const server = fakePortico(({ method, path }) => {
      const base = server.url;
      if (method === "POST" && path === "/api/join") {
        return Response.json({ id: "r1", link: `${base}/c/r1`, code: "0042", poll_secret: "ps_x", expires_at: new Date(Date.now() + 60_000).toISOString() }, { status: 201 });
      }
      if (path === "/api/join/r1") return Response.json({ status: "approved", computer: { id: "c1", name: "macbook" }, token: "pc_new" });
      return Response.json({ error: "internal", message: "Something went wrong." }, { status: 500 });
    });
    servers.push(server);
    const path = configPath();
    writeComputerFile(path, { url: server.url, computer: "macbook", token: "pc_old", off: ["/work/private"] });
    const joined = await joinComputer({ address: server.url, replace: true }, deps(path));
    expect(joined.unsynced).toEqual(["/work/private"]);
    expect(readComputerFile(path)?.off).toEqual(["/work/private"]);
  });

  test("a broken computer.json is reported, and replace writes over the broken file", async () => {
    const server = portico();
    const path = configPath();
    writeFileSync(path, "{ not json");
    await expect(joinComputer({ address: server.url }, deps(path))).rejects.toThrow(`${path} is not valid JSON.`);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
    await joinComputer({ address: server.url, replace: true }, deps(path));
    expect(readComputerFile(path)?.off).toEqual([]);
  });

  test("a refusal becomes a CommandError carrying Portico's message, and an answer that isn't a request to join shows nothing to the person", async () => {
    const path = configPath();
    const refusing = (async () => Response.json({ error: "rate_limited", message: "Too many requests to join from this address. Try again in 15 minutes." }, { status: 429 })) as unknown as typeof fetch;
    const refused = deps(path, { fetch: refusing });
    const err = await commandError(joinComputer({ address: "https://portico.example.com" }, refused));
    expect(err.message).toBe("Too many requests to join from this address. Try again in 15 minutes.");
    expect(refused.lines).toEqual([]);

    // Without a message in the answer, the HTTP status.
    const bare = (async () => new Response("Bad gateway", { status: 502 })) as unknown as typeof fetch;
    const status = await commandError(joinComputer({ address: "https://portico.example.com" }, deps(path, { fetch: bare })));
    expect(status.message).toBe("Portico at https://portico.example.com answered HTTP 502.");

    // The link is shown to a person, so anything but a consent page for this request is refused: another request's
    // page, plain http to a remote host, credentials or a query in the address, a code that isn't four digits, or
    // control characters.
    const ESC = String.fromCharCode(27);
    const expires = new Date(Date.now() + 60_000).toISOString();
    for (const answer of [
      { ok: true },
      { id: "r1", link: "https://portico.example.com/c/r2", code: "1234", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "https://portico.example.com/sign-in?next=/c/r1", code: "1234", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "http://portico.example.com/c/r1", code: "1234", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "https://u:p@portico.example.com/c/r1", code: "1234", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "https://portico.example.com/c/r1?to=evil", code: "1234", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "javascript:alert(1)//c/r1", code: "1234", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "https://portico.example.com/c/r1", code: `12${ESC}[2J`, poll_secret: "ps_x", expires_at: expires },
      { id: `r1${ESC}[31m`, link: `https://portico.example.com/c/r1${ESC}[31m`, code: "1234", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "https://portico.example.com/c/r1", code: "1234", poll_secret: "ps_x", expires_at: "soon" },
    ]) {
      const odd = deps(path, { fetch: (async () => Response.json(answer, { status: 201 })) as unknown as typeof fetch });
      const oddErr = await commandError(joinComputer({ address: "https://portico.example.com" }, odd));
      expect(oddErr.message).toBe("Portico at https://portico.example.com sent an answer that isn't a request to join. Nothing was written.");
      expect(odd.lines).toEqual([]);
    }
    expect(existsSync(path)).toBe(false);
    expect(existsSync(pendingJoinPath(path))).toBe(false);
  });

  test("control characters from Portico are stripped from its error text and from the computer name", async () => {
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const CSI = String.fromCharCode(0x9b);
    const NEL = String.fromCharCode(0x85);
    const path = configPath();
    const refusing = (async () =>
      Response.json({ error: "bad_request", message: `${ESC}[2J${ESC}]0;title${BEL}Bad name${CSI}31m` }, { status: 400 })) as unknown as typeof fetch;
    const err = await commandError(joinComputer({ address: "https://portico.example.com" }, deps(path, { fetch: refusing })));
    expect(err.message).toBe("[2J]0;titleBad name31m");

    const naming = (async (input: string | URL | Request) =>
      String(input).endsWith("/api/join")
        ? Response.json({ id: "r1", link: "https://portico.example.com/c/r1", code: "1234", poll_secret: "ps_x", expires_at: new Date(Date.now() + 60_000).toISOString() }, { status: 201 })
        : Response.json({ status: "approved", computer: { id: "c1", name: `studio${ESC}[31m${NEL}` }, token: "pc_x" })) as unknown as typeof fetch;
    const joined = await joinComputer({ address: "https://portico.example.com" }, deps(path, { fetch: naming }));
    expect(joined.computer).toBe("studio[31m");
    expect(readComputerFile(path)?.computer).toBe("studio[31m");
  });

  test("an unreachable Portico becomes a CommandError, and nothing is written", async () => {
    const path = configPath();
    const err = await commandError(joinComputer({ address: "http://127.0.0.1:1" }, deps(path)));
    expect(err.message).toBe("Portico at http://127.0.0.1:1 could not be reached.");
    expect(existsSync(path)).toBe(false);
  });

  test("a redirect is refused rather than followed, so nothing goes anywhere but the Portico that was named", async () => {
    const server = portico();
    const redirector = Bun.serve({ port: 0, fetch: (req) => Response.redirect(`${server.url}${new URL(req.url).pathname}`, 308) });
    try {
      const path = configPath();
      const err = await commandError(joinComputer({ address: `http://127.0.0.1:${redirector.port}` }, deps(path)));
      expect(err.message).toBe(`Portico at http://127.0.0.1:${redirector.port} answered HTTP 308.`);
      expect(existsSync(path)).toBe(false);
      expect(server.requests).toEqual([]);
    } finally {
      redirector.stop(true);
    }
  });

  // Root can write anywhere, so the refusal can't be staged there.
  test.skipIf(process.getuid?.() === 0)("a folder that can't be written is found out before a person is asked to do anything", async () => {
    const server = portico();
    const locked = join(tempDir(), "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    try {
      const path = join(locked, "computer.json");
      const d = deps(path);
      const err = await commandError(joinComputer({ address: server.url }, d));
      expect(err.message).toBe(`${pendingJoinPath(path)} could not be written (EACCES), so the join can't be finished from here. Nothing changed on Portico.`);
      expect(d.lines).toEqual([]);
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
