// File: src/lib/controller.svelte.ts
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// src/lib/controller.svelte.ts at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
// (docs/provenance.md).  The cache tokens of the compiler's, the standard
// library's and PLFA's URLs, the compiler's length in bytes, and the
// drive's cache namespace come from $lib/assets, which the build derives
// from the files, instead of values maintained by hand; the builtins' URL,
// which had no token, gains one (issue 3).  The map of compiler versions
// keeps only the one the site ships: agda-data.zip is built for that Agda,
// and the others named compilers the site has never carried (issue 49).
// That compiler is this repository's build of Agda 2.9.0 and its language
// server (compiler/build-agda-2.9.0.sh), which answers in the raw format
// the engine reads only when started with --raw; the standard library is
// 2.3 patched to check under 2.9.0 (stdlib/patches/; issue 58).
//
// The controller is the page's host of the engine (issue 62): it holds the
// page's Svelte state and does what is the page's own, and asks the
// engine packages for the rest.  @agda-native-ide/engine/browser starts
// Agda (the reactor and the drive in one worker, issue 59; its download,
// its startup failures in the words issue 8 gave them, the language
// server's session), and the engine's session sends every command, one at
// a time, validates Agda's answers, and decides by the give rule between a
// give and a load; the tool surface (@agda-native-ide/tools) answers the
// inspector's questions.  The controller supplies the URLs, the worker
// (bundled from ./worker/als.ts), the PLFA source conversion
// ($lib/agda/browser-source), when to persist, and the editor: it applies
// Agda's highlighting, goals and edits to CodeMirror ($lib/agda/handlers)
// as they arrive, and connects CodeMirror's language-server client, for
// hover, to the engine's editor channel.  PLFA's archive is one library in
// the engine's list of the drive's libraries (issue 13).
//
// The playground's Main.agda is a project of its own (issue 11): it lives
// at /play/Main.agda, beside /play/play.agda-lib, a library that depends
// on the standard library and agda-algebras, whose sources archive is in
// the list beside PLFA's, as agda-algebras' archives are built and checked
// (scripts/library-archives/stage.sh).  The page writes that library file
// as one of the drive's first files, and keeps the buffer in localStorage
// under a key named by its path, so a document stored for /Main.agda, a
// module of PLFA's library, is not shown in its place.  After a load that
// leaves goals, the controller asks for the selected goal's context, so
// that a check reports the goal with what is known there.
//
// The editor takes its text as the one Agda's positions refer to (the
// offsets' commit) when the engine is about to load it, and only then,
// in the tick the text was read: after a give or a case split, Agda goes
// on giving the remaining goals' ranges in the text it loaded (issue 59).
//
// When Agda cannot start, the page says why: the engine's startup failure
// is shown as "Agda could not start: ...", and a server that fails or
// exits on its own once started as "Agda stopped: ..." (issue 8).
//
// Each open file has an editor state of its own (issue 10, ./documents):
// the controller keeps those not on screen, and shows one with the
// view's setState, so its history, its selection and its scroll are its
// own; the language server's client follows the file on screen.
//
// Before a check of the playground's Main, the controller mounts the
// interfaces its imports need (issue 14): it reads the imports from the
// buffer, plans their closure from agda-algebras' archive index (which it
// fetches when Agda starts, with the library's sources), and mounts the
// archives this session has not, reading those the browser keeps from the
// engine's archive store and fetching the rest, but only once the reader
// has been told how many bytes and has agreed (`consent`, which the page
// shows).  A choice may be remembered for the tab (sessionStorage), and a
// decline is remembered for the archives declined, so a later check does
// not ask again for them.  At startup it also deletes the drive caches of
// other namespaces, and the archives the index no longer names.

import { EditorView } from "@codemirror/view";
import { Compartment, type EditorState, type StateEffect } from "@codemirror/state";
import { LSPClient, languageServerExtensions } from "@codemirror/lsp-client";
import { messagesOf, sourceKind } from "@agda-native-ide/engine";
import type {
  AgdaSession,
  CheckPlan,
  GiveValue,
  GoalView,
  MakeCaseValue,
  Outcome,
} from "@agda-native-ide/engine";
import {
  ARCHIVE_STORE,
  ArchiveNotKept,
  forgetOtherDriveCaches,
  startBrowserSession,
  type ArchiveRef as MountedArchive,
  type BrowserTransport,
} from "@agda-native-ide/engine/browser";
import {
  archiveRefs,
  importedModules,
  isBuiltinModule,
  parseArchiveIndex,
  parseLibraryDescription,
  planImports,
  statedSize,
  type ArchiveIndex,
  type LibraryDescription,
} from "@agda-native-ide/manifest";
import { createToolSurface, type ToolResult, type ToolSurface } from "@agda-native-ide/tools";

import { hoverTooltips } from "$lib/codemirror/lsp-hover";
import { asset } from "$app/paths";
import { assetFiles, cacheTokens, compilerBytes, driveCacheNamespace } from "$lib/assets";
import { applyAgdaResponse } from "./agda/handlers";
import { commit } from "./codemirror/offsets";
import {
  getActiveAgdaGoal,
  getAgdaGoalById,
  getAgdaGoalContents,
  getAgdaGoals,
} from "./agda/goals";
import { browserAgdaSource } from "./agda/browser-source";
import { OpenDocuments, fileOf, type DocumentFile } from "./documents";

type ALSWorkerStatus =
  | "initial"
  | "errored"
  | "loading"
  | "loaded"
  | "active"
  | "deactivating"
  | "terminated"
  | "exited";

/** What the inspector shows of the engine's state: "processing" while an
 * operation runs, "ready" when none does. */
export type AgdaIOTCMStatus = "init" | "ready" | "processing";

const supportedAgdaVersion = ["2.9.0"] as const;
export type SupportedAgdaVersion = (typeof supportedAgdaVersion)[number];

export interface AgdaProblem {
  severity: "error" | "warning";
  message: string;
}

export interface AgdaGoalInfo {
  id: number;
  type?: string;
  context: Array<{ name: string; type: string; inScope: boolean }>;
}

export interface AgdaResult {
  kind: string;
  title: string;
  body: string;
}

interface AgdaVersionSpec {
  // The compiler, gzipped.
  compressedPath: string;
  byteLength?: number;
  // The JavaScript glue GHC's post-linker wrote for the server's reactor
  // build, which the worker imports.
  gluePath: string;
  stdlibCandidates: string[];
  // Zip archive to unpack to the initial drive. Agda still runs
  // `--setup`, but this archive also carries primitive interfaces.
  dataPath?: string;
}

