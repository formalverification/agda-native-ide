// File: scripts/asset-manifest.mjs
//
// What the page needs to know about the files it fetches, derived from
// the files themselves when the site is built, where upstream maintained
// each value by hand (issue 3): a cache token for every URL that carries
// one, the compiler's length in bytes, and the namespace of the drive's
// IndexedDB cache.  vite.config.js hands the result to the page as
// AGDA_ASSETS, and src/lib/assets.ts reads it.
//
// A token is the first 16 hex digits of a SHA-256 over a file's bytes or,
// for a directory, over the SHA-256s and paths of its files, so a rebuilt
// asset gets a new URL and is never served stale from a cache.  The
// namespace is the same digest over everything Agda reads (the compiler,
// the builtins, the standard library and PLFA), so files persisted against
// one set of assets are never restored against another.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The assets the page fetches with a cache token, relative to static/.
 * The compiler's gzip, which the build writes beside it
 * (scripts/prepare-cloudflare-assets.mjs), shares the compiler's token,
 * since it changes exactly when the compiler does. */
export const ASSETS = {
  compiler: "als-2.8ext.wasm",
  builtins: "agda-data.zip",
  stdlib: "agda-stdlib-2.3.zip",
  plfaProject: "plfa/project.zip",
  plfaInterfaces: "plfa/interfaces",
};

const sha256 = (/** @type {string | Buffer} */ data) =>
  createHash("sha256").update(data).digest("hex");

/** Every file under `dir`, as paths relative to it, in a fixed order.
 * @param {string} dir
 * @returns {string[]} */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => statSync(join(dir, path)).isFile())
    .map((path) => path.split("\\").join("/"))
    .sort();
}

/** The SHA-256 of a file's bytes, or of the sha256sum-style listing of a
 * directory's files.
 * @param {string} path */
function digest(path) {
  if (!statSync(path).isDirectory()) return sha256(readFileSync(path));
  return sha256(
    filesUnder(path)
      .map((file) => `${sha256(readFileSync(join(path, file)))}  ${file}\n`)
      .join(""),
  );
}

/**
 * @typedef {object} AssetManifest
 * @property {Record<keyof typeof ASSETS, string>} tokens
 * @property {number | null} compilerBytes
 * @property {string} driveCacheNamespace
 */

/** PLFA's interface manifest and the archives it names, relative to
 * static/, which the page fetches when a chapter opens: the directory is
 * complete only with all of them, not with any one file in it.
 * @param {string} staticDir */
function plfaInterfaceFiles(staticDir) {
  const manifest = `${ASSETS.plfaInterfaces}/manifest.json`;
  const index = join(staticDir, manifest);
  if (!existsSync(index)) return [manifest];
  const { chapters = {} } = JSON.parse(readFileSync(index, "utf8"));
  return [
    manifest,
    ...[...new Set(Object.values(chapters).flat())].map(
      (archive) => `${ASSETS.plfaInterfaces}/${archive}.zip`,
    ),
  ];
}

/**
 * The manifest of the assets under `staticDir`.  With `strict` (the
 * build), a missing asset, or a missing PLFA interface manifest or archive
 * it names, is an error; without it (the dev server, the unit tests
 * and the type check, which can run before `make assets`), a missing
 * asset's token is "missing" and the compiler's length null.
 * @param {string} staticDir
 * @param {{ strict?: boolean }} [options]
 * @returns {AssetManifest}
 */
export function assetManifest(staticDir, { strict = true } = {}) {
  const isAbsent = (/** @type {string} */ path) =>
    !existsSync(join(staticDir, path));
  const missing = Object.values(ASSETS).filter(isAbsent);
  if (strict) {
    const absent = [
      ...missing,
      ...plfaInterfaceFiles(staticDir).filter(isAbsent),
    ];
    if (absent.length)
      throw new Error(
        `missing from ${staticDir}: ${absent.join(", ")} (run \`make assets\`)`,
      );
  }

  /** @type {[keyof typeof ASSETS, string | null][]} */
  const digests = Object.entries(ASSETS).map(([name, path]) => [
    /** @type {keyof typeof ASSETS} */ (name),
    missing.includes(path) ? null : digest(join(staticDir, path)),
  ]);
  const compiler = join(staticDir, ASSETS.compiler);

  return {
    tokens: /** @type {Record<keyof typeof ASSETS, string>} */ (
      Object.fromEntries(
        digests.map(([name, hex]) => [name, hex?.slice(0, 16) ?? "missing"]),
      )
    ),
    compilerBytes: existsSync(compiler) ? statSync(compiler).size : null,
    driveCacheNamespace: sha256(
      digests
        .map(([name, hex]) => `${hex ?? "missing"}  ${ASSETS[name]}\n`)
        .join(""),
    ).slice(0, 16),
  };
}
