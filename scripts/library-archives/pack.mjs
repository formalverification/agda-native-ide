// File: scripts/library-archives/pack.mjs
//
// Pack agda-algebras' interfaces, as build.sh wrote them, into the archives
// the page fetches, and write their index (issue 12;
// docs/notes/library-archives.md has the reasons and the index's schema).
// `nix build .#agda-algebras-archives` runs it; it needs node, zip and
// unzip.
//
//   node pack.mjs --interfaces DIR --sources ZIP --stdlib ZIP --builtins ZIP
//                 --wasm FILE --commit REV OUT
//
// The packing: one archive per agda-algebras module, holding its interface;
// and the standard-library modules grouped by the set of agda-algebras
// modules that reach them, one archive per group.  A group is needed by an
// import exactly when any of its modules is, so the archives a set of
// imports needs hold exactly its closure's interfaces, and nothing more.
// Each archive is a stored zip (the interfaces are zstd already), its
// entries at their paths on the drive, sorted, with one fixed time, so its
// bytes depend on its input alone; none may exceed 25 MiB, the largest file
// Cloudflare Pages serves.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { closure, summary } from "./index.mjs";

const LIMIT = 25 * 1024 * 1024;
// 1980-01-01, the earliest time a zip records.
const FIXED_TIME = 315532800;

const { values: args, positionals } = parseArgs({
  options: {
    interfaces: { type: "string" },
    sources: { type: "string" },
    stdlib: { type: "string" },
    builtins: { type: "string" },
    wasm: { type: "string" },
    commit: { type: "string" },
  },
  allowPositionals: true,
});
const out = positionals[0];
for (const name of ["interfaces", "sources", "stdlib", "builtins", "wasm", "commit"])
  if (!args[name] || !out) {
    console.error(
      "usage: pack.mjs --interfaces DIR --sources ZIP --stdlib ZIP --builtins ZIP --wasm FILE --commit REV OUT",
    );
    process.exit(2);
  }

/** @param {string} command @param {string[]} argv @param {object} [options] */
function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: "utf8", ...options });
  if (result.status !== 0)
    throw new Error(`${command} ${argv.join(" ")}: ${result.stderr || result.status}`);
  return result.stdout;
}

const sha256 = (/** @type {Buffer} */ data) =>
  createHash("sha256").update(data).digest("hex");

/** Every file under `dir`, relative to it, sorted. @param {string} dir */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => statSync(join(dir, path)).isFile())
    .sort();
}

/** The Agda sources a zip holds under `prefix`, by module path (`A/B` for
 * module `A.B`), mapped to `drive` + the path below the prefix.
 * @param {string} zip @param {string} prefix @param {string} drive */
function sourcesIn(zip, prefix, drive) {
  const sources = new Map();
  for (const entry of run("unzip", ["-Z1", zip]).split("\n")) {
    if (!entry.startsWith(prefix)) continue;
    const below = entry.slice(prefix.length);
    const match = below.match(/^(.*?)\.(agda|lagda(\.[a-z]+)?)$/);
    if (match) sources.set(match[1], drive + below);
  }
  return sources;
}

// ---- What build.sh wrote ---------------------------------------------------

const stage = join(args.interfaces, "stage");
const [version] = readdirSync(join(stage, "agda-algebras", "_build"));
const interfaceRoots = {
  "agda-algebras": `agda-algebras/_build/${version}/agda/src`,
  "standard-library": `stdlib/_build/${version}/agda/src`,
};

// The builtins' interfaces, from agda-data.zip, which the drive holds from
// the start.
const builtins = mkdtempSync(join(tmpdir(), "agda-data-"));
run("unzip", ["-q", args.builtins, "-d", builtins]);
const builtinRoot = `lib/prim/_build/${version}/agda`;

const sources = {
  "agda-algebras": sourcesIn(args.sources, "agda-algebras/src/", "/agda-algebras/src/"),
  "standard-library": sourcesIn(args.stdlib, "agda-stdlib-2.3/src/", "/stdlib/src/"),
  builtins: sourcesIn(args.builtins, "lib/prim/", "/lib/prim/"),
};

