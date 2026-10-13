// File: packages/manifest/src/library.test.ts
//
// A library's module list (issue 9): a list as the build writes it is
// accepted, and one that names a module not at its path, repeats one, or
// leaves the Explorer's order is refused, with the field named.  The list
// the site ships is checked when `make assets` has put it in static/.
//
// And agda-algebras' archive index (issue 14): it validates, a wrong field is named, the plan
// of an import is index.mjs's, it follows an import the index lacks into
// its source, and sizes are stated in one convention.  Two indexes: a cut
// of the real one committed beside this file (the closure of
// Overture.Signatures and Overture.Basic, as `make assets` copies it, one
// archive and one module per line), which every run reads; and the whole
// index, at AGDA_ALGEBRAS_INDEX or where `make assets` copies it
// (static/agda-algebras/), which a run without either skips, saying so.
// CI's browser job sets AGDA_ALGEBRAS_INDEX to the built site's.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  archiveRefs,
  compareModuleNames,
  parseArchiveIndex,
  parseLibraryDescription,
  parseLibraryManifest,
  planArchives,
  planImports,
  statedProgress,
  statedSize,
} from "./index.js";
import type { ArchiveIndex, LibraryDescription } from "./index.js";
// @ts-expect-error: a script of the archives' build, in JavaScript, with no declarations.
import { needs } from "../../../scripts/library-archives/index.mjs";

const INDEX = process.env.AGDA_ALGEBRAS_INDEX ?? new URL("../../../static/agda-algebras/index.json", import.meta.url).pathname;
// An index asked for by name must be there: CI's step would otherwise pass
// having compared nothing.
if (process.env.AGDA_ALGEBRAS_INDEX && !existsSync(INDEX))
  throw new Error(`AGDA_ALGEBRAS_INDEX names ${INDEX}, which does not exist`);
const shipped = existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : undefined;
const withIndex = shipped ? it : it.skip;
if (!shipped) console.warn(`library.test.ts: no index at ${INDEX}, so the tests over the whole index are skipped`);
const fixture = JSON.parse(readFileSync(new URL("./fixtures/agda-algebras-index-overture.json", import.meta.url), "utf8"));

const library: LibraryDescription = {
  kind: "library",
  name: "agda-algebras",
  agdaLib: "/agda-algebras/agda-algebras.agda-lib",
  sources: { url: "./agda-algebras-sources.zip?cache=005b0f5576bf88d2", bytes: 985_864, sha256: "0".repeat(64) },
  index: { url: "./agda-algebras/index.json?cache=7f94ac5807604672", bytes: 285_618, sha256: "1".repeat(64) },
  archives: { base: "./agda-algebras/" },
};

/** A small index: two modules of a library, one builtin, two archives. */
const small = (): ArchiveIndex => ({
  schema: 1,
  agda: { version: "2.9.0", wasm: "a".repeat(64) },
  libraries: {
    lib: { name: "lib", root: "/lib", agdaLib: "/lib/lib.agda-lib", sources: { path: "lib.zip", bytes: 1, sha256: "b".repeat(64) } },
    builtins: { root: "/lib/prim", sources: { path: "agda-data.zip", bytes: 1, sha256: "c".repeat(64) } },
  },
  roots: ["A", "B"],
  archives: {
    "interfaces/A.zip": { bytes: 100, sha256: "d".repeat(64), modules: 1 },
    "interfaces/B.zip": { bytes: 200, sha256: "e".repeat(64), modules: 1 },
  },
  modules: {
    A: { library: "lib", source: "/lib/src/A.agda", interface: "/lib/_build/A.agdai", bytes: 90, archive: "interfaces/A.zip", deps: ["B", "Agda.Primitive"] },
    B: { library: "lib", source: "/lib/src/B.agda", interface: "/lib/_build/B.agdai", bytes: 190, archive: "interfaces/B.zip", deps: [] },
    "Agda.Primitive": { library: "builtins", source: "/lib/prim/Agda/Primitive.agda", interface: "/lib/prim/_build/Agda/Primitive.agdai", bytes: 5, archive: null, deps: [] },
  },
});

