<script lang="ts">
  // File: src/routes/+page.svelte
  //
  // Changed from upstream: this is SeungheonOh/plfa-playground's
  // src/routes/+page.svelte at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
  // (docs/provenance.md).  The cache token of PLFA's interface manifest
  // and archives comes from $lib/assets, which the build derives from the
  // files, instead of a value maintained by hand (issue 3).  The page runs
  // Agda 2.9.0, and its status bar shows the version the language server
  // reports, in place of a literal "Agda 2.8" (issue 58): since the page
  // runs the server's reactor build, the version Agda gives when the
  // controller asks for it.  The page allocates no SharedArrayBuffer, since
  // the server and the drive share one worker, and so no longer requires
  // cross-origin isolation, or checks for it (issue 59).  Before it starts
  // Agda, the page checks that the browser has what it needs
  // ($lib/support), and says so when it does not; when Agda cannot start,
  // or its server stops of its own accord, the page says why, in the
  // banner, the inspector's heading and the status bar, rather than "Agda
  // ready" (issue 8).  Colors use the shared tokens in static/theme.css
  // (issue 17).  The playground's Main.agda is /play/Main.agda, a module of
  // a project of its own over the standard library and agda-algebras
  // ($lib/controller.svelte, PLAYGROUND; issue 11).  The Explorer is one
  // tree (ExplorerTree, from the views package; issue 9) of three
  // sections: the playground, every module of agda-algebras, from the
  // list the build writes (agda-algebras-modules.json), and PLFA's
  // chapters, by part.  Its rows stay focusable while Agda is busy (the
  // playground's files, the chapters and agda-algebras' modules, which open
  // only while Agda is idle, are aria-disabled then), which rows are
  // expanded is kept in localStorage, and the open file is revealed and
  // marked current.  Activating the open file's row moves to it rather
  // than loading it again.  The editor keeps a state of its own for each
  // open file, with its own history, shown with setState (issue 10,
  // $lib/documents), so undo never crosses files, and each file's edits
  // are saved under its own key whichever file is on screen; the open
  // files are tabs.  A module of agda-algebras opens read-only from the
  // Explorer, while Agda is idle: its text is the drive's, which is never
  // written, loaded so that hover, Infer and Normalize answer in its
  // scope, after the archives of its own closure are mounted; a line
  // above it says it is the checked library, links its page on
  // agda-algebras' site, and copies it, or the selection, into a file of
  // the playground's project, under /play/ ($lib/playground), or adds its
  // `open import` to Main.  Before a check of a playground file, or a load
  // of a library's module, the page mounts the interface archives it
  // needs, and before it fetches one it shows how many bytes and asks
  // (issue 14): the question sits at the foot of the code pane, as the
  // minibuffer does, with no spinner, since nothing is under way while it
  // waits; the fetch shows its progress in the inspector's heading, with a
  // STOP.

  import { onDestroy, onMount } from "svelte";
  import { setThemePreference, watchTheme, type ThemePreference } from "$lib/theme";
  import { basicSetup } from "codemirror";
  import { startCompletion } from "@codemirror/autocomplete";
  import { EditorState, Prec, type Extension } from "@codemirror/state";
  import { EditorView, keymap } from "@codemirror/view";
  import { marked } from "marked";
  import {
    ArrowLeft,
    ArrowRight,
    BookOpen,
    Braces,
    CircleAlert,
    CircleCheck,
    Copy,
    Download,
    ExternalLink,
    FileCode,
    FileInput,
    FolderOpen,
    Info,
    ListChecks,
    LoaderCircle,
    Lock,
    RotateCcw,
    Sigma,
    Split,
    SquareTerminal,
    TriangleAlert,
    WandSparkles,
    X,
    Zap,
  } from "@lucide/svelte";

  import {
    AgdaController,
    LS_DOC_KEY,
    MAIN_FILE,
    MountStopped,
    PLAYGROUND,
    formatDuration,
    sizeWithBytes,
  } from "$lib/controller.svelte";
  import {
    DocumentSaver,
    documentFile,
    readOnlyDocument,
    type DocumentFile,
  } from "$lib/documents";
  import {
    PLAYGROUND_DIR,
    moduleCopy,
    openImportEdit,
    playgroundModuleOf,
    playgroundTarget,
    selectionCopy,
  } from "$lib/playground";
  import { missingFeatures, unsupportedBrowserNotice } from "$lib/support";
  import { cacheTokens } from "$lib/assets";
  import { asset } from "$app/paths";
  import { myCodeMirrorTheme } from "$lib/codemirror/theme";
  import { agdaCompletions } from "$lib/codemirror/completion";
  import { symbolInput } from "$lib/codemirror/symbol-input";
  import {
    agdaSourceLanguage,
    literateAgdaLanguage,
  } from "$lib/codemirror/agda-language";
  import { agdaSupport } from "$lib/agda";
  import {
    ExplorerTree,
    GoalList,
    moduleTree,
    ProblemList,
    ResultView,
    type TreeItem,
  } from "@agda-native-ide/views";
  import {
    archiveUrls,
    chapters as corpusChapters,
    parseCorpusManifest,
    parseInterfaceManifest,
    parseLibraryManifest,
    planChapterArchives,
    statedProgress,
    statedSize,
    type Chapter,
    type CorpusManifest,
    type InterfaceManifest,
    type LibraryManifest,
  } from "@agda-native-ide/manifest";

  // The playground's default Main.agda (issue 11): agda-algebras' options
  // line, builtins alone, and one goal whose context is worth reading.
  const DEFAULT_SOURCE = `{-# OPTIONS --without-K --exact-split --safe #-}

-- The playground.  Main's project depends on the standard library and
-- agda-algebras, and Main has agda-algebras' options line: --safe refuses
-- a postulate here as the library would.  Main imports only Agda's
-- builtins, whose interfaces the page ships, so a check is quick; for a
-- module of either library (open import Setoid.Algebras.Basic, say) the
-- page offers to fetch the interfaces it needs, stating the bytes first.
module Main where

open import Agda.Builtin.Equality using (_≡_; refl)
open import Agda.Builtin.List     using (List; []; _∷_)
open import Agda.Builtin.Nat      using (Nat; zero; suc; _+_)

cong : {A B : Set} (f : A → B) {x y : A} → x ≡ y → f x ≡ f y
cong f refl = refl
trans : {A : Set} {x y z : A} → x ≡ y → y ≡ z → x ≡ z
trans refl q = q

-- h : A → B is a homomorphism when it carries _·_ to _*_.
IsHom : {A B : Set} → (A → A → A) → (B → B → B) → (A → B) → Set
IsHom _·_ _*_ h = ∀ x y → h (x · y) ≡ h x * h y

-- The composite of two homomorphisms is one.  The goal is the last step:
-- read its context, then give the term that fills it.
∘-hom : {A B C : Set} {_·_ : A → A → A} {_*_ : B → B → B} {_⋆_ : C → C → C}
        (g : B → C) (f : A → B)
      → IsHom _*_ _⋆_ g → IsHom _·_ _*_ f → IsHom _·_ _⋆_ (λ a → g (f a))
∘-hom g f g-hom f-hom x y = trans (cong g (f-hom x y)) {! !}

-- The length of a list is a homomorphism from lists under _++_ to the
-- naturals under _+_.
infixr 5 _++_
_++_ : {A : Set} → List A → List A → List A
[]       ++ ys = ys
(x ∷ xs) ++ ys = x ∷ xs ++ ys

length : {A : Set} → List A → Nat
length []       = zero
length (x ∷ xs) = suc (length xs)

length-hom : {A : Set} → IsHom _++_ _+_ (length {A})
length-hom []       ys = refl
length-hom (x ∷ xs) ys = cong suc (length-hom xs ys)
`;

  type CommandKind = "give" | "refine" | "case" | "infer" | "normalize" | "copy";
  type InspectorMode = "goals" | "result" | "problems";
  type WorkspaceMode = "playground" | "plfa";
  type ActiveResource = "markdown" | "agda";

  type PlfaChapter = Chapter;

  /** Where the Explorer keeps which of its rows are expanded, and what it
   * shows on a first visit: its three sections, and PLFA's first part. */
  const EXPLORER_KEY = "agda-web-ide-beta:explorer:expanded";
  const EXPLORER_DEFAULT = ["section:play", "section:agda-algebras", "section:plfa", "plfa:part1"];

  function storedExplorerExpanded(): string[] {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(EXPLORER_KEY) ?? "null");
      if (Array.isArray(stored) && stored.every((id) => typeof id === "string")) return stored;
    } catch {
      // Refused or unreadable storage: the first visit's rows.
    }
    return EXPLORER_DEFAULT;
  }

  const controller = new AgdaController({
    agdaVersion: "2.9.0",
  });
  /** Each file's edits saved under its own key, 250 ms after the last
   * (issue 10). */
  const saver = new DocumentSaver((key, text) => {
    try {
      localStorage.setItem(key, text);
    } catch (error) {
      console.warn(`Could not keep ${key} in the browser`, error);
    }
  });
  /** What every file's editor state has (the page's keys, its listener,
   * its theme), made with the editor. */
  let editorExtensions: Extension = [];
  /** A module's page on agda-algebras' site, which renders each module at
   * its path ([M1-11], issue 19): Overture.Signatures at
   * /Overture/Signatures/. */
  const libraryPage = (module: string) =>
    `https://agda-algebras.universalalgebra.org/${module.split(".").join("/")}/`;

  let editorHost: HTMLDivElement;
  let editor: EditorView | undefined;
  let readerContent = $state<HTMLDivElement>();
  let inspectorPreference = $state<"auto" | "goals">("auto");
  let filesOpen = $state(true);
  let themePreference = $state<ThemePreference>("system");
  let workspaceMode = $state<WorkspaceMode>("playground");
  let activeResource = $state<ActiveResource>("agda");
  let explorerExpanded = $state<string[]>(storedExplorerExpanded());
  let libraryModules = $state<LibraryManifest | null>(null);
  let libraryError = $state("");
  let plfaManifest = $state<CorpusManifest | null>(null);
  let plfaInterfaceManifest = $state<InterfaceManifest | null>(null);
  let plfaInterfaceManifestPromise: Promise<InterfaceManifest | null> | null =
    null;
  let plfaManifestPromise: Promise<CorpusManifest | null> = Promise.resolve(null);
  let selectedChapterId = $state("part1/Naturals");
  let plfaMarkdown = $state("");
  let plfaLoading = $state(false);
  let plfaError = $state("");
  let commandKind = $state<CommandKind | null>(null);
  let commandValue = $state("");
  let actionError = $state("");
  let startupError = $state("");
  let inspectorWidth = $state(390);
  let didAutoLoad = false;
  let stopWatchingThemeChanges: (() => void) | undefined;
  let globalKeydown: ((event: KeyboardEvent) => void) | undefined;
  let editorScrollHandler: (() => void) | undefined;
  let readerScrollFrame = 0;
  let editorScrollFrame = 0;
  let scrollSyncOwner: "reader" | "editor" | null = null;
  let scrollSyncRelease: ReturnType<typeof setTimeout> | undefined;
  let chapterRequest = 0;
  /** A copy's selection, taken when the copy's minibuffer opens. */
  let copySelection = $state<{ from: number; to: number; lines: number } | null>(null);

  const plfaChapters = $derived(
    plfaManifest ? corpusChapters(plfaManifest) : [],
  );
  const selectedChapter = $derived(
    plfaChapters.find((chapter) => chapter.id === selectedChapterId),
  );
  const selectedChapterIndex = $derived(
    plfaChapters.findIndex((chapter) => chapter.id === selectedChapterId),
  );
  const plfaHtml = $derived(
    plfaMarkdown ? renderPlfaMarkdown(plfaMarkdown) : "",
  );
  const plfaCodeBlocks = $derived.by(() => {
    const ranges: Array<{ from: number; to: number }> = [];
    const opening = /^```agda[^\n]*\n/gm;
    for (const match of plfaMarkdown.matchAll(opening)) {
      const from = (match.index ?? 0) + match[0].length;
      const closing = plfaMarkdown.indexOf("\n```", from);
      ranges.push({ from, to: closing < 0 ? from : closing });
    }
    return ranges;
  });
  const editorFileName = $derived(fileName(controller.currentFilePath));
  /** The library's module on screen, read-only (issue 10). */
  const currentLibrary = $derived(controller.currentFile.library);

  const isAgdaBusy = $derived(controller.iotcmStatus === "processing");
  // Work under way, which shows a spinner: Agda's, or a mount's.
  const isWorking = $derived(isAgdaBusy || controller.driveArchiveLoading);
  // Nothing else may start: work is under way, or the page waits for the
  // reader's answer to its question (issue 14), which shows no spinner.
  const isBusy = $derived(isWorking || controller.consent !== null || controller.planning);
  const compilerReady = $derived(
    controller.alsWorkerStatus === "active" &&
      controller.iotcmStatus === "ready",
  );
  /** Whether a module of agda-algebras opens now: it is read from the
   * drive and loaded, so Agda must be up and idle (issue 10). */
  const libraryOpens = $derived(compilerReady && !isBusy);
  const consentRequest = $derived(controller.consent);
  let consentRemember = $state(false);
  let consentForm = $state<HTMLFormElement>();

  // agda-algebras' rows, built once from its module list, and again with
  // each module aria-disabled, for while the page cannot open one.
  const libraryItems = $derived(
    libraryModules ? moduleTree(libraryModules.modules, "agda-algebras:") : null,
  );
  const libraryItemsDisabled = $derived(libraryItems ? disabledModules(libraryItems) : null);
  // A section's rows while they load, or why they could not.
  const message = (id: string, error: string, loading: string): TreeItem => ({
    id,
    label: error || loading,
    kind: error ? "error" : "message",
  });
  // The Explorer's sections.  The playground's files and PLFA's chapters
  // open only while Agda is idle, as the page has always done, so they are
  // aria-disabled meanwhile; agda-algebras' modules, which Agda loads when
  // they open, also while it starts (issue 10).
  const explorerItems = $derived.by((): TreeItem[] => [
    {
      id: "section:play",
      label: "Playground",
      kind: "section",
      children: [PLAYGROUND.file, ...controller.playgroundFiles].map((path) => ({
        id: path === PLAYGROUND.file ? "play:Main" : `play:${path}`,
        label: path.slice(`${PLAYGROUND_DIR}/`.length),
        kind: "file" as const,
        path,
        name: playgroundModuleOf(path),
        title: path,
        mark: "Saved locally",
        disabled: isBusy,
      })),
    },
    {
      id: "section:agda-algebras",
      label: "agda-algebras",
      kind: "section",
      title: libraryModules
        ? `agda-algebras at ${libraryModules.commit?.slice(0, 8) ?? "its pin"}: ${libraryModules.modules.length} modules`
        : undefined,
      children: (libraryOpens ? libraryItems : libraryItemsDisabled) ?? [
        message("agda-algebras:message", libraryError, "Loading the modules…"),
      ],
    },
    {
      id: "section:plfa",
      label: "PLFA",
      kind: "section",
      children: plfaManifest
        ? plfaManifest.groups.map((group) => ({
            id: `plfa:${group.id}`,
            label: group.title,
            kind: "folder" as const,
            title: group.title,
            children: group.chapters.map((chapter) => ({
              id: `plfa:${chapter.id}`,
              label: `${chapter.name}.lagda.md`,
              kind: "module" as const,
              path: chapter.modulePath,
              name: chapter.modulePath
                .slice(1)
                .replace(/\.lagda\.md$/, "")
                .split("/")
                .join("."),
              title: chapter.title,
              disabled: isBusy,
            })),
          }))
        : [message("plfa:message", plfaError, "Indexing")],
    },
  ]);
  /** The same tree, every module (and folder that is a module) aria-disabled. */
  function disabledModules(items: TreeItem[]): TreeItem[] {
    return items.map((item) => ({
      ...item,
      ...(item.path ? { disabled: true } : {}),
      ...(item.children ? { children: disabledModules(item.children) } : {}),
    }));
  }
  // Agda did not start (this browser lacks what the page needs, or a step
  // of the startup failed), or its server stopped of its own accord.  The
  // banner says which.
  const agdaFailed = $derived(startupError !== "");
  const agdaFailedLabel = $derived(
    controller.alsWorkerStatus === "exited"
      ? "Agda stopped"
      : "Agda did not start",
  );
  const compilerStarting = $derived(
    !agdaFailed &&
      (controller.alsWorkerStatus === "initial" ||
        controller.alsWorkerStatus === "loading" ||
        controller.alsWorkerStatus === "loaded"),
  );
  const progress = $derived.by(() => {
    const loaded = controller.wasmLoadingProgress?.bytesLoaded ?? 0;
    const total = controller.wasmLoadingProgress?.bytesTotal ?? 0;
    return total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  });
  const compilerLoadingLabel = $derived(
    controller.alsWorkerStatus === "loaded" ? "Starting Agda" : "Loading Agda",
  );
  const checkDurationLabel = $derived(
    controller.lastCheckDurationMs == null
      ? ""
      : formatDuration(controller.lastCheckDurationMs),
  );
  const currentGoals = $derived(
    controller.interactionPoints.map(
      (id) => controller.goalInfo[id] ?? { id, context: [] },
    ),
  );
  const inspectorMode = $derived.by((): InspectorMode => {
    if (inspectorPreference === "goals") return "goals";
    if (controller.problems.length) return "problems";
    if (
      controller.lastResult &&
      ["InferredType", "NormalForm", "Version"].includes(
        controller.lastResult.kind,
      )
    )
      return "result";
    return "goals";
  });
  // A mount's progress: by bytes, in the unit of their total.
  const mountLabel = $derived.by(() => {
    const mount = controller.mount;
    if (!mount) return "";
    if (!mount.fetching)
      return `Mounting ${mount.library} interfaces kept in this browser: ${mount.mounted} of ${mount.archives}`;
    // PLFA's archives come with no sizes: their count, and the bytes so far.
    return mount.total
      ? `Fetching ${mount.library} interfaces: ${statedProgress(mount.loaded, mount.total)}`
      : `Fetching ${mount.library} interfaces: ${mount.mounted} of ${mount.archives} archives, ${statedSize(mount.loaded)}`;
  });
  const inspectorHeading = $derived(
    agdaFailed
      ? agdaFailedLabel
      : compilerStarting
        ? `${compilerLoadingLabel} ${progress}%`
        : consentRequest
          ? `Fetch ${statedSize(consentRequest.bytes)} of agda-algebras' interfaces?`
          : mountLabel
            ? mountLabel
            : isBusy
          ? controller.lastAction
          : inspectorMode === "problems"
            ? `${controller.problems.length} problem${controller.problems.length === 1 ? "" : "s"}${checkDurationLabel ? ` · ${checkDurationLabel}` : ""}`
            : inspectorMode === "result"
              ? (controller.lastResult?.title ?? "Result")
              : currentGoals.length
                ? `${currentGoals.length} open goal${currentGoals.length === 1 ? "" : "s"}${checkDurationLabel ? ` · ${checkDurationLabel}` : ""}`
                : controller.checked
                  ? `Module checked${checkDurationLabel ? ` · ${checkDurationLabel}` : ""}`
                  : "Waiting for check",
  );


  /** A path's last part: the name a tab shows. */
  function fileName(path: string) {
    return path.slice(path.lastIndexOf("/") + 1);
  }

  const commandMeta: Record<
    CommandKind,
    { title: string; description: string; placeholder: string; action: string }
  > = {
    give: {
      title: "Give expression",
      description:
        "Check this expression against the selected goal and replace the hole.",
      placeholder: "expression",
      action: "Give",
    },
    refine: {
      title: "Refine goal",
      description:
        "Insert the expression and let Agda create any required subgoals.",
      placeholder: "constructor or expression (optional)",
      action: "Refine",
    },
    case: {
      title: "Split on variable",
      description:
        "Generate clauses by pattern matching. Leave blank to split on the result.",
      placeholder: "variable, e.g. n",
      action: "Split",
    },
    infer: {
      title: "Infer a type",
      description: "Infer an expression in the current module scope.",
      placeholder: "expression",
      action: "Infer",
    },
    normalize: {
      title: "Normalize expression",
      description:
        "Evaluate an expression to normal form in the current scope.",
      placeholder: "expression",
      action: "Normalize",
    },
    copy: {
      title: "Copy to the playground",
      description:
        "The copy's module name: the file is that name's path under /play/, which the copy's module line names.",
      placeholder: "module name, e.g. Signatures",
      action: "Copy",
    },
  };

  onMount(() => {
    themePreference = document.documentElement.dataset.theme === "dark"
      ? "dark" : document.documentElement.dataset.theme === "light" ? "light" : "system";
    const stopWatchingTheme = watchTheme();
    stopWatchingThemeChanges = stopWatchingTheme;
    editorExtensions = [
      basicSetup,
      myCodeMirrorTheme(),
      agdaSupport(),
      agdaCompletions(),
      symbolInput(),
      Prec.highest(
        keymap.of([
          {
            key: "Ctrl-c Ctrl-l",
            run: () => runCheck(),
          },
          {
            key: "Ctrl-c Ctrl-f",
            run: () => moveGoal(1),
          },
          {
            key: "Ctrl-c Ctrl-b",
            run: () => moveGoal(-1),
          },
          {
            key: "Ctrl-c Ctrl-Space",
            run: () => runEditorAction(() => controller.give()),
          },
          {
            key: "Ctrl-c Ctrl-r",
            run: () => runEditorAction(() => controller.refine()),
          },
          {
            key: "Ctrl-c Ctrl-c",
            run: () => openEditorCommand("case"),
          },
          {
            key: "Ctrl-c Ctrl-t",
            run: () => runEditorAction(() => controller.queryGoalType()),
          },
          {
            key: "Ctrl-c Ctrl-e",
            run: () => runEditorAction(() => controller.queryContext()),
          },
          {
            key: "Ctrl-c Ctrl-d",
            run: () => openEditorCommand("infer"),
          },
          {
            key: "Ctrl-c Ctrl-n",
            run: () => openEditorCommand("normalize"),
          },
          {
            key: "Ctrl-c Ctrl-?",
            run: () => showGoals(),
          },
          {
            // Stops a mount or Agda's command: both are under way when it
            // is pressed, so it is not held back as other commands are.
            key: "Ctrl-c Ctrl-x Ctrl-a",
            run: () => {
              stopWork();
              return true;
            },
          },
          {
            key: "Ctrl-Space",
            run: startCompletion,
          },
          {
            key: "Mod-Enter",
            run: () => runCheck(),
          },
        ]),
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          // The question was about the text before this edit.
          if (controller.consent) answerConsent("cancel");
          inspectorPreference = "goals";
          if (workspaceMode === "plfa")
            plfaMarkdown = update.state.doc.toString();
          // Saved under the key of the file edited, whichever is on
          // screen when the save runs (issue 10).
          saver.schedule(update.state);
        }
        if (update.selectionSet) {
          const head = update.state.selection.main.head;
          const selected = controller
            .getGoals()
            .find((goal) => goal.from <= head && head <= goal.to);
          if (selected) {
            controller.activeGoalId = selected.id;
            inspectorPreference = "goals";
          }
        }
      }),
      EditorView.theme({
        "&": { background: "var(--editor-surface)", color: "var(--editor-text)", fontSize: "14px" },
        ".cm-scroller": { overscrollBehavior: "contain", lineHeight: "1.72" },
        ".cm-content": { padding: "18px 0 80px" },
        ".cm-gutters": {
          background: "var(--editor-gutter-surface)",
          color: "var(--editor-gutter-text)",
          borderRight: "1px solid var(--editor-line)",
        },
        ".cm-activeLine, .cm-activeLineGutter": { background: "var(--editor-active-line)" },
        ".cm-cursor": { borderLeftColor: "var(--editor-cursor)", borderLeftWidth: "2px" },
        ".agda-hole": {
          background: "var(--goal-surface)",
          outline: "1px solid var(--goal-line)",
          borderRadius: "0",
        },
        ".agda-goal-marker": {
          background: "var(--editor-cursor)",
          color: "var(--goal-marker-text)",
          borderRadius: "0",
          padding: "0 5px",
          marginRight: "3px",
          fontSize: "10px",
          fontFamily: "Inter, sans-serif",
        },
        ".cm-tooltip": {
          border: "1px solid var(--tooltip-line)",
          borderRadius: "0",
          boxShadow: "none",
          background: "var(--surface)",
        },
        ".cm-lsp-documentation": {
          padding: "9px 11px",
          fontFamily: "JuliaMono, monospace",
          fontSize: "12px",
        },
        ".symbol-input-candidates": {
          background: "var(--surface)",
          border: "1px solid var(--tooltip-line)",
          boxShadow: "none",
        },
      }),
    ];
    editor = new EditorView({
      state: createEditorState(MAIN_FILE, localStorage.getItem(LS_DOC_KEY) ?? DEFAULT_SOURCE),
      parent: editorHost,
    });
    controller.connectEditorView(editor, createEditorState);
    editorScrollHandler = () => scheduleScrollSync("editor");
    editor.scrollDOM.addEventListener("scroll", editorScrollHandler, {
      passive: true,
    });

    globalKeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        runCheck();
      } else if (event.key === "Escape") {
        if (controller.consent) {
          event.preventDefault();
          answerConsent("cancel");
        } else if (commandKind) {
          commandKind = null;
          editor?.focus();
        }
      }
    };
    window.addEventListener("keydown", globalKeydown, { capture: true });
    // A reload or a navigation away saves what waits.
    window.addEventListener("pagehide", flushSaves);

    plfaManifestPromise = fetch("/plfa/manifest.json")
      .then((response) => {
        if (!response.ok) throw new Error("Could not load the PLFA index");
        return response.json();
      })
      .then((json) => {
        const parsed = parseCorpusManifest(json);
        if (!parsed.ok) throw new Error(`Could not read the PLFA index: ${parsed.error}`);
        plfaManifest = parsed.value;
        return parsed.value;
      })
      .catch((error) => {
        plfaError = readableError(error);
        return null;
      });

    void loadPlfaInterfaceManifest();

    fetch(
      `${asset("/agda-algebras-modules.json")}?cache=${cacheTokens.agdaAlgebrasModules}`,
    )
      .then((response) => {
        if (!response.ok)
          throw new Error(`Could not load agda-algebras' modules (HTTP ${response.status})`);
        return response.json();
      })
      .then((json) => {
        const parsed = parseLibraryManifest(json);
        if (!parsed.ok)
          throw new Error(`Could not read agda-algebras' modules: ${parsed.error}`);
        libraryModules = parsed.value;
      })
      .catch((error) => (libraryError = readableError(error)));

    const missing = missingFeatures();
    if (missing.length) {
      startupError = unsupportedBrowserNotice(missing);
      return;
    }
    void controller.startALSWASM().catch((error) => {
      if (controller.alsWorkerStatus !== "terminated")
        startupError = readableError(error);
    });
  });

  const flushSaves = () => saver.flush();

  /** A file's editor state (issue 10): its own text, history and language,
   * the language server's place (empty until the file is shown with Agda
   * up), read-only for a library's module, and what every state has. */
  function createEditorState(file: DocumentFile, text: string) {
    return EditorState.create({
      doc: text,
      extensions: [
        documentFile.of(file),
        file.library ? readOnlyDocument() : [],
        file.path.endsWith(".lagda.md") ? literateAgdaLanguage() : agdaSourceLanguage(),
        controller.lspClientCompartment.of([]),
        editorExtensions,
      ],
    });
  }

  function loadPlfaInterfaceManifest() {
    if (plfaInterfaceManifestPromise) return plfaInterfaceManifestPromise;
    plfaInterfaceManifestPromise = fetch(
      `/plfa/interfaces/manifest.json?cache=${cacheTokens.plfaInterfaces}`,
    )
      .then((response) => {
        if (!response.ok)
          throw new Error("Could not load the PLFA cache index");
        return response.json();
      })
      .then(async (json) => {
        // Checked against the chapters it names, so a chapter's archive
        // that is not a chapter is refused rather than fetched.
        const corpus = await plfaManifestPromise;
        const parsed = parseInterfaceManifest(json, corpus ?? undefined);
        if (!parsed.ok) throw new Error(parsed.error);
        plfaInterfaceManifest = parsed.value;
        return parsed.value;
      })
      .catch((error) => {
        // Without it, a chapter mounts every chapter's archives up to it.
        console.warn("The PLFA cache index is not used:", readableError(error));
        plfaInterfaceManifest = null;
        return null;
      });
    return plfaInterfaceManifestPromise;
  }

  $effect(() => {
    if (compilerReady && !didAutoLoad) {
      didAutoLoad = true;
      if (workspaceMode === "playground")
        setTimeout(() => {
          if (!isBusy) void runAction(() => checkCurrentFile({ automatic: true }));
        }, 50);
    }
  });

  onDestroy(() => {
    stopWatchingThemeChanges?.();
    // What waits to be saved is saved now, not dropped.
    flushSaves();
    if (scrollSyncRelease) clearTimeout(scrollSyncRelease);
    if (readerScrollFrame) cancelAnimationFrame(readerScrollFrame);
    if (editorScrollFrame) cancelAnimationFrame(editorScrollFrame);
    if (globalKeydown) {
      window.removeEventListener("keydown", globalKeydown, { capture: true });
      window.removeEventListener("pagehide", flushSaves);
    }
    if (editorScrollHandler && editor)
      editor.scrollDOM.removeEventListener("scroll", editorScrollHandler);
    controller.terminateALSWASM();
    editor?.destroy();
  });

  function readableError(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function renderPlfaMarkdown(source: string) {
    let blockIndex = 0;
    const codeOffsets = [...source.matchAll(/^```agda[^\n]*\n/gm)].map(
      (match) => (match.index ?? 0) + match[0].length,
    );
    const frontmatter = source.match(/^---\n[\s\S]*?\n---\n?/);
    const bodyOffset = frontmatter?.[0].length ?? 0;
    const markdownSource = source
      .slice(bodyOffset)
      .replace(
        /^#{1,6}\s+.+$/gm,
        (heading, offset) =>
          `<span class="source-scroll-anchor" data-source-offset="${bodyOffset + offset}"></span>\n${heading}`,
      )
      .replace(/\s+\{#([^}]+)\}(?=\n)/g, '\n<a id="$1"></a>')
      .replace(/^\{:[^}]+\}\s*$/gm, "");
    return (marked.parse(markdownSource) as string).replace(
      /<pre><code class="language-agda">/g,
      () =>
        `<pre class="agda-source-block" data-agda-block="${blockIndex}" data-source-offset="${codeOffsets[blockIndex++] ?? 0}" tabindex="0" title="Jump to this block in the literate source"><code class="language-agda">`,
    );
  }

  function claimScrollSync(owner: "reader" | "editor") {
    scrollSyncOwner = owner;
    if (scrollSyncRelease) clearTimeout(scrollSyncRelease);
    scrollSyncRelease = setTimeout(() => (scrollSyncOwner = null), 120);
  }

  function readerScrollPoints() {
    if (!readerContent || !editor) return [];
    const container = readerContent;
    const view = editor;
    const containerRect = container.getBoundingClientRect();
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const points = Array.from(
      container.querySelectorAll<HTMLElement>("[data-source-offset]"),
      (element) => ({
        source: Number(element.dataset.sourceOffset),
        top: Math.max(
          0,
          Math.min(
            maxTop,
            element.getBoundingClientRect().top -
              containerRect.top +
              container.scrollTop,
          ),
        ),
      }),
    ).filter((point) => Number.isFinite(point.source));
    points.push(
      { source: 0, top: 0 },
      { source: view.state.doc.length, top: maxTop },
    );
    return points.sort(
      (left, right) => left.top - right.top || left.source - right.source,
    );
  }

  function interpolateScroll(
    points: Array<{ source: number; top: number }>,
    value: number,
    input: "source" | "top",
    output: "source" | "top",
  ) {
    if (!points.length) return 0;
    const sorted = [...points].sort(
      (left, right) => left[input] - right[input],
    );
    if (value <= sorted[0][input]) return sorted[0][output];
    for (let index = 1; index < sorted.length; index++) {
      const upper = sorted[index];
      if (value > upper[input]) continue;
      const lower = sorted[index - 1];
      const span = upper[input] - lower[input];
      const ratio = span ? (value - lower[input]) / span : 0;
      return lower[output] + (upper[output] - lower[output]) * ratio;
    }
    return sorted.at(-1)?.[output] ?? 0;
  }

  function scheduleScrollSync(origin: "reader" | "editor") {
    if (workspaceMode !== "plfa" || !readerContent || !editor) return;
    if (scrollSyncOwner && scrollSyncOwner !== origin) return;
    claimScrollSync(origin);

    if (origin === "reader") {
      if (readerScrollFrame) return;
      readerScrollFrame = requestAnimationFrame(() => {
        readerScrollFrame = 0;
        if (!readerContent || !editor) return;
        const source = interpolateScroll(
          readerScrollPoints(),
          readerContent.scrollTop,
          "top",
          "source",
        );
        const block = editor.lineBlockAt(Math.round(source));
        const top = Math.max(0, block.top + editor.documentPadding.top);
        if (Math.abs(editor.scrollDOM.scrollTop - top) > 2)
          editor.scrollDOM.scrollTop = top;
      });
      return;
    }

    if (editorScrollFrame) return;
    editorScrollFrame = requestAnimationFrame(() => {
      editorScrollFrame = 0;
      if (!readerContent || !editor) return;
      const editorRect = editor.scrollDOM.getBoundingClientRect();
      const documentHeight = Math.max(
        0,
        (editorRect.top - editor.documentTop) / editor.scaleY,
      );
      const source = editor.lineBlockAtHeight(documentHeight).from;
      const top = interpolateScroll(
        readerScrollPoints(),
        source,
        "source",
        "top",
      );
      if (Math.abs(readerContent.scrollTop - top) > 2)
        readerContent.scrollTop = top;
    });
  }

  async function runAction(action: () => Promise<unknown>) {
    actionError = "";
    inspectorPreference = "auto";
    try {
      await action();
    } catch (error) {
      // A stopped mount is an outcome, which the status line states.
      if (!(error instanceof MountStopped)) actionError = readableError(error);
    }
  }

  function plfaInterfaceUrls(chapter: PlfaChapter) {
    if (!plfaManifest) return [];
    return archiveUrls(
      planChapterArchives(plfaManifest, plfaInterfaceManifest, chapter.id),
      "/plfa/interfaces",
      cacheTokens.plfaInterfaces,
    );
  }

  async function ensurePlfaInterfaces(chapter = selectedChapter) {
    if (!chapter) return Promise.resolve();
    await loadPlfaInterfaceManifest();
    await controller.mountDriveArchives(plfaInterfaceUrls(chapter), "PLFA's");
  }

  async function checkCurrentFile({ automatic = false }: { automatic?: boolean } = {}) {
    if (workspaceMode === "plfa") await ensurePlfaInterfaces();
    else {
      // The minibuffer gives way to the question, if one is asked.
      commandKind = null;
      if (!(await controller.prepareImports({ automatic }))) return;
    }
    await controller.loadAgdaFile();
  }
  controller.checkCurrentFile = checkCurrentFile;

  /** The reader's answer to the question before a fetch. */
  function answerConsent(choice: "fetch" | "source" | "cancel") {
    const remember = consentRemember;
    consentRemember = false;
    controller.answer(choice, remember);
    setTimeout(() => editor?.focus());
  }

  // The question takes the keyboard's focus only when the reader asked for
  // the check: on the automatic first check, Enter in the editor must not
  // answer it.
  $effect(() => {
    if (consentRequest?.focus && consentForm)
      consentForm.querySelector<HTMLButtonElement>(".consent-fetch")?.focus();
  });

  /** Stop what is under way: a mount, or else Agda's command. */
  function stopWork() {
    if (controller.driveArchiveLoading) controller.stopMount();
    else if (isAgdaBusy) void runAction(() => controller.abort());
  }

  function runCheck() {
    if (!compilerReady || isBusy) return true;
    void runAction(checkCurrentFile);
    return true;
  }

  function runEditorAction(action: () => Promise<unknown>) {
    if (compilerReady && !isBusy) void runAction(action);
    return true;
  }

  function openEditorCommand(kind: CommandKind) {
    if (compilerReady && !isBusy) openCommand(kind);
    return true;
  }

  function moveGoal(direction: -1 | 1) {
    const goals = controller.getGoals();
    if (!goals.length) return true;
    const active = controller.getActiveGoal();
    const current = Math.max(
      0,
      goals.findIndex((goal) => goal.id === active?.id),
    );
    const next = (current + direction + goals.length) % goals.length;
    selectGoal(goals[next].id);
    return true;
  }

  function showGoals() {
    inspectorPreference = "goals";
    const goal = controller.getActiveGoal();
    if (goal) controller.selectGoal(goal.id);
    return true;
  }

  function openCommand(kind: CommandKind) {
    actionError = "";
    commandKind = kind;
    if (kind === "copy") {
      // The selection, if any, is what is copied; the name offered is the
      // module's last part.
      const range = editor?.state.selection.main;
      const doc = editor?.state.doc;
      // A selection that ends at a line's start does not take that line.
      copySelection =
        range && doc && !range.empty
          ? {
              from: range.from,
              to: range.to,
              lines:
                doc.lineAt(range.to).number -
                doc.lineAt(range.from).number +
                (range.to === doc.lineAt(range.to).from ? 0 : 1),
            }
          : null;
      commandValue = currentLibrary?.module.split(".").pop() ?? "";
      // Then the first such name Agda finds nowhere, unless the reader has
      // typed meanwhile.
      const offered = commandValue;
      if (currentLibrary)
        void freeCopyName(currentLibrary.module).then((name) => {
          if (commandKind === "copy" && commandValue === offered) commandValue = name;
        });
    } else if (kind === "give" || kind === "refine") {
      const goal = controller.getActiveGoal();
      commandValue =
        goal && editor
          ? editor.state.doc
              .sliceString(goal.from + 2, Math.max(goal.from + 2, goal.to - 2))
              .trim()
          : "";
    } else commandValue = "";
    setTimeout(() =>
      document.querySelector<HTMLInputElement>("#command-input")?.focus(),
    );
  }

  async function submitCommand() {
    if (!commandKind) return;
    const kind = commandKind;
    const value = commandValue;
    await runAction(async () => {
      if (kind === "give") await controller.give(value);
      else if (kind === "refine") await controller.refine(value);
      else if (kind === "case") await controller.caseSplit(value);
      else if (kind === "infer") await controller.infer(value);
      else if (kind === "copy") await copyToPlayground(value);
      else await controller.normalize(value);
      commandKind = null;
      setTimeout(() => editor?.focus());
    });
  }

  function selectGoal(id: number) {
    controller.selectGoal(id);
    inspectorPreference = "goals";
    if (compilerReady && !isBusy)
      void runAction(() => controller.queryGoalType(id));
  }

  async function openPlfaChapter(chapter: PlfaChapter) {
    if (isBusy) return;
    const request = ++chapterRequest;
    workspaceMode = "plfa";
    activeResource = "markdown";
    selectedChapterId = chapter.id;
    plfaLoading = true;
    plfaError = "";

    try {
      const file: DocumentFile = {
        path: chapter.modulePath,
        storageKey: `agda-web-ide-beta:plfa-lagda:${chapter.id}`,
      };
      // A chapter open already is shown as it was left (issue 10).
      let source: string | undefined;
      if (!controller.isOpen(file.path)) {
        const sourceResponse = await fetch(chapter.sourcePath);
        if (!sourceResponse.ok) throw new Error(`Could not open ${chapter.name}`);
        const originalSource = await sourceResponse.text();
        if (request !== chapterRequest) return;
        source = localStorage.getItem(file.storageKey!) ?? originalSource;
      }
      controller.showDocument(file, source);
      plfaMarkdown = editor?.state.doc.toString() ?? "";
      // The editor's scroll (where the chapter was left, or its top) is
      // applied in its next measure; the reader follows it, rather than
      // its reset to the top dragging the editor back.
      claimScrollSync("editor");
      readerContent?.scrollTo({ top: 0 });
      requestAnimationFrame(() => scheduleScrollSync("editor"));
      if (controller.driveIsCreated)
        void runAction(() => ensurePlfaInterfaces(chapter));
    } catch (error) {
      if (request === chapterRequest) plfaError = readableError(error);
    } finally {
      if (request === chapterRequest) plfaLoading = false;
    }
  }

  /** Open a file of the playground's project: Main, or a copy (issue 10),
   * as it was left, or from the text the browser keeps; then check it. */
  function openPlayground(file: DocumentFile = MAIN_FILE) {
    if (isBusy) return;
    chapterRequest++;
    workspaceMode = "playground";
    activeResource = "agda";
    const source = controller.isOpen(file.path)
      ? undefined
      : (localStorage.getItem(file.storageKey!) ?? (file.path === PLAYGROUND.file ? DEFAULT_SOURCE : ""));
    controller.showDocument(file, source);
    setTimeout(() => editor?.focus());
    if (compilerReady)
      setTimeout(() => {
        if (!isBusy) void runAction(() => checkCurrentFile({ automatic: true }));
      }, 50);
  }

  /** Open a module of agda-algebras read-only (issue 10): the drive's copy,
   * which is the checked library, never written; loaded, after its
   * closure's archives are mounted (asking first, issue 14), so that
   * hover, Infer and Normalize answer in its scope. */
  async function openLibraryModule(item: TreeItem) {
    if (!item.path || !item.name || isBusy) return;
    // A module open already is shown whether or not Agda is up; one opened
    // anew is read from the drive, so it needs Agda.
    const open = controller.isOpen(item.path);
    if (!open && !libraryOpens) return;
    const request = ++chapterRequest;
    const file: DocumentFile = {
      path: item.path,
      library: { library: "agda-algebras", module: item.name },
    };
    try {
      const text = open ? undefined : await controller.readLibrarySource(file.path);
      if (request !== chapterRequest || isBusy) return;
      workspaceMode = "playground";
      activeResource = "agda";
      controller.showDocument(file, text);
      setTimeout(() => editor?.focus());
      // The reader asked for it: a question before a fetch takes the focus.
      if (compilerReady) void runAction(() => checkCurrentFile());
    } catch (error) {
      actionError = readableError(error);
    }
  }

  /** Copy the library's module on screen, or its selection, into a file of
   * the playground's project, named `name` (issue 10); open it editable,
   * and check it.  A name Agda finds already (in the playground, a library,
   * or the builtins) is refused: the copy would not check, or would make an
   * import of that name ambiguous. */
  async function copyToPlayground(name: string) {
    const library = controller.currentFile.library;
    if (!library || !editor) throw new Error("Open a module of agda-algebras to copy it");
    if (isBusy) throw new Error("Agda is busy; copy when it is done");
    const selection = copySelection;
    const target = playgroundTarget(name, selection ? ".agda" : ".lagda.md");
    if ("error" in target) throw new Error(target.error);
    const found = await controller.findModule(target.module);
    if (found)
      throw new Error(
        `Agda finds ${target.module} at ${found} already, so a copy named so would not check; name it otherwise`,
      );
    const source = editor.state.doc.toString();
    const copy = selection
      ? selectionCopy(source, library.module, target.module, selection)
      : { text: moduleCopy(source, library.module, target.module), at: 0 };
    if (copy?.text === undefined) throw new Error(`${library.module} declares no module line to rename`);
    const file = await controller.createPlaygroundFile(target.path, copy.text);
    copySelection = null;
    openPlayground(file);
    // A selection's copy is shown at the selection.
    if (selection && controller.currentFilePath === file.path && copy.at <= editor.state.doc.length)
      editor.dispatch({ selection: { anchor: copy.at }, effects: EditorView.scrollIntoView(copy.at, { y: "center" }) });
  }

  /** A name for a copy of `module` that Agda finds nowhere yet: its last
   * part, or that with a number after it (many modules share a last
   * part, and some are a library's top-level module). */
  async function freeCopyName(module: string) {
    const base = module.split(".").pop() ?? module;
    for (let n = 1; n < 100; n++) {
      const name = n === 1 ? base : `${base}${n}`;
      if (!(await controller.findModule(name))) return name;
    }
    return base;
  }

  /** Add `open import` of the library's module on screen to Main, and show
   * Main, which is then checked (issue 10).  Main that opens it already is
   * shown with its cursor on that line. */
  function importIntoMain() {
    const library = controller.currentFile.library;
    if (!library || isBusy) return;
    openPlayground(MAIN_FILE);
    if (!editor || controller.currentFilePath !== PLAYGROUND.file) return;
    const text = editor.state.doc.toString();
    const edit = openImportEdit(text, library.module);
    if (edit && "at" in edit) editor.dispatch({ selection: { anchor: edit.at }, scrollIntoView: true });
    else if (edit)
      editor.dispatch({
        changes: { from: edit.from, insert: edit.insert },
        selection: { anchor: edit.from + edit.insert.trimEnd().length },
        scrollIntoView: true,
      });
  }

  /** Which Explorer rows are expanded, kept for the next visit. */
  function setExplorerExpanded(expanded: string[]) {
    explorerExpanded = expanded;
    try {
      localStorage.setItem(EXPLORER_KEY, JSON.stringify(expanded));
    } catch {
      // A refused store still expands the rows for this visit.
    }
  }

  /** A file the Explorer or a tab opens: a file of the playground, a PLFA
   * chapter, or a module of agda-algebras, read-only (issue 10).  The file
   * on screen is not opened again, which would reset the cursor and the
   * reader; the focus moves to it instead. */
  function openFromExplorer(item: TreeItem) {
    if (item.path === controller.currentFilePath)
      return focusResource(workspaceMode === "plfa" ? "markdown" : "agda");
    if (item.path) openPath(item.path, item);
  }

  /** Open the file at `path`: `item`, the Explorer's row, names a library's
   * module. */
  function openPath(path: string, item?: TreeItem) {
    if (path === controller.currentFilePath) return focusResource(workspaceMode === "plfa" ? "markdown" : "agda");
    if (playgroundModuleOf(path)) return openPlayground(path === PLAYGROUND.file ? MAIN_FILE : controller.playgroundFile(path));
    const chapter = plfaChapters.find((entry) => entry.modulePath === path);
    if (chapter) return void openPlfaChapter(chapter);
    const open = controller.openFiles.find((file) => file.path === path)?.library;
    const module = item?.name ?? open?.module;
    if (module) void openLibraryModule({ id: `agda-algebras:${module}`, label: module, kind: "module", path, name: module });
  }

  /** Close a tab: its file's state, and its history, are forgotten; the
   * file on screen gives way to Main first. */
  function closeTab(path: string) {
    if (isBusy || path === PLAYGROUND.file) return;
    if (path === controller.currentFilePath) openPlayground(MAIN_FILE);
    if (path !== controller.currentFilePath) controller.closeDocument(path);
  }

  function focusResource(resource: ActiveResource) {
    activeResource = resource;
    if (resource === "agda") setTimeout(() => editor?.focus());
    else readerContent?.focus();
  }

  function moveChapter(direction: -1 | 1) {
    const chapter = plfaChapters[selectedChapterIndex + direction];
    if (chapter) void openPlfaChapter(chapter);
  }

  function handleReaderClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null;
    const sourceBlock = target?.closest<HTMLElement>("[data-agda-block]");
    if (sourceBlock) {
      const range = plfaCodeBlocks[Number(sourceBlock.dataset.agdaBlock)];
      if (!range || !editor) return;
      event.preventDefault();
      activeResource = "agda";
      claimScrollSync("reader");
      editor.dispatch({
        selection: { anchor: range.from },
        effects: EditorView.scrollIntoView(range.from, { y: "start" }),
      });
      editor.focus();
      return;
    }

    const anchor = target?.closest("a");
    const href = anchor?.getAttribute("href");
    if (!href?.startsWith("/")) return;

    const [pathname, fragment] = href.split("#", 2);
    const chapterName = decodeURIComponent(pathname)
      .split("/")
      .filter(Boolean)
      .at(-1);
    const chapter = plfaChapters.find(
      (candidate) =>
        candidate.name.toLowerCase() === chapterName?.toLowerCase(),
    );
    if (!chapter) return;

    event.preventDefault();
    void openPlfaChapter(chapter).then(() => {
      if (!fragment) return;
      setTimeout(() =>
        readerContent
          ?.querySelector<HTMLElement>(`#${CSS.escape(fragment)}`)
          ?.scrollIntoView({ block: "start" }),
      );
    });
  }

  function beginResize(event: PointerEvent) {
    const startX = event.clientX,
      startWidth = inspectorWidth;
    const move = (next: PointerEvent) =>
      (inspectorWidth = Math.max(
        300,
        Math.min(620, startWidth + startX - next.clientX),
      ));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }
