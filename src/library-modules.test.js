/// <reference types="vitest/globals" />
// File: src/library-modules.test.js
//
// The module list the build writes from a library's sources archive
// (scripts/library-modules.mjs, issue 9): every source under the
// directories the library includes, by name, path and title, in the
// Explorer's order, which the manifest package accepts.  The site's own
// list and archive are compared when `make assets` has put them in
// static/; `make assets-check` compares them too.

import { existsSync, readFileSync } from "node:fs";
import JSZip from "jszip";
import { parseLibraryManifest } from "@agda-native-ide/manifest";
import {
  frontMatterTitle,
  moduleList,
  readZip,
  serialize,
} from "../scripts/library-modules.mjs";

/** A zip of `files`, deflated as the flake's are, read back by the
 * script's own reader. @param {Record<string, string>} files */
async function archive(files) {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return readZip(bytes);
}

const titled = (title) => `---\nlayout: default\ntitle : "${title}"\n---\n\n# ${title}\n`;

describe("the module list of a sources archive", () => {
  it("lists every source the library includes, by name, path and title, in the Explorer's order", async () => {
    const files = await archive({
      "lib/lib.agda-lib": "name: lib\ndepend: standard-library-2.3\ninclude: src\n",
      "lib/LICENSE": "text",
      "lib/src/Setoid/Algebras.lagda.md": titled("Setoid.Algebras module"),
      "lib/src/Setoid.lagda.md": titled("Setoid module"),
      "lib/src/agda-algebras.lagda.md": `---\ntitle: "agda-algebras (The \\"Library\\")"\n---\n`,
      "lib/src/Legacy/Base/DEPRECATED.md": "# not a module\n",
      "lib/src/Legacy/Base/Old.agda": "module Legacy.Base.Old where\n",
      "lib/src/Typo.lagda.md": `n${titled("Typo module")}`,
      "lib/notes/Elsewhere.agda": "module Elsewhere where\n",
    });
    const list = moduleList(files, { commit: "f067d57d367a4830834ce1fd80937820754f9a28" });
    expect(list).toEqual({
      version: 1,
      library: "lib",
      commit: "f067d57d367a4830834ce1fd80937820754f9a28",
      include: ["/lib/src"],
      modules: [
        { name: "agda-algebras", path: "/lib/src/agda-algebras.lagda.md", title: 'agda-algebras (The "Library")' },
        { name: "Legacy.Base.Old", path: "/lib/src/Legacy/Base/Old.agda" },
        { name: "Setoid", path: "/lib/src/Setoid.lagda.md", title: "Setoid module" },
        { name: "Setoid.Algebras", path: "/lib/src/Setoid/Algebras.lagda.md", title: "Setoid.Algebras module" },
        { name: "Typo", path: "/lib/src/Typo.lagda.md" },
      ],
    });
    expect(parseLibraryManifest(list)).toEqual({ ok: true, value: list });
  });

  it("reads a library that includes its own directory, and refuses an archive without one library", async () => {
    const files = await archive({ "lib.agda-lib": "name: lib\ninclude: .\n", "Main.agda": "module Main where\n" });
    expect(moduleList(files)).toMatchObject({ include: ["/"], modules: [{ name: "Main", path: "/Main.agda" }] });
    await expect(archive({ "Main.agda": "" }).then(moduleList)).rejects.toThrow(/0 \.agda-lib files/);
  });

  it("reads a title as the front matter gives it, and nothing outside it", () => {
    expect(frontMatterTitle('---\ntitle: "A \\"quoted\\" one"\n---\n')).toBe('A "quoted" one');
    expect(frontMatterTitle("---\ntitle : 'It''s'\n---\n")).toBe("It's");
    expect(frontMatterTitle("---\ntitle:   plain words  \n---\n")).toBe("plain words");
    expect(frontMatterTitle("---\nlayout: x\n---\ntitle: later\n")).toBeUndefined();
    expect(frontMatterTitle('n---\ntitle: "typo"\n---\n')).toBeUndefined();
    expect(frontMatterTitle('---\ntitle: ""\n---\n')).toBeUndefined();
  });

  it("refuses an archive whose bytes are not the ones its directory describes", async () => {
    const zip = new JSZip();
    zip.file("lib.agda-lib", "name: lib\n");
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
    const at = bytes.indexOf("name: lib");
    bytes[at] = "N".charCodeAt(0);
    expect(() => readZip(bytes)).toThrow(/not the bytes/);
    expect(() => readZip(Buffer.from("not a zip"))).toThrow(/not a zip archive/);
  });

  const zip = new URL("../static/agda-algebras-sources.zip", import.meta.url);
  const shipped = new URL("../static/agda-algebras-modules.json", import.meta.url);
  it.skipIf(!existsSync(zip) || !existsSync(shipped))(
    "is, for the site's archive, the list the site ships (after make assets)",
    () => {
      const list = JSON.parse(readFileSync(shipped, "utf8"));
      const fresh = moduleList(readZip(readFileSync(zip)), { commit: list.commit });
      expect(serialize(fresh)).toBe(readFileSync(shipped, "utf8"));
      const sources = [...readZip(readFileSync(zip)).keys()].filter((path) => path.endsWith(".lagda.md"));
      expect(fresh.modules.map((entry) => entry.path.slice(1)).sort()).toEqual(sources.sort());
      expect(parseLibraryManifest(fresh).ok).toBe(true);
    },
  );
});
