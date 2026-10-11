/// <reference types="vitest/globals" />
// File: packages/engine/src/browser/worker/drive-index.test.ts
//
// The drive index changes no answer (issue 50): two Runno drives over the
// same files, one plain and one indexed, are given the same random
// sequences of the calls Agda makes and the writes the drive worker makes
// itself, and must agree on every result, every error and every key; and
// the indexed drive's root never runs Runno's per-key scans.

import * as Runno from "@runno/wasi";
import { indexDrive, type DriveIndex } from "./drive-index.js";

const { OpenFlags } = Runno.WASISnapshotPreview1;
type Drive = Runno.WASI["drive"];

/** A small fast generator, seeded, so a failure can be replayed. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const file = (path: string, content = "x"): Runno.WASIFile => ({
  path,
  mode: "string",
  content,
  timestamps: {
    access: new Date(0),
    modification: new Date(0),
    change: new Date(0),
  },
});

// Few names, so that paths collide, nest and share prefixes; with the
// characters a regular expression would read, "." and "..", and empty
// segments, since the scans compare strings and nothing else.
const NAMES = ["a", "b", "ab", "a.b", "x+y", "(c)", ".", "..", ""];

function makeOps(next: () => number) {
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(next() * items.length)];
  const path = () => {
    const segments = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
      pick(NAMES),
    );
    const joined = segments.join("/");
    return next() < 0.1 ? `${joined}/` : joined;
  };
  // Mostly keys as the drive writes them; a few without the leading "/",
  // or with two, which the scans also compare.
  const key = () => pick(["/", "/", "/", "/", "", "//"]) + path();
  return { pick, path, key };
}

function initialFiles(next: () => number) {
  const { key } = makeOps(next);
  const fs: Record<string, Runno.WASIFile> = {};
  for (let i = 0; i < 1 + Math.floor(next() * 25); i++) {
    const k = key();
    fs[k] = file(k, `file ${i}`);
  }
  return fs;
}

const clone = (fs: Record<string, Runno.WASIFile>) =>
  Object.fromEntries(
    Object.entries(fs).map(([k, f]) => [k, file(f.path, f.content as string)]),
  );

/** A result with the times a call made up (Runno stamps a directory's stat
 * and a new file with the clock) replaced, so two drives can be compared. */
function normalize(value: unknown): unknown {
  if (value instanceof Date) return "date";
  if (value instanceof Uint8Array) return [...value];
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v)]),
    );
  return value;
}

function attempt(call: () => unknown) {
  try {
    return { result: normalize(call()) };
  } catch (error) {
    return { threw: String(error) };
  }
}

function snapshot(drive: Drive) {
  return Object.keys(drive.fs).map((k) => [
    k,
    drive.fs[k].path,
    normalize(drive.fs[k].content),
  ]);
}

function runSequence(seed: number, steps: number) {
  const next = random(seed);
  const { pick, path, key } = makeOps(next);
  const files = initialFiles(next);
  const plain = new Runno.WASI({ fs: clone(files) }).drive;
  const indexedDrive = new Runno.WASI({ fs: clone(files) }).drive;
  const indexed: DriveIndex = indexDrive(indexedDrive);

  for (let step = 0; step < steps; step++) {
    const fds = [3, ...plain.openMap.keys(), 99];
    const fd = pick(fds);
    const p = path();
    const op = pick([
      "pathStat",
      "pathStat",
      "pathStat",
      "open",
      "open",
      "close",
      "unlink",
      "rename",
      "pathCreateDir",
      "list",
      "write",
      "assign",
    ]);
    let call: (drive: Drive) => unknown;
    switch (op) {
      case "open": {
        const flags = [
          OpenFlags.CREAT,
          OpenFlags.DIRECTORY,
          OpenFlags.EXCL,
          OpenFlags.TRUNC,
        ].reduce((all, flag) => (next() < 0.3 ? all | flag : all), 0);
        call = (drive) => drive.open(fd, p, flags, 0);
        break;
      }
      case "rename": {
        const fd2 = pick(fds);
        const p2 = path();
        call = (drive) => drive.rename(fd, p, fd2, p2);
        break;
      }
      case "write": {
        const bytes = new Uint8Array([1 + Math.floor(next() * 200)]);
        call = (drive) => [drive.write(fd, bytes), drive.close(fd)];
        break;
      }
      case "assign": {
        // The drive worker's own writes (its message types 3 and 4).
        const k = key();
        call = (drive) => {
          drive.fs[k] = file(k, "written");
          if (drive === indexedDrive) indexed.sync(k);
        };
        break;
      }
      case "close":
      case "list":
        call = (drive) => (drive as any)[op](fd);
        break;
      default:
        call = (drive) => (drive as any)[op](fd, p);
    }
    const expected = attempt(() => call(plain));
    const actual = attempt(() => call(indexedDrive));
    const where = `seed ${seed}, step ${step}: ${op}(${fd}, ${JSON.stringify(p)})`;
    expect(actual, where).toEqual(expected);
    expect(snapshot(indexedDrive), where).toEqual(snapshot(plain));
    expect([...indexed.index.keys].sort(), where).toEqual(
      Object.keys(indexedDrive.fs).sort(),
    );
  }
}

// The 300 sequences take about 4.6 s on a 20-core workstation, near
// vitest's default limit of 5 s, which a loaded machine exceeds; the limit
// is not what the test checks.
test("an indexed drive answers every call as the plain drive does", () => {
  for (let seed = 1; seed <= 300; seed++) runSequence(seed, 150);
}, 60_000);

test("on the drive's own layout, the root never scans its keys", () => {
  const layout = [
    "/Main.agda",
    "/plfa.agda-lib",
    "/lib/prim/agda-builtins.agda-lib",
    "/lib/prim/Agda/Builtin/Nat.agda",
    "/lib/prim/_build/2.8.0/agda/Agda/Builtin/Nat.agdai",
    "/stdlib/standard-library.agda-lib",
    "/stdlib/src/Data/Nat/Base.agda",
    "/home/root/.config/agda/libraries",
  ];
  const drive = new Runno.WASI({
    fs: Object.fromEntries(layout.map((k) => [k, file(k)])),
  }).drive;
  indexDrive(drive);
  const root = Object.getPrototypeOf(drive.openMap.get(3));
  const scans = ["containsFile", "containsDirectory", "contains"].map((name) =>
    vi.spyOn(root, name as "containsFile"),
  );

  expect(drive.pathStat(3, "stdlib/src/Data/Nat/Base.agda")[0]).toBe(0);
  expect(drive.pathStat(3, "stdlib/src/Data/Nat")[1]?.path).toBe(
    "/stdlib/src/Data/Nat/",
  );
  expect(drive.pathStat(3, "stdlib/src/Data/Nat/Base.lagda.md")[0]).toBe(76);
  const [opened, fd] = drive.open(3, "_build/2.8.0/agda/Main.agdai", 1, 0);
  expect(opened).toBe(0);
  expect(drive.close(fd!)).toBe(0);
  expect(drive.pathStat(3, "_build/2.8.0/agda/Main.agdai")[0]).toBe(0);
  expect(drive.pathCreateDir(3, "MAlonzo")).toBe(0);
  expect(drive.rename(3, "MAlonzo", 3, "JS")).toBe(0);
  expect(drive.unlink(3, "JS")).toBe(0);
  expect(drive.pathStat(3, "JS")[0]).toBe(76);

  for (const scan of scans) expect(scan).not.toHaveBeenCalled();
});