export const agdaVersionMap: Record<SupportedAgdaVersion, AgdaVersionSpec> = {
  ["__proto__" as any]: null,
  "2.9.0": {
    compressedPath: `${asset("/als-reactor-2.9.0.wasm.gz")}?cache=${cacheTokens.compiler}`,
    byteLength: compilerBytes,
    gluePath: `${asset("/als-reactor-2.9.0.js")}?cache=${cacheTokens.glue}`,
    stdlibCandidates: ["2.3"],
    dataPath: `${asset("/agda-data.zip")}?cache=${cacheTokens.builtins}`,
  },
};

/** The playground: Main.agda in its own project, whose library depends
 * on the standard library the page ships (its `.agda-lib` names it
 * standard-library-2.3) and agda-algebras, as stage.sh writes it. */
export const PLAYGROUND = {
  file: "/play/Main.agda",
  library: {
    path: "/play/play.agda-lib",
    text: "name: play\ndepend: standard-library-2.3 agda-algebras\ninclude: .\n",
  },
  /** Where Agda finds the modules Main imports: the project's own
   * directory and its libraries' include directories, in that order
   * (issue 14, for the imports agda-algebras' index does not list). */
  includes: ["/play", "/agda-algebras/src", "/stdlib/src"],
} as const;

/** Where the editor keeps a playground file's buffer: a key named by its
 * path on the drive. */
export const storageKeyOf = (path: string) => `agda-web-ide-beta:doc:${path}`;

/** The key of the playground's Main.  It was "agda-web-ide-beta:doc" while
 * the buffer was /Main.agda, a module of PLFA's library; nothing is
 * deployed, so only a developer's browser holds a document there, and it
 * stays, unread. */
export const LS_DOC_KEY = storageKeyOf(PLAYGROUND.file);

/** The playground's Main, as a document. */
export const MAIN_FILE: DocumentFile = { path: PLAYGROUND.file, storageKey: LS_DOC_KEY };

/** agda-algebras as the page describes it (issue 14): its sources, which
 * the drive mounts when it starts, its archive index, and where the index's
 * archives are, each with its bytes and digest from the build.  Undefined,
 * with the reason, where the build had no archives (the dev server before
 * `make assets`); the page then checks every import from source. */
export const AGDA_ALGEBRAS = (() => {
  const parsed = parseLibraryDescription({
    kind: "library",
    name: "agda-algebras",
    agdaLib: "/agda-algebras/agda-algebras.agda-lib",
    sources: {
      url: `${asset("/agda-algebras-sources.zip")}?cache=${cacheTokens.agdaAlgebras}`,
      ...assetFiles.agdaAlgebras,
    },
    index: {
      url: `${asset("/agda-algebras/index.json")}?cache=${cacheTokens.agdaAlgebrasIndex}`,
      ...assetFiles.agdaAlgebrasIndex,
    },
    archives: { base: asset("/agda-algebras/") },
  });
  return parsed.ok ? { description: parsed.value } : { error: parsed.error };
})();

/** What the page asks before it fetches (issue 14): the archives a check
 * needs that neither the drive nor the browser holds, their bytes, the
 * interfaces they hold, and the imports the index lacks. */
export interface ConsentRequest {
  library: string;
  archives: number;
  bytes: number;
  modules: number;
  unknown: string[];
  /** Of those archives, the ones the reader declined earlier in the tab,
   * which a question for new ones asks for again, saying so. */
  declined: { archives: number; bytes: number };
  /** Whether the question takes the keyboard's focus: not on a check the
   * reader did not ask for, where Enter in the editor would answer it. */
  focus: boolean;
}

/** The reader's answer: fetch the archives, check without them, or do
 * not check; and whether to give the same answer for the rest of the tab's
 * life. */
export type ConsentChoice = "fetch" | "source" | "cancel";

/** How a mount is going, as the page shows it. */
export interface MountState {
  library: string;
  loaded: number;
  /** Their bytes, where every archive's is known (not PLFA's). */
  total: number | undefined;
  mounted: number;
  archives: number;
  /** Whether anything is downloaded, or every archive is the browser's. */
  fetching: boolean;
}

/** sessionStorage, or nothing where the browser refuses it. */
const tabStorage = {
  get(key: string) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // Refused: the choice lasts as long as the page.
    }
  },
};

/** The keys under which a tab remembers its answers for a library. */
const rememberedChoiceKey = (library: string) => `agda-native-ide:fetch-choice:${library}`;
const declinedKey = (library: string) => `agda-native-ide:declined:${library}`;

/** A size as the page states it, with its exact count. */
export function sizeWithBytes(count: number) {
  return `${statedSize(count)} (${count.toLocaleString("en-US")} bytes)`;
}

function makeLspClient(rootUri: string = "/") {
  const lspExtsWithoutHover = languageServerExtensions().filter(
    (x) => !("active" in x),
  );

  return new LSPClient({
    timeout: 180000,
    rootUri,
    extensions: [...lspExtsWithoutHover, hoverTooltips()],
  });
}

/** What the tool surface's get_goal answers. */
type GoalAnswer = { goal: number; type: string; context: AgdaGoalInfo["context"] };

/** A tool's answer as the inspector words it, or the error to show. */
function toolError(result: ToolResult): string | undefined {
  if (result.status === "refused" || result.status === "failed") return result.message;
  return undefined;
}

export class AgdaController {
  editorView?: EditorView;
  lspClient?: LSPClient;
  session?: AgdaSession;
  transport?: BrowserTransport;
  tools?: ToolSurface;

  lspClientCompartment = new Compartment();

  alsWorkerStatus = $state<ALSWorkerStatus>("initial");
  wasmLoadingProgress = $state<{ bytesLoaded: number; bytesTotal: number } | null>(null);
  // What Agda answered to Cmd_show_version, which the engine sends when
  // the session opens, before the page may send anything.
  reportedAgdaVersion = $state<string | undefined>();
  driveIsCreated = $state(false);
  driveArchiveLoading = $state(false);
  /** The file on screen. */
  currentFile = $state<DocumentFile>(MAIN_FILE);
  /** The files open in the editor, in the order they were opened, as its
   * tabs show them (issue 10). */
  openFiles = $state<DocumentFile[]>([MAIN_FILE]);
  iotcmStatus = $state<AgdaIOTCMStatus>("init");
  checked = $state(false);
  showImplicitArgs = $state(false);
  showIrrelevantArgs = $state(false);
  interactionPoints = $state<number[]>([]);
  activeGoalId = $state<number | undefined>();
  goalInfo = $state<Record<number, AgdaGoalInfo>>({});
  problems = $state<AgdaProblem[]>([]);
  runningMessages = $state<string[]>([]);
  lastResult = $state<AgdaResult | null>(null);
  lastAction = $state("Waiting for Agda");
  lastCheckDurationMs = $state<number | undefined>();
  /** The question the page shows before it fetches, while it waits for
   * the answer (issue 14). */
  consent = $state<ConsentRequest | null>(null);
  /** A mount under way. */
  mount = $state<MountState | null>(null);
  /** What the last check's plan has to say: imports the index lacks, or an
   * index that could not be read. */
  planNote = $state("");