</script>

<svelte:head><title>Agda Playground: Agda in your browser</title></svelte:head>

<main class="app-shell" style={`--inspector-width: ${inspectorWidth}px`}>
  {#if startupError}<div class="fatal-banner">
      <CircleAlert size={18} /><span>{startupError}</span>
    </div>{/if}

  <section
    class:files-closed={!filesOpen}
    class:lesson-workspace={workspaceMode === "plfa"}
    class="workspace"
  >
    <aside class="activitybar" aria-label="Workspace navigation">
      <button
        class:active={filesOpen}
        class="activity"
        aria-label={filesOpen ? "Hide files" : "Show files"}
        aria-expanded={filesOpen}
        onclick={() => (filesOpen = !filesOpen)}
        title={filesOpen ? "Hide files" : "Show files"}
        ><FolderOpen size={19} /></button
      >
    </aside>
    <aside class="explorer" aria-label="Explorer">
      <div class="section-label">EXPLORER</div>
      <ExplorerTree
        label="Files"
        filterLabel="Filter files by name"
        items={explorerItems}
        expanded={explorerExpanded}
        current={controller.currentFilePath}
        onexpandedchange={setExplorerExpanded}
        onopen={openFromExplorer}
      />
    </aside>

    <section class:lesson-open={workspaceMode === "plfa"} class="editor-pane">
      {#if workspaceMode === "plfa"}
        <section class="reader-pane" aria-label="PLFA chapter">
          <div class="reader-tabs">
            <button
              class="reader-tab active"
              onclick={() => focusResource("markdown")}
            >
              <BookOpen size={15} /><span>{editorFileName}</span>
            </button>
          </div>
          <div class="reader-nav">
            <button
              onclick={() => moveChapter(-1)}
              disabled={selectedChapterIndex <= 0 || plfaLoading}
              aria-label="Previous PLFA chapter"
              title="Previous chapter"><ArrowLeft size={14} /></button
            >
            <strong>{selectedChapter?.title ?? "PLFA"}</strong>
            <button
              onclick={() => moveChapter(1)}
              disabled={selectedChapterIndex >= plfaChapters.length - 1 ||
                plfaLoading}
              aria-label="Next PLFA chapter"
              title="Next chapter"><ArrowRight size={14} /></button
            >
          </div>
          <div
            class="reader-content"
            bind:this={readerContent}
            tabindex="-1"
            onclick={handleReaderClick}
            onscroll={() => scheduleScrollSync("reader")}
          >
            {#if plfaLoading}
              <div class="reader-state">
                <LoaderCircle size={15} class="spin" />Opening chapter
              </div>
            {:else if plfaError}
              <div class="reader-state error">
                <CircleAlert size={15} />{plfaError}
              </div>
            {:else}
              <article class="markdown-body">{@html plfaHtml}</article>
            {/if}
          </div>
          <footer class="reader-status">
            <a
              href={plfaManifest?.source ?? "https://plfa.github.io"}
              target="_blank"
              rel="noreferrer">PLFA</a
            ><span>CC BY 4.0</span><span class="status-spacer"></span><span
              >{selectedChapterIndex + 1}/{plfaChapters.length}</span
            >
          </footer>
        </section>
      {/if}
      <section class="code-pane">
        <div class="editor-tabs">
          <div class="editor-tab-list" role="toolbar" aria-label="Open files">
            {#each controller.openFiles as file (file.path)}
              {@const current = file.path === controller.currentFilePath}
              <div class="editor-tab" class:active={current} title={file.path}>
                <button
                  class="editor-tab-open"
                  aria-current={current ? "page" : undefined}
                  aria-disabled={!current && isBusy ? "true" : undefined}
                  onclick={() => (current ? focusResource("agda") : !isBusy && openPath(file.path))}
                >
                  {#if file.library}<Lock size={13} />{:else}<FileCode size={15} />{/if}<span
                    >{fileName(file.path)}</span
                  >
                </button>
                {#if file.path !== PLAYGROUND.file}<button
                    class="tab-close"
                    aria-label={`Close ${fileName(file.path)}`}
                    title="Close"
                    disabled={isBusy}
                    onclick={() => closeTab(file.path)}><X size={12} /></button
                  >{/if}
              </div>
            {/each}
          </div>
          <label class="theme-control">
            <span>Theme</span>
            <select
              aria-label="Color theme"
              bind:value={themePreference}
              onchange={(event) =>
                setThemePreference(event.currentTarget.value as ThemePreference)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
        {#if currentLibrary}
          <div class="library-bar" role="note" aria-label="Read-only library module">
            <Lock size={13} />
            <p>
              <strong>Read-only</strong>: {currentLibrary.module} is agda-algebras{libraryModules?.commit
                ? ` at ${libraryModules.commit.slice(0, 8)}`
                : ""}, the checked library, as the playground imports it. Copy it to the
              playground to change it.
            </p>
            <div class="library-actions">
              <button
                class="library-copy"
                title="Copy this module, or the selection, into a file of the playground"
                onclick={() => openCommand("copy")}
                disabled={!compilerReady || isBusy}><Copy size={13} />Copy to playground</button
              >
              <button
                class="library-import"
                title={`Add open import ${currentLibrary.module} to Main.agda`}
                onclick={importIntoMain}
                disabled={isBusy}><FileInput size={13} />Import in Main</button
              >
              <a
                class="library-page"
                href={libraryPage(currentLibrary.module)}
                target="_blank"
                rel="noreferrer"
                title="Its page on the agda-algebras site, in a new tab"><ExternalLink size={13} />Its page</a
              >
            </div>
          </div>
        {/if}
        <div class="command-strip">
          <button
            title="Goal type (C-c C-t)"
            onclick={() => runAction(() => controller.queryGoalType())}
            disabled={!compilerReady || isBusy || !currentGoals.length}
            ><Info size={14} />Type</button
          >
          <button
            title="Context (C-c C-e)"
            onclick={() => runAction(() => controller.queryContext())}
            disabled={!compilerReady || isBusy || !currentGoals.length}
            ><ListChecks size={14} />Context</button
          ><span class="strip-divider"></span>
          <button
            title="Give hole contents (C-c C-Space)"
            onclick={() => openCommand("give")}
            disabled={!compilerReady || isBusy || !currentGoals.length}
            ><Zap size={14} />Give</button
          >
          <button
            title="Refine or introduce (C-c C-r)"
            onclick={() => openCommand("refine")}
            disabled={!compilerReady || isBusy || !currentGoals.length}
            ><WandSparkles size={14} />Refine</button
          >
          <button
            title="Case split (C-c C-c)"
            onclick={() => openCommand("case")}
            disabled={!compilerReady || isBusy || !currentGoals.length}
            ><Split size={14} />Case split</button
          ><span class="strip-divider"></span>
          <button
            title="Infer type (C-c C-d)"
            onclick={() => openCommand("infer")}
            disabled={!compilerReady || isBusy}><Sigma size={14} />Infer</button
          >
          <button
            title="Normalize (C-c C-n)"
            onclick={() => openCommand("normalize")}
            disabled={!compilerReady || isBusy}
            ><RotateCcw size={14} />Normalize</button
          >
        </div>
        <div class="editor-host" bind:this={editorHost}></div>
        {#if commandKind && !consentRequest}
          <form
            class="minibuffer"
            onsubmit={(event) => {
              event.preventDefault();
              void submitCommand();
            }}
          >
            <label for="command-input">
              <span>AGDA</span>
              <strong
                >{commandKind === "copy" && currentLibrary
                  ? copySelection
                    ? `Copy the selection (${copySelection.lines} ${copySelection.lines === 1 ? "line" : "lines"}), with the code above it, to /play/`
                    : `Copy ${currentLibrary.module} to /play/`
                  : commandMeta[commandKind].title}</strong
              >
            </label>
            <input
              id="command-input"
              class="mono"
              bind:value={commandValue}
              placeholder={commandMeta[commandKind].placeholder}
              title={commandMeta[commandKind].description}
              autocomplete="off"
            />
            <button type="submit" class="minibuffer-run"
              >{commandMeta[commandKind].action}<span>↵</span></button
            >
            <button
              type="button"
              class="minibuffer-cancel"
              onclick={() => {
                commandKind = null;
                editor?.focus();
              }}
              aria-label="Cancel command">ESC</button
            >
          </form>
        {/if}
        {#if consentRequest}
          <form
            class="consent"
            aria-label="Fetch agda-algebras' interfaces"
            bind:this={consentForm}
            onsubmit={(event) => {
              event.preventDefault();
              answerConsent("fetch");
            }}
          >
            <p class="consent-text">
              {currentLibrary ? `Loading ${currentLibrary.module}` : `Checking ${editorFileName}`} needs
              <strong class="consent-size" data-bytes={consentRequest.bytes}
                >{sizeWithBytes(consentRequest.bytes)}</strong
              >
              of agda-algebras' interfaces: <span class="consent-count"
                >{consentRequest.archives}
                {consentRequest.archives === 1 ? "archive" : "archives"} holding
                {consentRequest.modules}
                {consentRequest.modules === 1 ? "module" : "modules"}</span
              >, from this site. Without them, Agda checks those modules from
              source, which can take minutes.
            </p>
            {#if consentRequest.declined.archives}<p class="consent-note">
                {consentRequest.declined.archives === consentRequest.archives ? "All" : "Of them,"}
                {consentRequest.declined.archives}
                {consentRequest.declined.archives === 1 ? "archive" : "archives"},
                {sizeWithBytes(consentRequest.declined.bytes)}, you declined earlier in this
                tab.
              </p>{/if}
            {#if consentRequest.unknown.length}<p class="consent-note">
                Not in agda-algebras' index, so checked from source either way:
                {consentRequest.unknown.join(", ")}.
              </p>{/if}
            <div class="consent-actions">
              <button type="submit" class="consent-fetch"
                >Fetch {statedSize(consentRequest.bytes)}</button
              >
              <button
                type="button"
                class="consent-source"
                onclick={() => answerConsent("source")}>Check from source</button
              >
              <button
                type="button"
                class="consent-cancel"
                onclick={() => answerConsent("cancel")}>Cancel</button
              >
              <label class="consent-remember"
                ><input type="checkbox" bind:checked={consentRemember} />
                Remember my answer in this tab</label
              >
            </div>
          </form>
        {/if}
        <footer class="statusbar">
          {#if !compilerStarting}<span
              class:success={controller.checked &&
                !controller.problems.some((p) => p.severity === "error")}
            >
              {#if agdaFailed}<CircleAlert size={13} />{agdaFailedLabel}{:else if consentRequest}<Download
                  size={13}
                />Fetch {statedSize(consentRequest.bytes)}?{:else if isWorking}<LoaderCircle
                  size={13}
                  class="spin"
                />{controller.lastAction}{:else if controller.problems.some((p) => p.severity === "error")}<CircleAlert
                  size={13}
                />{controller.problems.filter((p) => p.severity === "error")
                  .length} error{:else}<CircleCheck
                  size={13}
                />{controller.checked ? "Checked" : "Agda ready"}{/if}
            </span>{/if}<span
            >{currentGoals.length} goal{currentGoals.length === 1
              ? ""
              : "s"}</span
          ><span class="status-spacer"></span><span class="status-version"
            >{controller.reportedAgdaVersion
              ? `Agda ${controller.reportedAgdaVersion}`
              : "Agda"}</span
          ><span
            >WASI · local</span
          ><span>UTF-8</span>
        </footer>
      </section>
    </section>

    <div
      class="resize-handle"
      role="separator"
      aria-label="Resize inspector"
      onpointerdown={beginResize}
    ></div>
    <aside class="inspector">
      <div class="inspector-header" aria-live="polite">
        <span class="inspector-title">
          {#if compilerStarting || isWorking}<LoaderCircle
              size={14}
              class="spin"
            />{:else if consentRequest}<Download
              size={14}
            />{:else if inspectorMode === "problems"}<TriangleAlert
              size={14}
            />{:else if inspectorMode === "result"}<SquareTerminal
              size={14}
            />{:else}<Braces size={14} />{/if}
          <strong>AGDA INFO</strong>
        </span>
        <span class="inspector-state">
          <span class="inspector-status">{inspectorHeading}</span>
          {#if isAgdaBusy || controller.driveArchiveLoading}<button
              class="abort-action"
              onclick={stopWork}
              title={controller.driveArchiveLoading
                ? "Stop fetching (C-c C-x C-a)"
                : "Abort current Agda command (C-c C-x C-a)"}>STOP</button
            >{/if}
        </span>
      </div>
      <div class="inspector-content">
        {#if inspectorMode === "goals"}
          <GoalList
            goals={currentGoals}
            active={controller.activeGoalId}
            context={controller.activeGoalId == null
              ? []
              : (controller.goalInfo[controller.activeGoalId]?.context ?? [])}
            onselect={selectGoal}
          />
        {:else if inspectorMode === "result"}
          <ResultView
            result={controller.lastResult}
            log={controller.runningMessages}
          />
        {:else}<ProblemList problems={controller.problems} />{/if}
      </div>
      {#if controller.planNote && workspaceMode === "playground"}<div class="plan-note">
          <Info size={15} /><span>{controller.planNote}</span>
        </div>{/if}
      {#if actionError}<div class="action-error">
          <CircleAlert size={15} /><span>{actionError}</span><button
            onclick={() => (actionError = "")}
            aria-label="Dismiss"><X size={14} /></button
          >
        </div>{/if}
    </aside>
  </section>
</main>

<style>
  .app-shell {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--canvas);
    overflow: hidden;
  }
  :global(.spin) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  button {
    border: 0;
    background: none;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .fatal-banner {
    min-height: 39px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px 16px;
    color: var(--error);
    background: var(--error-soft);
    border-bottom: 1px solid var(--error-banner-line);
    font-size: 12px;
  }
  .workspace {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 44px 210px minmax(320px, 1fr) 5px var(
        --inspector-width
      );
  }
  .workspace.files-closed {
    grid-template-columns: 44px minmax(320px, 1fr) 5px var(--inspector-width);
  }
  .workspace.files-closed .explorer {
    display: none;
  }
  .workspace.lesson-workspace {
    grid-template-columns: 44px 210px minmax(340px, 43fr) minmax(420px, 57fr);
    grid-template-rows: minmax(300px, 64fr) minmax(210px, 36fr);
  }
  .workspace.lesson-workspace.files-closed {
    grid-template-columns: 44px minmax(340px, 43fr) minmax(420px, 57fr);
  }
  .lesson-workspace .activitybar,
  .lesson-workspace .explorer {
    grid-row: 1 / 3;
  }
  .lesson-workspace .editor-pane.lesson-open {
    display: contents;
  }
  .lesson-workspace .reader-pane {
    grid-column: 3;
    grid-row: 1 / 3;
  }
  .lesson-workspace.files-closed .reader-pane {
    grid-column: 2;
  }
  .lesson-workspace .code-pane {
    grid-column: 4;
    grid-row: 1;
    border-bottom: 1px solid var(--line-strong);
  }
  .lesson-workspace.files-closed .code-pane {
    grid-column: 3;
  }
  .lesson-workspace .resize-handle {
    display: none;
  }
  .lesson-workspace .inspector {
    grid-column: 4;
    grid-row: 2;
  }
  .lesson-workspace.files-closed .inspector {
    grid-column: 3;
  }
  .activitybar {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 8px 0;
    background: var(--activity-surface);
    border-right: 1px solid var(--line);
  }
  .activity {
    position: relative;
    width: 44px;
    height: 40px;
    display: grid;
    place-items: center;
    color: var(--activity-text);
  }
  .activity:hover,
  .activity.active {
    color: var(--accent);
  }
  .activity.active:before {
    content: "";
    position: absolute;
    left: 0;
    width: 2px;
    height: 24px;
    background: var(--accent);
  }
  .explorer {
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--explorer-surface);
    border-right: 1px solid var(--line);
    color: var(--muted);
    overflow: hidden;
  }
  .section-label {
    height: 35px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    font-size: 10px;
    letter-spacing: 0.09em;
  }
  .editor-pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--editor-surface);
  }
  .editor-pane.lesson-open {
    display: grid;
    grid-template-columns: minmax(330px, 42%) minmax(360px, 1fr);
  }
  .code-pane,
  .reader-pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .code-pane {
    flex: 1;
  }
  .reader-pane {
    background: var(--surface);
    border-right: 1px solid var(--line-strong);
  }
  .reader-tabs {
    height: 37px;
    min-height: 37px;
    display: flex;
    border-bottom: 1px solid var(--line);
    background: var(--tab-surface);
  }
  .reader-tab {
    min-width: 140px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px;
    border-right: 1px solid var(--line);
    color: var(--muted);
    font-size: 12px;
    text-align: left;
  }
  .reader-tab.active {
    position: relative;
    color: var(--text);
    background: var(--editor-surface);
  }
  .reader-tab.active:before {
    content: "";
    position: absolute;
    inset: 0 0 auto;
    height: 2px;
    background: var(--accent);
  }
  .reader-tab :global(svg) {
    color: var(--accent);
  }
  .reader-nav {
    min-height: 39px;
    display: grid;
    grid-template-columns: 31px minmax(0, 1fr) 31px;
    align-items: center;
    border-bottom: 1px solid var(--reader-line);
  }
  .reader-nav button {
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--muted);
  }
  .reader-nav button:not(:disabled):hover {
    color: var(--accent-strong);
    background: var(--accent-soft);
  }
  .reader-nav strong {
    overflow: hidden;
    color: var(--reader-heading);
    font-size: 10px;
    font-weight: 600;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reader-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    outline: 0;
    scroll-padding-top: 18px;
  }
  .reader-state {
    min-height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    color: var(--muted);
    font-size: 11px;
  }
  .reader-state.error {
    color: var(--error);
  }
  .reader-status {
    height: 25px;
    min-height: 25px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 9px;
    border-top: 1px solid var(--line);
    background: var(--status-surface);
    color: var(--status-text);
    font-size: 10px;
  }
  .reader-status a {
    color: var(--accent-strong);
    text-decoration: none;
  }
  .markdown-body {
    max-width: 760px;
    margin: 0 auto;
    padding: 24px 28px 80px;
    color: var(--reader-text);
    font-family: Georgia, "Times New Roman", serif;
    font-size: 14px;
    line-height: 1.58;
  }
  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3) {
    margin: 1.65em 0 0.6em;
    color: var(--text);
    font-family: Arial, Helvetica, sans-serif;
    font-weight: 600;
    line-height: 1.2;
  }
  .markdown-body :global(h1) {
    padding-bottom: 7px;
    border-bottom: 1px solid var(--reader-heading-line);
    font-size: 22px;
  }
  .markdown-body :global(h2) {
    font-size: 17px;
  }
  .markdown-body :global(h3) {
    font-size: 14px;
  }
  .markdown-body :global(p),
  .markdown-body :global(ul),
  .markdown-body :global(ol),
  .markdown-body :global(blockquote) {
    margin: 0 0 1em;
  }
  .markdown-body :global(a) {
    color: var(--accent-strong);
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
  .markdown-body :global(code),
  .markdown-body :global(pre) {
    font-family: JuliaMono, "SFMono-Regular", Consolas, monospace;
  }
  .markdown-body :global(code) {
    padding: 1px 3px;
    background: var(--reader-inline-surface);
    font-size: 0.88em;
  }
  .markdown-body :global(pre) {
    overflow: auto;
    margin: 0 0 1.2em;
    padding: 12px 13px;
    border: 1px solid var(--reader-code-line);
    background: var(--reader-code-surface);
    font-size: 11px;
    line-height: 1.55;
  }
  .markdown-body :global(pre code) {
    padding: 0;
    background: transparent;
  }
  .markdown-body :global(pre.agda-source-block) {
    cursor: pointer;
    border-left: 3px solid var(--reader-code-accent);
  }
  .markdown-body :global(pre.agda-source-block:hover),
  .markdown-body :global(pre.agda-source-block:focus) {
    border-color: var(--accent);
    background: var(--reader-code-hover-surface);
    outline: 1px solid var(--accent);
  }
  .markdown-body :global(.source-scroll-anchor) {
    display: block;
    height: 0;
    pointer-events: none;
  }
  .markdown-body :global(blockquote) {
    padding: 7px 12px;
    border-left: 3px solid var(--reader-quote-line);
    color: var(--reader-quote-text);
    background: var(--reader-quote-surface);
  }
  .markdown-body :global(table) {
    width: 100%;
    margin-bottom: 1.2em;
    border-collapse: collapse;
    font-size: 12px;
  }
  .markdown-body :global(th),
  .markdown-body :global(td) {
    padding: 6px 7px;
    border: 1px solid var(--reader-table-line);
    text-align: left;
  }
  .markdown-body :global(img) {
    max-width: 100%;
  }
  .editor-tabs {
    height: 37px;
    min-height: 37px;
    display: flex;
    border-bottom: 1px solid var(--line);
    background: var(--tab-surface);
  }
  .theme-control {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    color: var(--muted);
    font-size: 11px;
  }
  .theme-control select {
    min-width: 76px;
    padding: 3px 4px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 0;
    cursor: pointer;
  }
  /* The open files, one tab each (issue 10), scrolling sideways when
     they do not fit. */
  .editor-tab-list {
    min-width: 0;
    display: flex;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .editor-tab {
    min-width: 140px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 8px 0 12px;
    color: var(--muted);
    border-right: 1px solid var(--line);
    font-size: 12px;
  }
  .editor-tab-open {
    height: 100%;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0;
    color: inherit;
    font: inherit;
  }
  .editor-tab-open[aria-disabled="true"] {
    cursor: not-allowed;
  }
  .tab-close {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    color: inherit;
  }
  .tab-close:not(:disabled):hover {
    opacity: 1;
    color: var(--accent-strong);
    background: var(--accent-soft);
  }
  .editor-tab.active {
    position: relative;
    background: var(--editor-surface);
    color: var(--text);
  }
  .editor-tab.active:before {
    content: "";
    position: absolute;
    inset: 0 0 auto;
    height: 2px;
    background: var(--accent);
  }
  .editor-tab-open :global(svg:first-child) {
    color: var(--accent);
  }
  /* A library's module (issue 10): the line that says it is the checked
     library, read-only, and its actions, wrapping at any width. */
  .library-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--command-line);
    background: var(--accent-soft);
    color: var(--text);
    font-size: 11px;
    line-height: 1.45;
  }
  .library-bar > :global(svg) {
    flex: none;
    color: var(--accent-strong);
  }
  .library-bar p {
    flex: 1 1 260px;
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .library-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .library-actions button,
  .library-actions a {
    min-height: 24px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 8px;
    border: 1px solid var(--command-hover-line);
    color: var(--accent-strong);
    background: var(--surface);
    font-size: 11px;
    text-decoration: none;
  }
  .library-actions button:not(:disabled):hover,
  .library-actions a:hover {
    background: var(--accent-soft);
  }
  :global(.tab-close) {
    margin-left: auto;
    opacity: 0.45;
  }
  .command-strip {
    min-height: 39px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--command-line);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .command-strip button {
    height: 29px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 0;
    color: var(--command-text);
    font-size: 11px;
  }
  .command-strip button:not(:disabled):hover {
    background: var(--accent-soft);
    color: var(--accent-strong);
    border-color: var(--command-hover-line);
  }
  .strip-divider {
    width: 1px;
    height: 18px;
    flex: none;
    margin: 0 3px;
    background: var(--line);
  }
  .editor-host {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .editor-host :global(.cm-editor) {
    height: 100%;
  }
  .minibuffer {
    min-height: 45px;
    display: grid;
    grid-template-columns: auto minmax(120px, 1fr) auto auto;
    align-items: stretch;
    border-top: 1px solid var(--input-line);
    background: var(--input-label-surface);
  }
  .minibuffer label {
    min-width: 150px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 10px;
    border-right: 1px solid var(--input-divider);
    color: var(--input-label-text);
    white-space: nowrap;
  }
  .minibuffer label span {
    padding: 3px 4px;
    color: var(--input-badge-text);
    background: var(--accent-fill);
    font:
      700 8px JuliaMono,
      monospace;
    letter-spacing: 0.06em;
  }
  .minibuffer label strong {
    font-size: 10px;
  }
  .minibuffer input {
    min-width: 0;
    border: 0;
    border-right: 1px solid var(--input-divider);
    border-radius: 0;
    outline: 0;
    padding: 0 10px;
    color: var(--input-text);
    background: var(--input-surface);
    font-size: 12px;
  }
  .minibuffer input:focus {
    border-left: 3px solid var(--accent);
  }
  .minibuffer-run,
  .minibuffer-cancel {
    min-width: 66px;
    padding: 0 10px;
    border-right: 1px solid var(--input-button-line);
    background: var(--tab-surface);
    color: var(--input-button-text);
    font:
      700 9px JuliaMono,
      monospace;
    letter-spacing: 0.035em;
  }
  .minibuffer-run {
    color: var(--input-badge-text);
    background: var(--accent-fill);
  }
  .minibuffer-run span {
    margin-left: 5px;
  }
  .minibuffer-run:hover {
    background: var(--accent-fill-hover);
  }
  .minibuffer-cancel:hover {
    background: var(--input-button-hover-surface);
  }
  /* The question before a fetch (issue 14), at the foot of the code pane
     as the minibuffer is, wrapping at any width. */
  .consent {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--input-line);
    background: var(--input-label-surface);
    color: var(--input-label-text);
    font-size: 11px;
    line-height: 1.5;
  }
  .consent p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .consent-size {
    color: var(--input-text);
  }
  .consent-note {
    color: var(--muted);
  }
  .consent-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
  }
  .consent-actions button {
    min-height: 26px;
    padding: 0 10px;
    border: 1px solid var(--input-button-line);
    background: var(--tab-surface);
    color: var(--input-button-text);
    font:
      700 9px JuliaMono,
      monospace;
    letter-spacing: 0.035em;
  }
  .consent-actions .consent-fetch {
    border-color: var(--accent-fill);
    color: var(--input-badge-text);
    background: var(--accent-fill);
  }
  .consent-actions .consent-fetch:hover {
    background: var(--accent-fill-hover);
  }
  .consent-actions button:not(.consent-fetch):hover {
    background: var(--input-button-hover-surface);
  }
  .consent-remember {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--input-label-text);
  }
  .plan-note {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 10px;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 10px;
  }
  .plan-note span {
    flex: 1;
    overflow-wrap: anywhere;
  }
  .statusbar {
    height: 25px;
    min-height: 25px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 9px;
    background: var(--status-surface);
    border-top: 1px solid var(--line);
    color: var(--status-text);
    font-size: 10px;
  }
  .statusbar span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .statusbar .success {
    color: var(--accent);
  }
  .status-spacer {
    flex: 1;
  }
  .resize-handle {
    cursor: col-resize;
    background: var(--resize-surface);
    border-inline: 1px solid var(--line);
    z-index: 5;
  }
  .resize-handle:hover,
  .resize-handle:focus {
    background: var(--resize-hover-surface);
    outline: 0;
  }
  .inspector {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--inspector-surface);
  }
  .inspector-header {
    height: 38px;
    min-height: 38px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-bottom: 1px solid var(--line);
    background: var(--status-surface);
    padding: 0 10px;
  }
  .inspector-title {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--accent-strong);
    font-size: 10px;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .inspector-state {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .abort-action {
    height: 23px;
    padding: 0 7px;
    border: 1px solid var(--abort-line);
    color: var(--error);
    font:
      700 8px JuliaMono,
      monospace;
    letter-spacing: 0.04em;
  }
  .abort-action:hover {
    color: var(--input-badge-text);
    background: var(--error-fill);
  }
  .inspector-status {
    min-width: 0;
    overflow: hidden;
    color: var(--muted);
    font-size: 9px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .inspector-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 14px;
  }
  .action-error {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 10px;
    border-top: 1px solid var(--error-action-line);
    background: var(--error-soft);
    color: var(--error);
    font-size: 10px;
  }
  .action-error span {
    flex: 1;
    overflow-wrap: anywhere;
  }
  .action-error button {
    display: grid;
    place-items: center;
    color: inherit;
  }
  @media (max-width: 1080px) {
    .workspace {
      grid-template-columns: 42px 180px minmax(300px, 1fr) 5px min(
          var(--inspector-width),
          36vw
        );
    }
    .workspace.files-closed {
      grid-template-columns: 42px minmax(300px, 1fr) 5px min(
          var(--inspector-width),
          36vw
        );
    }
    .workspace.lesson-workspace {
      grid-template-columns: 42px 180px minmax(300px, 43fr) minmax(350px, 57fr);
    }
    .workspace.lesson-workspace.files-closed {
      grid-template-columns: 42px minmax(300px, 43fr) minmax(350px, 57fr);
    }
  }
  @media (max-width: 800px) {
    .workspace {
      display: flex;
      flex-direction: column;
      overflow: auto;
    }
    .explorer,
    .activitybar,
    .resize-handle {
      display: none;
    }
    .editor-pane {
      min-height: 58vh;
    }
    .workspace.lesson-workspace .editor-pane.lesson-open {
      min-height: 116vh;
      display: flex;
      flex-direction: column;
      overflow: visible;
    }
    .workspace.lesson-workspace .reader-pane {
      min-height: 55vh;
      border-right: 0;
      border-bottom: 1px solid var(--line-strong);
    }
    .workspace.lesson-workspace .code-pane {
      min-height: 61vh;
    }
    .inspector {
      min-height: 42vh;
      border-top: 1px solid var(--line);
    }
    .inspector-content {
      min-height: 300px;
    }
    .statusbar span:nth-last-child(-n + 3) {
      display: none;
    }
  }
  @media (max-width: 520px) {
    .command-strip {
      padding-left: 4px;
    }
    .minibuffer {
      grid-template-columns: auto minmax(90px, 1fr) 49px 42px;
    }
    .minibuffer label {
      min-width: auto;
      padding: 0 7px;
    }
    .minibuffer label strong {
      display: none;
    }
    .minibuffer-run,
    .minibuffer-cancel {
      min-width: 0;
      padding: 0 5px;
      font-size: 8px;
    }
  }
</style>
