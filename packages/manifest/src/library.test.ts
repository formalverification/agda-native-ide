// File: packages/manifest/src/library.test.ts
//
// A library's module list (issue 9): a list as the build writes it is
// accepted, and one that names a module not at its path, repeats one, or
// leaves the Explorer's order is refused, with the field named.  The list
// the site ships is checked when `make assets` has put it in static/.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { compareModuleNames, parseLibraryManifest } from "./index.js";

const list = () => ({
  version: 1,
  library: "agda-algebras",
  commit: "f067d57d367a4830834ce1fd80937820754f9a28",
  include: ["/agda-algebras/src"],
  modules: [
    { name: "agda-algebras", path: "/agda-algebras/src/agda-algebras.lagda.md", title: "The library" },
    { name: "Base", path: "/agda-algebras/src/Base.lagda.md" },
    { name: "Base.Equality", path: "/agda-algebras/src/Base/Equality.agda" },
    { name: "Base.Functions", path: "/agda-algebras/src/Base/Functions.lagda.md" },
    { name: "Legacy.Base", path: "/agda-algebras/src/Legacy/Base.lagda.md" },
  ],
});

const shipped = new URL("../../../static/agda-algebras-modules.json", import.meta.url);

describe("a library's module list", () => {
  it("accepts a list as the build writes it", () => {
    expect(parseLibraryManifest(list())).toEqual({ ok: true, value: list() });
  });

  it("refuses a name that is not the module at its path", () => {
    const moved = list();
    moved.modules[2].name = "Base.Equalities";
    expect(parseLibraryManifest(moved)).toEqual({
      ok: false,
      error: "the module list: modules.2.name is not the module at /agda-algebras/src/Base/Equality.agda",
    });
    const outside = list();
    outside.modules[1].path = "/stdlib/Base.lagda.md";
    expect(parseLibraryManifest(outside)).toMatchObject({
      ok: false,
      error: "the module list: modules.1.name is not the module at /stdlib/Base.lagda.md",
    });
  });

  it("refuses a name that is no module name, and a path that is no source", () => {
    const dotted = list();
    dotted.modules[1].name = "Base.";
    expect(parseLibraryManifest(dotted)).toEqual({
      ok: false,
      error: "the module list: modules.1.name must be a dotted module name",
    });
    const spaced = list();
    spaced.modules[1].name = "Base Two";
    expect(parseLibraryManifest(spaced).ok).toBe(false);
    const notes = list();
    notes.modules[1].path = "/agda-algebras/src/Base.md";
    expect(parseLibraryManifest(notes)).toEqual({
      ok: false,
      error: "the module list: modules.1.path must be an absolute path to an Agda source on the engine's drive",
    });
  });

  it("refuses a repeated module and one out of the Explorer's order", () => {
    const repeated = list();
    repeated.modules.splice(2, 0, structuredClone(repeated.modules[1]));
    expect(parseLibraryManifest(repeated)).toEqual({
      ok: false,
      error: "the module list: modules.2.name repeats Base",
    });
    const swapped = list();
    [swapped.modules[2], swapped.modules[3]] = [swapped.modules[3], swapped.modules[2]];
    expect(parseLibraryManifest(swapped)).toEqual({
      ok: false,
      error: "the module list: modules.3.name comes after Base.Functions in the Explorer's order",
    });
  });

  it("orders by segment, case aside first, a module before those under its name", () => {
    const names = ["Setoid.Algebras", "agda-algebras", "Setoid", "HSP", "Setoid-Extra", "Homomorphisms", "hsp", "Setoid.Algebras.Basic"];
    expect([...names].sort(compareModuleNames)).toEqual([
      "agda-algebras",
      "Homomorphisms",
      "HSP",
      "hsp",
      "Setoid",
      "Setoid.Algebras",
      "Setoid.Algebras.Basic",
      "Setoid-Extra",
    ]);
  });

  it.skipIf(!existsSync(shipped))("accepts the list the site ships (after make assets)", () => {
    const parsed = parseLibraryManifest(JSON.parse(readFileSync(shipped, "utf8")));
    expect(parsed.ok ? "" : parsed.error).toBe("");
    if (!parsed.ok) return;
    expect(parsed.value.library).toBe("agda-algebras");
    expect(parsed.value.modules.length).toBeGreaterThan(300);
  });
});
