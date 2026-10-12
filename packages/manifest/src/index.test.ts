// File: packages/manifest/src/index.test.ts
//
// The manifests the page ships validate, a wrong field is named, and the
// plan of a chapter's archives is the page's.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  archiveUrls,
  chapters,
  isLiterate,
  parseCorpusManifest,
  parseInterfaceManifest,
  planChapterArchives,
} from "./index.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"));
const corpusJson = read("static/plfa/manifest.json");
const interfacesJson = read("static/plfa/interfaces/manifest.json");

describe("the manifests", () => {
  it("accepts the ones the page ships", () => {
    const corpus = parseCorpusManifest(corpusJson);
    expect(corpus.ok).toBe(true);
    if (!corpus.ok) return;
    expect(chapters(corpus.value)).toHaveLength(25);
    expect(chapters(corpus.value).every(isLiterate)).toBe(true);
    expect(parseInterfaceManifest(interfacesJson, corpus.value).ok).toBe(true);
  });

  it("refuses a manifest naming the field that is wrong", () => {
    const broken = structuredClone(corpusJson);
    broken.groups[1].chapters[2].modulePath = "plfa/part2/Lambda.lagda.md";
    expect(parseCorpusManifest(broken)).toEqual({
      ok: false,
      error:
        "the corpus manifest: groups.1.chapters.2.modulePath must be an absolute path to an Agda source on the engine's drive",
    });
    const repeated = structuredClone(corpusJson);
    repeated.groups[0].chapters[1].id = repeated.groups[0].chapters[0].id;
    expect(parseCorpusManifest(repeated)).toMatchObject({
      ok: false,
      error: "the corpus manifest: groups.0.chapters.1.id repeats the id part1/Naturals",
    });
    expect(parseCorpusManifest({ ...corpusJson, commit: "870f9bb" })).toMatchObject({
      ok: false,
      error: "the corpus manifest: commit must be a full commit hash",
    });
  });

  it("refuses an interface manifest that names no chapter", () => {
    const corpus = parseCorpusManifest(corpusJson);
    if (!corpus.ok) throw new Error(corpus.error);
    expect(parseInterfaceManifest({ version: 2, chapters: {} })).toMatchObject({ ok: false });
    expect(
      parseInterfaceManifest({ version: 1, chapters: { "part1/Naturals": ["part9/Nothing"] } }, corpus.value),
    ).toEqual({
      ok: false,
      error: "the interface manifest: chapters.part1/Naturals names part9/Nothing, which is not a chapter",
    });
  });

  it("plans a chapter's archives as the page did", () => {
    const corpus = parseCorpusManifest(corpusJson);
    const interfaces = parseInterfaceManifest(interfacesJson);
    if (!corpus.ok || !interfaces.ok) throw new Error("the shipped manifests");
    expect(planChapterArchives(corpus.value, interfaces.value, "part1/Equality")).toEqual([
      "part1/Naturals",
      "part1/Equality",
    ]);
    // Without an interface manifest: every chapter up to it.
    expect(planChapterArchives(corpus.value, null, "part1/Relations")).toEqual([
      "part1/Naturals",
      "part1/Induction",
      "part1/Relations",
    ]);
    expect(planChapterArchives(corpus.value, null, "part9/Nothing")).toEqual([]);
    expect(archiveUrls(["part1/Naturals"], "/plfa/interfaces", "abc")).toEqual([
      "/plfa/interfaces/part1/Naturals.zip?cache=abc",
    ]);
  });
});