describe("the library's description", () => {
  it("accepts the page's, and names a wrong field", () => {
    expect(parseLibraryDescription(library)).toEqual({ ok: true, value: library });
    expect(parseLibraryDescription({ ...library, archives: { base: "./agda-algebras" } })).toEqual({
      ok: false,
      error: "the library's description: archives.base must end with a slash",
    });
    expect(parseLibraryDescription({ ...library, index: { ...library.index, sha256: "nope" } })).toEqual({
      ok: false,
      error: "the library's description: index.sha256 must be a SHA-256, in hex",
    });
    expect(parseLibraryDescription({ ...library, kind: "corpus" })).toMatchObject({ ok: false });
  });
});

describe("the archive index", () => {
  it("accepts a cut of the one the site ships", () => {
    const parsed = parseArchiveIndex(fixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value.archives)).toHaveLength(15);
    for (const roots of [["Overture.Signatures"], ["Overture.Basic"], ["Overture.Basic", "Overture.Signatures", "Data.Vec"]])
      expect(planArchives(parsed.value, roots), roots.join()).toEqual(needs(fixture, roots));
    expect(planArchives(parsed.value, ["Overture.Signatures"])).toMatchObject({ archives: { length: 3 }, bytes: 206_933 });
  });

  withIndex("accepts the one the site ships", () => {
    const parsed = parseArchiveIndex(shipped);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value.archives)).toHaveLength(395);
    expect(parsed.value.roots).toHaveLength(350);
  });

  it("names a wrong field, quoting a key that holds a dot", () => {
    const index = small() as unknown as { modules: Record<string, { deps: unknown[]; archive: unknown }> };
    index.modules["A"].deps = ["Nowhere.At.All"];
    expect(parseArchiveIndex(index)).toEqual({
      ok: false,
      error: "the archive index: modules.A.deps names Nowhere.At.All, which is not a module of the index",
    });
    const dotted = small() as unknown as { modules: Record<string, { archive: unknown }> };
    dotted.modules["Agda.Primitive"].archive = "interfaces/Missing.zip";
    expect(parseArchiveIndex(dotted)).toEqual({
      ok: false,
      error:
        'the archive index: modules["Agda.Primitive"].archive names interfaces/Missing.zip, which is not an archive of the index',
    });
    const bytes = small() as unknown as { archives: Record<string, { bytes: unknown }> };
    bytes.archives["interfaces/B.zip"].bytes = -1;
    expect(parseArchiveIndex(bytes)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^the archive index: archives\["interfaces\/B\.zip"\]\.bytes /),
    });
    expect(parseArchiveIndex({ ...small(), schema: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/^the archive index: schema /) });
  });
});

describe("the plan of an import", () => {
  it("takes the closure's archives, less the builtins', and names what the index lacks", () => {
    expect(planArchives(small(), ["A", "Mine.Own", "A"])).toEqual({
      modules: 3,
      archives: ["interfaces/A.zip", "interfaces/B.zip"],
      bytes: 300,
      floor: 280,
      unknown: ["Mine.Own"],
    });
    expect(planArchives(small(), ["Agda.Primitive"])).toMatchObject({ archives: [], bytes: 0 });
    expect(archiveRefs(small(), ["interfaces/B.zip"], library)).toEqual([
      {
        url: `./agda-algebras/interfaces/B.zip?cache=${"e".repeat(16)}`,
        sha256: "e".repeat(64),
        bytes: 200,
        path: "interfaces/B.zip",
        modules: 1,
      },
    ]);
  });

  withIndex("is index.mjs's for every root and the fixed sets of roots", () => {
    const parsed = parseArchiveIndex(shipped);
    if (!parsed.ok) throw new Error(parsed.error);
    const sets = [
      ...parsed.value.roots.map((root) => [root]),
      ["Overture.Signatures"],
      ["Overture.Basic", "Setoid.Algebras.Basic", "Setoid.Varieties.HSP"],
      ["Data.Nat.Properties", "Overture.Basic"],
    ];
    for (const roots of sets) expect(planArchives(parsed.value, roots), roots.join()).toEqual(needs(shipped, roots));
    // The browser check's import, and the milestone's.
    expect(planArchives(parsed.value, ["Overture.Signatures"])).toMatchObject({ archives: { length: 3 }, bytes: 206_933 });
    expect(planArchives(parsed.value, ["Setoid.Varieties.HSP"])).toMatchObject({ archives: { length: 128 }, bytes: 39_251_541 });
  });
});

