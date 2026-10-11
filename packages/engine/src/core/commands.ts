// File: packages/engine/src/core/commands.ts
//
// Agda's interaction commands, built as the one line of text Agda reads:
// `IOTCM <file> <level> <method> (<command>)`.  The grammar is Agda's
// `Interaction'` and `IOTCM'` (src/full/Agda/Interaction/Base.hs at the
// pinned commit, da66a8c7); both engines read the same line, natively on
// standard input and in the page inside the language server's `agda`
// request.  Every string is a Haskell string literal, which Agda reads
// with `read`: JSON's escapes (`≡`) are refused with "cannot read".

/** A Haskell string literal for `text`: printable ASCII as itself, `"` and
 * `\` escaped, and every other character as its decimal code point,
 * followed by the empty escape `\&` so that a digit after it cannot join
 * the number. */
export function haskellString(text: string): string {
  let out = '"';
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (character === '"') out += '\\"';
    else if (character === "\\") out += "\\\\";
    else if (point === 0x0a) out += "\\n";
    else if (point >= 0x20 && point < 0x7f) out += character;
    else out += `\\${point}\\&`;
  }
  return out + '"';
}

/** How much highlighting Agda sends with an answer: `NonInteractive`
 * returns Agda's own highlighting inline (the page colors the text it
 * loaded, and a given term, from it); `None` returns none. */
export type HighlightingLevel = "None" | "NonInteractive" | "Interactive";

/** How Agda normalizes a type or a term it shows. */
export type Rewrite = "AsIs" | "Instantiated" | "HeadNormal" | "Simplified" | "Normalised";

/** One interaction command, before it is written for a file. */
export type Command =
  | { kind: "load"; path: string; args?: readonly string[] }
  | { kind: "showVersion" }
  | { kind: "abort" }
  | { kind: "goalTypeContext"; goal: number; rewrite: Rewrite }
  | { kind: "goalType"; goal: number; rewrite: Rewrite }
  | { kind: "context"; goal: number; rewrite: Rewrite }
  | { kind: "give"; goal: number; expression: string }
  | { kind: "refine"; goal: number; expression: string }
  | { kind: "makeCase"; goal: number; patterns: string }
  | { kind: "infer"; goal: number; expression: string; rewrite: Rewrite }
  | { kind: "inferToplevel"; expression: string; rewrite: Rewrite }
  | { kind: "compute"; goal: number; expression: string }
  | { kind: "computeToplevel"; expression: string };

/** The command itself, in Agda's syntax. */
export function commandText(command: Command): string {
  switch (command.kind) {
    case "load":
      return `Cmd_load ${haskellString(command.path)} [${(command.args ?? []).map(haskellString).join(",")}]`;
    case "showVersion":
      return "Cmd_show_version";
    case "abort":
      return "Cmd_abort";
    case "goalTypeContext":
      return `Cmd_goal_type_context ${command.rewrite} ${command.goal} noRange ""`;
    case "goalType":
      return `Cmd_goal_type ${command.rewrite} ${command.goal} noRange ""`;
    case "context":
      return `Cmd_context ${command.rewrite} ${command.goal} noRange ""`;
    case "give":
      return `Cmd_give WithoutForce ${command.goal} noRange ${haskellString(command.expression)}`;
    case "refine":
      return `Cmd_refine_or_intro False ${command.goal} noRange ${haskellString(command.expression)}`;
    case "makeCase":
      return `Cmd_make_case ${command.goal} noRange ${haskellString(command.patterns)}`;
    case "infer":
      return `Cmd_infer ${command.rewrite} ${command.goal} noRange ${haskellString(command.expression)}`;
    case "inferToplevel":
      return `Cmd_infer_toplevel ${command.rewrite} ${haskellString(command.expression)}`;
    case "compute":
      return `Cmd_compute DefaultCompute ${command.goal} noRange ${haskellString(command.expression)}`;
    case "computeToplevel":
      return `Cmd_compute_toplevel DefaultCompute ${haskellString(command.expression)}`;
  }
}

/** The line Agda reads: the command, for the file it concerns, with the
 * highlighting it asks for, sent `Direct` (inline), since `Indirect` makes
 * Agda write a temporary file a WASI host may not have. */
export function iotcm(
  path: string,
  command: Command,
  highlighting: HighlightingLevel = "NonInteractive",
): string {
  return `IOTCM ${haskellString(path)} ${highlighting} Direct (${commandText(command)})`;
}
