// A page of Portico's own as Markdown, for a reader that asks with `Accept: text/markdown`. The Markdown is made from
// the page's HTML, so the two never say different things. Only what Portico's pages use is handled: headings,
// paragraphs, lists, code, links and bold.

interface Node {
  tag: string;
  attrs: string;
  children: (Node | string)[];
}

const VOID = new Set(["meta", "link", "br", "input", "img", "hr"]);
/** Elements with nothing to read. */
const SKIPPED = new Set(["head", "script", "style", "svg", "template", "button", "input", "label", "select", "textarea"]);
const BLOCKS = new Set(["h1", "h2", "h3", "h4", "p", "pre", "ol", "ul", "li", "div", "main", "section", "header", "form", "body", "html"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decode = (text: string) => text.replace(/&(#?\w+);/g, (all, name: string) => ENTITIES[name] ?? all);

function parse(html: string): Node {
  const root: Node = { tag: "root", attrs: "", children: [] };
  const open = [root];
  const pattern = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z][a-z0-9-]*)\s*>|<([a-z][a-z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/gi;
  for (const m of html.matchAll(pattern)) {
    const top = open[open.length - 1]!;
    if (m[4] !== undefined) top.children.push(m[4]);
    else if (m[2] !== undefined) {
      const node: Node = { tag: m[2].toLowerCase(), attrs: m[3] ?? "", children: [] };
      top.children.push(node);
      if (!VOID.has(node.tag) && !node.attrs.endsWith("/")) open.push(node);
    } else if (m[1] !== undefined) {
      const at = open.map((n) => n.tag).lastIndexOf(m[1].toLowerCase());
      if (at > 0) open.length = at;
    }
  }
  return root;
}

const textOf = (node: Node | string): string => (typeof node === "string" ? node : node.children.map(textOf).join(""));

function find(node: Node, tag: string): Node | null {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    const hit = child.tag === tag ? child : find(child, tag);
    if (hit) return hit;
  }
  return null;
}

function inline(node: Node | string, base: string): string {
  if (typeof node === "string") return decode(node).replace(/\s+/g, " ");
  if (SKIPPED.has(node.tag) || /\shidden(\s|=|$)/.test(node.attrs)) return "";
  const inner = node.children.map((child) => inline(child, base)).join("");
  if (node.tag === "code") return `\`${decode(textOf(node))}\``;
  if (node.tag === "strong" || node.tag === "b") return `**${inner.trim()}**`;
  if (node.tag === "em" || node.tag === "i") return `*${inner.trim()}*`;
  if (node.tag === "a") {
    const href = decode(/\shref="([^"]*)"/.exec(node.attrs)?.[1] ?? "");
    return href && inner.trim() ? `[${inner.trim()}](${href.startsWith("/") ? base + href : href})` : inner;
  }
  return inner;
}

/** The blocks of a container, each a piece of Markdown. Loose text and inline elements between blocks make a paragraph. */
function blocks(node: Node, base: string): string[] {
  const out: string[] = [];
  let loose = "";
  const flush = () => {
    if (loose.trim()) out.push(loose.trim());
    loose = "";
  };
  for (const child of node.children) {
    if (typeof child === "string" || !BLOCKS.has(child.tag)) {
      loose += inline(child, base);
      continue;
    }
    flush();
    if (/\shidden(\s|=|$)/.test(child.attrs)) continue;
    const heading = /^h([1-4])$/.exec(child.tag);
    if (heading) out.push(`${"#".repeat(Number(heading[1]))} ${inline({ ...child, tag: "span" }, base).trim()}`);
    else if (child.tag === "p") out.push(inline({ ...child, tag: "span" }, base).trim());
    else if (child.tag === "pre") out.push(`\`\`\`\n${decode(textOf(child)).replace(/\n+$/, "")}\n\`\`\``);
    else if (child.tag === "ol" || child.tag === "ul") {
      let n = 0;
      const items = child.children.filter((item): item is Node => typeof item !== "string" && item.tag === "li");
      out.push(
        items
          .map((item) => {
            const mark = child.tag === "ol" ? `${++n}. ` : "- ";
            return mark + blocks(item, base).join("\n\n").replace(/\n/g, `\n${" ".repeat(mark.length)}`);
          })
          .join("\n"),
      );
    } else out.push(...blocks(child, base));
  }
  flush();
  return out.filter((block) => block !== "");
}

/** The page's `<main>` as Markdown. `base` is this Portico's address, for links that start with "/". */
export function pageMarkdown(html: string, base: string): string {
  const root = parse(html);
  const main = find(root, "main") ?? find(root, "body") ?? root;
  return (
    blocks(main, base)
      .join("\n\n")
      .replace(/[ \t]+\n/g, "\n") + "\n"
  );
}
