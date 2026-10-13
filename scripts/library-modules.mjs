// File: scripts/library-modules.mjs
//
// The list of a library's modules, which the Explorer shows as a tree
// (issue 9), written from the library's sources archive when the site's
// assets are built: each module's dotted name, its path on the page's
// drive, and the title its front matter gives, in the Explorer's order.
// The flake writes agda-algebras' list from agda-algebras-sources.zip
// (mkAgdaAlgebrasModules), and `make assets-check` writes it again from the
// archive in static/ and refuses a list that differs, so the list the site
// ships names exactly the modules the archive holds.
//
// The archive is read here, with node's zlib alone (it is a plain zip,
// deflated, as `zip -X -D` writes it), so the flake needs no unzip and the
// assets check no npm package.  A module is a source, by the engine's
// suffixes (packages/engine/src/core/paths.ts), under a directory the
// library's `.agda-lib` includes; its drive path is its path in the
// archive, which the page extracts at the drive's root.  The order is the
// one @agda-native-ide/manifest checks: by name segment, case aside first,
// then by code point, so a module comes before the modules under its name
// and `agda-algebras` before `Classical`.
//
//   node scripts/library-modules.mjs SOURCES.zip [--commit REV] > LIST.json
//   node scripts/library-modules.mjs --check SOURCES.zip LIST.json

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";

/** The engine's source suffixes, longest first (paths.ts). */
const SUFFIXES = [".lagda.md", ".lagda.tex", ".lagda.rst", ".lagda.org", ".lagda.typ", ".lagda", ".agda"];

/**
 * The files of a zip archive, by path: stored or deflated entries, with no
 * Zip64 record and no encryption, which is what `zip -X -D` writes for an
 * archive of this size.  Anything else is refused.
 * @param {Buffer} zip
 * @returns {Map<string, Buffer>}
 */
export function readZip(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > zip.length) throw new Error("not a zip archive: no end of central directory");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error("a Zip64 archive, which this reader does not read");
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`entry ${i}: not a central directory record`);
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error(`${name}: encrypted`);
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name}: no local header`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    const bytes = method === 0 ? data : method === 8 ? inflateRawSync(data) : null;
    if (bytes === null) throw new Error(`${name}: compression method ${method}, neither stored nor deflated`);
    if (bytes.length !== size || crc32(bytes) !== crc) throw new Error(`${name}: not the bytes the archive's directory describes`);
    files.set(name, bytes);
  }
  return files;
}

/** The fields of an `.agda-lib` file, each as its words.
 * @param {string} text */
function agdaLib(text) {
  /** @type {Record<string, string[]>} */
  const fields = {};
  let key = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/--.*$/, "");
    const field = line.match(/^([A-Za-z-]+)\s*:(.*)$/);
    if (field) {
      key = field[1];
      fields[key] = field[2].trim().split(/\s+/).filter(Boolean);
    } else if (key && /^\s/.test(line)) fields[key].push(...line.trim().split(/\s+/).filter(Boolean));
  }
  return fields;
}

/**
 * The `title` of a module's front matter (a YAML block opening its first
 * line, as agda-algebras writes `title:` or `title :`), or undefined.
 * @param {string} text
 */
export function frontMatterTitle(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  for (const line of lines.slice(1)) {
    if (line === "---" || line === "...") return undefined;
    const title = line.match(/^title\s*:\s*(.*?)\s*$/);
    if (!title) continue;
    const value = title[1];
    let parsed = value;
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      parsed = value.slice(1, -1).replaceAll("''", "'");
    return parsed.trim() || undefined;
  }
  return undefined;
}

/** The Explorer's order of two dotted names: segment by segment, case
 * aside first and then by code point; a name before the names under it.
 * @param {string} left @param {string} right */
export function compareModuleNames(left, right) {
  const a = left.split(".");
  const b = right.split(".");
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareCodePoints(a[i].toLowerCase(), b[i].toLowerCase()) || compareCodePoints(a[i], b[i]);
    if (order) return order;
  }
  return a.length - b.length;
}

/** @param {string} a @param {string} b */
const compareCodePoints = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The module list of a sources archive: the library its one `.agda-lib`
 * names, the directories it includes (drive paths), and every source
 * under them, with its title.
 * @param {Map<string, Buffer>} files
 * @param {{ commit?: string }} [options]
 */
export function moduleList(files, { commit } = {}) {
  const libs = [...files.keys()].filter((path) => path.endsWith(".agda-lib"));
  if (libs.length !== 1) throw new Error(`the archive holds ${libs.length} .agda-lib files, not one`);
  const libPath = libs[0];
  const lib = agdaLib(files.get(libPath)?.toString("utf8") ?? "");
  const library = lib.name?.[0];
  if (!library) throw new Error(`${libPath} names no library`);
  const base = libPath.split("/").slice(0, -1);
  // Each included directory as a prefix of archive paths: "" for the
  // archive's root, else the directory and a slash.
  const include = (lib.include ?? ["."]).map((dir) => {
    const segments = [...base, ...dir.split("/")].filter((segment) => segment !== "" && segment !== ".");
    return segments.length ? `${segments.join("/")}/` : "";
  });
  const modules = [];
  for (const [path, bytes] of files) {
    const suffix = SUFFIXES.find((candidate) => path.endsWith(candidate));
    const dir = include.find((prefix) => path.startsWith(prefix));
    if (!suffix || dir === undefined) continue;
    const name = path.slice(dir.length, -suffix.length).split("/").join(".");
    const title = frontMatterTitle(bytes.toString("utf8"));
    modules.push({ name, path: `/${path}`, ...(title ? { title } : {}) });
  }
  modules.sort((left, right) => compareModuleNames(left.name, right.name));
  return {
    version: 1,
    library,
    ...(commit ? { commit } : {}),
    include: include.map((prefix) => `/${prefix.replace(/\/$/, "")}`),
    modules,
  };
}

/** The list as the site ships it: one line of JSON. @param {object} list */
export const serialize = (list) => `${JSON.stringify(list)}\n`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { commit: { type: "string" }, check: { type: "boolean", default: false } },
  });
  try {
    if (values.check) {
      if (positionals.length !== 2) throw new Error("usage: library-modules.mjs --check SOURCES.zip LIST.json");
      const [zip, listPath] = positionals;
      const shipped = readFileSync(listPath, "utf8");
      const commit = JSON.parse(shipped).commit;
      const fresh = moduleList(readZip(readFileSync(zip)), { commit });
      if (serialize(fresh) !== shipped) {
        const old = JSON.parse(shipped).modules ?? [];
        const index = fresh.modules.findIndex((entry, i) => JSON.stringify(entry) !== JSON.stringify(old[i]));
        const where = index < 0 ? `the list's header, or its length (${old.length})` : `entry ${index}, ${fresh.modules[index].name}`;
        throw new Error(`${listPath} is not the module list of ${zip}: it differs at ${where}; run make assets`);
      }
      console.log(`library-modules: ${listPath} lists the ${fresh.modules.length} modules of ${zip}`);
    } else {
      if (positionals.length !== 1) throw new Error("usage: library-modules.mjs SOURCES.zip [--commit REV]");
      process.stdout.write(serialize(moduleList(readZip(readFileSync(positionals[0])), { commit: values.commit })));
    }
  } catch (error) {
    console.error(`library-modules: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
