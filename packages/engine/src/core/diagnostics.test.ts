// File: packages/engine/src/core/diagnostics.test.ts
//
// The batch run's messages, read from output batch Agda 2.9.0 (da66a8c7)
// printed on 2026-10-11 for small modules over its builtins (paths
// shortened to /p): an open goal and a `?`, a type error, unsolved metas,
// a termination problem, and a warning printed twice around the banner.

import { describe, expect, it } from "vitest";

import { parseDiagnostics } from "./diagnostics.js";

const BANNER = `${"\u2014".repeat(4)} All done; warnings encountered ${"\u2014".repeat(24)}`;

describe("a batch run's diagnostics", () => {
  it("reads an error's code, file, range and message", () => {
    const output = [
      "Checking Bad (/p/Bad.agda).",
      "/p/Bad.agda:5.7-11: error: [UnequalTypes]",
      "The type",
      "  Bool",
      "is not a subtype of",
      "  Nat",
      "when checking that the expression true has type Nat",
      "",
    ].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      {
        severity: "error",
        code: "UnequalTypes",
        file: "/p/Bad.agda",
        range: { startLine: 5, startCol: 7, endLine: 5, endCol: 11 },
        message: "The type\n  Bool\nis not a subtype of\n  Nat\nwhen checking that the expression true has type Nat",
      },
    ]);
  });

  it("reads a range over two lines, and the locations the message lists", () => {
    const output = [
      "Checking Hole (/p/Hole.agda).",
      "/p/Hole.agda:4.7-6.10: error: [UnsolvedInteractionMetas]",
      "Unsolved interaction metas at the following locations:",
      "  /p/Hole.agda:4.7-12",
      "  /p/Hole.agda:6.9-10",
    ].join("\n");
    const [hole] = parseDiagnostics(output);
    expect(hole).toMatchObject({
      code: "UnsolvedInteractionMetas",
      range: { startLine: 4, startCol: 7, endLine: 6, endCol: 10 },
    });
    expect(hole.message.split("\n")).toHaveLength(3);
  });

  it("reads a warning once, though Agda prints it again after its banner", () => {
    const warning = ["/p/Unreach.agda:6.1-16: warning: -W[no]UnreachableClauses", "Unreachable clause", "when checking the definition of f"];
    const output = ["Checking Unreach (/p/Unreach.agda).", "", ...warning, "", BANNER, "", ...warning, ""].join("\n");
    expect(parseDiagnostics(output)).toEqual([
      {
        severity: "warning",
        code: "UnreachableClauses",
        file: "/p/Unreach.agda",
        range: { startLine: 6, startCol: 1, endLine: 6, endCol: 16 },
        message: "Unreachable clause\nwhen checking the definition of f",
      },
    ]);
  });

  it("ends a message at a progress line, and keeps a message's own position lines", () => {
    const output = [
      "/p/Warn.agda:3.1-4.16: error: [TerminationIssue]",
      "Termination checking failed for the following function:",
      "  loop",
      "Problematic call:",
      "  loop n",
      "    (at /p/Warn.agda:4.10-14)",
      " Checking Other (/p/Other.agda).",
    ].join("\n");
    const [termination] = parseDiagnostics(output);
    expect(termination.code).toBe("TerminationIssue");
    expect(termination.message.endsWith("(at /p/Warn.agda:4.10-14)")).toBe(true);
  });

  it("reads the older comma positions, a position with no end, and CR LF line ends", () => {
    const output = "/p/A.agda:6,12-17: error: [X]\r\nfirst\r\n/p/B.agda:3.1: warning: -W[no]Y rest of line\r\n";
    expect(parseDiagnostics(output)).toEqual([
      { severity: "error", code: "X", file: "/p/A.agda", range: { startLine: 6, startCol: 12, endLine: 6, endCol: 17 }, message: "first" },
      { severity: "warning", code: "Y", file: "/p/B.agda", range: { startLine: 3, startCol: 1, endLine: 3, endCol: 1 }, message: "rest of line" },
    ]);
  });

  it("finds nothing where Agda printed no header, whatever the exit code says", () => {
    expect(parseDiagnostics("Error: Unrecognized option:\n--no-such-option\n")).toEqual([]);
    expect(parseDiagnostics("")).toEqual([]);
  });
});