  /** A plan under way, which the page counts as busy. */
  planning = $state(false);
  private planned?: Promise<boolean>;
  /** agda-algebras' archive index, once fetched and read. */
  private libraryIndex?: Promise<ArchiveIndex>;
  /** Answers the consent question the page shows. */
  private answerConsent?: (choice: ConsentChoice, remember: boolean) => void;
  /** Stops the mount under way. */
  private mountStopper?: AbortController;

  /** Each open file's editor state, as it was when another was shown. */
  private readonly documents = new OpenDocuments();
  /** Where each file kept off screen was scrolled to. */
  private readonly scrolled = new Map<string, StateEffect<unknown>>();
  /** Makes a file's editor state, the first time it opens: the page's
   * editor, for that file. */
  private createState?: (file: DocumentFile, text: string) => EditorState;

  /** Set by terminateALSWASM, so the session's end is not reported. */
  private stopRequested = false;
  /** Counts the documents the editor has shown: a check's answers that
   * arrive after another document replaced its own are not applied. */
  private documentEpoch = 0;
  /** Archive mounts in flight. */
  private mounting = 0;
  /** How the page checks the file on screen (in PLFA, with the chapter's
   * interfaces mounted first; in the playground, with what its imports need,
   * issue 14); a plain check by default.  `automatic` is a check the reader
   * did not ask for. */
  checkCurrentFile: (options?: { automatic?: boolean }) => Promise<void> = () => this.loadAgdaFile();
  /** Stops the engine, during its startup or after. */
  private stopper?: AbortController;

  constructor(
    readonly config: {
      agdaVersion: SupportedAgdaVersion;
    },
  ) {
    this.lspClient = makeLspClient();
  }

  /** The path of the file on screen. */
  get currentFilePath() {
    return this.currentFile.path;
  }

  /** The editor, and how to make a file's state in it.  The view's own
   * state is the first file's. */
  connectEditorView(view: EditorView, createState: (file: DocumentFile, text: string) => EditorState) {
    this.editorView = view;
    this.createState = createState;
    const file = fileOf(view.state);
    if (file) {
      this.currentFile = file;
      this.openFiles = [file];
    }
  }

  /** Start Agda.  The promise settles when the session ends: it rejects
   * with what the page shows when Agda could not start or stopped on its
   * own, and resolves when the page stopped it. */
  async startALSWASM() {
    if (this.session || this.alsWorkerStatus === "loading")
      throw new Error("Agda is already starting");
    const spec = agdaVersionMap[this.config.agdaVersion];
    this.alsWorkerStatus = "loading";
    this.stopRequested = false;
    this.stopper = new AbortController();

    const started = await startBrowserSession(
      {
        createWorker: () =>
          new Worker(new URL("./worker/als.ts", import.meta.url), {
            name: "ALS LSP Worker",
            type: "module",
          }),
        compiler: { url: spec.compressedPath, byteLength: spec.byteLength },
        // Absolute: the worker resolves URLs against itself.
        glueUrl: new URL(spec.gluePath, location.href).href,
        archives: {
          builtin: spec.dataPath,
          stdlib: `${asset("/agda-stdlib-2.3-patched.zip")}?cache=${cacheTokens.stdlib}`,
          // agda-algebras at /agda-algebras, which the playground's project
          // depends on; PLFA at the root, where its chapters are.
          libraries: [
            {
              url: `${asset("/agda-algebras-sources.zip")}?cache=${cacheTokens.agdaAlgebras}`,
              agdaLib: "/agda-algebras/agda-algebras.agda-lib",
              name: "agda-algebras",
              what: "agda-algebras",
            },
            {
              url: `${asset("/plfa/project.zip")}?cache=${cacheTokens.plfaProject}`,
              agdaLib: "/plfa.agda-lib",
              name: "plfa",
              what: "PLFA",
            },
          ],
        },
        files: [PLAYGROUND.library],
        cacheNamespace: driveCacheNamespace,
        // The interface archives the page mounts are kept by their digest
        // (issue 14).
        archiveStore: ARCHIVE_STORE,
        // --raw: the server answers in Agda's own JSON (ResponseJSONRaw),
        // which the engine reads.  ALS drives Agda through its interactive
        // command loop, but unlike the `agda --interaction` executable it
        // does not enable Agda's loaded-file cache by default, so the
        // option is passed explicitly.  The fork's +RTS -A64m -RTS (a 64 MB
        // nursery) is gone: it made no check faster while it grew the heap
        // by 70 to 90 MiB (issue 59).
        args: ["--raw", "+AGDA", "--interaction", "-AGDA"],
        onProgress: (progress) => {
          if ((this.alsWorkerStatus as ALSWorkerStatus) === "terminated") return;
          if (progress.phase === "downloading")
            this.wasmLoadingProgress = { bytesLoaded: progress.loaded, bytesTotal: progress.total };
          else if (progress.phase === "downloaded") this.alsWorkerStatus = "loaded";
          // The drive is ready for archives once the session has opened.
        },
        signal: this.stopper.signal,
      },
      { convertSource: browserAgdaSource, highlighting: "NonInteractive" },
    );
    if (started.kind !== "session") {
      this.driveIsCreated = false;
      if ((this.alsWorkerStatus as ALSWorkerStatus) === "terminated") return 0;
      this.alsWorkerStatus = "errored";
      throw new Error(`Agda could not start: ${started.message}.`, { cause: started });
    }

    const { session, transport } = started;
    this.session = session;
    this.transport = transport;
    this.tools = createToolSurface(session);
    this.driveIsCreated = true;
    this.reportedAgdaVersion = session.agdaVersion;
    session.onResponse((event) => {
      // An answer about another file than the one on screen (a check that
      // was running when a chapter opened) is not this document's.
      if (event.operation.path === this.currentFilePath)
        this.onResponse(event.response, event.operation.command);
    });

    const ended = new Promise<number>((resolve, reject) => {
      session.onStatus((status) => {
        if (status.state === "ended") {
          this.iotcmStatus = "init";
          const ending = session.ending ?? {};
          this.deactivate();
          this.session = undefined;
          this.transport = undefined;
          this.tools = undefined;
          if (this.stopRequested) {
            this.alsWorkerStatus = "terminated";
            resolve(0);
          } else {
            this.alsWorkerStatus = "exited";
            const detail =
              ending.reason === "timeout"
                ? `the ${String(ending.operation)} did not end when it was aborted, so Agda was stopped`
                : typeof ending.detail === "string"
                  ? ending.detail
                  : `the language server stopped (${String(ending.reason)})`;
            reject(new Error(`Agda stopped: ${detail}.`));
          }
        } else this.iotcmStatus = status.state === "busy" ? "processing" : "ready";
      });
    });

    this.alsWorkerStatus = "active";
    this.iotcmStatus = "ready";
    // The drive's caches of other namespaces are deleted; agda-algebras'
    // index is read, and the archives it no longer names are evicted.
    void forgetOtherDriveCaches(driveCacheNamespace).catch((error: unknown) =>
      console.warn("Could not delete the stale drive caches", error),
    );
    void this.readLibraryIndex().then(
      (index) => this.evictStaleArchives(index),
      () => {},
    );
    this.lspClient!.connect(transport.editorChannel);
    this.editorView!.dispatch({
      effects: this.lspClientCompartment.reconfigure(
        this.lspClient!.plugin(`file://${this.currentFilePath}`),
      ),
    });
    return ended;
  }

