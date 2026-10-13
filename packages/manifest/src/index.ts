// File: packages/manifest/src/index.ts
//
// The manifests the page reads today, validated, and the planning it does
// with them, in a package every host imports (issue 62): the PLFA corpus
// manifest (static/plfa/manifest.json: the book, its pin, and its chapters,
// each a literate module the engine loads), its interface manifest
// (static/plfa/interfaces/manifest.json: for each chapter, the archives of
// interfaces a check of it reads), and a library's module list (issue 9;
// agda-algebras-modules.json, which the build writes from the library's
// sources archive: every module, with its path and title, for the
// Explorer).  A manifest that is not what the page can use is refused with
// a message naming the field.
//
// These are the present formats, not issue 24's plugin manifest: they
// have no kind, no digests and no costs, and nothing here loads a plugin.
// docs/engine/overview.md maps them to that format.  A library whose
// interfaces come as archives named by an index (issue 14) has its own
// description, which does have a kind, digests and costs (./library.ts),
// and is the first of the plugin manifest's kinds.
//
// A field's name joins its path's keys with dots, and quotes a key that is
// not a plain word, so that a key holding a dot (a module's name in an
// archive index, `modules["Overture.Basic"].deps`) is not read as two.

import { z } from "zod";
import { isSourcePath, sourceKind } from "@agda-native-ide/engine";

import {
  archiveIndexSchema,
  libraryDescriptionSchema,
  type ArchiveIndex,
  type LibraryDescription,
} from "./library.js";

export { importedModules } from "./imports.js";
export {
  archiveRefs,
  isBuiltinModule,
  planArchives,
  planImports,
  statedProgress,
  statedSize,
} from "./library.js";
export type {
  ArchiveIndex,
  ArchivePlan,
  ArchiveRef,
  ImportPlan,
  LibraryDescription,
  SourceReader,
} from "./library.js";

const urlPath = z
  .string()
  .regex(/^\/(?:[^/\s]+\/)*[^/\s]+$/, "must be an absolute path on the site, with no empty segment");

const chapter = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/, "must be a slash-separated id"),
  name: z.string().min(1),
  title: z.string().min(1),
  sourcePath: urlPath,
  modulePath: z
    .string()
    .refine(isSourcePath, "must be an absolute path to an Agda source on the engine's drive"),
});

const corpus = z
  .object({
    title: z.string().min(1),
    source: z.url(),
    license: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/, "must be a full commit hash"),
    revisionDate: z.iso.date(),
    groups: z
      .array(z.object({ id: z.string().min(1), title: z.string().min(1), chapters: z.array(chapter).min(1) }))
      .min(1),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.groups.forEach((group, g) =>
      group.chapters.forEach((entry, c) => {
        if (seen.has(entry.id))
          context.addIssue({
            code: "custom",
            path: ["groups", g, "chapters", c, "id"],
            message: `repeats the id ${entry.id}`,
          });
        seen.add(entry.id);
      }),
    );
  });

const interfaces = z.object({
  version: z.literal(1),
  chapters: z.record(z.string(), z.array(z.string().min(1))),
});

/** A part of a module name: no whitespace, and none of Agda's reserved
 * characters, the dot among them. */
const namePart = String.raw`[^\s.;{}()@"]+`;

const libraryModule = z.object({
  name: z.string().regex(new RegExp(`^${namePart}(?:\\.${namePart})*$`, "u"), "must be a dotted module name"),
  path: z.string().refine(isSourcePath, "must be an absolute path to an Agda source on the engine's drive"),
  title: z.string().min(1).optional(),
});

// The module list: each name is the module at its path (the path under an
// included directory, its suffix dropped and its slashes read as dots), no
// name is listed twice, and the modules are in the Explorer's order, the
// order the build writes and the tree shows.
const library = z
  .object({
    version: z.literal(1),
    library: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/, "must be a full commit hash").optional(),
    include: z
      .array(z.string().regex(/^\/(?:(?:[^/\s]+\/)*[^/\s]+)?$/, "must be an absolute directory on the engine's drive"))
      .min(1),
    modules: z.array(libraryModule).min(1),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.modules.forEach((entry, index) => {
      const path = ["modules", index, "name"];
      if (!value.include.some((dir) => moduleAt(dir, entry.path) === entry.name))
        context.addIssue({ code: "custom", path, message: `is not the module at ${entry.path}` });
      else if (seen.has(entry.name)) context.addIssue({ code: "custom", path, message: `repeats ${entry.name}` });
      else if (index > 0 && compareModuleNames(value.modules[index - 1].name, entry.name) > 0)
        context.addIssue({
          code: "custom",
          path,
          message: `comes after ${value.modules[index - 1].name} in the Explorer's order`,
        });
      seen.add(entry.name);
    });
  });

