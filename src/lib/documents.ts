// File: src/lib/documents.ts
//
// The editor's documents (issue 10): one CodeMirror state per open file,
// shown with EditorView.setState, so that each file keeps its own text,
// selection, history and language, undo never crosses files, and an edit
// is saved under its own file's key whichever file is on screen when the
// save runs.  The fork swapped one document between files inside one
// state, so Ctrl-Z after opening a chapter put Main.agda's text into the
// chapter, and the autosave stored it there (measured on the live site on
// 2026-10-04).
//
// A module of a library opens read-only: it is the checked library, whose
// interface other files import.  No transaction changes its text (not a
// keystroke, a paste, an undo, symbol input's own edit, or one of Agda's),
// and its content is not editable, but it takes the focus, so the keyboard
// still moves and selects in it and the page's keys reach it.

import { EditorState, Facet, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** A module of a library, as a read-only document shows it. */
export interface LibraryModule {
  /** The library's name, as its `.agda-lib` gives it. */
  library: string;
  /** The module's name. */
  module: string;
}

/** What the page knows of a document's file. */
export interface DocumentFile {
  /** Its path on the drive. */
  path: string;
  /** Where the browser keeps its text (localStorage); none for a file the
   * page never saves, a library's module. */
  storageKey?: string;
  /** Set for a module of a library, which is shown read-only. */
  library?: LibraryModule;
}

/** The file a state shows, given when the state is made. */
export const documentFile = Facet.define<DocumentFile, DocumentFile | undefined>({
  combine: (values) => values[0],
  static: true,
});

/** The file `state` shows, if it was made for one. */
export function fileOf(state: EditorState): DocumentFile | undefined {
  return state.facet(documentFile);
}

/** A read-only document: nothing changes its text, and its content is not
 * editable, yet focusable (so arrows, selection and the page's keys work). */
export function readOnlyDocument(): Extension {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: "0" }),
    EditorState.changeFilter.of(() => false),
  ];
}

/** The documents the editor has open, by path, in the order they were
 * opened: each one's state as it was last shown. */
export class OpenDocuments {
  private readonly states = new Map<string, EditorState>();

  /** The paths open, in the order they were opened. */
  get paths(): string[] {
    return [...this.states.keys()];
  }

  has(path: string): boolean {
    return this.states.has(path);
  }

  /** The state kept for `path`. */
  get(path: string): EditorState | undefined {
    return this.states.get(path);
  }

  /** Keep `state` as its file's (the file it was made for). */
  keep(state: EditorState): void {
    const file = fileOf(state);
    if (!file) throw new Error("a document's state names its file");
    this.states.set(file.path, state);
  }

  /** Forget `path`'s state, and with it its history. */
  close(path: string): boolean {
    return this.states.delete(path);
  }
}

/** One save per file, `delayMs` after its last edit: each file's timer
 * saves that file's text, under its own key, whichever file is on screen
 * when it fires. */
export class DocumentSaver {
  private readonly pending = new Map<string, { timer: ReturnType<typeof setTimeout>; text: () => string }>();

  constructor(
    private readonly save: (key: string, text: string) => void,
    private readonly delayMs = 250,
  ) {}

  /** Save `state`'s text under its file's key after the delay, in place of
   * a save of the same file still waiting.  A file with no key is not
   * saved. */
  schedule(state: EditorState): void {
    const key = fileOf(state)?.storageKey;
    if (!key) return;
    const waiting = this.pending.get(key);
    if (waiting) clearTimeout(waiting.timer);
    const text = () => state.doc.toString();
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.save(key, text());
    }, this.delayMs);
    this.pending.set(key, { timer, text });
  }

  /** Save at once what waits. */
  flush(): void {
    for (const [key, { timer, text }] of this.pending) {
      clearTimeout(timer);
      this.save(key, text());
    }
    this.pending.clear();
  }
}
