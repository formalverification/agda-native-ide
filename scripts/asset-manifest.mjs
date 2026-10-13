// File: scripts/asset-manifest.mjs
//
// What the page needs to know about the files it fetches, derived from
// the files themselves when the site is built, where upstream maintained
// each value by hand (issue 3): a cache token for every URL that carries
// one, the compiler's length in bytes, and the namespace of the drive's
// IndexedDB cache.  vite.config.js hands the result to the page as
// AGDA_ASSETS, and src/lib/assets.ts reads it.  The compiler is the
// language server's reactor build, with the JavaScript glue its worker
// imports (issue 59).  agda-algebras' sources are a library on the drive,
// which the playground's project depends on (issue 11); the list of its
// modules is what the Explorer shows (issue 9); and its archive index names
// the interface archives the page mounts as a check's imports need them
// (issue 14): the page reads its bytes and digest, and those of the
// sources, from `files`, for the library's description.
//
// A token is the first 16 hex digits of a SHA-256 over a file's bytes or,
// for a directory, over the SHA-256s and paths of its files, so a rebuilt
// asset gets a new URL and is never served stale from a cache.  The
// namespace is the same digest over everything Agda reads (the compiler
// and its glue, the builtins, the standard library, agda-algebras' sources
// and its archive index, and PLFA), so files persisted against one set of
// assets are never restored against another; the list of modules, which
// Agda does not read, is left out of it.  The index carries every
// archive's SHA-256, so its digest stands for the archives too; the build
// refuses an archive whose bytes are not the index's.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The assets the page fetches with a cache token, relative to static/.
 * The compiler's gzip, which the build writes beside it
 * (scripts/prepare-cloudflare-assets.mjs), shares the compiler's token,
 * since it changes exactly when the compiler does. */
export const ASSETS = {
  compiler: "als-reactor-2.9.0.wasm",
  glue: "als-reactor-2.9.0.js",
  builtins: "agda-data.zip",
  stdlib: "agda-stdlib-2.3-patched.zip",
  agdaAlgebras: "agda-algebras-sources.zip",
  agdaAlgebrasModules: "agda-algebras-modules.json",
  agdaAlgebrasIndex: "agda-algebras/index.json",
  plfaProject: "plfa/project.zip",
  plfaInterfaces: "plfa/interfaces",
};

/** The assets Agda does not read, which the drive's cache namespace
 * leaves out: a new list of modules is no reason to drop a reader's
 * drive. */
const NOT_READ_BY_AGDA = new Set(["agdaAlgebrasModules"]);

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
 * @property {Partial<Record<keyof typeof ASSETS, { bytes: number, sha256: string }>>} files
 *   each asset that is a file, by its length and its full SHA-256
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

/** The files agda-algebras' index names, relative to static/, with the
 * SHA-256 it gives each: its interface archives, under the index's
 * directory, and the sources it was built from (the builtins, the
 * standard library and agda-algebras' own), which the site ships at its
 * root.  None if there is no index.
 * @param {string} staticDir
 * @returns {{ archives: { path: string, sha256: string }[],
 *   sources: { path: string, sha256: string }[] }} */
function libraryIndexFiles(staticDir) {
  const index = join(staticDir, ASSETS.agdaAlgebrasIndex);
  if (!existsSync(index)) return { archives: [], sources: [] };
  const base = ASSETS.agdaAlgebrasIndex.replace(/[^/]*$/, "");
  const { archives = {}, libraries = {} } = JSON.parse(readFileSync(index, "utf8"));
  return {
    archives: Object.entries(archives).map(([path, archive]) => ({
      path: `${base}${path}`,
      sha256: /** @type {{ sha256: string }} */ (archive).sha256,
    })),
    sources: Object.values(libraries).flatMap((library) => {
      const sources = /** @type {{ sources?: { path: string, sha256: string } }} */ (library).sources;
      return sources ? [{ path: sources.path, sha256: sources.sha256 }] : [];
    }),
  };
}

/**
 * The manifest of the assets under `staticDir`.  With `strict` (the
 * build), a missing asset, a missing PLFA interface manifest or archive it
 * names, or an interface archive agda-algebras' index names that is
 * missing or whose bytes are not the index's, is an error; without it
 * (the dev server, the unit tests and the type check, which can run
 * before `make assets`), a missing asset's token is "missing" and the
 * compiler's length null.
 * @param {string} staticDir
 * @param {{ strict?: boolean }} [options]
 * @returns {AssetManifest}
 */
export function assetManifest(staticDir, { strict = true } = {}) {
  const isAbsent = (/** @type {string} */ path) =>
    !existsSync(join(staticDir, path));
  const missing = Object.values(ASSETS).filter(isAbsent);
  if (strict) {
    const { archives, sources } = libraryIndexFiles(staticDir);
    const absent = [
      ...missing,
      ...plfaInterfaceFiles(staticDir).filter(isAbsent),
      ...[...archives, ...sources].map(({ path }) => path).filter(isAbsent),
    ];
    if (absent.length)
      throw new Error(
        `missing from ${staticDir}: ${absent.join(", ")} (run \`make assets\`)`,
      );
    const changed = (/** @type {{ path: string, sha256: string }[]} */ files) =>
      files.filter(({ path, sha256: expected }) => digest(join(staticDir, path)) !== expected).map(({ path }) => path);
    // An archive whose bytes are not the index's would be refused in the
    // reader's tab; an index built from other sources than the site ships
    // would have every archive's interfaces checked again, without a word.
    const otherArchives = changed(archives);
    if (otherArchives.length)
      throw new Error(
        `not the archives ${ASSETS.agdaAlgebrasIndex} names, in ${staticDir}: ${otherArchives.join(", ")} (run \`make assets\`)`,
      );
    const otherSources = changed(sources);
    if (otherSources.length)
      throw new Error(
        `${ASSETS.agdaAlgebrasIndex} was built from other sources than ${staticDir} has: ${otherSources.join(", ")} (run \`make assets\`)`,
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
    files: Object.fromEntries(
      digests.flatMap(([name, hex]) => {
        const path = join(staticDir, ASSETS[name]);
        return hex !== null && statSync(path).isFile()
          ? [[name, { bytes: statSync(path).size, sha256: hex }]]
          : [];
      }),
    ),
    driveCacheNamespace: sha256(
      digests
        .filter(([name]) => !NOT_READ_BY_AGDA.has(name))
        .map(([name, hex]) => `${hex ?? "missing"}  ${ASSETS[name]}\n`)
        .join(""),
    ).slice(0, 16),
  };
}
