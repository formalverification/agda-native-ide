// File: src/lib/playground.test.ts
//
// Copies of a library's module into the playground, and the import added
// to Main (issue 10).

import { describe, expect, it } from "vitest";

import {
  moduleCopy,
  openImportEdit,
  playgroundModuleOf,
  playgroundTarget,
  renameModule,
  selectionCopy,
} from "./playground";

/** A module as agda-algebras writes one: front matter, prose, a hidden
 * block with its options, module line and imports, then code. */
const SIGNATURES = `---
title : "Overture.Signatures module"
---

This module of the library names the module Overture.Signatures in prose:
module Overture.Signatures where (not code).

<!--
\`\`\`agda
{-# OPTIONS --without-K --exact-split --safe #-}

module Overture.Signatures where

open import Agda.Primitive  using () renaming ( Set to  Type )
open import Data.Product    using ( Σ-syntax ; proj₁
                                  ; proj₂ )
open import Level           using ( Level ; _⊔_ ) renaming ( suc to lsuc )
\`\`\`
-->

\`\`\`haskell
import Not.Agda
\`\`\`

\`\`\`agda
Signature : (𝓞 𝓥 : Level) → Type (lsuc (𝓞 ⊔ 𝓥))
Signature 𝓞 𝓥 = Σ[ F ∈ Type 𝓞 ] (F → Type 𝓥)
\`\`\`
`;

describe("a copy's name and path", () => {
  it("is a module name or its path under /play/, with either extension", () => {
    expect(playgroundTarget("Signatures", ".lagda.md")).toEqual({ module: "Signatures", path: "/play/Signatures.lagda.md" });
    expect(playgroundTarget(" Exercises.Sig ", ".agda")).toEqual({ module: "Exercises.Sig", path: "/play/Exercises/Sig.agda" });
    expect(playgroundTarget("/play/Exercises/Sig.agda", ".agda")).toEqual({ module: "Exercises.Sig", path: "/play/Exercises/Sig.agda" });
    expect(playgroundTarget("Sig-2'", ".agda")).toEqual({ module: "Sig-2'", path: "/play/Sig-2'.agda" });
    expect(playgroundTarget("𝑆ig", ".agda")).toEqual({ module: "𝑆ig", path: "/play/𝑆ig.agda" });
  });

  it("refuses what is not a module name", () => {
    expect(playgroundTarget("", ".agda")).toEqual({ error: "Name the copy's module" });
    for (const name of ["2Sig", "My Sig", "Sig..A", "where", "A.module", "Sig(1)"])
      expect(playgroundTarget(name, ".agda")).toHaveProperty("error");
  });

  it("reads a playground file's module from its path", () => {
    expect(playgroundModuleOf("/play/Main.agda")).toBe("Main");
    expect(playgroundModuleOf("/play/Exercises/Sig.lagda.md")).toBe("Exercises.Sig");
    expect(playgroundModuleOf("/agda-algebras/src/Overture.lagda.md")).toBeUndefined();
  });
});

describe("the module line", () => {
  it("is renamed where code declares it, not in prose", () => {
    const renamed = renameModule(SIGNATURES, "Overture.Signatures", "Signatures", true)!;
    expect(renamed).toContain("\nmodule Signatures where\n");
    expect(renamed).toContain("module Overture.Signatures where (not code).");
    expect(renamed.length).toBe(SIGNATURES.length - "Overture.".length);
    expect(moduleCopy(SIGNATURES, "Overture.Signatures", "Signatures")).toBe(renamed);
  });

  it("keeps a parameterized module's parameters", () => {
    const text = "```agda\nmodule Setoid.Algebras.Basic {𝑆 : Signature 𝓞 𝓥} where\n```\n";
    expect(renameModule(text, "Setoid.Algebras.Basic", "Basic", true)).toBe(
      "```agda\nmodule Basic {𝑆 : Signature 𝓞 𝓥} where\n```\n",
    );
  });

  it("is not a longer name's prefix, and absent is undefined", () => {
    const text = "module Overture.SignaturesMore where\n";
    expect(renameModule(text, "Overture.Signatures", "X", false)).toBeUndefined();
    expect(renameModule("```agda\nx = 1\n```\n", "Overture.Signatures", "X", true)).toBeUndefined();
  });
});

