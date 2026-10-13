// File: packages/engine/src/browser/worker/drive.ts
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// src/lib/worker/drive.ts at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
// (docs/provenance.md).  The drive's lookups are answered from an index of
// its paths (./drive-index.ts), which follows the drive's own writes as
// well as Agda's (issue 50).  Agda's builtin library is extracted as it
// comes, since the flake builds agda-data.zip with its interfaces already
// where the shipped Agda looks for them, under _build/<its version>/agda/;
// the callback that moved them there, to a path that named one Agda
// version, is gone (issue 49).
//
// The drive is no longer a worker of its own but a module of the language
// server's worker (./als.ts), whose WASI drive it is, so that a file call
// is a function call on that worker's thread and no memory is shared
// (issue 59).  Its message loop over two shared rings is gone: the page's
// writes, archive extraction and the IndexedDB cache are functions the
// worker exposes.  The cache now reads each dirty file from the drive's own
// record, drive.fs, where Agda's writes land, rather than from the record
// the drive was built from, which Runno copies, so files at paths made
// after startup (Main's interface, a mounted archive's) are persisted too.
// A browser that refuses IndexedDB, by an error or by throwing at once,
// leaves the drive uncached.
//
// It moved from the page into the engine package's browser transport with
// the worker (issue 62), and reads a source back as Agda would read it,
// which the engine compares with what it wrote.  It is laid out with a list
// of libraries, each an archive, its `.agda-lib` and its name, where it took
// PLFA's archive alone, and writes the registry from that list (issue 13).
// It starts with the files the host names, a project's own `.agda-lib`,
// where it held an empty /Main.agda for the page's buffer: the host writes
// its sources where it keeps them.  They are written over what the cache
// restores, so a host's file is always its current text (issue 11).  A
// mounted archive's files leave the cache, and the drive says which paths
// it holds; a newer deploy's page may delete its database, which an open
// connection would block (issue 14).

import * as Runno from "@runno/wasi";
import JSZip from "jszip";

import { indexDrive } from "./drive-index.js";
import { DRIVE_CACHE_PREFIX, type DriveArchives, type DriveFile } from "./protocol.js";

let lastTimestamp = Date.now();

function nextTimestamp() {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return new Date(lastTimestamp);
}

function createFileEntry(path: string, content: string | Uint8Array) {
  const now = nextTimestamp();
  const obj = {
    path,
    timestamps: {
      access: now,
      change: now,
      modification: now,
    },
    mode: typeof content === "string" ? "string" : ("binary" as any),
    content,
  } as Runno.WASIFile;
  return [path, obj] as const;
}