  terminateALSWASM() {
    this.stopRequested = true;
    this.stopper?.abort();
    this.mountStopper?.abort();
    this.answerConsent?.("cancel", false);
    const session = this.session;
    this.alsWorkerStatus = "terminated";
    this.wasmLoadingProgress = null;
    this.driveIsCreated = false;
    this.driveArchiveLoading = false;
    void session?.dispose();
    this.deactivate();
  }

  deactivate() {
    this.lspClient!.disconnect();
    this.editorView?.dispatch({
      effects: this.lspClientCompartment.reconfigure([]),
    });
  }

  /** Agda's highlighting, goals and edits, applied to the editor as they
   * arrive; its running info, kept for the compiler log. */
  private onResponse(response: Parameters<typeof applyAgdaResponse>[1], command: Parameters<typeof applyAgdaResponse>[2]) {
    if (this.editorView) applyAgdaResponse(this.editorView, response, command);
    if (response.kind === "Status") {
      this.checked = response.status.checked;
      this.showImplicitArgs = response.status.showImplicitArguments;
      this.showIrrelevantArgs = response.status.showIrrelevantArguments;
    } else if (response.kind === "RunningInfo") {
      this.runningMessages = [...this.runningMessages.slice(-49), response.message];
    } else if (response.kind === "ClearRunningInfo") {
      this.runningMessages = [];
    }
  }

  private requireSession() {
    if (!this.session || this.alsWorkerStatus !== "active") throw new Error("Agda is not ready");
    return this.session;
  }

  /** Check the buffer: nothing when Agda already holds it, a give when the
   * only edit is inside one goal, a load of the file otherwise. */
  async loadAgdaFile() {
    if (this.alsWorkerStatus !== "active" || !this.session) {
      throw new Error("Agda is still starting");
    }
    const view = this.editorView;
    if (!view) throw new Error("The Agda editor is not ready");
    const session = this.session;
    const file = this.currentFile;
    const path = file.path;
    const epoch = this.documentEpoch;
    const source = view.state.doc.toString();
    let plan: CheckPlan | undefined;
    const started = performance.now();
    const checking = session.check(path, source, {
      onPlan: (planned) => {
        plan = planned;
        if (planned.kind === "load") {
          // The text Agda will read is now the one its positions refer to.
          view.dispatch({ effects: commit.of() });
          this.persistDocument(source, file);
        }
      },
    });
    if (plan?.kind === "unchanged") {
      this.lastAction = "Already checked";
      await checking;
      return;
    }
    this.lastCheckDurationMs = undefined;
    this.problems = [];
    this.lastResult = null;
    if (plan?.kind === "give") {
      this.lastAction = `Checking goal ${plan.goal}…`;
      this.activeGoalId = plan.goal;
    } else {
      this.lastAction = "Checking source…";
      this.goalInfo = {};
      this.interactionPoints = [];
      this.activeGoalId = undefined;
    }
    const outcome = await checking;
    // Another document replaced this one while Agda checked it.
    if (epoch !== this.documentEpoch) return;
    this.lastCheckDurationMs = performance.now() - started;
    if (outcome.kind !== "answer") return this.operationFailed(outcome);
    const value = outcome.value;
    if (value.plan === "give") {
      this.afterGive(value.give, outcome.responses);
      this.checked = this.getGoals().length === 0 && !this.hasErrors();
    } else if (value.plan === "load") {
      const load = value.load;
      this.problems = [
        ...load.errors.map((message) => ({ severity: "error" as const, message })),
        ...load.warnings.map((message) => ({ severity: "warning" as const, message })),
      ];
      if (load.errors.length)
        this.lastResult = { kind: "Error", title: "Type checking failed", body: load.errors[0] };
      this.setGoals(load.goals);
      this.lspClient!.notification("textDocument/didSave", {
        textDocument: { uri: "file://" + path },
      });
      if (!load.errors.length) {
        void this.transport?.persist().catch((error: unknown) =>
          console.warn("Could not persist the Agda cache", error),
        );
        await this.readActiveContext(epoch);
      }
    }
    this.finishAction();
  }

  /** The selected goal's context, after a load: the inspector shows a goal
   * with what is known there, as a check reports it (issue 11), where it
   * waited for the goal to be selected.  One question to Agda, quietly. */
  private async readActiveContext(epoch: number) {
    const id = this.activeGoalId;
    if (id == null || !this.tools) return;
    const result = await this.tools.get_goal({ goal: id });
    if (epoch !== this.documentEpoch) return;
    if (result.status === "answer") this.keepGoal(result.result as GoalAnswer);
    else console.warn(`Could not read goal ${id}'s context`, toolError(result) ?? result.status);
  }

  /** A goal's type and context, as Agda answered them, kept for the
   * inspector. */
  private keepGoal(answer: GoalAnswer) {
    const context = answer.context.map((entry) => ({ name: entry.name, type: entry.type, inScope: entry.inScope }));
    this.goalInfo = { ...this.goalInfo, [answer.goal]: { id: answer.goal, type: answer.type, context } };
    return context;
  }

