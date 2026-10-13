// File: src/lib/playground.ts
//
// Files of the playground's project made from a library's module
// (issue 10): a copy of the module, or of a selection in it, under /play/,
// which is the project's include directory, so a file /play/X/Y.agda is
// the module X.Y.  A copy's module line names it by its own path: a copy
// that kept the library's name would not check (Agda wants a module at
// the path its name gives, and finds two files for one module when the
// path is the library's under /play/).  Also the edit that adds an
// `open import` to Main.  These functions read and write text only.

/** The playground's directory on the drive. */
export const PLAYGROUND_DIR = "/play";

/** A module name's part, as the page accepts one: a letter (of any
 * script) or an underscore, then letters, digits, `_`, `'` or `-`, with no
 * `__` (Agda reads that as a mixfix operator's holes). */
const NAME_PART = /^(?!.*__)[\p{L}_][\p{L}\p{N}_'-]*$/u;

/** Agda's keywords, which no module name part may be. */
const KEYWORDS = new Set(
  "abstract codata coinductive constructor data do eta-equality field forall hiding import in inductive infix infixl infixr instance interleaved let macro module mutual no-eta-equality opaque open overlap pattern postulate primitive private public quote quoteTerm record renaming rewrite syntax tactic to unfolding unquote unquoteDecl unquoteDef using variable where with"
    .split(" ")
    // Agda's reserved letter, and a hole, are no names either.
    .concat(["λ", "_"]),
);

/** The module a playground file holds, by its path; none outside /play/. */
export function playgroundModuleOf(path: string): string | undefined {
  const match = /^\/play\/(.+)\.(agda|lagda\.md)$/.exec(path);
  return match ? match[1].split("/").join(".") : undefined;
}

/** Where a copy goes: the module name the reader gave (`X.Y`, or the path
 * `X/Y` under /play/, with or without the file's extension), its path, or
 * why it cannot be one. */
export function playgroundTarget(
  name: string,
  extension: ".agda" | ".lagda.md",
): { module: string; path: string } | { error: string } {
  const trimmed = name
    .trim()
    .replace(/^\/?play\//, "")
    .replace(/\.(agda|lagda\.md)$/, "");
  if (!trimmed) return { error: "Name the copy's module" };
  const parts = trimmed.split(/[./]/);
  const bad = parts.find((part) => !NAME_PART.test(part) || KEYWORDS.has(part));
  if (bad !== undefined)
    return {
      error: bad
        ? `"${bad}" cannot be part of a module's name: use letters, digits, _, ' and -, starting with a letter`
        : `"${trimmed}" has an empty part`,
    };
  // Agda's own modules are named Agda.…, which the page's import planner
  // takes for builtins, whose interfaces the drive holds.
  if (parts[0] === "Agda") return { error: "Agda's own modules are named Agda.…; name the copy otherwise" };
  return { module: parts.join("."), path: `${PLAYGROUND_DIR}/${parts.join("/")}${extension}` };
}

/** The lines of a source, each with whether Agda reads it as code: every
 * line of an .agda file, and in literate Markdown the lines inside a
 * code block whose fence names no language or names agda. */
function codeLines(text: string, literate: boolean): Array<{ text: string; from: number; code: boolean }> {
  const lines: Array<{ text: string; from: number; code: boolean }> = [];
  let from = 0;
  let fence: "agda" | "other" | undefined;
  for (const line of text.split("\n")) {
    let code = !literate;
    if (literate) {
      const opening = /^```\s*(\S*)/.exec(line);
      if (fence === undefined && opening) fence = opening[1] === "" || opening[1] === "agda" ? "agda" : "other";
      else if (fence !== undefined && /^```\s*$/.test(line)) fence = undefined;
      else code = fence === "agda";
    }
    lines.push({ text: line, from, code });
    from += line.length + 1;
  }
  return lines;
}

/** The lines, with those that begin inside a `{- -}` comment (nested ones
 * counted) not code. */
function outsideBlockComments(lines: Array<{ text: string; from: number; code: boolean }>) {
  let depth = 0;
  return lines.map((line) => {
    const code = line.code && depth === 0;
    for (let at = 0; at + 1 < line.text.length; at++) {
      const two = line.text.slice(at, at + 2);
      if (depth === 0 && two === "--") break;
      if (two === "{-") (depth += 1), (at += 1);
      else if (two === "-}" && depth > 0) (depth -= 1), (at += 1);
    }
    return { ...line, code };
  });
}

/** Escape a string for a regular expression. */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a line declares the module `name` (with parameters, or not). */
const declares = (name: string) => {
  const declaration = new RegExp(`^module[ \\t]+${escape(name)}(?=[\\s({]|$)`);
  return (line: { text: string; code: boolean }) => line.code && declaration.test(line.text);
};

/** Rename the module a source declares: its first `module <from>` line in
 * code (a parameterized module keeps its parameters).  Undefined when the
 * source declares no module of that name. */
export function renameModule(text: string, from: string, to: string, literate: boolean): string | undefined {
  const line = codeLines(text, literate).find(declares(from));
  if (!line) return undefined;
  const at = line.from + line.text.indexOf(from);
  return text.slice(0, at) + to + text.slice(at + from.length);
}

/** A copy of the whole module: its text, the module line renamed. */
export function moduleCopy(source: string, from: string, to: string): string | undefined {
  return renameModule(source, from, to, true);
}

/** A copy of a selection, as an .agda file: the module's code from its
 * start through the selection's last line, the module line renamed, so
 * that what the selection uses from the code above it (its definitions,
 * variables, imports and opens, and the modules around it) is in scope.
 * Prose is left out, which Agda reads as blank lines, so the code means
 * what it meant.  `at` is where the selection's first line of code is in
 * the copy.  Undefined when the source declares no module of that name. */
export function selectionCopy(
  source: string,
  from: string,
  to: string,
  selection: { from: number; to: number },
): { text: string; at: number } | undefined {
  const lines = codeLines(source, true);
  const header = lines.findIndex(declares(from));
  if (header < 0) return undefined;
  const lineOf = (offset: number) => lines.findLastIndex((line) => line.from <= offset);
  const first = lineOf(selection.from);
  // A selection that ends at a line's start does not take that line.
  const end = selection.to > selection.from && lines[lineOf(selection.to)].from === selection.to ? selection.to - 1 : selection.to;
  const last = lineOf(end);
  const kept: string[] = [];
  let at = -1;
  lines.forEach((line, index) => {
    if (index > last || !line.code) return;
    if (index >= first && at < 0) at = kept.reduce((length, text) => length + text.length + 1, 0);
    kept.push(index === header ? line.text.replace(from, to) : line.text);
  });
  const text = kept.join("\n").replace(/\s+$/, "") + "\n";
  return { text, at: at < 0 ? text.length : Math.min(at, text.length) };
}

/** The edit that adds `open import <module>` to an .agda source, after its
 * last import statement, or else after its module line; where it opens the
 * module already (`at`, the line's start); or none, when it declares no
 * module. */
export function openImportEdit(
  text: string,
  module: string,
): { from: number; insert: string } | { at: number } | undefined {
  const lines = outsideBlockComments(codeLines(text, false));
  const opened = new RegExp(`^open[ \\t]+import[ \\t]+${escape(module)}(?=\\s|$)`);
  const existing = lines.find((line) => line.code && opened.test(line.text));
  if (existing) return { at: existing.from };
  let after: number | undefined;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].code && /^(open[ \t]+)?import[ \t]/.test(lines[index].text)) {
      while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1].text)) index++;
      after = index;
    }
  }
  after ??= lines.findIndex((line) => line.code && /^module[ \t]/.test(line.text));
  if (after < 0) return undefined;
  const line = lines[after];
  const end = line.from + line.text.length;
  return end >= text.length
    ? { from: end, insert: `\nopen import ${module}\n` }
    : { from: end + 1, insert: `open import ${module}\n` };
}
