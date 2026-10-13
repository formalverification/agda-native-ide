/// <reference types="vitest/globals" />
// File: src/asset-manifest.test.js
//
// The values the build derives from the assets it ships
// (scripts/asset-manifest.mjs, issue 3): each token follows its own
// asset's content and nothing else, and the build refuses to run without
// an asset.  agda-algebras' sources are among them, since Agda reads them
// (issue 11); the list of its modules is too, outside the drive cache's
// namespace, since Agda does not read it (issue 9); and its archive index,
// whose archives and sources the build checks against the digests it
// records (issue 14).

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assetManifest } from "../scripts/asset-manifest.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

let dir;

function write(path, content) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "asset-manifest-"));
  write("als-reactor-2.9.0.wasm", "compiler v1");
  write("als-reactor-2.9.0.js", "glue v1");
  write("agda-data.zip", "builtins v1");
  write("agda-stdlib-2.3-patched.zip", "stdlib v1");
  write("agda-algebras-sources.zip", "agda-algebras v1");
  write("agda-algebras-modules.json", "modules v1");
  write("plfa/project.zip", "plfa v1");
  write(
    "plfa/interfaces/manifest.json",
    JSON.stringify({
      version: 1,
      chapters: { "part1/Naturals": ["part1/Naturals"] },
    }),
  );
  write("plfa/interfaces/part1/Naturals.zip", "naturals v1");
  write("agda-algebras/interfaces/A.zip", "a v1");
  writeIndex();
});

/** agda-algebras' index, naming one archive and the sources as they are. */
function writeIndex({ archive = "a v1", sources = "agda-algebras v1" } = {}) {
  write(
    "agda-algebras/index.json",
    JSON.stringify({
      schema: 1,
      libraries: {
        "agda-algebras": { sources: { path: "agda-algebras-sources.zip", sha256: sha256(sources) } },
        "standard-library": { sources: { path: "agda-stdlib-2.3-patched.zip", sha256: sha256("stdlib v1") } },
        builtins: { sources: { path: "agda-data.zip", sha256: sha256("builtins v1") } },
      },
      archives: { "interfaces/A.zip": { bytes: 4, sha256: sha256(archive), modules: 1 } },
    }),
  );
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the asset manifest", () => {
  it("takes a file's token from its bytes, and the compiler's length from its size", () => {
    const manifest = assetManifest(dir);
    expect(manifest.tokens.compiler).toBe(sha256("compiler v1").slice(0, 16));
    expect(manifest.tokens.glue).toBe(sha256("glue v1").slice(0, 16));
    expect(manifest.tokens.stdlib).toBe(sha256("stdlib v1").slice(0, 16));
    expect(manifest.tokens.agdaAlgebras).toBe(sha256("agda-algebras v1").slice(0, 16));
    expect(manifest.tokens.agdaAlgebrasModules).toBe(sha256("modules v1").slice(0, 16));
    expect(manifest.compilerBytes).toBe("compiler v1".length);
    expect(assetManifest(dir)).toEqual(manifest);
  });

  it("changes one token, and the namespace, when one asset changes", () => {
    // Not building: the index records the sources it was built from.
    for (const [name, path] of [
      ["builtins", "agda-data.zip"],
      ["agdaAlgebras", "agda-algebras-sources.zip"],
      ["agdaAlgebrasIndex", "agda-algebras/index.json"],
    ]) {
      const before = assetManifest(dir, { strict: false });
      write(path, `${name} v2`);
      const after = assetManifest(dir, { strict: false });
      for (const other of Object.keys(before.tokens))
        if (other === name)
          expect(after.tokens[other]).not.toBe(before.tokens[other]);
        else expect(after.tokens[other]).toBe(before.tokens[other]);
      expect(after.driveCacheNamespace).not.toBe(before.driveCacheNamespace);
    }
  });

  it("changes the list of modules' token, and not the namespace, when the list changes", () => {
    const before = assetManifest(dir);
    write("agda-algebras-modules.json", "modules v2");
    const after = assetManifest(dir);
    for (const name of Object.keys(before.tokens))
      if (name === "agdaAlgebrasModules") expect(after.tokens[name]).not.toBe(before.tokens[name]);
      else expect(after.tokens[name]).toBe(before.tokens[name]);
    expect(after.driveCacheNamespace).toBe(before.driveCacheNamespace);
  });

  it("changes a directory's token when a file in it changes, appears or moves", () => {
    const tokens = [assetManifest(dir).tokens.plfaInterfaces];
    write("plfa/interfaces/part1/Naturals.zip", "naturals v2");
    tokens.push(assetManifest(dir).tokens.plfaInterfaces);
    write("plfa/interfaces/part1/Induction.zip", "induction v1");
    tokens.push(assetManifest(dir).tokens.plfaInterfaces);
    mkdirSync(join(dir, "plfa/interfaces/part2"));
    renameSync(
      join(dir, "plfa/interfaces/part1/Induction.zip"),
      join(dir, "plfa/interfaces/part2/Induction.zip"),
    );
    tokens.push(assetManifest(dir).tokens.plfaInterfaces);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("refuses a missing archive that PLFA's interface manifest names", () => {
    rmSync(join(dir, "plfa/interfaces/part1/Naturals.zip"));
    expect(() => assetManifest(dir)).toThrow(/part1\/Naturals\.zip/);
    expect(assetManifest(dir, { strict: false }).tokens.plfaInterfaces).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });

  it("refuses a missing PLFA interface manifest", () => {
    rmSync(join(dir, "plfa/interfaces/manifest.json"));
    expect(() => assetManifest(dir)).toThrow(/interfaces\/manifest\.json/);
    expect(() => assetManifest(dir, { strict: false })).not.toThrow();
  });

  it("gives each file's length and full digest, and no directory's", () => {
    const { files, tokens } = assetManifest(dir);
    expect(files.agdaAlgebras).toEqual({ bytes: "agda-algebras v1".length, sha256: sha256("agda-algebras v1") });
    expect(files.agdaAlgebrasIndex.sha256.slice(0, 16)).toBe(tokens.agdaAlgebrasIndex);
    expect(files.plfaInterfaces).toBeUndefined();
  });

  it("refuses an archive the index names that is missing or not its digest's, unless it is not building", () => {
    rmSync(join(dir, "agda-algebras/interfaces/A.zip"));
    expect(() => assetManifest(dir)).toThrow(/missing from .*agda-algebras\/interfaces\/A\.zip/);
    expect(() => assetManifest(dir, { strict: false })).not.toThrow();
    write("agda-algebras/interfaces/A.zip", "a v2");
    expect(() => assetManifest(dir)).toThrow(/not the archives agda-algebras\/index\.json names, .*interfaces\/A\.zip/);
    writeIndex({ archive: "a v2" });
    expect(() => assetManifest(dir)).not.toThrow();
  });

  it("refuses an index built from other sources than the site ships", () => {
    writeIndex({ sources: "agda-algebras v0" });
    expect(() => assetManifest(dir)).toThrow(/index\.json was built from other sources than .* has: agda-algebras-sources\.zip/);
    expect(() => assetManifest(dir, { strict: false })).not.toThrow();
  });

  it("refuses a missing asset, unless it is not building", () => {
    rmSync(join(dir, "agda-stdlib-2.3-patched.zip"));
    expect(() => assetManifest(dir)).toThrow(/agda-stdlib-2\.3-patched\.zip/);
    const manifest = assetManifest(dir, { strict: false });
    expect(manifest.tokens.stdlib).toBe("missing");
    expect(manifest.tokens.compiler).toBe(sha256("compiler v1").slice(0, 16));
  });
});