  /** The goals an answer lists, for the inspector. */
  private setGoals(goals: GoalView[]) {
    this.interactionPoints = goals.map((goal) => goal.id);
    this.goalInfo = Object.fromEntries(
      goals.map((goal) => [
        goal.id,
        { id: goal.id, type: goal.type, context: this.goalInfo[goal.id]?.context ?? [] },
      ]),
    );
    if (this.activeGoalId == null || !this.interactionPoints.includes(this.activeGoalId))
      this.activeGoalId = this.interactionPoints[0];
  }

  private hasErrors() {
    return this.problems.some((problem) => problem.severity === "error");
  }

  private finishAction() {
    this.lastAction = this.hasErrors()
      ? "Check failed"
      : this.checked
        ? "Checked successfully"
        : "Ready";
  }

  private operationFailed(outcome: Exclude<Outcome<unknown>, { kind: "answer" }>) {
    if (outcome.kind === "failure" && outcome.reason === "aborted") {
      this.lastAction = "Aborted";
      return;
    }
    this.lastAction = "Ready";
    throw new Error(outcome.message);
  }

  /** After a give or a refine: Agda's errors, the goals that remain, and
   * the edited buffer saved where Agda reads it. */
  private afterGive(value: GiveValue, responses: Parameters<typeof messagesOf>[0]) {
    const { errors, warnings } = messagesOf(responses);
    this.problems = [
      ...errors.map((message) => ({ severity: "error" as const, message })),
      ...warnings.map((message) => ({ severity: "warning" as const, message })),
    ];
    if (errors.length)
      this.lastResult = { kind: "Error", title: "Type checking failed", body: errors[0] };
    if (value.accepted) {
      this.setGoals(value.goals);
      void this.saveToDrive();
    }
  }

  /** After a case split, the same. */
  private afterCase(value: MakeCaseValue) {
    if (value.error) {
      this.problems = [{ severity: "error", message: value.error }];
      this.lastResult = { kind: "Error", title: "Type checking failed", body: value.error };
    } else if (value.edit) void this.saveToDrive();
  }

  /** Write the buffer where Agda reads it, and persist the drive.  It does
   * not move Agda's positions: those refer to the text it loaded. */
  private async saveToDrive() {
    const view = this.editorView;
    const transport = this.transport;
    const file = this.currentFile;
    if (!view || !transport) return;
    const doc = view.state.doc.toString();
    this.persistDocument(doc, file);
    try {
      await transport.writeSource(file.path, browserAgdaSource(file.path, doc));
    } catch (error) {
      console.warn("Could not save the buffer where Agda reads it", error);
      return;
    }
    this.lspClient!.notification("textDocument/didSave", {
      textDocument: { uri: "file://" + file.path },
    });
    try {
      await transport.persist();
    } catch (error) {
      console.warn("Could not persist the Agda cache", error);
    }
  }

  /** Mount archives on the drive, those not yet mounted: `what` is whose
   * interfaces they hold, for the status line ("PLFA's", "agda-algebras'"),
   * `bytes`, when known, what they cost, which the status line states
   * before the first byte is fetched, and `fetching` false for archives the
   * browser keeps, which are read from its store and never downloaded.  A
   * stop is not a failure: it throws `MountStopped`, which the page shows
   * as the outcome it is, and an archive planned as kept that the store has
   * lost throws `ArchiveNotKept`, so the plan is made again. */
  async mountDriveArchives(
    archives: readonly (string | MountedArchive)[],
    what: string,
    { bytes, fetching = true }: { bytes?: number; fetching?: boolean } = {},
  ): Promise<void> {
    const transport = this.transport;
    if (!transport || !this.driveIsCreated) throw new Error("Agda filesystem is not ready");
    const missing = transport.unmounted(archives);
    if (!missing.length) return;
    const count = `${missing.length} ${missing.length === 1 ? "archive" : "archives"}`;
    this.mounting += 1;
    this.driveArchiveLoading = true;
    this.lastAction = !fetching
      ? `Mounting ${count} of ${what} interfaces, kept in this browser…`
      : bytes === undefined
        ? `Fetching ${count} of ${what} interfaces…`
        : `Fetching ${count} of ${what} interfaces, ${sizeWithBytes(bytes)}…`;
    const stopper = new AbortController();
    this.mountStopper = stopper;
    this.mount = { library: what, loaded: 0, total: bytes, mounted: 0, archives: missing.length, fetching };
    try {
      await transport.mountArchives(missing, {
        signal: stopper.signal,
        onProgress: (progress) => {
          this.mount = {
            library: what,
            loaded: progress.loaded,
            total: progress.total ?? bytes,
            mounted: progress.mounted,
            archives: progress.archives,
            fetching,
          };
        },
      });
      // A stop that came when nothing was left to download (the archives
      // read from the store, or the last extractions) still stops.
      if (stopper.signal.aborted) throw stopper.signal.reason;
      this.lastAction = `${what[0].toUpperCase()}${what.slice(1)} interfaces are mounted`;
    } catch (error) {
      if (stopper.signal.aborted) {
        const mounted = missing.length - transport.unmounted(missing).length;
        this.lastAction = `Stopped: ${mounted} of ${count} mounted`;
        throw new MountStopped(this.lastAction);
      }
      this.lastAction = "Ready";
      if (error instanceof ArchiveNotKept) throw error;
      throw new Error(`${describe(error)}.`, { cause: error });
    } finally {
      this.mounting -= 1;
      this.driveArchiveLoading = this.mounting > 0;
      this.mount = null;
      if (this.mountStopper === stopper) this.mountStopper = undefined;
    }
  }

  /** Stop the mount under way. */
  stopMount() {
    this.mountStopper?.abort();
  }

  /** agda-algebras' archive index: fetched once, its bytes checked against
   * the digest the build recorded, and read.  A failure is not kept: the
   * next check that needs the index asks for it again. */
  readLibraryIndex(): Promise<ArchiveIndex> {
    if (this.libraryIndex) return this.libraryIndex;
    const library = AGDA_ALGEBRAS.description;
    const what = "agda-algebras' archive index";
    const reading = (async () => {
      if (!library) throw new Error(`${what} is not in this build (${AGDA_ALGEBRAS.error})`);
      let response: Response;
      try {
        response = await fetch(library.index.url);
      } catch (error) {
        throw new Error(`${what} could not be downloaded (${describe(error)})`, { cause: error });
      }
      if (!response.ok)
        throw new Error(`${what} could not be downloaded (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""})`);
      const data = await response.arrayBuffer();
      const digest = await sha256Hex(data);
      if (digest !== library.index.sha256)
        throw new Error(`${what} is not the one this page was built with (its SHA-256 is ${digest.slice(0, 16)}, not ${library.index.sha256.slice(0, 16)})`);
      const parsed = parseArchiveIndex(JSON.parse(new TextDecoder().decode(data)));
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    })();
    this.libraryIndex = reading;
    reading.catch(() => {
      if (this.libraryIndex === reading) this.libraryIndex = undefined;
    });
    return reading;
  }