// Agda's graph, without the module build.sh wrote to import everything.
const dot = readFileSync(join(args.interfaces, "graph.dot"), "utf8");
const labels = new Map(
  [...dot.matchAll(/(m\d+)\[label="([^"]+)"\]/g)].map((m) => [m[1], m[2]]),
);
/** @type {Map<string, Set<string>>} */
const deps = new Map([...labels.values()].map((name) => [name, new Set()]));
for (const [, from, to] of dot.matchAll(/(m\d+) -> (m\d+)/g))
  deps.get(/** @type {string} */ (labels.get(from)))?.add(/** @type {string} */ (labels.get(to)));
deps.delete("All");

const aaModules = readFileSync(join(args.interfaces, "modules.txt"), "utf8")
  .split("\n")
  .filter(Boolean);

/** Where each module's interface and source are, and its library. */
const modules = new Map();
for (const name of [...deps.keys()].sort()) {
  const path = name.replaceAll(".", "/");
  const found = [
    ...Object.entries(interfaceRoots).map(([library, root]) => [
      library,
      join(stage, root, `${path}.agdai`),
      `/${root}/${path}.agdai`,
    ]),
    ["builtins", join(builtins, builtinRoot, `${path}.agdai`), `/${builtinRoot}/${path}.agdai`],
  ].filter(([, file]) => existsSync(file));
  if (found.length !== 1)
    throw new Error(`${name}: ${found.length} interfaces, not 1`);
  const [[library, file, drivePath]] = found;
  const source = sources[library].get(path);
  if (!source) throw new Error(`${name}: no source in ${library}`);
  modules.set(name, { library, file, drivePath, source, bytes: statSync(file).size });
}

// Every interface built is a module of the graph, and every module of
// agda-algebras is in it.
for (const [library, root] of Object.entries(interfaceRoots))
  for (const file of filesUnder(join(stage, root))) {
    const name = file.replace(/\.agdai$/, "").replaceAll("/", ".");
    if (modules.get(name)?.library !== library)
      throw new Error(`${root}/${file} is not in the graph`);
  }
for (const name of aaModules)
  if (modules.get(name)?.library !== "agda-algebras")
    throw new Error(`${name} is not in the graph`);

// ---- The packing -----------------------------------------------------------

const graph = {
  modules: Object.fromEntries(
    [...deps].map(([name, set]) => [name, { deps: [...set] }]),
  ),
};
/** @type {Map<string, string[]>} the agda-algebras modules reaching each module */
const reachedBy = new Map([...modules.keys()].map((name) => [name, []]));
for (const root of aaModules)
  for (const name of closure(/** @type {any} */ (graph), [root]))
    reachedBy.get(name)?.push(root);

/** @type {Map<string, string[]>} archive path -> its modules, sorted */
const archives = new Map();
for (const [name, { library }] of modules) {
  let archive;
  if (library === "agda-algebras") archive = `interfaces/${name}.zip`;
  else if (library === "standard-library") {
    const key = /** @type {string[]} */ (reachedBy.get(name)).join("\n");
    if (!key) throw new Error(`${name}: no agda-algebras module reaches it`);
    archive = key;
  } else continue;
  archives.set(archive, [...(archives.get(archive) ?? []), name]);
}
// A standard-library group is named by a digest of its modules, so its name
// changes only when its membership does.
for (const [key, members] of [...archives]) {
  if (key.startsWith("interfaces/")) continue;
  archives.delete(key);
  const digest = sha256(Buffer.from(members.join("\n"))).slice(0, 12);
  archives.set(`interfaces/stdlib-${digest}.zip`, members);
}

// ---- The archives ----------------------------------------------------------

mkdirSync(join(out, "interfaces"), { recursive: true });
const tree = mkdtempSync(join(tmpdir(), "interfaces-"));
for (const { file, drivePath } of modules.values()) {
  if (!drivePath.startsWith("/agda-algebras/") && !drivePath.startsWith("/stdlib/"))
    continue;
  const target = join(tree, drivePath);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
  chmodSync(target, 0o644);
  utimesSync(target, FIXED_TIME, FIXED_TIME);
}

/** @type {Record<string, { bytes: number, sha256: string, modules: number }>} */
const archiveTable = {};
const moduleArchive = new Map();
for (const [path, members] of [...archives].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const entries = members.map((name) => modules.get(name).drivePath.slice(1)).sort();
  run("zip", ["-X", "-D", "-0", "-q", join(out, path), "-@"], {
    cwd: tree,
    input: entries.join("\n") + "\n",
    env: { ...process.env, TZ: "UTC" },
  });
  const data = readFileSync(join(out, path));
  if (data.length > LIMIT)
    throw new Error(`${path} is ${data.length} bytes, over 25 MiB`);
  archiveTable[path] = { bytes: data.length, sha256: sha256(data), modules: members.length };
  for (const name of members) moduleArchive.set(name, path);
}

const sourcesName = basename(args.sources);
copyFileSync(args.sources, join(out, sourcesName));
chmodSync(join(out, sourcesName), 0o644);
const fileDigest = (/** @type {string} */ path) => ({
  bytes: statSync(path).size,
  sha256: sha256(readFileSync(path)),
});

// ---- The index -------------------------------------------------------------

const index = {
  schema: 1,
  agda: { version, wasm: sha256(readFileSync(args.wasm)) },
  libraries: {
    "agda-algebras": {
      name: "agda-algebras",
      commit: args.commit,
      root: "/agda-algebras",
      agdaLib: "/agda-algebras/agda-algebras.agda-lib",
      sources: { path: sourcesName, ...fileDigest(args.sources) },
    },
    "standard-library": {
      name: "standard-library-2.3",
      root: "/stdlib",
      agdaLib: "/stdlib/standard-library.agda-lib",
      sources: { path: basename(args.stdlib), ...fileDigest(args.stdlib) },
    },
    builtins: {
      root: "/lib/prim",
      sources: { path: basename(args.builtins), ...fileDigest(args.builtins) },
    },
  },
  roots: aaModules,
  archives: archiveTable,
  modules: Object.fromEntries(
    [...modules].map(([name, m]) => [
      name,
      {
        library: m.library,
        source: m.source,
        interface: m.drivePath,
        bytes: m.bytes,
        archive: moduleArchive.get(name) ?? null,
        deps: [.../** @type {Set<string>} */ (deps.get(name))].sort(),
      },
    ]),
  ),
};

// One archive and one module per line, so that a diff of two indexes reads.
const lines = (/** @type {Record<string, unknown>} */ table) =>
  "{\n" +
  Object.entries(table)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(",\n") +
  "\n }";
const { archives: a, modules: m, ...head } = index;
const json =
  JSON.stringify(head, null, 1).replace(/\n}$/, "") +
  `,\n "archives": ${lines(a)},\n "modules": ${lines(m)}\n}\n`;
writeFileSync(join(out, "index.json"), json);
writeFileSync(join(out, "summary.md"), summary(JSON.parse(json)));
process.stdout.write(summary(JSON.parse(json)));