describe("the plan of a source's imports", () => {
  it("follows an import the index lacks into its source on the drive", async () => {
    const drive: Record<string, string> = {
      "/play/Mine.agda": "module Mine where\nopen import A\nopen import Theirs\nopen import Agda.Builtin.Float\n",
      "/lib/src/Theirs.lagda.md": "# Theirs\n```agda\nmodule Theirs where\nopen import B\nopen import Mine\n```\n",
      "/play/Notes.lagda.org": "#+begin_src agda2\nmodule Notes where\nopen import B\n#+end_src\n",
    };
    const reads: string[] = [];
    const read = async (path: string) => {
      reads.push(path);
      return drive[path];
    };
    const plan = await planImports(small(), ["Mine", "Nowhere", "Agda.Builtin.Nat"], { includes: ["/play", "/lib/src/"], read });
    expect(plan).toEqual({
      modules: 3,
      archives: ["interfaces/A.zip", "interfaces/B.zip"],
      bytes: 300,
      floor: 280,
      unknown: ["Mine", "Nowhere"],
      fromSource: ["Mine", "Theirs"],
      unread: [],
      missing: ["Nowhere"],
    });
    // A source in a format the plan does not read is found, and named.
    expect(await planImports(small(), ["Notes"], { includes: ["/play"], read })).toMatchObject({
      archives: [],
      fromSource: ["Notes"],
      unread: ["Notes"],
      missing: [],
    });
    // A builtin is never looked for; a module is read once.
    expect(reads.some((path) => path.includes("Agda"))).toBe(false);
    expect(reads.filter((path) => path === "/play/Mine.agda")).toHaveLength(1);
  });
});

describe("a size as the page states it", () => {
  it("is bytes, KB of 1,024 bytes, or MiB", () => {
    expect(statedSize(0)).toBe("0 bytes");
    expect(statedSize(1)).toBe("1 byte");
    expect(statedSize(1023)).toBe("1023 bytes");
    expect(statedSize(1024)).toBe("1.0 KB");
    expect(statedSize(206_933)).toBe("202.1 KB");
    expect(statedSize(1_048_524)).toBe("1023.9 KB");
    // Not "1024.0 KB": what rounds to a MiB is stated in MiB.
    expect(statedSize(1_048_550)).toBe("1.0 MiB");
    expect(statedSize(4_318_471)).toBe("4.1 MiB");
    expect(statedSize(16_974_016)).toBe("16.2 MiB");
    expect(statedSize(39_251_541)).toBe("37.4 MiB");
    expect(statedSize(69_376_238)).toBe("66.2 MiB");
  });

  it("states a pair in the unit of its total", () => {
    expect(statedProgress(0, 206_933)).toBe("0.0 of 202.1 KB");
    expect(statedProgress(206_933, 206_933)).toBe("202.1 of 202.1 KB");
    expect(statedProgress(900, 39_044_608)).toBe("0.0 of 37.2 MiB");
    expect(statedProgress(12, 900)).toBe("12 of 900 bytes");
  });
});

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

const shippedList = new URL("../../../static/agda-algebras-modules.json", import.meta.url);

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

  it.skipIf(!existsSync(shippedList))("accepts the list the site ships (after make assets)", () => {
    const parsed = parseLibraryManifest(JSON.parse(readFileSync(shippedList, "utf8")));
    expect(parsed.ok ? "" : parsed.error).toBe("");
    if (!parsed.ok) return;
    expect(parsed.value.library).toBe("agda-algebras");
    expect(parsed.value.modules.length).toBeGreaterThan(300);
  });
});
