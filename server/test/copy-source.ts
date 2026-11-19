import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The text inside a TypeScript file's string literals, a piece at a time: each quoted string, and each stretch of a
 * template between its `${…}` parts. Comments and code are left out, so what comes back is what the program can say.
 * A small scanner, not a parser: enough for this repo's own source.
 */
export function stringPieces(source: string): { text: string; line: number }[] {
  const pieces: { text: string; line: number }[] = [];
  // What the scanner is inside, innermost last: a template's text, or the code of one of its `${…}` parts.
  const stack: ("template" | "code")[] = [];
  let line = 1;
  let i = 0;
  let depth = 0;
  const depths: number[] = [];
  // Whether a `/` here would start a regular expression: after an operator or opening bracket, not after a value.
  let regexOk = true;
  const template = () => {
    let text = "";
    const start = line;
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === "\\") {
        text += source[i + 1] === "n" ? "\n" : (source[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (ch === "`") {
        i++;
        stack.pop();
        pieces.push({ text, line: start });
        return;
      }
      if (ch === "$" && source[i + 1] === "{") {
        i += 2;
        pieces.push({ text, line: start });
        stack.push("code");
        depths.push(depth);
        depth = 0;
        return;
      }
      if (ch === "\n") line++;
      text += ch;
      i++;
    }
  };
  while (i < source.length) {
    if (stack[stack.length - 1] === "template") {
      template();
      regexOk = false;
      continue;
    }
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === "\n") line++;
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += source.slice(i, stop).split("\n").length - 1;
      i = stop;
      continue;
    }
    if (ch === "/" && regexOk) {
      // A regular expression: skipped whole, with its character classes, so a quote inside starts no string.
      let inClass = false;
      i++;
      while (i < source.length && source[i] !== "\n") {
        const c = source[i]!;
        if (c === "\\") i++;
        else if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        i++;
      }
      i++;
      regexOk = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = line;
      let text = "";
      i++;
      while (i < source.length && source[i] !== ch && source[i] !== "\n") {
        if (source[i] === "\\") {
          text += source[i + 1] === "n" ? "\n" : (source[i + 1] ?? "");
          i += 2;
        } else text += source[i++];
      }
      i++;
      pieces.push({ text, line: start });
      regexOk = false;
      continue;
    }
    if (ch === "`") {
      i++;
      stack.push("template");
      continue;
    }
    if (stack[stack.length - 1] === "code") {
      if (ch === "{") depth++;
      else if (ch === "}") {
        if (depth === 0) {
          stack.pop();
          depth = depths.pop() ?? 0;
          i++;
          continue;
        }
        depth--;
      }
    }
    if (!/\s/.test(ch)) regexOk = /[=(,:;!&|?{}[+\-*%<>~^]/.test(ch) || (ch === "n" && /\breturn$/.test(source.slice(Math.max(0, i - 6), i + 1)));
    i++;
  }
  return pieces;
}

/** Every file under a folder with one of the endings, node_modules and logs left out. */
export function filesUnder(dir: string, endings: string[]): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "logs" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path, endings));
    else if (endings.some((ending) => name.endsWith(ending))) found.push(path);
  }
  return found.sort();
}

const SQL = /\b(SELECT|INSERT (INTO|OR)|UPDATE \w+ SET|DELETE FROM|CREATE (TABLE|INDEX|UNIQUE)|ALTER TABLE|REFERENCES|PRIMARY KEY|JOIN \w+|WHERE|ORDER BY)\b/;

/** The words that break the word rule for Porticos, in copy a person or an agent can see. Empty when the copy is clean. */
export function wordProblems(copy: string): string[] {
  const rules: [RegExp, string][] = [
    // The place is "a Portico": nothing visible calls it a workspace.
    [/\bworkspaces?\b/gi, "says workspace"],
    // A person's own is "your Portico" or "Chris's Portico", never the stored name.
    [/\bPersonal\b(?! (access|information|data))/g, "says Personal"],
    // "This Portico" would be the place being looked at, which is always named. An installation is a Portico server.
    [/\bthis Portico\b(?! server)/gi, "says this Portico: name the Portico, or say this Portico server"],
    [/\bPortico (instance|installation|deployment|host)s?\b/gi, "an installation is a Portico server"],
  ];
  const problems: string[] = [];
  for (const [re, why] of rules) {
    for (const match of copy.matchAll(re)) {
      const start = Math.max(0, match.index! - 40);
      problems.push(`${why}: …${copy.slice(start, match.index! + match[0].length + 40).replace(/\s+/g, " ")}…`);
    }
  }
  return problems;
}

/**
 * The word rule over a source file's own strings. A string of one word is an identifier (a JSON key, a change topic, a
 * CSS class), and SQL names the tables; everything else is something the program can say.
 */
export function sourceWordProblems(path: string): string[] {
  const problems: string[] = [];
  for (const piece of stringPieces(readFileSync(path, "utf8"))) {
    const text = piece.text;
    if (!/\s/.test(text.trim()) || SQL.test(text)) continue;
    // Markup names and addresses inside a longer string are identifiers too.
    const prose = text
      .replace(/<[^>]*>?/g, " ")
      .replace(/[\w-]+="[^"]*"/g, " ")
      .replace(/\/api\/[\w/:{}$.-]*/g, " ")
      .replace(/\b[\w-]*[_.][\w.-]*\b/g, " ");
    for (const problem of wordProblems(prose)) problems.push(`${path}:${piece.line} ${problem}`);
  }
  return problems;
}