function equalContent(left: string | Uint8Array, right: string | Uint8Array) {
  if (typeof left === "string" || typeof right === "string") {
    return (
      typeof left === "string" && typeof right === "string" && left === right
    );
  }
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function replaceFileContent(file: Runno.WASIFile, content: Uint8Array) {
  if (file.mode === "binary" && equalContent(file.content, content))
    return false;
  const changed = nextTimestamp();
  file.mode = "binary";
  file.content = content;
  file.timestamps.change = changed;
  file.timestamps.modification = changed;
  return true;
}

function fsAssign(
  path: string,
  content: string | Uint8Array,
  target: Record<string, Runno.WASIFile>,
) {
  const [key, obj] = createFileEntry(path, content);
  target[key] = obj;
  return obj;
}

async function extractZip(
  data: ArrayBuffer | Uint8Array,
  prefix: string,
  target: Record<string, Runno.WASIFile>,
  pathResolver?: (path: string) => string | null,
) {
  const zip = await JSZip.loadAsync(data);
  const filePromises: Promise<string>[] = [];

  if (prefix === "/") prefix = "";

  zip.forEach((_path, file) => {
    if (file.dir) return;
    const path = pathResolver ? pathResolver(_path) : _path;
    if (path == null) return;
    filePromises.push(
      file.async("uint8array").then((content) => {
        fsAssign(`${prefix}/${path}`, content, target);
        return `${prefix}/${path}`;
      }),
    );
  });

  return Promise.all(filePromises);
}

/** The drive's first record: Agda's builtin library (with its
 * interfaces), the standard library's sources at /stdlib, each library
 * extracted at the root in order, and Agda's library registry naming
 * them: the libraries file their `.agda-lib` files, and the defaults file
 * their names. */
export async function layOutDrive({ builtin, stdlib, libraries }: DriveArchives) {
  const fs: Record<string, Runno.WASIFile> = {};
  const registered: { agdaLib: string; name: string }[] = [];

  if (builtin) {
    await extractZip(builtin, "/", fs);
  }

  if (stdlib) {
    await extractZip(stdlib, "/stdlib", fs, (p) => {
      if (
        !p.match(/^agda-stdlib-[\.\d]+\/(?:src|_build\/)/) &&
        !p.match(/^agda-stdlib-[\.\d]+\/standard-library\.agda-lib$/)
      ) {
        return null;
      }
      return p.replace(/^agda-stdlib-[\.\d]+\//, "");
    });
    registered.push({
      agdaLib: "/stdlib/standard-library.agda-lib",
      name: "standard-library",
    });
  }

  for (const library of libraries) {
    await extractZip(library.data, "/", fs);
    registered.push(library);
  }

  if (registered.length) {
    const lines = (field: "agdaLib" | "name") =>
      registered.map((library) => `${library[field]}\n`).join("");
    fsAssign("/home/root/.config/agda/libraries", lines("agdaLib"), fs);
    fsAssign("/home/root/.config/agda/defaults", lines("name"), fs);
  }

  return fs;
}

/** The drive the worker mounts: the first record, then what an earlier
 * visit persisted over it, then the host's files over both, so that a
 * host's file is its current text, never an archive's entry or a copy the
 * cache kept (issue 11). */
export async function prepareDrive(
  archives: DriveArchives,
  files: readonly DriveFile[],
  database: IDBDatabase | null,
) {
  const fs = await layOutDrive(archives);
  await restoreCachedFiles(database, fs).catch((error) => {
    console.warn("Could not restore the persistent Agda cache", error);
  });
  for (const file of files) fsAssign(file.path, file.text, fs);
  return fs;
}

// ---- The persistent cache ---------------------------------------------

interface CachedFile {
  path: string;
  mode: "string" | "binary";
  content: string | Uint8Array;
  timestamps: { access: number; change: number; modification: number };
}

/** The drive's IndexedDB database for one set of assets, or null where the
 * worker has no IndexedDB or cannot open it: the drive is then not
 * cached, and works all the same. */
export function openCacheDatabase(namespace: string) {
  return new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(`${DRIVE_CACHE_PREFIX}${namespace}`, 1);
    } catch (error) {
      // A browser that does not allow storage may throw at once.
      console.warn("Persistent Agda cache is unavailable", error);
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("files")) {
        request.result.createObjectStore("files", { keyPath: "path" });
      }
    };
    request.onsuccess = () => {
      // A newer deploy's page deletes this database when its namespace is
      // stale (./drive-caches.ts); an open connection would block that.
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      console.warn("Persistent Agda cache is unavailable", request.error);
      resolve(null);
    };
  });
}

function cacheTransaction<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void) => void,
) {
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction("files", mode);
    transaction.onerror = () => reject(transaction.error);
    run(transaction.objectStore("files"), resolve);
  });
}

/** Restore what an earlier visit persisted into the first record, where
 * it replaces an archive's entry at the same path. */
export async function restoreCachedFiles(
  database: IDBDatabase | null,
  fs: Record<string, Runno.WASIFile>,
) {
  if (!database) return;
  const records = await cacheTransaction<CachedFile[]>(
    database,
    "readonly",
    (store, resolve) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as CachedFile[]);
    },
  );
  for (const record of records) {
    fs[record.path] = {
      path: record.path,
      mode: record.mode,
      content:
        record.mode === "binary"
          ? new Uint8Array(record.content as Uint8Array)
          : (record.content as string),
      timestamps: {
        access: new Date(record.timestamps.access),
        change: new Date(record.timestamps.change),
        modification: new Date(record.timestamps.modification),
      },
    } as Runno.WASIFile;
    lastTimestamp = Math.max(
      lastTimestamp,
      record.timestamps.change,
      record.timestamps.modification,
    );
  }
}

// do the normalization the dirty way
function removeTrailingDotDots(path: string) {
  let dotdotCount = 0;
  while (path.endsWith("/..")) {
    path = path.slice(0, -3);
    dotdotCount++;
  }

  if (path === "..") {
    return ".";
  }

  for (let i = 0; i < dotdotCount; i++) {
    const lastSlash = path.lastIndexOf("/", path.length - 4);
    if (lastSlash < 0) {
      return ".";
    }
    path = path.slice(0, lastSlash);
  }

  return path;
}

