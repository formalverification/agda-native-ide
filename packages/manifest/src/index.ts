// File: packages/manifest/src/index.ts
//
// The manifests the page reads today, validated, and the planning it does
// with them, in a package every host imports (issue 62): the PLFA corpus
// manifest (static/plfa/manifest.json: the book, its pin, and its chapters,
// each a literate module the engine loads) and its interface manifest
// (static/plfa/interfaces/manifest.json: for each chapter, the archives of
// interfaces a check of it reads).  A manifest that is not what the page
// can use is refused with a message naming the field.
//
// These are the present formats, not issue 24's plugin manifest: they
// have no kind, no digests and no costs, and nothing here loads a plugin.
// docs/engine/overview.md maps them to that format.

import { z } from "zod";
import { isSourcePath, sourceKind } from "@agda-native-ide/engine";

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

export type CorpusManifest = z.infer<typeof corpus>;
export type Chapter = z.infer<typeof chapter>;
export type InterfaceManifest = z.infer<typeof interfaces>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parsed<T>(schema: z.ZodType<T>, what: string, json: unknown): Parsed<T> {
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const issue = result.error.issues[0];
  const field = issue.path.length ? issue.path.map(String).join(".") : "(the manifest)";
  return { ok: false, error: `${what}: ${field} ${issue.message}` };
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
