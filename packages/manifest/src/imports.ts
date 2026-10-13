// File: packages/manifest/src/imports.ts
//
// The modules a source imports, read from its text, so that a host can
// plan what to mount before Agda loads it (issue 14).  What is read is the
// source's own `import` statements; what those modules import in turn is
// the archive index's question (./library.ts), since Agda's dependency
// graph is exact where a reading of the text is not.  The reading follows
// Agda 2.9.0's own rules as far as an import needs them (Agda.Syntax.Parser.
// Lexer and Literate at the compiler's commit): comments (nested block
// comments and pragmas, and `--` where a token starts), string and
// character literals, and, in a literate source, its code alone.

import type { SourceKind } from "@agda-native-ide/engine";

/** A name part: no whitespace, none of the reserved punctuation, and no
 * `.`, which separates a qualified name's parts. */
const NAME_PART = String.raw`[^\s.;{}()@"]+`;

/** An import statement: `import M` or `open import M`, at the start of a
 * line or after a layout brace or semicolon, M a qualified name. */
const IMPORT = new RegExp(
  String.raw`(?:^|[\s;{])(?:open\s+)?import\s+(${NAME_PART}(?:\.${NAME_PART})*)`,
  "gu",
);

/** Where a token may start: the text's start, whitespace, or reserved
 * punctuation. */
const TOKEN_BOUNDARY = /[\s(){};@"]/u;

/** `text` with every comment, pragma, string and character literal blanked
 * (line breaks kept), in one pass from the left, so that what remains is
 * code: a `{-` inside a string is not a comment, nor a `"` inside one. */
function blankNonCode(text: string): string {
  const chars = [...text];
  const out = chars.slice();
  const blank = (from: number, to: number) => {
    for (let at = from; at < Math.min(to, chars.length); at++) if (out[at] !== "\n") out[at] = " ";
  };
  // Where the last comment or literal ended: a token starts there too
  // (`'a'-- x` ends in a comment).
  let boundary = 0;
  const startsToken = (at: number) => at === 0 || at === boundary || TOKEN_BOUNDARY.test(chars[at - 1]);
  const skip = (from: number, to: number) => {
    blank(from, to);
    boundary = Math.min(to, chars.length);
    return boundary;
  };
  let at = 0;
  while (at < chars.length) {
    const char = chars[at];
    const next = chars[at + 1];
    if (char === "{" && next === "-" && chars[at + 2] === "#") {
      // A pragma: it ends at its #-}, nesting only through {-# (Lexer.x's
      // pragma states), so a {- inside one, in a FOREIGN block say, opens
      // nothing.
      let depth = 1;
      let end = at + 3;
      while (end < chars.length && depth > 0) {
        if (chars[end] === "{" && chars[end + 1] === "-" && chars[end + 2] === "#") (depth += 1), (end += 3);
        else if (chars[end] === "#" && chars[end + 1] === "-" && chars[end + 2] === "}") (depth -= 1), (end += 3);
        else end += 1;
      }
      at = skip(at, end);
    } else if (char === "{" && next === "-") {
      // A block comment; they nest.
      let depth = 1;
      let end = at + 2;
      while (end < chars.length && depth > 0) {
        if (chars[end] === "{" && chars[end + 1] === "-") (depth += 1), (end += 2);
        else if (chars[end] === "-" && chars[end + 1] === "}") (depth -= 1), (end += 2);
        else end += 1;
      }
      at = skip(at, end);
    } else if (char === "-" && next === "-" && startsToken(at)) {
      // A line comment: `--` where a token starts, whatever follows (`A
      // --x` ends in a comment; `a--b` is one name; checked natively).
      let end = at;
      while (end < chars.length && chars[end] !== "\n") end += 1;
      at = skip(at, end);
    } else if (char === '"') {
      let end = at + 1;
      while (end < chars.length && chars[end] !== '"' && chars[end] !== "\n") end += chars[end] === "\\" ? 2 : 1;
      at = skip(at, end + 1);
    } else if (char === "'" && startsToken(at)) {
      // A character literal, '"' or '\'' among them; a prime inside a name
      // (f') does not start one.
      let end = at + 1;
      if (chars[end] === "\\") {
        end += 2;
        while (end < chars.length && chars[end] !== "'" && chars[end] !== "\n") end += 1;
      } else end += 1;
      if (chars[end] === "'") at = skip(at, end + 1);
      else at += 1;
    } else at += 1;
  }
  return out.join("");
}

/** A literate source's code, each line where it stands and the rest
 * blank, as Agda's literate processors take it; undefined for the formats
 * this reading does not follow (reStructuredText, Org). */
function codeOf(text: string, kind: SourceKind): string | undefined {
  if (kind === "agda") return text;
  const lines = text.split("\n");
  if (kind === "lagda.md" || kind === "lagda.typ") {
    // Agda's literateMd, by default: a line ending in ``` or ```agda opens
    // code, a fence naming another language opens a block that is not
    // Agda's, and a bare ``` closes either.
    const opens = /^.*```(?:agda)?\s*$/u;
    const opensOther = /^\s*```[a-zA-Z0-9-]*\s*$/u;
    const closes = /^\s*```\s*$/u;
    let state: "text" | "code" | "other" = "text";
    return lines
      .map((line) => {
        if (state === "text") {
          if (opens.test(line)) state = "code";
          else if (opensOther.test(line)) state = "other";
          return "";
        }
        if (closes.test(line)) {
          state = "text";
          return "";
        }
        return state === "code" ? line : "";
      })
      .join("\n");
  }
  if (kind === "lagda" || kind === "lagda.tex") {
    // Agda's literateTeX: \begin{code} not after a % on its line, to a line
    // that starts with \end{code}.
    const opens = /^(?:[^\\%]|\\.)*\\begin\{code\}/u;
    const closes = /^[ \t]*\\end\{code\}/u;
    let inCode = false;
    return lines
      .map((line) => {
        if (!inCode) {
          inCode = opens.test(line);
          return "";
        }
        if (closes.test(line)) {
          inCode = false;
          return "";
        }
        return line;
      })
      .join("\n");
  }
  return undefined;
}

/** The modules a source imports, by name, each once, in the order of their
 * first import; undefined for a literate format this reading does not
 * follow.  An import inside a nested module counts, and so does one Agda
 * would refuse: the reading is for planning what to mount, and Agda's own
 * check decides the rest. */
export function importedModules(text: string, kind: SourceKind = "agda"): string[] | undefined {
  const code = codeOf(text, kind);
  if (code === undefined) return undefined;
  const found = new Set<string>();
  for (const match of blankNonCode(code).matchAll(IMPORT)) found.add(match[1]);
  return [...found];
}
