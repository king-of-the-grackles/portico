/**
 * The status card's page: one self-contained document an MCP Apps host (ChatGPT, for one) draws in a sandboxed frame
 * beside the answer of portico_status. The host hands the page the tool's result over postMessage, as JSON-RPC:
 * the page sends `ui/initialize`, then `ui/notifications/initialized`, and the host sends `ui/notifications/tool-result`.
 *
 * What the page never does: call a tool, make a network request, load anything, or put text on screen as markup (every
 * string goes through textContent). Its one button asks the host to open a link, and only a link on Portico's own
 * public URL, which the server writes into the page.
 *
 * The script uses no template strings, so the page can live in one here.
 */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Portico status</title>
<style>
:root {
  --teal: #1f6f5c; --teal-dark: #185a4a; --accent: #1f6f5c; --teal-wash: #eef4f1;
  --ink: #102b25; --ink-soft: #2f4640; --muted: #4e625c; --line: #c9d1c7;
  --card: #f7f8f5; --surface: #ffffff;
}
:root[data-theme="dark"] {
  --teal: #247a65; --teal-dark: #1e6b58; --accent: #7fd1b9; --teal-wash: #1d332d;
  --ink: #e8efe9; --ink-soft: #c5d1cb; --muted: #9fb0a9; --line: #34443f;
  --card: #16211e; --surface: #0f1917;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --teal: #247a65; --teal-dark: #1e6b58; --accent: #7fd1b9; --teal-wash: #1d332d;
    --ink: #e8efe9; --ink-soft: #c5d1cb; --muted: #9fb0a9; --line: #34443f;
    --card: #16211e; --surface: #0f1917;
    }
}
* { box-sizing: border-box; }
/* No color-scheme of the page's own: a frame whose scheme differs from its host's gets an opaque backdrop, and the corners would show. */
html, body { margin: 0; background: transparent; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); font-size: 14px; line-height: 20px; }
[hidden] { display: none !important; }
.card { max-width: 480px; padding: 16px; border-radius: 16px; background: var(--card); box-shadow: inset 0 0 0 1px var(--line); display: flex; flex-direction: column; gap: 12px; }
h1 { margin: 0; font-size: 18px; line-height: 24px; font-weight: 700; letter-spacing: -0.01em; text-wrap: balance; overflow-wrap: anywhere; }
p { margin: 0; color: var(--ink-soft); overflow-wrap: anywhere; text-wrap: pretty; }
.quoted { padding: 8px 12px; border-left: 3px solid var(--line); border-radius: 0 8px 8px 0; background: var(--surface); color: var(--ink); white-space: pre-wrap; }
.actions { display: flex; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; max-width: 100%; min-height: 44px; padding: 8px 16px; border-radius: 8px; font: inherit; font-size: 15px; line-height: 24px; font-weight: 600; cursor: pointer; white-space: nowrap; border: 1px solid var(--teal); background: var(--surface); color: var(--accent); }
.btn:hover { background: var(--teal-wash); }
.btn[data-primary="true"] { background: var(--teal); color: #ffffff; }
.btn[data-primary="true"]:hover { background: var(--teal-dark); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn svg { width: 14px; height: 14px; flex: none; }
/* The one quiet line a card may have. */
.note { font-size: 13px; line-height: 18px; color: var(--muted); }
@media (prefers-reduced-motion: no-preference) { .btn { transition: background-color 200ms ease; } }
</style>
</head>
<body>
<main class="card" id="card" hidden>
  <h1 id="title"></h1>
  <p class="quoted" id="quote" hidden></p>
  <div class="actions" id="actions" hidden>
    <button type="button" class="btn" id="open"><span id="open-label"></span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3H3v10h10v-3"/><path d="M9 3h4v4"/><path d="M13 3L7 9"/></svg></button>
  </div>
  <p class="note" id="note" hidden></p>
</main>
<script>
(function () {
  "use strict";
  // Portico's public URL, written by the server. The button opens nothing anywhere else.
  var ORIGIN = __PORTICO_ORIGIN__;
  var el = function (id) { return document.getElementById(id); };
  var text = function (value, max) { return typeof value === "string" ? value.slice(0, max) : ""; };
  var nextId = 1;
  var pending = {};
  var ready = false;
  // What the host has sent over the MCP Apps bridge: the older bridge fills in only what is still missing.
  var fromHost = { theme: false, result: false };
  var hostCapabilities = {};
  var linkUrl = null;

  function post(message) { window.parent.postMessage(message, "*"); }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params }); }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }

  function setTheme(theme) {
    if (theme !== "light" && theme !== "dark") return false;
    document.documentElement.setAttribute("data-theme", theme);
    return true;
  }
  function hostContext(context) {
    if (context && typeof context === "object" && setTheme(context.theme)) fromHost.theme = true;
  }
  function reportSize() {
    if (!ready) return;
    var box = document.documentElement.getBoundingClientRect();
    notify("ui/notifications/size-changed", { width: Math.ceil(box.width), height: Math.ceil(box.height) });
  }

  /** A link the server wrote, on Portico's own public URL: anything else shows no button. */
  function safeLink(link) {
    if (!link || typeof link !== "object" || typeof link.url !== "string") return null;
    try {
      var url = new URL(link.url);
      return url.origin === ORIGIN && (url.protocol === "https:" || url.protocol === "http:") ? url.href : null;
    } catch (error) {
      return null;
    }
  }
  function localTime(at) {
    var date = new Date(at);
    if (isNaN(date.getTime())) return at;
    try {
      return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch (error) {
      return date.toLocaleString();
    }
  }

  /**
   * Draws the card from a tool result: one header line, a message's subject, the one button, and at most one quiet
   * line. Every string is set as text. A result with no card data (a refusal) shows its own text as the header.
   */
  function show(result) {
    if (!result || typeof result !== "object") return;
    var card = result.structuredContent && typeof result.structuredContent === "object" ? result.structuredContent : null;
    var display = card && card.display && typeof card.display === "object" ? card.display : {};
    var header = text(display.header, 300) || (card ? text(card.title, 300) : "");
    if (header === "") {
      var first = Array.isArray(result.content) ? result.content[0] : null;
      header = first ? text(first.text, 300) : "";
      card = null;
      display = {};
    }
    if (header === "") return;
    el("title").textContent = header;

    var subject = text(display.subject, 400);
    el("quote").textContent = subject;
    el("quote").hidden = subject === "";

    linkUrl = safeLink(card ? card.link : null);
    el("actions").hidden = linkUrl === null;
    if (linkUrl !== null) {
      el("open-label").textContent = text(card.link.label, 40) || "Open Portico";
      el("open").setAttribute("data-primary", card.link.primary === true ? "true" : "false");
    }

    var note = text(display.note, 200);
    if (note !== "" && text(display.noteAt, 40) !== "") note = note + " " + localTime(text(display.noteAt, 40)) + ".";
    el("note").textContent = note;
    el("note").hidden = note === "";

    el("card").hidden = false;
    reportSize();
  }

  /** Asks the host to open the link: the MCP Apps request, or ChatGPT's own call where the host offers only that one. */
  el("open").addEventListener("click", function () {
    if (linkUrl === null) return;
    var legacy = window.openai;
    var external = legacy && typeof legacy.openExternal === "function";
    if (external && !hostCapabilities.openLinks) {
      legacy.openExternal({ href: linkUrl, redirectUrl: false });
      return;
    }
    if (ready) request("ui/open-link", { url: linkUrl }).catch(function () {});
  });

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
    if (typeof message.method === "string") {
      if (message.method === "ui/notifications/tool-result") {
        fromHost.result = true;
        show(message.params);
      } else if (message.method === "ui/notifications/host-context-changed") hostContext(message.params);
      else if (message.id !== undefined && message.id !== null) {
        // A request from the host: the two the page has an answer to, and a refusal for the rest.
        if (message.method === "ping" || message.method === "ui/resource-teardown") post({ jsonrpc: "2.0", id: message.id, result: {} });
        else post({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
      return;
    }
    var waiting = pending[message.id];
    if (!waiting) return;
    delete pending[message.id];
    if (message.error) waiting.reject(message.error);
    else waiting.resolve(message.result || {});
  });

  // ChatGPT's older bridge, where a host still offers only that one: the same data, read from window.openai.
  function fromLegacy() {
    var legacy = window.openai;
    if (!legacy || typeof legacy !== "object") return;
    if (!fromHost.theme) setTheme(legacy.theme);
    if (!fromHost.result && legacy.toolOutput && typeof legacy.toolOutput === "object") show({ structuredContent: legacy.toolOutput });
  }
  window.addEventListener("openai:set_globals", fromLegacy);
  fromLegacy();

  if (window.parent !== window) {
    request("ui/initialize", { appInfo: { name: "portico-status", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" }).then(
      function (result) {
        hostCapabilities = result.hostCapabilities && typeof result.hostCapabilities === "object" ? result.hostCapabilities : {};
        hostContext(result.hostContext);
        notify("ui/notifications/initialized", {});
        ready = true;
        reportSize();
      },
      function () {},
    );
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(reportSize).observe(document.documentElement);
})();
</script>
</body>
</html>
`;

/** The page, with Portico's public URL written in: the one place its button may lead. */
export function cardPage(publicUrl: string): string {
  // JSON inside a script: "<" is written as an escape, so no value can end the script.
  return PAGE.replace("__PORTICO_ORIGIN__", () => JSON.stringify(new URL(publicUrl).origin).replace(/</g, "\\u003c"));
}