describe("a selection's copy", () => {
  const select = (text: string) => ({ from: SIGNATURES.indexOf(text), to: SIGNATURES.indexOf(text) + text.length });
  const definition = "Signature : (𝓞 𝓥 : Level) → Type (lsuc (𝓞 ⊔ 𝓥))\nSignature 𝓞 𝓥 = Σ[ F ∈ Type 𝓞 ] (F → Type 𝓥)\n";

  it("is the module's code through the selection, renamed, without prose or other blocks", () => {
    const copy = selectionCopy(SIGNATURES, "Overture.Signatures", "SignatureType", select(definition))!;
    expect(copy.text).toBe(
      [
        "{-# OPTIONS --without-K --exact-split --safe #-}",
        "",
        "module SignatureType where",
        "",
        "open import Agda.Primitive  using () renaming ( Set to  Type )",
        "open import Data.Product    using ( Σ-syntax ; proj₁",
        "                                  ; proj₂ )",
        "open import Level           using ( Level ; _⊔_ ) renaming ( suc to lsuc )",
        "Signature : (𝓞 𝓥 : Level) → Type (lsuc (𝓞 ⊔ 𝓥))",
        "Signature 𝓞 𝓥 = Σ[ F ∈ Type 𝓞 ] (F → Type 𝓥)",
        "",
      ].join("\n"),
    );
    expect(copy.text.slice(copy.at)).toBe(definition);
  });

  it("ends at the selection's last line, not the line it ends at the start of", () => {
    const line = "Signature : (𝓞 𝓥 : Level) → Type (lsuc (𝓞 ⊔ 𝓥))\n";
    const copy = selectionCopy(SIGNATURES, "Overture.Signatures", "S", select(line))!;
    expect(copy.text.endsWith(line)).toBe(true);
    expect(copy.text).not.toContain("Signature 𝓞 𝓥 =");
    // From mid-line to mid-line, the lines it touches.
    const middle = selectionCopy(SIGNATURES, "Overture.Signatures", "S", select("(lsuc (𝓞 ⊔ 𝓥))\nSignature 𝓞"))!;
    expect(middle.text.slice(middle.at)).toBe(definition);
  });

  it("is none for a source that declares no such module", () => {
    expect(selectionCopy(SIGNATURES, "Overture.Other", "S", select(definition))).toBeUndefined();
  });
});

describe("an open import added to Main", () => {
  const main = "{-# OPTIONS --safe #-}\nmodule Main where\n\nopen import Agda.Builtin.Nat\n  using (Nat)\nimport Agda.Builtin.Bool\n\nx : Nat\nx = 0\n";

  it("goes after the last import statement", () => {
    const edit = openImportEdit(main, "Overture.Signatures");
    expect(edit).toEqual({ from: main.indexOf("\nx : Nat"), insert: "open import Overture.Signatures\n" });
    if (!edit || !("insert" in edit)) throw new Error("no edit");
    expect(main.slice(0, edit.from) + edit.insert + main.slice(edit.from)).toContain(
      "import Agda.Builtin.Bool\nopen import Overture.Signatures\n\nx : Nat",
    );
  });

  it("goes after the module line when there is no import, and at the end of a last line", () => {
    expect(openImportEdit("module Main where\nx = 0\n", "M")).toEqual({ from: 18, insert: "open import M\n" });
    expect(openImportEdit("module Main where", "M")).toEqual({ from: 17, insert: "\nopen import M\n" });
  });

  it("is where Main opens the module already, and none without a module", () => {
    expect(openImportEdit(main + "open import Overture.Signatures\n", "Overture.Signatures")).toEqual({
      at: main.length,
    });
    expect(openImportEdit("x = 0\n", "M")).toBeUndefined();
  });
});