/** Index a WASI drive, normalize its paths, and mark the interfaces Agda
 * writes for the cache; return what the page asks of the drive. */
export function attachDrive(
  drive: Runno.WASI["drive"],
  database: IDBDatabase | null,
) {
  const driveIndex = indexDrive(drive);
  const dirtyCachePaths = new Set<string>();

  const origPathStat = drive.pathStat.bind(drive);
  drive.pathStat = (fdDir: number, path: string) =>
    origPathStat(fdDir, removeTrailingDotDots(path));

  const origDriveOpen = drive.open.bind(drive);
  drive.open = (fdDir: number, path: string, oflags: number, fdflags: number) =>
    origDriveOpen(fdDir, removeTrailingDotDots(path), oflags, fdflags);

  function cacheWrittenInterface(fd: number) {
    const openFile = drive.openMap.get(fd) as
      | { file?: Runno.WASIFile }
      | undefined;
    const file = openFile?.file;
    if (file?.path.endsWith(".agdai")) {
      const changed = nextTimestamp();
      file.timestamps.change = changed;
      file.timestamps.modification = changed;
      dirtyCachePaths.add(file.path);
    }
  }

  const origDriveWrite = drive.write.bind(drive);
  drive.write = (fd: number, data: Uint8Array) => {
    const result = origDriveWrite(fd, data);
    if (result === 0) cacheWrittenInterface(fd);
    return result;
  };

  const origDrivePwrite = drive.pwrite.bind(drive);
  drive.pwrite = (fd: number, data: Uint8Array, offset: number) => {
    const result = origDrivePwrite(fd, data, offset);
    if (result === 0) cacheWrittenInterface(fd);
    return result;
  };

  return {
    /** Write a file (the user's buffer, or any source) for Agda. */
    writeFile(path: string, content: Uint8Array) {
      const existing = drive.fs[path];
      if (existing) {
        if (replaceFileContent(existing, content)) dirtyCachePaths.add(path);
      } else {
        const [, entry] = createFileEntry(path, content);
        drive.fs[path] = entry;
        driveIndex.sync(path);
        dirtyCachePaths.add(path);
      }
    },

    /** A file's text as it was written, or undefined.  A byte order mark
     * is kept, as node's reading keeps it: the session compares this text
     * with the one it sent, and Agda counts the mark as a position. */
    readFile(path: string): string | undefined {
      const file = drive.fs[path];
      if (!file) return undefined;
      return typeof file.content === "string"
        ? file.content
        : new TextDecoder("utf-8", { ignoreBOM: true }).decode(file.content);
    },

    /** Extract a zip at the root (interface archives, more libraries).
     * Its files are the archive's, which the host keeps (issue 14): none
     * is persisted in the drive's cache, and a copy the cache holds at one
     * of their paths (an interface an earlier check wrote) is deleted, so
     * that it is neither restored again nor stored twice. */
    async mountArchive(data: ArrayBuffer) {
      const paths = await extractZip(data, "/", drive.fs);
      paths.forEach(driveIndex.sync);
      for (const path of paths) dirtyCachePaths.delete(path);
      if (database)
        await cacheTransaction<void>(database, "readwrite", (store, resolve) => {
          for (const path of paths) store.delete(path);
          store.transaction.oncomplete = () => resolve();
        }).catch((error) => console.warn("Could not drop the cache's copies of an archive's files", error));
    },

    /** Which of these paths the drive holds. */
    present(paths: string[]) {
      return paths.filter((path) => Object.hasOwn(drive.fs, path));
    },

    /** Persist the sources written and the interfaces Agda wrote. */
    async persist() {
      if (!database || dirtyCachePaths.size === 0) return;
      const records: CachedFile[] = [...dirtyCachePaths].flatMap((path) => {
        const file = drive.fs[path];
        if (!file) return [];
        return [
          {
            path,
            mode: file.mode,
            content:
              file.mode === "binary"
                ? new Uint8Array(file.content as Uint8Array)
                : file.content,
            timestamps: {
              access: file.timestamps.access.getTime(),
              change: file.timestamps.change.getTime(),
              modification: file.timestamps.modification.getTime(),
            },
          } as CachedFile,
        ];
      });
      await cacheTransaction<void>(database, "readwrite", (store, resolve) => {
        for (const record of records) store.put(record);
        store.transaction.oncomplete = () => resolve();
      });
      for (const record of records) dirtyCachePaths.delete(record.path);
    },
  };
}
