// File: packages/manifest/src/library.ts
//
// A library whose interfaces come as archives named by an index (issue
// 14): its description, the index itself (agda-algebras' `index.json`,
// schema 1, as docs/notes/library-archives.md gives it), and the plan of
// what a set of imports needs from it.  The description is what the page
// knows of agda-algebras when it starts: where its sources, its index and
// its archives are, and what each costs in bytes.  Issue 24's plugin
// manifest is to generalize it, as a plugin of kind "library", not to
// replace it.
//
// The plan is the one `scripts/library-archives/index.mjs` computes
// (`needs`), which the archives' check and gate prove for every root:
// everything reachable along `deps` from the imports is their closure,
// since Agda's graph keeps reachability exact, and the archives holding
// the closure's interfaces are what the imports need.

import { z } from "zod";
import type { SourceKind } from "@agda-native-ide/engine";

import { importedModules } from "./imports.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256, in hex");
const bytes = z.number().int().nonnegative();

/** A path on the engine's drive: absolute, with no empty segment. */
const drivePath = z
  .string()
  .regex(/^\/(?:[^/\s]+\/)*[^/\s]+$/, "must be an absolute path on the drive, with no empty segment");

/** An archive's path in the index, relative to the index's directory. */
const archivePath = z
  .string()
  .regex(/^(?:[^/\s.][^/\s]*\/)*[^/\s.][^/\s]*\.zip$/, "must be a relative path to a zip, with no empty or dot segment");

/** A URL as the page names it: absolute, or relative to the page. */
const url = z.string().regex(/^\S+$/, "must be a URL, with no whitespace");

/** A file to download, with what it costs and its digest. */
const download = z.object({ url, bytes, sha256 });

const description = z.object({
  kind: z.literal("library"),
  /** Its name, as a `depend:` line names it. */
  name: z.string().min(1),
  /** Its `.agda-lib` on the drive. */
  agdaLib: drivePath.refine((path) => path.endsWith(".agda-lib"), "must name an .agda-lib file"),
  /** Its sources' archive, mounted when the engine starts. */
  sources: download,
  /** Its archive index (schema 1). */
  index: download,
  /** Where the index's archive paths resolve: a URL ending in a slash. */
  archives: z.object({ base: url.refine((base) => base.endsWith("/"), "must end with a slash") }),
});

const indexSchema = z
  .object({
    schema: z.literal(1),
    agda: z.object({ version: z.string().min(1), wasm: sha256 }),
    libraries: z.record(
      z.string().min(1),
      z.object({
        name: z.string().min(1).optional(),
        commit: z.string().regex(/^[0-9a-f]{40}$/, "must be a full commit hash").optional(),
        root: drivePath,
        agdaLib: drivePath.optional(),
        sources: z.object({ path: z.string().min(1), bytes, sha256 }),
      }),
    ),
    roots: z.array(z.string().min(1)),
    archives: z.record(archivePath, z.object({ bytes, sha256, modules: z.number().int().positive() })),
    modules: z.record(
      z.string().min(1),
      z.object({
        library: z.string().min(1),
        source: drivePath,
        interface: drivePath,
        bytes,
        archive: archivePath.nullable(),
        deps: z.array(z.string().min(1)),
      }),
    ),
  })
  .superRefine((index, context) => {
    const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    for (const [name, module] of Object.entries(index.modules)) {
      if (!Object.hasOwn(index.libraries, module.library))
        issue(["modules", name, "library"], `names ${module.library}, which is not a library of the index`);
      if (module.archive !== null && !Object.hasOwn(index.archives, module.archive))
        issue(["modules", name, "archive"], `names ${module.archive}, which is not an archive of the index`);
      const dep = module.deps.find((dep) => !Object.hasOwn(index.modules, dep));
      if (dep !== undefined) issue(["modules", name, "deps"], `names ${dep}, which is not a module of the index`);
    }
    index.roots.forEach((root, at) => {
      if (!Object.hasOwn(index.modules, root)) issue(["roots", at], `names ${root}, which is not a module of the index`);
    });
  });

export type LibraryDescription = z.infer<typeof description>;
export type ArchiveIndex = z.infer<typeof indexSchema>;

export { description as libraryDescriptionSchema, indexSchema as archiveIndexSchema };

/** What a set of imports needs from a library's archives. */
export interface ArchivePlan {
  /** The modules of the closure, its builtins included. */
  modules: number;
  /** The archives holding the closure's interfaces, by path, sorted. */
  archives: string[];
  /** Their bytes. */
  bytes: number;
  /** The bytes of the closure's interfaces alone: what any packing must
   * fetch at least. */
  floor: number;
  /** The imports the index does not list (a reader's own module, or a
   * standard-library module the library does not reach): Agda checks them
   * from source, and the plan fetches nothing for them. */
  unknown: string[];
}

/** The plan for `imports`: `scripts/library-archives/index.mjs`'s `needs`.
 * A builtin's interface (`archive` null) is on the drive from the start. */
export function planArchives(index: ArchiveIndex, imports: readonly string[]): ArchivePlan {
  const listed = (name: string) => Object.hasOwn(index.modules, name);
  const unknown = imports.filter((name) => !listed(name));
  const seen = new Set<string>();
  const todo = imports.filter(listed);
  while (todo.length) {
    const name = todo.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    todo.push(...index.modules[name].deps);
  }
  const archives = new Set<string>();
  let floor = 0;
  for (const name of seen) {
    const { archive, bytes } = index.modules[name];
    if (archive === null) continue;
    archives.add(archive);
    floor += bytes;
  }
  const sorted = [...archives].sort();
  return {
    modules: seen.size,
    archives: sorted,
    bytes: sorted.reduce((sum, path) => sum + index.archives[path].bytes, 0),
    floor,
    unknown: [...new Set(unknown)],
  };
}