export type CorpusManifest = z.infer<typeof corpus>;
export type Chapter = z.infer<typeof chapter>;
export type InterfaceManifest = z.infer<typeof interfaces>;
export type LibraryManifest = z.infer<typeof library>;
export type LibraryModule = z.infer<typeof libraryModule>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A field's path as the error names it: `groups.1.chapters.2.id`, or
 * `modules["Overture.Basic"].deps` where a key is not a plain word. */
function fieldName(path: readonly PropertyKey[]): string {
  return path
    .map((key, at) => {
      const text = String(key);
      if (/^[A-Za-z_$][\w$]*$|^\d+$/.test(text)) return at === 0 ? text : `.${text}`;
      return `[${JSON.stringify(text)}]`;
    })
    .join("");
}

function parsed<T>(schema: z.ZodType<T>, what: string, json: unknown): Parsed<T> {
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const issue = result.error.issues[0];
  const field = issue.path.length ? fieldName(issue.path) : "(the manifest)";
  return { ok: false, error: `${what}: ${field} ${issue.message}` };
}

/** A library's description, or the first field that is wrong. */
export function parseLibraryDescription(json: unknown): Parsed<LibraryDescription> {
  return parsed(libraryDescriptionSchema, "the library's description", json);
}

/** A library's archive index (schema 1), or the first field that is
 * wrong: a module naming an archive, a library or a dependency the index
 * does not have is wrong too. */
export function parseArchiveIndex(json: unknown): Parsed<ArchiveIndex> {
  return parsed(archiveIndexSchema, "the archive index", json);
}

/** The PLFA corpus manifest, or the first field that is wrong. */
export function parseCorpusManifest(json: unknown): Parsed<CorpusManifest> {
  return parsed(corpus, "the corpus manifest", json);
}

/** The interface manifest, or the first field that is wrong; an archive
 * named for a chapter must be a chapter's, when the corpus is given. */
export function parseInterfaceManifest(json: unknown, against?: CorpusManifest): Parsed<InterfaceManifest> {
  const result = parsed(interfaces, "the interface manifest", json);
  if (!result.ok || !against) return result;
  const known = new Set(chapters(against).map((entry) => entry.id));
  for (const [id, archives] of Object.entries(result.value.chapters)) {
    if (!known.has(id))
      return { ok: false, error: `the interface manifest: chapters.${id} is not a chapter of the corpus` };
    const unknown = archives.find((archive) => !known.has(archive));
    if (unknown !== undefined)
      return { ok: false, error: `the interface manifest: chapters.${id} names ${unknown}, which is not a chapter` };
  }
  return result;
}

/** A library's module list, or the first field that is wrong. */
export function parseLibraryManifest(json: unknown): Parsed<LibraryManifest> {
  return parsed(library, "the module list", json);
}

/** The module a source path holds when `dir` is on the include path, or
 * undefined when the path is not under it. */
function moduleAt(dir: string, path: string): string | undefined {
  const kind = sourceKind(path);
  const prefix = dir === "/" ? dir : `${dir}/`;
  if (!kind || !path.startsWith(prefix)) return undefined;
  return path.slice(prefix.length, -(kind.length + 1)).split("/").join(".");
}

const compareCodePoints = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The Explorer's order of two dotted names: segment by segment, case
 * aside first and then by code point; a name before the names under it,
 * so a module comes before the modules in the folder of its name. */
export function compareModuleNames(left: string, right: string): number {
  const a = left.split(".");
  const b = right.split(".");
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareCodePoints(a[i].toLowerCase(), b[i].toLowerCase()) || compareCodePoints(a[i], b[i]);
    if (order) return order;
  }
  return a.length - b.length;
}

/** The chapters in reading order. */
export function chapters(manifest: CorpusManifest): Chapter[] {
  return manifest.groups.flatMap((group) => group.chapters);
}

/** The archives a check of a chapter reads: its interface manifest's list,
 * or, without one, every chapter up to it, as the page has always done. */
export function planChapterArchives(
  manifest: CorpusManifest,
  interfaceManifest: InterfaceManifest | null,
  chapterId: string,
): string[] {
  const all = chapters(manifest);
  const index = all.findIndex((entry) => entry.id === chapterId);
  if (index < 0) return [];
  return interfaceManifest?.chapters[chapterId] ?? all.slice(0, index + 1).map((entry) => entry.id);
}

/** The URLs of archives, under `base`, with the cache token the build
 * derives from them. */
export function archiveUrls(ids: readonly string[], base: string, cacheToken: string): string[] {
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return ids.map((id) => `${prefix}${id}.zip?cache=${cacheToken}`);
}

/** Whether a chapter's module is literate (PLFA's are Markdown). */
export function isLiterate(entry: Chapter): boolean {
  return sourceKind(entry.modulePath)?.startsWith("lagda") ?? false;
}
