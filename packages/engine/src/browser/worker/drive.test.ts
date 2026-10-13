/// <reference types="vitest/globals" />
// File: packages/engine/src/browser/worker/drive.test.ts
//
// The drive gives back the text it was given, as the native engine's
// filesystem does: the session compares the two after every load.  And it
// is laid out with a list of libraries, whose registry it writes (issue
// 13), and the host's files over what the cache restores (issue 11).

import * as Runno from "@runno/wasi";
import JSZip from "jszip";

import { attachDrive, layOutDrive, prepareDrive } from "./drive.js";

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

/** An IndexedDB database as restoreCachedFiles reads it, holding these
 * files as a visit would have persisted them. */
function cached(files: { path: string; content: string }[]): IDBDatabase {
  const records = files.map(({ path, content }) => ({
    path,
    mode: "string",
    content,
    timestamps: { access: 0, change: 0, modification: 0 },
  }));
  const store = {
    getAll() {
      const request: { result: unknown; onsuccess: (() => void) | null } = { result: records, onsuccess: null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  return { transaction: () => ({ onerror: null, objectStore: () => store }) } as unknown as IDBDatabase;
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
    // The page's buffer is the host's to write, where it keeps it.
    expect(fs["/Main.agda"]).toBeUndefined();
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

  it("names only the libraries it has, with no standard library", async () => {
    const fs = await layOutDrive({
      builtin: null,
      stdlib: null,
      libraries: [{ data: await zip({ "plfa.agda-lib": "name: plfa\n" }), agdaLib: "/plfa.agda-lib", name: "plfa" }],
    });
    expect(text(fs, "/home/root/.config/agda/libraries")).toBe("/plfa.agda-lib\n");
    expect(text(fs, "/home/root/.config/agda/defaults")).toBe("plfa\n");
  });

  it("writes no registry when it has no library", async () => {
    const fs = await layOutDrive({ builtin: null, stdlib: null, libraries: [] });
    expect(fs["/home/root/.config/agda/libraries"]).toBeUndefined();
    expect(fs["/home/root/.config/agda/defaults"]).toBeUndefined();
  });

  it("writes the host's files over the archives and what the cache restores, and registers none of them", async () => {
    const play = "name: play\ndepend: standard-library-2.3 agda-algebras\ninclude: .\n";
    const fs = await prepareDrive(
      {
        builtin: null,
        stdlib: await zip({ "agda-stdlib-2.3/standard-library.agda-lib": "name: standard-library-2.3\n" }),
        libraries: [
          {
            data: await zip({
              "agda-algebras/agda-algebras.agda-lib": "name: agda-algebras\n",
              "play/play.agda-lib": "an archive's copy\n",
            }),
            agdaLib: "/agda-algebras/agda-algebras.agda-lib",
            name: "agda-algebras",
          },
        ],
      },
      [{ path: "/play/play.agda-lib", text: play }],
      cached([
        { path: "/play/play.agda-lib", content: "a cached copy\n" },
        { path: "/play/Main.agda", content: "module Main where\n" },
      ]),
    );
    expect(text(fs, "/play/play.agda-lib")).toBe(play);
    // What the cache restores stays, where the host names no file.
    expect(text(fs, "/play/Main.agda")).toBe("module Main where\n");
    expect(text(fs, "/home/root/.config/agda/libraries")).toBe(
      "/stdlib/standard-library.agda-lib\n/agda-algebras/agda-algebras.agda-lib\n",
    );
    expect(text(fs, "/home/root/.config/agda/defaults")).toBe("standard-library\nagda-algebras\n");
  });
});

/** A database the drive persists to and deletes from, in memory. */
function writable() {
  const records = new Map<string, unknown>();
  const store = {
    put: (record: { path: string }) => void records.set(record.path, record),
    delete: (path: string) => void records.delete(path),
    transaction: { oncomplete: null as (() => void) | null },
  };
  const database = {
    transaction: () => {
      queueMicrotask(() => queueMicrotask(() => store.transaction.oncomplete?.()));
      return { onerror: null, objectStore: () => store };
    },
  } as unknown as IDBDatabase;
  return { database, records };
}

describe("an archive mounted on the drive", () => {
  it("leaves the drive's cache: a dirty copy is not persisted, and a cached one is deleted", async () => {
    const wasi = new Runno.WASI({ args: ["agda"], env: {}, fs: {} });
    const { database, records } = writable();
    const drive = attachDrive(wasi.drive, database);
    const path = "/lib/_build/2.9.0/agda/src/A.agdai";
    // An interface an earlier check wrote, cached, and written again now.
    records.set(path, { path });
    drive.writeFile(path, new TextEncoder().encode("built in the browser"));
    drive.writeFile("/play/Main.agda", new TextEncoder().encode("module Main where\n"));
    await drive.mountArchive(await zip({ "lib/_build/2.9.0/agda/src/A.agdai": "from the archive" }));
    expect(drive.readFile(path)).toBe("from the archive");
    expect(records.has(path)).toBe(false);
    await drive.persist();
    expect([...records.keys()]).toEqual(["/play/Main.agda"]);
    expect(drive.present([path, "/play/Main.agda", "/lib/Missing.agdai"])).toEqual([path, "/play/Main.agda"]);
  });
});