  /** Evict the archives the browser keeps that the index no longer names:
   * an archive whose digest changed is fetched again when a check needs it. */
  private async evictStaleArchives(index: ArchiveIndex) {
    const evicted = await this.transport
      ?.retainArchives("agda-algebras", Object.values(index.archives).map((archive) => archive.sha256))
      .catch((error: unknown) => {
        console.warn("Could not evict the stale archives", error);
        return [];
      });
    if (evicted?.length) console.info(`Evicted ${evicted.length} archives that agda-algebras' index no longer names`);
  }

  /** Before a check of the playground's Main: mount the archives its
   * imports need, asking first when any is to be fetched (issue 14).
   * `automatic` is a check the reader did not ask for (the first, when Agda
   * is ready), whose question does not take the keyboard's focus.  False
   * when the reader cancelled, or stopped the mount, and nothing is to be
   * checked.  One plan at a time: a second check while one is planned
   * waits for it, and the page counts planning as busy. */
  prepareImports({ automatic = false }: { automatic?: boolean } = {}): Promise<boolean> {
    if (this.planned) return this.planned;
    this.planning = true;
    const planned = this.planUntilSettled(automatic).finally(() => {
      this.planned = undefined;
      this.planning = false;
    });
    this.planned = planned;
    return planned;
  }

  /** The plan of the text on screen, made again (at most twice) when the
   * text's imports changed while it was made, or the store lost an archive
   * the plan counted as kept: the check that follows reads the text then
   * on screen, and its imports must be the planned ones.  A plan still
   * unsettled after that is not checked: the reader is told to check
   * again. */
  private async planUntilSettled(automatic: boolean): Promise<boolean> {
    const imports = () => {
      const view = this.editorView;
      if (!view) return [];
      const kind = sourceKind(this.currentFilePath) ?? "agda";
      return (importedModules(view.state.doc.toString(), kind) ?? []).filter((name) => !isBuiltinModule(name));
    };
    for (let attempt = 0; ; attempt++) {
      const planned = imports();
      const outcome = await this.planOnce(planned, automatic);
      if (outcome === "stop") return false;
      if (outcome === "check" && imports().join("\n") === planned.join("\n")) return true;
      if (attempt >= 2) {
        // The note, not the status line, which a page at rest does not show.
        this.planNote =
          outcome === "again"
            ? "Not checked: the browser's store lost archives as they were mounted; check again."
            : "Not checked: the imports changed while their archives were planned; check again.";
        return false;
      }
    }
  }

  /** One plan, and its mount: "check" when the check may go on, "stop"
   * when it must not, and "again" when an archive the plan counted as kept
   * is gone. */
  private async planOnce(imports: string[], automatic: boolean): Promise<"check" | "stop" | "again"> {
    const transport = this.transport;
    this.planNote = "";
    // Builtins alone (the default Main) need no plan and no index.
    if (!transport || !imports.length) return "check";
    const library = AGDA_ALGEBRAS.description;
    if (!library) {
      this.planNote = `This build has no archives of agda-algebras' interfaces (${AGDA_ALGEBRAS.error}), so Agda checks its modules from source.`;
      return "check";
    }
    if (!globalThis.crypto?.subtle) {
      this.planNote =
        "agda-algebras' interfaces cannot be checked against their digests here (the page is not served from a secure origin, https or localhost), so none is mounted, and Agda checks its modules from source.";
      return "check";
    }
    let index: ArchiveIndex;
    try {
      index = await this.readLibraryIndex();
    } catch (error) {
      this.planNote = `${describe(error)}, so Agda checks agda-algebras' modules from source; reload the page to try again.`;
      return "check";
    }
    if (this.reportedAgdaVersion && index.agda.version !== this.reportedAgdaVersion) {
      this.planNote = `agda-algebras' interfaces are Agda ${index.agda.version}'s and this is Agda ${this.reportedAgdaVersion}, so Agda checks its modules from source.`;
      return "check";
    }
    const plan = await planImports(index, imports, {
      includes: PLAYGROUND.includes,
      read: (source) => transport.readSource(source).catch(() => undefined),
    });
    const notes: string[] = [];
    if (plan.fromSource.length)
      notes.push(`Not in agda-algebras' index, so checked from source: ${plan.fromSource.join(", ")}.`);
    if (plan.unread.length)
      notes.push(`The page cannot read the imports of ${plan.unread.join(", ")}, so what they import is checked from source too.`);
    if (plan.missing.length) notes.push(`Not found: ${plan.missing.join(", ")}.`);
    const note = (more: string) => (this.planNote = [...notes, more].filter(Boolean).join(" "));
    note("");
    const refs = transport.unmounted(
      archiveRefs(index, plan.archives, library).map((archive) => ({
        ...archive,
        library: "agda-algebras",
        what: `agda-algebras' archive ${archive.path}`,
      })),
    );
    // An archive whose every interface the drive already holds (an earlier
    // check wrote them, and the drive's cache restored them) is not
    // mounted: Agda accepts an interface by its source's hash and its
    // imports' (iFullHash), which one built in the browser from the same
    // sources shares with the archive's.
    const interfaces = interfacesByArchive(index);
    const present = await transport.present(refs.flatMap((archive) => interfaces.get(archive.path) ?? []));
    const needed = refs.filter((archive) => !(interfaces.get(archive.path) ?? []).every((file) => present.has(file)));
    if (!needed.length) return "check";
    const kept = await transport.kept(needed.map((archive) => archive.sha256));
    const keptRefs = needed.filter((archive) => kept.has(archive.sha256));
    let fetchRefs = needed.filter((archive) => !kept.has(archive.sha256));
    const bytes = fetchRefs.reduce((sum, archive) => sum + archive.bytes, 0);
    if (fetchRefs.length) {
      const choice = await this.choose(
        {
          library: "agda-algebras",
          archives: fetchRefs.length,
          bytes,
          modules: fetchRefs.reduce((sum, archive) => sum + archive.modules, 0),
          unknown: plan.fromSource,
          focus: !automatic,
        },
        fetchRefs,
      );
      if (choice === "cancel") {
        this.lastAction = "Not checked";
        return "stop";
      }
      if (choice === "source") {
        // What the browser keeps costs nothing to mount, and is mounted.
        note("agda-algebras' interfaces were not fetched, so Agda checks the modules they hold from source.");
        fetchRefs = [];
      }
    }
    try {
      // What the browser keeps first, read from its store and never
      // fetched, then what the reader agreed to fetch.
      if (keptRefs.length)
        await this.mountDriveArchives(
          keptRefs.map((archive) => ({ ...archive, fetch: false as const })),
          "agda-algebras'",
          { fetching: false },
        );
      if (fetchRefs.length) await this.mountDriveArchives(fetchRefs, "agda-algebras'", { bytes });
    } catch (error) {
      if (error instanceof MountStopped) {
        note(`${error.message}; nothing was checked.`);
        return "stop";
      }
      // The store lost an archive it kept: plan again, which states and
      // asks for what is now to be fetched.
      if (error instanceof ArchiveNotKept) return "again";
      throw new Error(`${describe(error)}; nothing was checked.`, { cause: error });
    }
    return "check";
  }