/** An archive as the engine's browser transport mounts it: its URL, under
 * the description's base, with the first 16 hex digits of its SHA-256 as
 * its `?cache=` token, so that its URL changes exactly when it does. */
export interface ArchiveRef {
  url: string;
  sha256: string;
  bytes: number;
  /** Its path in the index. */
  path: string;
  /** The interfaces it holds. */
  modules: number;
}

/** The archives named by `paths`, as the transport mounts them. */
export function archiveRefs(
  index: ArchiveIndex,
  paths: readonly string[],
  library: LibraryDescription,
): ArchiveRef[] {
  return paths.map((path) => {
    const { sha256, bytes, modules } = index.archives[path];
    return { url: `${library.archives.base}${path}?cache=${sha256.slice(0, 16)}`, sha256, bytes, path, modules };
  });
}

/** A size as the page states it, in one convention: bytes below a KB,
 * then KB (a KB is 1,024 bytes) below a MiB, then MiB (1,024 KB), to one
 * decimal. */
export function statedSize(count: number): string {
  if (count < 1024) return `${count} ${count === 1 ? "byte" : "bytes"}`;
  const kb = count / 1024;
  if (Number(kb.toFixed(1)) < 1024) return `${kb.toFixed(1)} KB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MiB`;
}

/** A source on the drive, by its path, or undefined when there is none. */
export type SourceReader = (path: string) => Promise<string | undefined>;

/** A plan that follows the imports the index does not list into their
 * sources on the drive. */
export interface ImportPlan extends ArchivePlan {
  /** The modules the index does not list whose sources the plan found:
   * Agda checks them from source, and the plan mounts what they import,
   * except for those in `unread`. */
  fromSource: string[];
  /** Those whose imports the plan could not read, being in a literate
   * format it does not follow (reStructuredText, Org, Forester): what they
   * import is not planned. */
  unread: string[];
  /** The modules found neither in the index nor on the drive; Agda says
   * what it makes of them. */
  missing: string[];
}

/** The suffixes Agda 2.9.0 tries for a module's source
 * (Agda.Syntax.Parser.Literate's literateProcessors), in the order the plan
 * reads them; Forester's, which the engine names no kind for, is found and
 * not read. */
const SOURCE_SUFFIXES: readonly [string, SourceKind | undefined][] = [
  [".agda", "agda"],
  [".lagda.md", "lagda.md"],
  [".lagda", "lagda"],
  [".lagda.tex", "lagda.tex"],
  [".lagda.typ", "lagda.typ"],
  [".lagda.rst", "lagda.rst"],
  [".lagda.org", "lagda.org"],
  [".lagda.tree", undefined],
];

/** The suffixes Agda 2.9.0 tries for a module's source, in its order. */
export const sourceSuffixes: readonly string[] = SOURCE_SUFFIXES.map(([suffix]) => suffix);

/** Whether a module is one of Agda's builtins, whose interfaces are on the
 * drive from the start (agda-data.zip), listed in the index or not. */
export const isBuiltinModule = (name: string) => name === "Agda.Primitive" || name.startsWith("Agda.");

/** The plan for `imports`, after following each import the index does not
 * list into its source under one of `includes` (the include directories of
 * the project and its libraries on the drive), whose imports join the
 * plan: `open import Data.Vec`, which agda-algebras does not reach, still
 * mounts the archives of the modules it imports that agda-algebras does. */
export async function planImports(
  index: ArchiveIndex,
  imports: readonly string[],
  { includes, read }: { includes: readonly string[]; read: SourceReader },
): Promise<ImportPlan> {
  const listed = (name: string) => Object.hasOwn(index.modules, name);
  const wanted = imports.filter((name) => !isBuiltinModule(name));
  const roots = new Set(wanted.filter(listed));
  const fromSource: string[] = [];
  const unread: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const todo = wanted.filter((name) => !listed(name));
  while (todo.length) {
    const name = todo.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    let found: { text: string; kind: SourceKind | undefined } | undefined;
    search: for (const include of includes)
      for (const [suffix, kind] of SOURCE_SUFFIXES) {
        const text = await read(`${include.replace(/\/$/, "")}/${name.split(".").join("/")}${suffix}`);
        if (text !== undefined) {
          found = { text, kind };
          break search;
        }
      }
    if (!found) {
      missing.push(name);
      continue;
    }
    fromSource.push(name);
    const imported = found.kind && importedModules(found.text, found.kind);
    if (!imported) unread.push(name);
    for (const next of imported || []) {
      if (isBuiltinModule(next)) continue;
      if (listed(next)) roots.add(next);
      else todo.push(next);
    }
  }
  const plan = planArchives(index, [...roots]);
  return { ...plan, unknown: [...new Set(wanted.filter((name) => !listed(name)))], fromSource, unread, missing };
}

/** A pair of sizes in the unit of the larger: "120.0 of 202.1 KB". */
export function statedProgress(done: number, total: number): string {
  const unit = statedSize(total).replace(/^[\d.]+ /, "");
  const scale = unit === "MiB" ? 1024 * 1024 : unit === "KB" ? 1024 : 1;
  const figure = (count: number) => (scale === 1 ? String(count) : (count / scale).toFixed(1));
  return `${figure(done)} of ${figure(total)} ${unit}`;
}
