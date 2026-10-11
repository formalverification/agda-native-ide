// File: packages/engine/src/core/text.test.ts

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { haskellString, iotcm } from "./commands.js";
import { planCheck } from "./give-rule.js";
import { isSourcePath, sourceKind } from "./paths.js";
import {
  OffsetTable,
  codePointLength,
  preservesPositions,
  sha256Hex,
  sourceDigest,
  utf8,
} from "./text.js";

const samples = [
  "",
  "a",
  "abc",
  "ℕ → ℕ",
  "𝔸 x = {! !}",
  "﻿module M where",
  "x".repeat(55),
  "y".repeat(56),
  "z".repeat(64),
  "≡".repeat(1000),
  "lone \uD800 surrogate",
];

describe("text", () => {
  it("encodes UTF-8 as TextEncoder does", () => {
    for (const sample of samples)
      expect(Array.from(utf8(sample))).toEqual(Array.from(new TextEncoder().encode(sample)));
  });

  it("digests as node's SHA-256 does", () => {
    for (const sample of samples)
      expect(sha256Hex(utf8(sample))).toBe(createHash("sha256").update(sample).digest("hex"));
    expect(sourceDigest("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("counts code points, not UTF-16 units", () => {
    expect(codePointLength("𝔸𝔹")).toBe(2);
    expect("𝔸𝔹".length).toBe(4);
  });

  it("converts code point offsets and UTF-16 offsets", () => {
    const text = "a𝔸b𝔹c";
    const table = new OffsetTable(text);
    // a=0, 𝔸=1, b=2, 𝔹=3, c=4 as code points; a=0, 𝔸=1..2, b=3, 𝔹=4..5, c=6.
    expect([0, 1, 2, 3, 4, 5].map((cp) => table.toUtf16(cp))).toEqual([0, 1, 3, 4, 6, 7]);
    expect([0, 1, 3, 4, 6, 7].map((u) => table.toCodePoint(u))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(() => table.toCodePoint(2)).toThrow(/splits a surrogate pair/);
    expect(() => table.toUtf16(6)).toThrow(RangeError);
    // Agda's 1-based pos.
    expect(table.fromAgdaPos(3)).toBe(3);
  });

  it("skips a byte-order mark as Agda does", () => {
    const table = new OffsetTable("﻿ab");
    expect(table.fromAgdaPos(1)).toBe(1);
  });

  it("finds a conversion that moves positions", () => {
    expect(preservesPositions("import Data.Nat\nx", "import plfa.Nat\nx")).toBe(true);
    expect(preservesPositions("import Data.Nat\nx", "import plfa.Nat \nx")).toBe(false);
    expect(preservesPositions("import Data.Nat", "import plfa.Nat")).toBe(true);
    expect(preservesPositions("import Data.Nat", "import N")).toBe(false);
    expect(preservesPositions("a\nb", "a\n\nb")).toBe(false);
    // Two code points where there were two, though UTF-16 differs.
    expect(preservesPositions("𝔸x", "ab")).toBe(true);
  });
});

describe("commands", () => {
  it("writes Haskell string literals Agda's read accepts", () => {
    expect(haskellString("refl")).toBe('"refl"');
    expect(haskellString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(haskellString("≡")).toBe('"\\8801\\&"');
    // A digit after an escape stays a digit.
    expect(haskellString("ℕ1")).toBe('"\\8469\\&1"');
    expect(haskellString("𝔸")).toBe('"\\120120\\&"');
    expect(haskellString("a\nb\tc")).toBe('"a\\nb\\9\\&c"');
  });

  it("writes one IOTCM line", () => {
    expect(iotcm("/M.agda", { kind: "load", path: "/M.agda" })).toBe(
      'IOTCM "/M.agda" NonInteractive Direct (Cmd_load "/M.agda" [])',
    );
    expect(iotcm("/M.agda", { kind: "give", goal: 3, expression: "suc n" }, "None")).toBe(
      'IOTCM "/M.agda" None Direct (Cmd_give WithoutForce 3 noRange "suc n")',
    );
    expect(iotcm("/M.agda", { kind: "abort" }, "None")).toBe('IOTCM "/M.agda" None Direct (Cmd_abort)');
  });
});

describe("paths", () => {
  it("names sources by their suffixes", () => {
    expect(sourceKind("/a/B.lagda.md")).toBe("lagda.md");
    expect(sourceKind("/a/B.agda")).toBe("agda");
    expect(sourceKind("/a/B.txt")).toBeUndefined();
    expect(isSourcePath("/plfa/part1/Naturals.lagda.md")).toBe(true);
    expect(isSourcePath("plfa/Naturals.lagda.md")).toBe(false);
    expect(isSourcePath("/plfa/../Naturals.lagda.md")).toBe(false);
    expect(isSourcePath("/plfa//Naturals.agda")).toBe(false);
  });
});

describe("the give rule", () => {
  const previous = "f = {! !}\ng = {! a !}\n";
  const goals = [
    { id: 0, from: 4, to: 9 },
    { id: 1, from: 14, to: 21 },
  ];

  it("sends nothing for the same text", () => {
    expect(planCheck(previous, goals, previous)).toEqual({ kind: "unchanged" });
  });

  it("gives an edit wholly inside one goal", () => {
    const next = "f = {! x !}\ng = {! a !}\n";
    expect(planCheck(previous, goals, next)).toEqual({
      kind: "give",
      goal: 0,
      expression: "x",
      span: { id: 0, from: 4, to: 11 },
    });
  });

  it("loads an edit outside every goal", () => {
    expect(planCheck(previous, goals, "f = {! !}\nh = {! a !}\n").kind).toBe("load");
  });

  it("loads an edit across two goals", () => {
    expect(planCheck(previous, goals, "f = {! x !}\ng = {! b !}\n").kind).toBe("load");
  });

  it("loads an edit that empties a goal", () => {
    expect(planCheck(previous, goals, "f = {! !}\ng = {!  !}\n")).toEqual({
      kind: "load",
      reason: "the edit empties goal 1",
    });
  });

  it("loads an edit that breaks a goal's braces", () => {
    expect(planCheck(previous, goals, "f = {! x }\ng = {! a !}\n").kind).toBe("load");
  });
});