  /** The reader's answer to fetching `archives`: the one remembered for
   * the tab; "source" when every one of them was declined before in this
   * tab; or the page's question, which states the bytes of all of them, the
   * declined among them, since a check that needs new archives asks again
   * for the whole set rather than fetch part of it with no word: nothing is
   * fetched that the question did not state, and the reader may decline
   * again. */
  private async choose(
    request: Omit<ConsentRequest, "declined">,
    archives: readonly { url: string; bytes: number }[],
  ): Promise<ConsentChoice> {
    const remembered = tabStorage.get(rememberedChoiceKey(request.library));
    if (remembered === "fetch" || remembered === "source") return remembered;
    const declined = new Set<string>(safeJsonArray(tabStorage.get(declinedKey(request.library))));
    const urls = archives.map((archive) => archive.url);
    if (urls.every((url) => declined.has(url))) return "source";
    const again = archives.filter((archive) => declined.has(archive.url));
    // A question still open is answered "cancel" before another is asked.
    this.answerConsent?.("cancel", false);
    const { choice, remember } = await new Promise<{ choice: ConsentChoice; remember: boolean }>((resolve) => {
      this.answerConsent = (choice, remember) => resolve({ choice, remember });
      this.consent = {
        ...request,
        declined: { archives: again.length, bytes: again.reduce((sum, archive) => sum + archive.bytes, 0) },
      };
    });
    this.consent = null;
    this.answerConsent = undefined;
    if (remember && choice !== "cancel") tabStorage.set(rememberedChoiceKey(request.library), choice);
    if (choice === "source")
      tabStorage.set(declinedKey(request.library), JSON.stringify([...new Set([...declined, ...urls])]));
    return choice;
  }

  /** The page's answer to the consent question it shows. */
  answer(choice: ConsentChoice, remember = false) {
    this.answerConsent?.(choice, remember);
  }

  getGoals() {
    if (!this.editorView) return [];
    return getAgdaGoals(this.editorView.state);
  }

  getActiveGoal() {
    if (!this.editorView) return undefined;
    if (this.activeGoalId != null) {
      const selected = getAgdaGoalById(
        this.editorView.state,
        this.activeGoalId,
      );
      if (selected) return selected;
    }
    return getActiveAgdaGoal(this.editorView.state);
  }

  selectGoal(id: number) {
    if (!this.editorView) return;
    const goal = getAgdaGoalById(this.editorView.state, id);
    if (!goal) return;
    this.activeGoalId = id;
    this.editorView.dispatch({
      selection: { anchor: Math.min(goal.from + 2, goal.to) },
      scrollIntoView: true,
    });
    this.editorView.focus();
  }

  private requireGoal() {
    const goal = this.getActiveGoal();
    if (!goal)
      throw new Error("Place the cursor in a goal and load the file first");
    this.activeGoalId = goal.id;
    const ref = this.requireSession().goalRef(goal.id);
    if (!ref) throw new Error(`Goal ${goal.id} is not among the goals of Agda's last check; check the file again`);
    return { goal, ref };
  }

  /** The inspector's question about a goal, through the tool surface: the
   * goal named, even one that has no place in the editor (a refine's), or
   * else the goal at the cursor. */
  private async askGoal(id: number | undefined, show: "type" | "context") {
    if (id != null) this.selectGoal(id);
    const goalId = id ?? this.requireGoal().goal.id;
    if (id != null) this.activeGoalId = id;
    this.lastAction =
      show === "type" ? `Inspecting goal ${goalId}…` : `Loading context for goal ${goalId}…`;
    const result = await this.tools!.get_goal({ goal: goalId });
    const error = toolError(result);
    if (error) {
      this.lastAction = "Ready";
      throw new Error(error);
    }
    if (result.status !== "answer") return;
    const answer = result.result as GoalAnswer;
    const context = this.keepGoal(answer);
    this.lastResult =
      show === "type"
        ? { kind: "GoalType", title: `Goal ${answer.goal}`, body: answer.type }
        : {
            kind: "Context",
            title: `Context for goal ${answer.goal}`,
            body: context.map((entry) => `${entry.name} : ${entry.type}`).join("\n") || "Empty context",
          };
    this.finishAction();
  }

  queryGoalType(id?: number) {
    return this.askGoal(id, "type");
  }

  queryContext(id?: number) {
    return this.askGoal(id, "context");
  }

  async give(expression?: string) {
    const { goal, ref } = this.requireGoal();
    const value =
      expression?.trim() || getAgdaGoalContents(this.editorView!.state, goal);
    if (!value) throw new Error("Enter an expression to give");
    this.lastAction = `Giving goal ${goal.id}…`;
    const outcome = await this.requireSession().give(ref, value);
    if (outcome.kind !== "answer") return this.operationFailed(outcome);
    this.afterGive(outcome.value, outcome.responses);
    this.finishAction();
  }

  async refine(expression?: string) {
    const { goal, ref } = this.requireGoal();
    const value =
      expression?.trim() || getAgdaGoalContents(this.editorView!.state, goal);
    this.lastAction = `Refining goal ${goal.id}…`;
    const outcome = await this.requireSession().refine(ref, value);
    if (outcome.kind !== "answer") return this.operationFailed(outcome);
    this.afterGive(outcome.value, outcome.responses);
    this.finishAction();
  }

