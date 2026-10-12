// File: packages/engine/src/browser/worker/drive-index.ts
//
// An index of the in-memory drive's paths (issue 50).  Runno's drive is a
// flat record from absolute path to file, and its root directory answers
// each membership test (is this path a file, is it a directory) by
// scanning every key on the drive and building a regular expression for
// each one.  A lookup therefore costs time in proportion to the number of
// files on the drive, and Agda makes about 130 of them per imported module.
// The index answers those tests from the drive's keys, counted by the
// paths and directories they name, and keeps itself in step with every
// method that adds or removes a key.
//
// It changes no answer.  Runno's own methods still compute every result;
// only the root directory's three scans (containsFile, containsDirectory
// and contains) are replaced, by lookups that agree with them on every
// path and every state of the drive (drive-index.test.ts runs both side by
// side).  It knows the drive through its record of files, its table of
// open descriptors and the methods it wraps, so that it can move with the
// drive (issue 59) or come to sit over another store.  It moved with the
// drive into the engine package's browser transport (issue 62).

import * as Runno from "@runno/wasi";

const { Result } = Runno.WASISnapshotPreview1;

type Drive = Runno.WASI["drive"];
type Files = Record<string, Runno.WASIFile>;
type DriveStat = Extract<ReturnType<Drive["pathStat"]>, { length: 2 }>[1];

/** A directory descriptor as Runno opens one: a record of files, and the
 * prefix its paths are relative to ("/" for the whole drive). */
interface OpenDirectory {
  dir: Files;
  prefix: string;
  containsFile(path: string): boolean;
  containsDirectory(path: string): boolean;
  contains(path: string): boolean;
  fullPath(path: string): string;
  stat(): DriveStat;
}

/** The drive's keys, and what the root directory's scans read from them.
 * The root compares a path with each key less one leading "/": it is a
 * file when some key names it, and a directory when some key names a path
 * below it, that is, when it is the part of a key before one of the key's
 * slashes.  Both are counted, since two keys can name one path ("a" and
 * "/a") and one key names every directory above it. */
export class PathIndex {
  readonly keys = new Set<string>();
  private readonly files = new Map<string, number>();
  private readonly directories = new Map<string, number>();

  /** Bring the index in step with `fs` at `key`, whether the key was
   * added, removed or left alone. */
  sync(fs: Files, key: string) {
    const present = Object.prototype.hasOwnProperty.call(fs, key);
    if (present === this.keys.has(key)) return;
    if (present) this.keys.add(key);
    else this.keys.delete(key);
    const step = present ? 1 : -1;
    const path = relative(key);
    count(this.files, path, step);
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1))
      count(this.directories, path.slice(0, at), step);
  }

  /** The root's containsFile: some key names `path`. */
  hasFile(path: string) {
    return this.files.has(path);
  }

  /** The root's containsDirectory: some key names a path below `path`. */
  hasDirectory(path: string) {
    return this.directories.has(path);
  }

  /** The root's contains: `path` is a file or a directory. */
  contains(path: string) {
    return this.hasFile(path) || this.hasDirectory(path);
  }
}

/** A key's path as the root reads it, with one leading "/" removed. */
function relative(key: string) {
  return key.startsWith("/") ? key.slice(1) : key;
}

function count(counts: Map<string, number>, key: string, step: number) {
  const n = (counts.get(key) ?? 0) + step;
  if (n === 0) counts.delete(key);
  else counts.set(key, n);
}

export interface DriveIndex {
  index: PathIndex;
  /** Bring the index in step with the drive at `key`, after the drive's
   * owner wrote it directly (in place of a WASI call). */
  sync(key: string): void;
}

/** Index `drive`: answer its root directory's scans from the index, and
 * those of any directory it opens later over the whole drive, and wrap
 * the methods that add or remove keys so that the index follows them.
 * Call it once the drive is constructed (Runno copies the record it is
 * given), and before anything else wraps these methods. */
