/// <reference types="vitest/globals" />
// File: src/asset-manifest.test.js
//
// The values the build derives from the assets it ships
// (scripts/asset-manifest.mjs, issue 3): each token follows its own
// asset's content and nothing else, and the build refuses to run without
// an asset.

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
  write("als-2.8ext.wasm", "compiler v1");
  write("agda-data.zip", "builtins v1");
  write("agda-stdlib-2.3.zip", "stdlib v1");
  write("plfa/project.zip", "plfa v1");
  write(
    "plfa/interfaces/manifest.json",
    JSON.stringify({
      version: 1,
      chapters: { "part1/Naturals": ["part1/Naturals"] },
    }),
  );
  write("plfa/interfaces/part1/Naturals.zip", "naturals v1");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the asset manifest", () => {
  it("takes a file's token from its bytes, and the compiler's length from its size", () => {
    const manifest = assetManifest(dir);
    expect(manifest.tokens.compiler).toBe(sha256("compiler v1").slice(0, 16));
    expect(manifest.tokens.stdlib).toBe(sha256("stdlib v1").slice(0, 16));
    expect(manifest.compilerBytes).toBe("compiler v1".length);
    expect(assetManifest(dir)).toEqual(manifest);
  });

  it("changes one token, and the namespace, when one asset changes", () => {
    const before = assetManifest(dir);
    write("agda-data.zip", "builtins v2");
    const after = assetManifest(dir);
    for (const name of Object.keys(before.tokens))
      if (name === "builtins")
        expect(after.tokens[name]).not.toBe(before.tokens[name]);
      else expect(after.tokens[name]).toBe(before.tokens[name]);
    expect(after.driveCacheNamespace).not.toBe(before.driveCacheNamespace);
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

  it("refuses a missing asset, unless it is not building", () => {
    rmSync(join(dir, "agda-stdlib-2.3.zip"));
    expect(() => assetManifest(dir)).toThrow(/agda-stdlib-2\.3\.zip/);
    const manifest = assetManifest(dir, { strict: false });
    expect(manifest.tokens.stdlib).toBe("missing");
    expect(manifest.tokens.compiler).toBe(sha256("compiler v1").slice(0, 16));
  });
});
