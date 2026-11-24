// A stand-in for an app that draws MCP Apps cards: enough of a host to show Portico's status card as the server serves
// the card, and to record what the card's page says to its host. Used by the MCP scenario and by the recorded flow.
// The frame is as locked down as a real host's: sandboxed with scripts only, under the content policy a host applies
// when the page's resource asks for nothing.
import type { FrameLocator, Page } from "@playwright/test";
import { BASE_URL } from "./env";

/** Where the stand-in host's own page lives. Nothing answers there but this file's route. */
export const CARD_HOST = "http://card-host.test/";
export const CARD_URI = "ui://portico/status-v1.html";

/** The policy MCP Apps gives a page whose resource declares no domains: no network at all. */
const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none';">`;

let nextId = 1;
/** One JSON-RPC request to /mcp with an agent's token: `{ status, body }`. */
export async function mcp(token: string | null, method: string, params?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) }),
  });
  const text = await res.text();
  return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
}

/** portico_status's whole answer, as a host hands the answer to the card: content, structuredContent, isError. */
export async function statusResult(token: string, args: Record<string, unknown> = {}): Promise<any> {
  const { body } = await mcp(token, "tools/call", { name: "portico_status", arguments: args });
  if (body.error) throw new Error(`portico_status: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** The card's page, read the way a host reads the page (resources/read), with the host's content policy put in. */
export async function cardPage(token: string): Promise<string> {
  const read = await mcp(token, "resources/read", { uri: CARD_URI });
  const item = read.body.result?.contents?.[0];
  if (read.status !== 200 || item?.mimeType !== "text/html;profile=mcp-app") throw new Error(`resources/read answered ${read.status}: ${JSON.stringify(read.body).slice(0, 200)}`);
  return (item.text as string).replace("<head>", `<head>${POLICY}`);
}

/** Opens the stand-in host's page: blank, with an optional line above the card saying what the page is. */
export async function openCardHost(page: Page, label = ""): Promise<void> {
  await page.route(CARD_HOST, (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>host</title><body style="margin:0;padding:16px;background:#ffffff;font:14px/20px system-ui,sans-serif;color:#555"></body>` }),
  );
  await page.goto(CARD_HOST);
  if (label) {
    await page.evaluate((text) => {
      const p = document.createElement("p");
      p.id = "host-label";
      p.style.margin = "0 0 12px";
      p.textContent = text;
      document.body.appendChild(p);
    }, label);
  }
}

/**
 * Draws one card on the open host page: a sandboxed frame holding the page, the MCP Apps handshake (ui/initialize,
 * ui/notifications/initialized), then the tool's input and result. Everything the page says is kept for cardMessages.
 */
export async function drawCard(page: Page, html: string, toolResult: unknown, theme: "light" | "dark" = "light"): Promise<FrameLocator> {
  await page.evaluate(
    ({ html, toolResult, theme }) => {
      const w = window as unknown as { seen: any[]; listener?: (event: MessageEvent) => void };
      w.seen = [];
      document.querySelector("iframe")?.remove();
      if (w.listener) window.removeEventListener("message", w.listener);
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.style.cssText = "display: block; width: 100%; height: 120px; border: 0";
      frame.srcdoc = html;
      const say = (message: unknown) => frame.contentWindow!.postMessage(message, "*");
      w.listener = (event) => {
        if (event.source !== frame.contentWindow) return;
        const m = event.data;
        w.seen.push(m);
        if (m.method === "ui/initialize") {
          say({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "stand-in-host", version: "1" }, hostCapabilities: { openLinks: {} }, hostContext: { theme } } });
        } else if (m.method === "ui/notifications/initialized") {
          say({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: {} } });
          say({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: toolResult });
        } else if (m.method === "ui/notifications/size-changed") {
          // As a host does: the frame is as tall as the card says the card is.
          if (typeof m.params?.height === "number") frame.style.height = `${Math.min(Math.max(m.params.height, 40), 2000)}px`;
        } else if (m.method === "ui/open-link") say({ jsonrpc: "2.0", id: m.id, result: {} });
      };
      window.addEventListener("message", w.listener);
      document.body.appendChild(frame);
    },
    { html, toolResult, theme },
  );
  return page.frameLocator("iframe");
}

/** Every message the card's page has sent its host since the last drawCard. */
export function cardMessages(page: Page): Promise<any[]> {
  return page.evaluate(() => (window as unknown as { seen: any[] }).seen);
}
