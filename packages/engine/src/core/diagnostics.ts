// File: packages/engine/src/core/diagnostics.ts
//
// Agda's messages in a batch run's output, read into diagnostics.  The
// verdict is the run's exit code; these say why, and nothing here can
// change it: a change in Agda's message format can empty the list, never
// turn a failing run green (agda-native-air ADR 0002 § 3).
//
// Batch Agda 2.9.0 (da66a8c7) prints each message on standard output as a
// header line and the message's lines after it, as follows:
//
//   /p/Bad.agda:5.7-11: error: [UnequalTypes]
//   The type
//     Bool
//   ...
//   /p/Hole.agda:4.7-6.10: error: [UnsolvedInteractionMetas]
//   /p/Unreach.agda:6.1-16: warning: -W[no]UnreachableClauses
//
// and, when a run had warnings, prints them again after a banner of
// em-dashes, "All done; warnings encountered"; the second copies are
// dropped.  Its progress lines (`Checking M (path).`, indented when
// nested) end a message.

import type { Diagnostic } from "./outcome.js";

const HEADER = /^(.+?):(\d+)[.,](\d+)(?:-(?:(\d+)[.,])?(\d+))?: (error|warning): (.*)$/;
const UNPLACED = /^(error|warning): (.*)$/;
const CODE = /^(?:\[([A-Za-z0-9_]+)\]|-W\[no\]([A-Za-z0-9_]+))\s*(.*)$/;
// The banner is a run of U+2014 around "All done".
const BANNER = /^\u2014+ All done/;
const PROGRESS = /^\s*(?:Checking|Skipping|Loading) \S+ \(.*\)\.\s*$/;

interface Open {
  diagnostic: Diagnostic;
  lines: string[];
}

function header(line: string): Diagnostic | undefined {
  const placed = HEADER.exec(line);
  const unplaced = placed ? undefined : UNPLACED.exec(line);
  if (!placed && !unplaced) return undefined;
  const severity = (placed ? placed[6] : unplaced![1]) as Diagnostic["severity"];
  const rest = placed ? placed[7] : unplaced![2];
  const coded = CODE.exec(rest);
  const diagnostic: Diagnostic = { severity, message: coded ? coded[3] : rest };
  const code = coded?.[1] ?? coded?.[2];
  if (code) diagnostic.code = code;
  if (placed) {
    const startLine = Number(placed[2]);
    const startCol = Number(placed[3]);
    diagnostic.file = placed[1];
    diagnostic.range = {
      startLine,
      startCol,
      endLine: placed[4] ? Number(placed[4]) : startLine,
      endCol: placed[5] ? Number(placed[5]) : startCol,
    };
  }
  return diagnostic;
}

/** The diagnostics in a batch run's output, in the order Agda printed
 * them, each once. */
export function parseDiagnostics(output: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  const seen = new Set<string>();
  let open: Open | undefined;
  const close = () => {
    if (!open) return;
    const lines = open.lines;
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const first = open.diagnostic.message;
    open.diagnostic.message = [...(first ? [first] : []), ...lines].join("\n");
    const key = JSON.stringify(open.diagnostic);
    if (!seen.has(key)) {
      seen.add(key);
      found.push(open.diagnostic);
    }
    open = undefined;
  };
  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    const next = header(line);
    if (next) {
      close();
      open = { diagnostic: next, lines: [] };
      continue;
    }
    if (BANNER.test(line) || PROGRESS.test(line)) {
      close();
      continue;
    }
    open?.lines.push(line);
  }
  close();
  return found;
}
