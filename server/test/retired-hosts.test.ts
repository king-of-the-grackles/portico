// An address the server used to answer on: every request there says Gone and names the address to use now.
import { describe, expect, test } from "bun:test";
import { parseEnv } from "../src/config";
import { copyProblems, makePortico, PUBLIC_URL, visibleCopy } from "./helpers";

const OLD = "old.portico.example.com";

describe("retired hosts", () => {
  test("every path on a retired host answers 410 with the new address, and nothing behind it runs", async () => {
    const p = makePortico({ config: { retiredHosts: [OLD] } });
    for (const [method, path] of [["GET", "/mcp"], ["POST", "/mcp"], ["GET", "/.well-known/oauth-protected-resource"], ["GET", "/.well-known/oauth-authorization-server"], ["POST", "/oauth/register"], ["POST", "/api/join"], ["GET", "/api/agent/inbox"], ["GET", "/healthz"]] as const) {
      const res = await p.app.request(path, { method, headers: { host: OLD, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect([path, res.status]).toEqual([path, 410]);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("gone");
      expect(body.message).toBe(`Portico no longer answers at ${OLD}. Portico is at ${PUBLIC_URL}. An agent or connector set up for ${OLD} joins again there: ${PUBLIC_URL}/join`);
    }
    // The host's case and a port make no difference.
    expect((await p.app.request("/mcp", { headers: { host: `OLD.Portico.Example.com:443` } })).status).toBe(410);
    // No metadata for the old address: a connector there can't be sent to the new one by a mismatched answer.
    expect(JSON.stringify(await (await p.app.request("/.well-known/oauth-protected-resource", { headers: { host: OLD } })).json())).not.toContain("authorization_servers");
  });

  test("a browser gets a page that says so", async () => {
    const p = makePortico({ config: { retiredHosts: [OLD] } });
    const res = await p.app.request("/sign-in", { headers: { host: OLD, accept: "text/html" } });
    expect(res.status).toBe(410);
    const page = await res.text();
    expect(page).toContain("<h1>This address is retired</h1>");
    expect(page).toContain(`<a href="${PUBLIC_URL}">${PUBLIC_URL}</a>`);
    expect(copyProblems(visibleCopy(page))).toEqual([]);
  });

  test("the server's own address and any other host are answered as before", async () => {
    const p = makePortico({ config: { retiredHosts: [OLD] } });
    const own = new URL(PUBLIC_URL).host;
    expect((await p.app.request("/healthz", { headers: { host: own } })).status).toBe(200);
    expect((await p.app.request("/healthz")).status).toBe(200);
    expect((await (await p.app.request("/.well-known/oauth-protected-resource", { headers: { host: own } })).json()) as object).toMatchObject({ resource: `${PUBLIC_URL}/mcp` });
    // With nothing retired, the old host is just another name for the server.
    expect((await makePortico().app.request("/healthz", { headers: { host: OLD } })).status).toBe(200);
  });

  test("PORTICO_RETIRED_HOSTS is a list of host names, and never the server's own", () => {
    expect(parseEnv({ PORTICO_RETIRED_HOSTS: " Old.Portico.Example.com , older.portico.example.com," }, "k").retiredHosts).toEqual([OLD, "older.portico.example.com"]);
    expect(() => parseEnv({ PORTICO_RETIRED_HOSTS: "https://old.portico.example.com" }, "k")).toThrow(/host names separated by commas/);
    expect(() => parseEnv({ PORTICO_PUBLIC_URL: PUBLIC_URL, PORTICO_RETIRED_HOSTS: new URL(PUBLIC_URL).hostname }, "k")).toThrow(/this server answers there/);
  });
});
