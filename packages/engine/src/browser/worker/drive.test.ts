/// <reference types="vitest/globals" />
// File: packages/engine/src/browser/worker/drive.test.ts
//
// The drive gives back the text it was given, as the native engine's
// filesystem does: the session compares the two after every load.  And it
// is laid out with a list of libraries, whose registry it writes (issue
// 13).

import * as Runno from "@runno/wasi";
import JSZip from "jszip";

import { attachDrive, layOutDrive } from "./drive.js";

describe("the drive's sources", () => {
  it("reads back a source as it was written, with its byte order mark", () => {
    const wasi = new Runno.WASI({ args: ["agda"], env: {}, fs: {} });
    const drive = attachDrive(wasi.drive, null);
    for (const text of ["﻿module Bom where\n", "module Plain where\n", "﻿", ""]) {
      drive.writeFile("/project/M.agda", new TextEncoder().encode(text));
      expect(drive.readFile("/project/M.agda")).toBe(text);
    }
    expect(drive.readFile("/project/Missing.agda")).toBeUndefined();
  });
});

/** A zip of the given files, as an archive the page fetches. */
async function zip(files: Record<string, string>) {
  const archive = new JSZip();
  for (const [path, text] of Object.entries(files)) archive.file(path, text);
  return archive.generateAsync({ type: "arraybuffer" });
}

const text = (fs: Record<string, Runno.WASIFile>, path: string) => {
  const file = fs[path];
  if (!file) return undefined;
  return typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content);
};

describe("the drive's libraries", () => {
  it("extracts each library at the root, and names them after the standard library", async () => {
    const fs = await layOutDrive({
      builtin: null,
      stdlib: await zip({
        "agda-stdlib-2.3/standard-library.agda-lib": "name: standard-library-2.3\ninclude: src\n",
        "agda-stdlib-2.3/src/Data/Nat.agda": "module Data.Nat where\n",
        "agda-stdlib-2.3/README.md": "not on the drive\n",
      }),
      libraries: [
        {
          data: await zip({
            "agda-algebras/agda-algebras.agda-lib": "name: agda-algebras\n",
            "agda-algebras/src/Overture/Basic.lagda.md": "# Overture.Basic\n",
          }),
          agdaLib: "/agda-algebras/agda-algebras.agda-lib",
          name: "agda-algebras",
        },
        {
          data: await zip({ "plfa.agda-lib": "name: plfa\n" }),
          agdaLib: "/plfa.agda-lib",
          name: "plfa",
        },
      ],
    });
    expect(text(fs, "/home/root/.config/agda/libraries")).toBe(
      "/stdlib/standard-library.agda-lib\n/agda-algebras/agda-algebras.agda-lib\n/plfa.agda-lib\n",
    );
    expect(text(fs, "/home/root/.config/agda/defaults")).toBe("standard-library\nagda-algebras\nplfa\n");
    expect(text(fs, "/agda-algebras/src/Overture/Basic.lagda.md")).toBe("# Overture.Basic\n");
    expect(text(fs, "/stdlib/src/Data/Nat.agda")).toBe("module Data.Nat where\n");
    expect(fs["/stdlib/README.md"]).toBeUndefined();
    expect(text(fs, "/Main.agda")).toBe("");
  });

  it("writes the registry as the page's drive had it, for the standard library and PLFA", async () => {
    const stdlib = await zip({ "agda-stdlib-2.3/standard-library.agda-lib": "name: standard-library-2.3\n" });
    const alone = await layOutDrive({ builtin: null, stdlib, libraries: [] });
    expect(text(alone, "/home/root/.config/agda/libraries")).toBe("/stdlib/standard-library.agda-lib\n");
    expect(text(alone, "/home/root/.config/agda/defaults")).toBe("standard-library\n");
    const withPlfa = await layOutDrive({
      builtin: null,
      stdlib: await zip({ "agda-stdlib-2.3/standard-library.agda-lib": "name: standard-library-2.3\n" }),
      libraries: [{ data: await zip({ "plfa.agda-lib": "name: plfa\n" }), agdaLib: "/plfa.agda-lib", name: "plfa" }],
    });
    expect(text(withPlfa, "/home/root/.config/agda/libraries")).toBe(
      "/stdlib/standard-library.agda-lib\n/plfa.agda-lib\n",
    );
    expect(text(withPlfa, "/home/root/.config/agda/defaults")).toBe("standard-library\nplfa\n");
  });

  it("writes no registry when it has no library", async () => {
    const fs = await layOutDrive({ builtin: null, stdlib: null, libraries: [] });
    expect(fs["/home/root/.config/agda/libraries"]).toBeUndefined();
    expect(fs["/home/root/.config/agda/defaults"]).toBeUndefined();
  });
});