export function indexDrive(drive: Drive): DriveIndex {
  const fs = drive.fs;
  const index = new PathIndex();
  for (const key of Object.keys(fs)) index.sync(fs, key);
  const sync = (key: string) => index.sync(fs, key);

  // Runno's constructor opens the root as descriptor 3, an instance of the
  // class it checks every directory descriptor against.
  const root = drive.openMap.get(3) as unknown as OpenDirectory | undefined;
  if (root === undefined || root.dir !== fs || root.prefix !== "/")
    throw new Error("the drive's descriptor 3 is not its root directory");
  const OpenDirectory = root.constructor as new (
    dir: Files,
    prefix: string,
  ) => OpenDirectory;

  const directoryAt = (fd: number) => {
    const entry: unknown = drive.openMap.get(fd);
    return entry instanceof OpenDirectory ? entry : undefined;
  };
  const coversDrive = (directory?: OpenDirectory) =>
    directory !== undefined && directory.dir === fs && directory.prefix === "/";
  const answerFromIndex = (directory: OpenDirectory) => {
    directory.containsFile = (path) => index.hasFile(path);
    directory.containsDirectory = (path) => index.hasDirectory(path);
    directory.contains = (path) => index.contains(path);
  };
  answerFromIndex(root);

  // A directory's stat reads only its prefix, but Runno first filters the
  // whole drive into the record it gives the directory; skip the filter.
  const pathStat = drive.pathStat.bind(drive);
  drive.pathStat = (fd, path) => {
    if (
      coversDrive(directoryAt(fd)) &&
      !index.hasFile(path) &&
      (path === "." || index.hasDirectory(path))
    ) {
      const prefix = path === "." ? "/" : `/${path}/`;
      return [Result.SUCCESS, new OpenDirectory({}, prefix).stat()];
    }
    return pathStat(fd, path);
  };

  // O_CREAT adds the file's key; opening "." opens the whole drive again.
  const open = drive.open.bind(drive);
  drive.open = (fd, path, oflags, fdflags) => {
    const directory = directoryAt(fd);
    const result = open(fd, path, oflags, fdflags);
    if (directory) sync(directory.fullPath(path));
    if (result[0] === Result.SUCCESS) {
      const opened = directoryAt(result[1]);
      if (opened && coversDrive(opened)) answerFromIndex(opened);
    }
    return result;
  };

  // A new directory is a placeholder file in it.
  const pathCreateDir = drive.pathCreateDir.bind(drive);
  drive.pathCreateDir = (fd, path) => {
    const directory = directoryAt(fd);
    const result = pathCreateDir(fd, path);
    if (directory) sync(`${directory.fullPath(path)}/.runno`);
    return result;
  };

  // Runno removes the key and every key below it; only a directory has
  // keys below it, so only a directory's removal is looked for in them.
  const unlink = drive.unlink.bind(drive);
  drive.unlink = (fd, path) => {
    const target = directoryAt(fd)?.fullPath(path);
    const touched =
      target === undefined
        ? []
        : index.hasDirectory(relative(target))
          ? [...index.keys].filter(
              (key) => key === target || key.startsWith(`${target}/`),
            )
          : [target];
    const result = unlink(fd, path);
    touched.forEach(sync);
    return result;
  };

  // Runno moves every key that starts with the old path, with or without a
  // "/" after it, to the key with the new path in its place.
  const rename = drive.rename.bind(drive);
  drive.rename = (fd, path, newFd, newPath) => {
    const from = directoryAt(fd)?.fullPath(path);
    const to = directoryAt(newFd)?.fullPath(newPath);
    const touched =
      from === undefined || to === undefined
        ? []
        : [...index.keys]
            .filter((key) => key.startsWith(from))
            .flatMap((key) => [key, key.replace(from, to)]);
    const result = rename(fd, path, newFd, newPath);
    touched.forEach(sync);
    return result;
  };

  return { index, sync };
}
