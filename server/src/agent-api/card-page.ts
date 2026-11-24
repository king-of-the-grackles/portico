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
  --ochre: #8a4f0e; --ochre-wash: #fbf1df; --danger: #9a2e22; --danger-wash: #f8ecea;
  --quiet: #4f4a45; --quiet-wash: #ecebe8;
}
:root[data-theme="dark"] {
  --teal: #247a65; --teal-dark: #1e6b58; --accent: #7fd1b9; --teal-wash: #1d332d;
  --ink: #e8efe9; --ink-soft: #c5d1cb; --muted: #9fb0a9; --line: #34443f;
  --card: #16211e; --surface: #0f1917;
  --ochre: #f0c078; --ochre-wash: #3a2c14; --danger: #f1a79d; --danger-wash: #3d1f1b;
  --quiet: #c5ccc8; --quiet-wash: #2a2f2d;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --teal: #247a65; --teal-dark: #1e6b58; --accent: #7fd1b9; --teal-wash: #1d332d;
    --ink: #e8efe9; --ink-soft: #c5d1cb; --muted: #9fb0a9; --line: #34443f;
    --card: #16211e; --surface: #0f1917;
    --ochre: #f0c078; --ochre-wash: #3a2c14; --danger: #f1a79d; --danger-wash: #3d1f1b;
    --quiet: #c5ccc8; --quiet-wash: #2a2f2d;
    }
}
* { box-sizing: border-box; }
/* No color-scheme of the page's own: a frame whose scheme differs from its host's gets an opaque backdrop, and the corners would show. */
html, body { margin: 0; background: transparent; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); font-size: 14px; line-height: 20px; }
[hidden] { display: none !important; }
.card { max-width: 480px; padding: 16px; border-radius: 16px; background: var(--card); box-shadow: inset 0 0 0 1px var(--line); display: flex; flex-direction: column; gap: 12px; }
.head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--muted); }
.pill { margin-left: auto; padding: 2px 10px; border-radius: 999px; font-size: 12px; line-height: 18px; font-weight: 700; white-space: nowrap; background: var(--quiet-wash); color: var(--quiet); }
.pill[data-tone="ok"] { background: var(--teal-wash); color: var(--accent); }
.pill[data-tone="wait"] { background: var(--ochre-wash); color: var(--ochre); }
.pill[data-tone="no"] { background: var(--danger-wash); color: var(--danger); }
h1 { margin: 0; font-size: 18px; line-height: 24px; font-weight: 700; letter-spacing: -0.01em; text-wrap: balance; overflow-wrap: anywhere; }
p { margin: 0; color: var(--ink-soft); overflow-wrap: anywhere; text-wrap: pretty; }
#lines { display: flex; flex-direction: column; gap: 8px; }
.quoted { padding: 8px 12px; border-left: 3px solid var(--line); border-radius: 0 8px 8px 0; background: var(--surface); color: var(--ink); white-space: pre-wrap; }
ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
li { display: flex; align-items: flex-start; gap: 8px; color: var(--ink); overflow-wrap: anywhere; }
li::before { flex: none; width: 16px; height: 16px; margin-top: 2px; border-radius: 50%; font-size: 11px; line-height: 16px; font-weight: 700; text-align: center; }
li[data-tone="ok"]::before { content: "\\2713"; background: var(--teal-wash); color: var(--accent); }
li[data-tone="warn"]::before { content: "!"; background: var(--ochre-wash); color: var(--ochre); }
.actions { display: flex; margin-top: 4px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; max-width: 100%; min-height: 44px; padding: 8px 16px; border-radius: 8px; font: inherit; font-size: 15px; line-height: 24px; font-weight: 600; cursor: pointer; white-space: nowrap; border: 1px solid var(--teal); background: var(--surface); color: var(--accent); }
.btn:hover { background: var(--teal-wash); }
.btn[data-primary="true"] { background: var(--teal); color: #ffffff; }
.btn[data-primary="true"]:hover { background: var(--teal-dark); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.btn svg { width: 14px; height: 14px; flex: none; }
.help { font-size: 12px; line-height: 16px; color: var(--muted); }
/* Under the button, one quiet block: what a press does, then the address, close together. */
.addr { margin-top: -8px; font-size: 12px; line-height: 16px; color: var(--muted); user-select: all; -webkit-user-select: all; }
@media (prefers-reduced-motion: no-preference) { .btn { transition: background-color 200ms ease; } }
</style>
</head>
<body>
<main class="card" id="card" hidden>
  <div class="head"><span>Portico</span><span class="pill" id="pill"></span></div>
  <h1 id="title"></h1>
  <p class="quoted" id="quote" hidden></p>
  <div id="lines"></div>
  <ul id="facts" hidden></ul>
  <div class="actions" id="actions" hidden>
    <button type="button" class="btn" id="open"><span id="open-label"></span><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3H3v10h10v-3"/><path d="M9 3h4v4"/><path d="M13 3L7 9"/></svg></button>
  </div>
  <p class="help" id="help" hidden></p>
  <p class="addr" id="addr" hidden></p>
</main>
<script>
(function () {
  "use strict";
  // Portico's public URL, written by the server. The button opens nothing anywhere else.
  var ORIGIN = __PORTICO_ORIGIN__;
  var TONES = { ok: true, wait: true, no: true, quiet: true };
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
  function paragraph(parent, value) {
    var p = document.createElement("p");
    p.textContent = value;
    parent.appendChild(p);
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

  /** Draws the card from a tool result. Every string is set as text. A result with no card data shows its own text. */
  function show(result) {
    if (!result || typeof result !== "object") return;
    var card = result.structuredContent;
    if (!card || typeof card !== "object" || typeof card.title !== "string") {
      var first = Array.isArray(result.content) ? result.content[0] : null;
      var plain = first && typeof first.text === "string" ? first.text : "";
      if (plain === "") return;
      card = { title: "Portico", pill: null, lines: plain.split("\\n").slice(0, 8) };
    }
    var pill = card.pill && typeof card.pill === "object" ? card.pill : null;
    el("pill").textContent = pill ? text(pill.text, 40) : "";
    el("pill").hidden = !pill || text(pill.text, 40) === "";
    el("pill").setAttribute("data-tone", pill && TONES[pill.tone] === true ? pill.tone : "quiet");
    el("title").textContent = text(card.title, 300);

    var quote = text(card.quote, 400);
    el("quote").textContent = quote;
    el("quote").hidden = quote === "";

    var lines = el("lines");
    lines.textContent = "";
    (Array.isArray(card.lines) ? card.lines : []).slice(0, 8).forEach(function (line) {
      if (text(line, 600) !== "") paragraph(lines, text(line, 600));
    });
    if (card.ends && typeof card.ends === "object" && text(card.ends.label, 80) !== "" && text(card.ends.at, 40) !== "") {
      paragraph(lines, text(card.ends.label, 80) + " " + localTime(text(card.ends.at, 40)) + ".");
    }

    var facts = el("facts");
    facts.textContent = "";
    (Array.isArray(card.facts) ? card.facts : []).slice(0, 6).forEach(function (fact) {
      if (!fact || typeof fact !== "object" || text(fact.text, 300) === "") return;
      var li = document.createElement("li");
      li.setAttribute("data-tone", fact.tone === "ok" ? "ok" : "warn");
      var span = document.createElement("span");
      span.textContent = text(fact.text, 300);
      li.appendChild(span);
      facts.appendChild(li);
    });
    facts.hidden = facts.children.length === 0;

    linkUrl = safeLink(card.link);
    el("actions").hidden = linkUrl === null;
    el("help").hidden = linkUrl === null || text(card.link.help, 300) === "";
    el("addr").hidden = linkUrl === null;
    if (linkUrl !== null) {
      el("open-label").textContent = text(card.link.label, 40) || "Open Portico";
      el("open").setAttribute("data-primary", card.link.primary === true ? "true" : "false");
      el("help").textContent = text(card.link.help, 300);
      el("addr").textContent = linkUrl;
    }
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
