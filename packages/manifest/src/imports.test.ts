// File: packages/manifest/src/imports.test.ts
//
// The imports read from a source: each form of the statement, nothing in
// a comment, a pragma, a string or a character literal, and only the code
// of a literate source, by Agda 2.9.0's own rules.

import { describe, expect, it } from "vitest";

import { importedModules } from "./imports.js";

describe("importedModules", () => {
  it("reads every form of the statement, each module once", () => {
    const source = [
      "{-# OPTIONS --without-K --exact-split --safe #-}",
      "module Main where",
      "",
      "import Overture.Signatures",
      "open import Setoid.Algebras.Basic using (Algebra) renaming (𝕌[_] to U)",
      "open import Data.Product as Prod public",
      "import Level as L",
      "open import Relation.Binary.Bundles  -- a comment after it",
      "open import Algebra.Structures {A = ℕ} _≡_",
      "import Overture.Signatures",
      "open import",
      "  Data.List",
      "",
      "module Inner where",
      "  open import Overture.Basic",
      "  private module P where { open import Data.Nat ; import Data.Fin }",
    ].join("\n");
    expect(importedModules(source)).toEqual([
      "Overture.Signatures",
      "Setoid.Algebras.Basic",
      "Data.Product",
      "Level",
      "Relation.Binary.Bundles",
      "Algebra.Structures",
      "Data.List",
      "Overture.Basic",
      "Data.Nat",
      "Data.Fin",
    ]);
  });

  it("reads nothing in a comment, a pragma, a string or a character literal", () => {
    const source = [
      "module Main where",
      "-- open import Commented.Out",
      "x = y -- import After.Code",
      "y = z --open import Dashes.Then.Letters",
      "{- import Block.Comment",
      "   {- open import Nested.Comment -}",
      "   import Still.Inside -}",
      "{-# FOREIGN GHC import Data.Text #-}",
      's = "open import In.A.String"',
      'q = "a \\" import Escaped.Quote"',
      's2 = "{- not a comment" ; open import After.A.String',
      "c = '\"' ; open import After.A.Quote.Char",
      "d = f' x ; open import After.A.Prime",
      "a--b = c",
      'e = \'a\'-- open import After.A.Char.Then.Dashes',
      '{-# FOREIGN GHC s = "{-" #-}',
      "open import Real.One",
    ].join("\n");
    // Each case checked natively, Agda 2.9.0: the dashes after a character
    // literal open a comment, and a {- in a pragma opens nothing.
    expect(importedModules(source)).toEqual(["After.A.String", "After.A.Quote.Char", "After.A.Prime", "Real.One"]);
  });

  it("reads `import` only as a keyword", () => {
    expect(importedModules("module M where\nmyimport X\nimportX Y\nx = reimport Z\n")).toEqual([]);
    expect(importedModules("module M where\nopen import 𝕄.α.Β\n")).toEqual(["𝕄.α.Β"]);
  });

  it("reads a Markdown source's code as Agda does: bare fences and agda fences", () => {
    const markdown = [
      "# A chapter",
      "",
      "To use it, write `open import Prose.Mention`.",
      "",
      "```agda",
      "module Chapter where",
      "open import Data.Nat",
      "```",
      "",
      "```haskell",
      "import Data.Map",
      "```",
      "",
      "```",
      "open import Data.List",
      "```",
      "",
      "``` agda",
      "open import Not.A.Fence",
      "```",
    ].join("\n");
    expect(importedModules(markdown, "lagda.md")).toEqual(["Data.Nat", "Data.List"]);
    expect(importedModules(markdown, "lagda.typ")).toEqual(["Data.Nat", "Data.List"]);
  });

  it("reads a LaTeX source's code blocks, not one after a %", () => {
    const latex = [
      "\\section{Prose} import Prose.Mention",
      "\\begin{code}",
      "module Chapter where",
      "open import Data.Bool",
      "\\end{code}",
      "open import After.The.Block",
      "% \\begin{code}",
      "open import Commented.Block",
      "\\end{code}",
    ].join("\n");
    expect(importedModules(latex, "lagda")).toEqual(["Data.Bool"]);
    expect(importedModules(latex, "lagda.tex")).toEqual(["Data.Bool"]);
  });

  it("does not read the literate formats it does not follow", () => {
    expect(importedModules("open import Data.Nat", "lagda.rst")).toBeUndefined();
    expect(importedModules("open import Data.Nat", "lagda.org")).toBeUndefined();
  });
});
