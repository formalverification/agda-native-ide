// File: src/lib/documents.test.ts
//
// The editor's documents (issue 10): a state per file, so undo never
// crosses files; a library's module that no transaction changes; each
// file's edits saved under its own key.

import { history, undo } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentSaver, OpenDocuments, documentFile, fileOf, readOnlyDocument, type DocumentFile } from "./documents";

const MAIN: DocumentFile = { path: "/play/Main.agda", storageKey: "doc:/play/Main.agda" };
const CHAPTER: DocumentFile = { path: "/plfa/part1/Naturals.lagda.md", storageKey: "plfa:part1/Naturals" };
const MODULE: DocumentFile = {
  path: "/agda-algebras/src/Overture/Signatures.lagda.md",
  library: { library: "agda-algebras", module: "Overture.Signatures" },
};

const make = (file: DocumentFile, text: string) =>
  EditorState.create({ doc: text, extensions: [documentFile.of(file), file.library ? readOnlyDocument() : [], history()] });

/** A command's target: the state, and a dispatch that replaces it. */
function target(state: EditorState) {
  const box = {
    state,
    dispatch: (transaction: Transaction) => {
      box.state = transaction.state;
    },
  };
  return box;
}

/** Type `text` at the end, as a reader's input. */
const typed = (state: EditorState, text: string) =>
  state.update({ changes: { from: state.doc.length, insert: text }, userEvent: "input.type" }).state;

describe("a state per open file", () => {
  it("keeps each file's own text and history, so undo never crosses files", () => {
    const documents = new OpenDocuments();
    // Main is edited, and kept as another file is shown.
    const main = typed(make(MAIN, "module Main where\n"), "-- an edit\n");
    documents.keep(main);
    const chapter = make(CHAPTER, "module plfa.part1.Naturals where\n");
    documents.keep(chapter);
    // Undo in the chapter, which has no history of its own: nothing.
    const shown = target(documents.get(CHAPTER.path)!);
    expect(undo(shown)).toBe(false);
    expect(shown.state.doc.toString()).toBe("module plfa.part1.Naturals where\n");
    // Main, shown again, undoes its own edit, and only it.
    const back = target(documents.get(MAIN.path)!);
    expect(back.state.doc.toString()).toBe("module Main where\n-- an edit\n");
    expect(undo(back)).toBe(true);
    expect(back.state.doc.toString()).toBe("module Main where\n");
    expect(documents.paths).toEqual([MAIN.path, CHAPTER.path]);
  });

  it("names each state's file, and forgets a closed one", () => {
    const documents = new OpenDocuments();
    documents.keep(make(MODULE, "text"));
    expect(fileOf(documents.get(MODULE.path)!)).toEqual(MODULE);
    expect(documents.close(MODULE.path)).toBe(true);
    expect(documents.has(MODULE.path)).toBe(false);
    expect(() => documents.keep(EditorState.create({ doc: "" }))).toThrow(/names its file/);
  });
});

describe("a library's module", () => {
  it("is read-only, and no transaction changes its text", () => {
    const state = make(MODULE, "module Overture.Signatures where\n");
    expect(state.readOnly).toBe(true);
    // A reader's keystroke, a paste, or an edit made by code.
    for (const userEvent of ["input.type", "input.paste", undefined]) {
      const next = state.update({ changes: { from: 0, insert: "x" }, ...(userEvent ? { userEvent } : {}) }).state;
      expect(next.doc.toString()).toBe("module Overture.Signatures where\n");
    }
    // Undo has nothing to undo, and a selection still moves.
    const box = target(state);
    expect(undo(box)).toBe(false);
    const selected = state.update({ selection: { anchor: 0, head: 6 } }).state;
    expect(selected.sliceDoc(selected.selection.main.from, selected.selection.main.to)).toBe("module");
  });
});

describe("the autosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves each file under its own key, whichever file is shown when it runs", () => {
    const saved: Array<[string, string]> = [];
    const saver = new DocumentSaver((key, text) => saved.push([key, text]), 250);
    // Typing in Main, then a chapter opened before Main's save ran: the
    // fork stored Main's text under the chapter's key here.
    saver.schedule(typed(make(MAIN, "module Main where\n"), "x"));
    saver.schedule(typed(make(CHAPTER, "chapter\n"), "y"));
    vi.advanceTimersByTime(250);
    expect(saved).toEqual([
      [MAIN.storageKey, "module Main where\nx"],
      [CHAPTER.storageKey, "chapter\ny"],
    ]);
  });

  it("keeps one save per file, the last, and never saves a library's module", () => {
    const saved: Array<[string, string]> = [];
    const saver = new DocumentSaver((key, text) => saved.push([key, text]), 250);
    const main = make(MAIN, "");
    saver.schedule(typed(main, "a"));
    vi.advanceTimersByTime(100);
    saver.schedule(typed(main, "ab"));
    saver.schedule(make(MODULE, "library"));
    vi.advanceTimersByTime(249);
    expect(saved).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(saved).toEqual([[MAIN.storageKey, "ab"]]);
  });

  it("saves what waits at once when flushed", () => {
    const saved: Array<[string, string]> = [];
    const saver = new DocumentSaver((key, text) => saved.push([key, text]), 250);
    saver.schedule(typed(make(MAIN, ""), "z"));
    saver.flush();
    expect(saved).toEqual([[MAIN.storageKey, "z"]]);
    vi.advanceTimersByTime(1000);
    expect(saved).toHaveLength(1);
  });
});