  async caseSplit(patterns = "") {
    const { goal, ref } = this.requireGoal();
    this.lastAction = `Splitting goal ${goal.id}…`;
    const outcome = await this.requireSession().makeCase(ref, patterns);
    if (outcome.kind !== "answer") return this.operationFailed(outcome);
    this.afterCase(outcome.value);
    this.finishAction();
  }

  /** An expression's type or normal form, through the tool surface. */
  private async askExpression(tool: "type_of" | "normalize", expression: string, goal?: number) {
    const result = await this.tools![tool]({ expression, ...(goal == null ? {} : { goal }) });
    const error = toolError(result);
    if (error) {
      this.lastAction = "Ready";
      throw new Error(error);
    }
    if (result.status !== "answer") return;
    const answer = result.result as { type?: string; normalForm?: string; error?: string };
    if (answer.error !== undefined) {
      this.problems = [{ severity: "error", message: answer.error }];
      this.lastResult = { kind: "Error", title: "Type checking failed", body: answer.error };
    } else if (tool === "type_of")
      this.lastResult = { kind: "InferredType", title: "Inferred type", body: answer.type ?? "" };
    else this.lastResult = { kind: "NormalForm", title: "Normal form", body: answer.normalForm ?? "" };
    this.finishAction();
  }

  /** Agda answers an expression in the scope of the file it holds: if
   * that is not the file on screen, check this one first.  (The fork named
   * the file in the command, and Agda loaded it.) */
  private async holdCurrentFile() {
    if (this.requireSession().basis?.path !== this.currentFilePath) await this.checkCurrentFile();
    // A check the reader cancelled leaves Agda without this file's scope.
    if (this.requireSession().basis?.path !== this.currentFilePath)
      throw new Error(`${this.currentFilePath.split("/").pop()} was not checked, so Agda cannot answer in its scope`);
  }

  async infer(expression: string) {
    if (!expression.trim()) throw new Error("Enter an expression to infer");
    await this.holdCurrentFile();
    this.lastAction = "Inferring type…";
    return this.askExpression("type_of", expression);
  }

  async normalize(expression: string) {
    if (!expression.trim()) throw new Error("Enter an expression to normalize");
    await this.holdCurrentFile();
    const goal = this.getActiveGoal();
    this.lastAction = "Normalizing expression…";
    if (goal) this.activeGoalId = goal.id;
    return this.askExpression("normalize", expression, goal?.id);
  }

  async abort() {
    this.lastAction = "Aborting…";
    this.session?.abort();
  }

  /** Keep `source` as `file`'s text in the browser, if the page saves it:
   * a library's module it never does. */
  persistDocument(source: string, file: DocumentFile = this.currentFile) {
    if (file.storageKey) localStorage.setItem(file.storageKey, source);
  }

  /** Whether `path` is open in the editor. */
  isOpen(path: string) {
    return this.openFiles.some((file) => file.path === path);
  }

  /** Show `file` in the editor: its state as it was last shown, or a new
   * one with `text` the first time it opens.  Each file has a state of its
   * own (issue 10), with its own history, so undo never crosses files, and
   * the state left keeps its text, its selection and its history.  What
   * Agda answered is the file's it answered for: the inspector starts
   * afresh, a check still running is not applied, and the next check of a
   * file loads it. */
  showDocument(file: DocumentFile, text?: string) {
    const view = this.editorView;
    if (!view || file.path === this.currentFilePath) return;
    let next = this.documents.get(file.path);
    if (!next) {
      if (text === undefined || !this.createState) throw new Error(`${file.path} is not open`);
      next = this.createState(file, text);
    }
    // The state left is kept without the language server's plugin, which
    // only the state on screen holds, and with where it was scrolled to.
    this.scrolled.set(this.currentFilePath, view.scrollSnapshot());
    this.documents.keep(view.state.update({ effects: this.lspClientCompartment.reconfigure([]) }).state);
    this.documents.keep(next);
    if (!this.isOpen(file.path)) this.openFiles = [...this.openFiles, fileOf(next) ?? file];
    // The file shown gains it: the client opens the file on the server
    // with the text shown (didOpen), as the left one's is closed.
    if (this.alsWorkerStatus === "active")
      next = next.update({
        effects: this.lspClientCompartment.reconfigure(this.lspClient!.plugin(`file://${file.path}`)),
      }).state;
    this.documentEpoch += 1;
    // The editor no longer shows what Agda holds.
    this.session?.reloadNext("the editor shows another file");
    this.currentFile = fileOf(next) ?? file;
    this.checked = false;
    this.problems = [];
    this.interactionPoints = [];
    this.goalInfo = {};
    this.activeGoalId = undefined;
    this.lastResult = null;
    this.lastCheckDurationMs = undefined;
    this.planNote = "";
    view.setState(next);
    // Where it was left, or a file opened for the first time at its top.
    view.dispatch({ effects: this.scrolled.get(file.path) ?? EditorView.scrollIntoView(0, { y: "start" }) });
  }

  /** Close a file that is not on screen: its state, and its history, are
   * forgotten; its text stays where the page keeps it.  Main stays open. */
  closeDocument(path: string) {
    if (path === this.currentFilePath || path === PLAYGROUND.file) return;
    this.documents.close(path);
    this.scrolled.delete(path);
    this.openFiles = this.openFiles.filter((file) => file.path !== path);
  }

}

/** An error in its own words. */
function describe(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
}

/** A JSON array of strings from storage, or none. */
function safeJsonArray(text: string | null): string[] {
  try {
    const value = JSON.parse(text ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** The SHA-256 of `data`, in hex, by the browser's own implementation
 * (a secure context: https, or localhost). */
async function sha256Hex(data: ArrayBuffer) {
  if (!globalThis.crypto?.subtle)
    throw new Error("the page is not served from a secure origin (https, or localhost), so the browser computes no SHA-256");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A mount the reader stopped: an outcome, not a failure. */
export class MountStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MountStopped";
  }
}

/** Each archive's interfaces, by their paths on the drive. */
const archiveInterfaces = new WeakMap<ArchiveIndex, Map<string, string[]>>();
function interfacesByArchive(index: ArchiveIndex): Map<string, string[]> {
  let map = archiveInterfaces.get(index);
  if (!map) {
    map = new Map();
    for (const module of Object.values(index.modules))
      if (module.archive !== null) map.set(module.archive, [...(map.get(module.archive) ?? []), module.interface]);
    archiveInterfaces.set(index, map);
  }
  return map;
}

