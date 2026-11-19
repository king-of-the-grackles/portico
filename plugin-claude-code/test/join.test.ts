import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { folderId, readComputerFile, writeComputerFile } from "../src/computer";
import { CommandError } from "../src/computer-api";
import { CODE_QUESTION, defaultComputerName, joinComputer, type JoinDeps, JoinWaiting, parseServerAddress, pendingJoinPath, WrongCode } from "../src/join";
import { contractPortico, fakePortico, tempDir } from "./helpers";

const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

/** The Portico the test's person looks at: the code on its page is what that person types at the prompt. */
let current: ReturnType<typeof contractPortico> | null = null;

function portico(person: Parameters<typeof contractPortico>[0] = "allow") {
  const server = contractPortico(person);
  servers.push(server);
  current = server;
  return server;
}

const configPath = () => join(tempDir(), "computer.json");
const hostname = () => "MacBook-Pro.local";

/**
 * What a join needs from outside, with the printed lines kept and no real waiting between polls. As in a terminal: the
 * person types the code the page shows. `noPrompt` is an agent's shell, where nothing can be typed.
 */
function deps(path: string, over: Partial<JoinDeps> = {}): JoinDeps & { lines: string[] } {
  const lines: string[] = [];
  const server = current;
  return { configPath: path, hostname, out: (line) => lines.push(line), pollMs: 1, lines, readCode: async () => server?.typeCode() ?? null, ...over };
}
const noPrompt = { readCode: undefined };

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
  test("asks with the hostname-based name, prints the link, takes the code at the prompt, then writes computer.json with mode 600", async () => {
    const server = portico();
    const path = configPath();
    const asked: string[] = [];
    const d = deps(path, { readCode: async (question) => (asked.push(question), server.typeCode()) });
    const joined = await joinComputer({ address: server.url, client: "claude-code" }, d);
    expect(joined).toEqual({ url: server.url, computer: "macbook-pro", path, unsynced: [], already: false });
    expect(server.requests[0]).toEqual({ method: "POST", path: "/api/join", token: null, body: { kind: "computer", name: "macbook-pro", client: "claude-code" } });
    // The code goes to Portico with the poll secret, and nowhere else.
    expect(server.requests[1]).toEqual({ method: "POST", path: "/api/join/r1/code", token: expect.stringMatching(/^ps_/), body: { code: "4821" } });
    expect(asked).toEqual([CODE_QUESTION]);
    // The lines a person acts on: the page, what to do there, and when the request runs out. Never a code: Portico sends none.
    expect(d.lines).toEqual([
      "A person allows this computer on one Portico page:",
      `  1. Open ${server.url}/c/r1 in a browser, sign in and press Allow.`,
      "  2. The page then shows a 4-digit code. Type that code here, and nowhere else.",
      expect.stringMatching(/^The request runs out at \d{4}-\d\d-\d\dT[\d:.]+Z\.$/),
    ]);
    expect(readComputerFile(path)).toEqual({ url: server.url, computer: "macbook-pro", token: expect.stringMatching(/^pc_/), off: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The poll secret is kept only while the join waits.
    expect(existsSync(pendingJoinPath(path))).toBe(false);
    expect(d.lines.join("\n")).not.toMatch(/ps_|pc_|4821/);
  });

  test("the name Portico answers with is the one written", async () => {
    const server = portico();
    const first = await joinComputer({ address: server.url, name: "studio" }, deps(configPath()));
    const second = await joinComputer({ address: `${server.url}/join`, name: "studio" }, deps(configPath()));
    expect([first.computer, second.computer]).toEqual(["studio", "studio-2"]);
  });

  test("a wrong code at the prompt says so and asks again; too many close the request", async () => {
    const server = portico();
    const path = configPath();
    const typed = ["0000", "48 21"];
    const d = deps(path, { readCode: async () => typed.shift() ?? null });
    expect((await joinComputer({ address: server.url }, d)).computer).toBe("macbook-pro");
    expect(d.lines[4]).toBe("That code doesn't match the one Portico's page shows. 4 tries are left.");
    // Something that isn't 4 digits never leaves the computer.
    const other = configPath();
    const odd = ["abcd", "123", ""];
    const waiting = await joinComputer({ address: server.url }, deps(other, { readCode: async () => odd.shift() ?? null })).catch((err: unknown) => err);
    expect(waiting).toBeInstanceOf(JoinWaiting);
    expect(server.requests.filter((r) => r.path === "/api/join/r2/code")).toEqual([]);
    // Five wrong codes: the request is closed, and the waiting join is forgotten.
    const guesses = deps(other, { readCode: async () => "0000" });
    const err = await commandError(joinComputer({ address: server.url }, guesses));
    expect(err).not.toBeInstanceOf(WrongCode);
    expect(err.message).toBe("The join wasn't allowed on Portico, or too many wrong codes closed the request. Nothing was written. Run the join again for a fresh link.");
    expect(server.requests.filter((r) => r.path === "/api/join/r2/code")).toHaveLength(5);
    expect(existsSync(pendingJoinPath(other))).toBe(false);
    expect(existsSync(other)).toBe(false);
  });

  test("with no prompt, the first call prints the link and waits for Allow; a second call hands the code in", async () => {
    const server = portico("wait");
    const path = configPath();
    const first = deps(path, noPrompt);
    const waiting = await joinComputer({ address: server.url, waitSeconds: 0 }, first).then(
      () => null,
      (err: unknown) => err,
    );
    expect(waiting).toBeInstanceOf(JoinWaiting);
    expect((waiting as JoinWaiting).allowed).toBe(false);
    expect(existsSync(path)).toBe(false);
    const pending = pendingJoinPath(path);
    expect(statSync(pending).mode & 0o777).toBe(0o600);
    // What waits on disk: the request and its poll secret. No code: only the person has one.
    expect(JSON.parse(readFileSync(pending, "utf8"))).toEqual({ url: server.url, id: "r1", pollSecret: expect.stringMatching(/^ps_/), link: `${server.url}/c/r1`, expiresAt: expect.any(String) });
    // A code before anyone pressed Allow: told so, and the join keeps waiting.
    const early = await commandError(joinComputer({ code: "4821" }, deps(path, noPrompt)));
    expect(early.message).toBe(`Nobody has pressed Allow yet. Open ${server.url}/c/r1 in a browser, sign in and press Allow: the page then shows the code.`);
    expect(existsSync(pending)).toBe(true);

    // The person presses Allow: the same command sees that, prints the same link, and says how the code comes in.
    server.state.person = "allow";
    const second = deps(path, noPrompt);
    const allowed = await joinComputer({ address: server.url, waitSeconds: 100 }, second).catch((err: unknown) => err);
    expect(allowed).toBeInstanceOf(JoinWaiting);
    expect((allowed as JoinWaiting).allowed).toBe(true);
    expect(server.requests.filter((r) => r.method === "POST" && r.path === "/api/join")).toHaveLength(1);
    expect(second.lines).toEqual(first.lines);
    expect(existsSync(path)).toBe(false);

    // The second call: a wrong code keeps the join waiting, the right one finishes it, with no address needed.
    const wrong = await commandError(joinComputer({ code: "0000" }, deps(path, noPrompt)));
    expect(wrong).toBeInstanceOf(WrongCode);
    expect(wrong.message).toBe("That code doesn't match the one Portico's page shows. 4 tries are left.");
    expect(existsSync(pending)).toBe(true);
    const third = deps(path, noPrompt);
    const joined = await joinComputer({ code: "4821" }, third);
    expect(joined).toEqual({ url: server.url, computer: "macbook-pro", path, unsynced: [], already: false });
    expect(third.lines).toEqual([]);
    expect(readComputerFile(path)?.token).toMatch(/^pc_/);
    expect(existsSync(pending)).toBe(false);
    // With nothing waiting, or a join waiting for another Portico, a code has nowhere to go.
    for (const opts of [{ code: "4821" }, { code: "4821", address: "https://other.example.com" }]) {
      expect((await commandError(joinComputer(opts, deps(configPath(), noPrompt)))).message).toBe(
        "No join waits for a code here. Run the join with the Portico server's address first: that prints the link to open.",
      );
    }
  });

  test("a request that ran out: the join says so, and running again asks for a fresh link in place of the old request", async () => {
    const server = portico("late");
    const path = configPath();
    const err = await commandError(joinComputer({ address: server.url }, deps(path, noPrompt)));
    expect(err.message).toBe("The request ran out before the join was finished. Run the join again for a fresh link.");
    expect(existsSync(path)).toBe(false);
    expect(existsSync(pendingJoinPath(path))).toBe(false);

    // A request still on file whose time has passed is replaced, not left waiting beside the new one.
    server.state.person = "wait";
    let clock = Date.now();
    await joinComputer({ address: server.url, waitSeconds: 0 }, deps(path, { now: () => clock, ...noPrompt })).catch(() => {});
    clock += 16 * 60_000;
    // The old code is no use by then either.
    expect((await commandError(joinComputer({ code: "4822" }, deps(path, { now: () => clock, ...noPrompt })))).message).toBe(
      "The request ran out before the join was finished. Run the join again for a fresh link.",
    );
    await joinComputer({ address: server.url, waitSeconds: 0 }, deps(path, noPrompt)).catch(() => {});
    clock = Date.now() + 16 * 60_000;
    server.state.person = "allow";
    const fresh = deps(path, { now: () => clock });
    const joined = await joinComputer({ address: server.url }, fresh);
    expect(joined.already).toBe(false);
    const posts = server.requests.filter((r) => r.method === "POST" && r.path === "/api/join");
    expect(posts.at(-1)!.body).toMatchObject({ kind: "computer", replaces: { id: "r3", poll_secret: expect.stringMatching(/^ps_/) } });
    expect(fresh.lines[1]).toBe(`  1. Open ${server.url}/c/r4 in a browser, sign in and press Allow.`);
    expect(server.asked.get("r3")!.closed).toBe(true);
  });

  test("a join the person turns down writes nothing", async () => {
    const server = portico("deny");
    const path = configPath();
    const err = await commandError(joinComputer({ address: server.url }, deps(path, noPrompt)));
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
    expect(server.requests.filter((r) => r.path === "/api/join/r1/code")).toHaveLength(1);

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
        return Response.json({ id: "r1", link: `${base}/c/r1`, poll_secret: "ps_x", expires_at: new Date(Date.now() + 60_000).toISOString() }, { status: 201 });
      }
      if (path === "/api/join/r1/code") return Response.json({ status: "approved", computer: { id: "c1", name: "macbook" }, token: "pc_new" });
      return Response.json({ error: "internal", message: "Something went wrong." }, { status: 500 });
    });
    servers.push(server);
    const path = configPath();
    writeComputerFile(path, { url: server.url, computer: "macbook", token: "pc_old", off: ["/work/private"] });
    const joined = await joinComputer({ address: server.url, replace: true }, deps(path, { readCode: async () => "0042" }));
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
    // page, plain http to a remote host, credentials or a query in the address, or control characters.
    const ESC = String.fromCharCode(27);
    const expires = new Date(Date.now() + 60_000).toISOString();
    for (const answer of [
      { ok: true },
      { id: "r1", link: "https://portico.example.com/c/r2", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "https://portico.example.com/sign-in?next=/c/r1", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "http://portico.example.com/c/r1", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "https://u:p@portico.example.com/c/r1", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "https://portico.example.com/c/r1?to=evil", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "javascript:alert(1)//c/r1", poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "https://portico.example.com/c/r1", poll_secret: "", expires_at: expires },
      { id: `r1${ESC}[31m`, link: `https://portico.example.com/c/r1${ESC}[31m`, poll_secret: "ps_x", expires_at: expires },
      { id: "r1", link: "https://portico.example.com/c/r1", poll_secret: "ps_x", expires_at: "soon" },
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
        ? Response.json({ id: "r1", link: "https://portico.example.com/c/r1", poll_secret: "ps_x", expires_at: new Date(Date.now() + 60_000).toISOString() }, { status: 201 })
        : Response.json({ status: "approved", computer: { id: "c1", name: `studio${ESC}[31m${NEL}` }, token: "pc_x" })) as unknown as typeof fetch;
    const joined = await joinComputer({ address: "https://portico.example.com" }, deps(path, { fetch: naming, readCode: async () => "1234" }));
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
