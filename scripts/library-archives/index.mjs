// File: scripts/library-archives/index.mjs
//
// Reading agda-algebras' archive index (issue 12; its schema is in
// docs/notes/library-archives.md): which archives a set of imports needs,
// and a summary of the sizes.  check.sh uses it to stage each root from the
// archives the index names, so the check proves the index, not a guess;
// the page's mount (issue 14) is to compute the same thing.
//
//   node index.mjs needs INDEX ROOT...   the archives the roots' closure
//                                        needs, one per line
//   node index.mjs each INDEX [ROOT...]  for each root (default: every
//                                        root of the index), a line: the
//                                        root, its closure's modules, the
//                                        bytes of its archives, and them
//   node index.mjs summary INDEX         the sizes, as Markdown

import { readFileSync } from "node:fs";

/**
 * @typedef {object} Module
 * @property {string} library
 * @property {string} source       its path on the drive
 * @property {string} interface    its interface's path on the drive
 * @property {number} bytes        its interface's size
 * @property {string | null} archive  the archive holding its interface, or
 *   null for a builtin, whose interface is in agda-data.zip, on the drive
 *   from the start
 * @property {string[]} deps       Agda's dependency graph, transitively
 *   reduced: everything reachable along deps is the module's closure, but
 *   deps alone are not its imports
 *
 * @typedef {object} Archive
 * @property {number} bytes
 * @property {string} sha256
 * @property {number} modules
 *
 * @typedef {object} Index
 * @property {number} schema
 * @property {{ version: string, wasm: string }} agda
 * @property {Record<string, any>} libraries
 * @property {string[]} roots
 * @property {Record<string, Archive>} archives
 * @property {Record<string, Module>} modules
 */

/** @param {string} path @returns {Index} */
export function readIndex(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Every module the given modules reach, themselves included.
 * @param {Index} index @param {string[]} roots */
export function closure(index, roots) {
  const seen = new Set();
  const todo = [...roots];
  while (todo.length) {
    const name = /** @type {string} */ (todo.pop());
    if (seen.has(name)) continue;
    const module = index.modules[name];
    if (!module) throw new Error(`not in the index: ${name}`);
    seen.add(name);
    todo.push(...module.deps);
  }
  return seen;
}

/** The archives a set of imports needs, sorted, with what they hold: the
 * closure's interfaces (the floor) and the archives' own bytes.
 * @param {Index} index @param {string[]} roots */
export function needs(index, roots) {
  const modules = closure(index, roots);
  const archives = new Set();
  let floor = 0;
  for (const name of modules) {
    const { archive, bytes } = index.modules[name];
    if (archive === null) continue;
    archives.add(archive);
    floor += bytes;
  }
  const sorted = [...archives].sort();
  return {
    modules: modules.size,
    archives: sorted,
    bytes: sorted.reduce((sum, path) => sum + index.archives[path].bytes, 0),
    floor,
  };
}

const n = (/** @type {number} */ x) => x.toLocaleString("en-US");

/** The roots a summary always reports: two light imports and the heavy one
 * the benchmarks use (issue 18), and the three together. */
export const FIXED_ROOTS = [
  ["Overture.Basic"],
  ["Setoid.Algebras.Basic"],
  ["Setoid.Varieties.HSP"],
  ["Overture.Basic", "Setoid.Algebras.Basic", "Setoid.Varieties.HSP"],
];

/** The sizes, as Markdown. @param {Index} index */
export function summary(index) {
  const lines = [];
  const libraries = new Map();
  for (const module of Object.values(index.modules)) {
    const [count, bytes] = libraries.get(module.library) ?? [0, 0];
    libraries.set(module.library, [count + 1, bytes + module.bytes]);
  }
  const archives = Object.entries(index.archives);
  const largest = archives.reduce((a, b) => (b[1].bytes > a[1].bytes ? b : a));
  const sources = index.libraries["agda-algebras"].sources;
  lines.push(
    `agda-algebras \`${index.libraries["agda-algebras"].commit}\`, built by Agda ${index.agda.version} (\`agda.wasm\` ${index.agda.wasm.slice(0, 16)}...)`,
    "",
    "| Library | Modules | Interface bytes |",
    "|---|---:|---:|",
    ...[...libraries].sort().map(
      ([library, [count, bytes]]) => `| ${library} | ${n(count)} | ${n(bytes)} |`,
    ),
    "",
    `${n(archives.length)} interface archives, ${n(archives.reduce((s, [, a]) => s + a.bytes, 0))} bytes; the largest \`${largest[0]}\`, ${n(largest[1].bytes)}.  Sources: \`${sources.path}\`, ${n(sources.bytes)} bytes.`,
    "",
    "| Imports | Modules | Archives | Bytes fetched | Floor | Over |",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const roots of FIXED_ROOTS) {
    const need = needs(index, roots);
    lines.push(
      `| ${roots.map((r) => `\`${r}\``).join(", ")} | ${n(need.modules)} | ${n(need.archives.length)} | ${n(need.bytes)} | ${n(need.floor)} | ${(100 * (need.bytes - need.floor) / need.floor).toFixed(2)}% |`,
    );
  }
  const perRoot = index.roots
    .map((root) => ({ root, ...needs(index, [root]) }))
    .sort((a, b) => a.archives.length - b.archives.length);
  const median = perRoot[Math.floor(perRoot.length / 2)];
  const heaviest = perRoot.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  const limit = 25 * 1024 * 1024;
  lines.push(
    "",
    `Over all ${perRoot.length} roots: archives per root ${perRoot[0].archives.length} to ${perRoot[perRoot.length - 1].archives.length} (median ${median.archives.length}); the heaviest root \`${heaviest.root}\`, ${n(heaviest.modules)} modules and ${n(heaviest.bytes)} bytes; ${perRoot.filter((r) => r.floor > limit).length} roots need more than 25 MiB.`,
  );
  return lines.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, path, ...roots] = process.argv.slice(2);
  if (command === "needs" && path && roots.length) {
    for (const archive of needs(readIndex(path), roots).archives)
      console.log(archive);
  } else if (command === "each" && path) {
    const index = readIndex(path);
    for (const root of roots.length ? roots : index.roots) {
      const need = needs(index, [root]);
      console.log([root, need.modules, need.bytes, ...need.archives].join(" "));
    }
  } else if (command === "summary" && path) {
    process.stdout.write(summary(readIndex(path)));
  } else {
    console.error(
      "usage: index.mjs needs INDEX ROOT... | each INDEX [ROOT...] | summary INDEX",
    );
    process.exit(2);
  }
}
