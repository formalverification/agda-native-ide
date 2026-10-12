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
// module of PLFA's library, is not shown in its place.
//
// The editor takes its text as the one Agda's positions refer to (the
// offsets' commit) when the engine is about to load it, and only then,
// in the tick the text was read: after a give or a case split, Agda goes
// on giving the remaining goals' ranges in the text it loaded (issue 59).
//
// When Agda cannot start, the page says why: the engine's startup failure
// is shown as "Agda could not start: ...", and a server that fails or
// exits on its own once started as "Agda stopped: ..." (issue 8).

import type { EditorView } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { LSPClient, languageServerExtensions } from "@codemirror/lsp-client";
import { messagesOf } from "@agda-native-ide/engine";
import type {
  AgdaSession,
  CheckPlan,
  GiveValue,
  GoalView,
  MakeCaseValue,
  Outcome,
} from "@agda-native-ide/engine";
import { startBrowserSession, type BrowserTransport } from "@agda-native-ide/engine/browser";
import { createToolSurface, type ToolResult, type ToolSurface } from "@agda-native-ide/tools";

import { hoverTooltips } from "$lib/codemirror/lsp-hover";
import { asset } from "$app/paths";
import { cacheTokens, compilerBytes, driveCacheNamespace } from "$lib/assets";
import { applyAgdaResponse } from "./agda/handlers";
import { commit } from "./codemirror/offsets";
import {
  getActiveAgdaGoal,
  getAgdaGoalById,
  getAgdaGoalContents,
  getAgdaGoals,
} from "./agda/goals";
import { browserAgdaSource } from "./agda/browser-source";

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
} as const;

/** Where the editor keeps the playground's buffer: a key named by its path
 * on the drive.  It was "agda-web-ide-beta:doc" while the buffer was
 * /Main.agda, a module of PLFA's library; nothing is deployed, so only a
 * developer's browser holds a document there, and it stays, unread. */
export const LS_DOC_KEY = `agda-web-ide-beta:doc:${PLAYGROUND.file}`;

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
  currentFilePath = $state<string>(PLAYGROUND.file);
  currentStorageKey = LS_DOC_KEY;
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

  /** Set by terminateALSWASM, so the session's end is not reported. */
  private stopRequested = false;
  /** Counts the documents the editor has shown: a check's answers that
   * arrive after another document replaced its own are not applied. */
  private documentEpoch = 0;
  /** Archive mounts in flight. */
  private mounting = 0;
  /** How the page checks the file on screen (in PLFA, with the chapter's
   * interfaces mounted first); a plain check by default. */
  checkCurrentFile: () => Promise<void> = () => this.loadAgdaFile();
  /** Stops the engine, during its startup or after. */
  private stopper?: AbortController;

  constructor(
    readonly config: {
      agdaVersion: SupportedAgdaVersion;
    },
  ) {
    this.lspClient = makeLspClient();
  }

  connectEditorView(view: EditorView) {
    this.editorView = view;
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
    const path = this.currentFilePath;
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
          this.persistDocument(source);
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
      if (!load.errors.length)
        void this.transport?.persist().catch((error: unknown) =>
          console.warn("Could not persist the Agda cache", error),
        );
    }
    this.finishAction();
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
    if (!view || !transport) return;
    const doc = view.state.doc.toString();
    this.persistDocument(doc);
    try {
      await transport.writeSource(this.currentFilePath, browserAgdaSource(this.currentFilePath, doc));
    } catch (error) {
      console.warn("Could not save the buffer where Agda reads it", error);
      return;
    }
    this.lspClient!.notification("textDocument/didSave", {
      textDocument: { uri: "file://" + this.currentFilePath },
    });
    try {
      await transport.persist();
    } catch (error) {
      console.warn("Could not persist the Agda cache", error);
    }
  }

  async mountDriveArchives(urls: string[]): Promise<void> {
    const transport = this.transport;
    if (!transport || !this.driveIsCreated) throw new Error("Agda filesystem is not ready");
    const missing = transport.unmounted(urls);
    if (!missing.length) return;
    this.mounting += 1;
    this.driveArchiveLoading = true;
    this.lastAction = `Loading ${missing.length} PLFA cache ${missing.length === 1 ? "bundle" : "bundles"}…`;
    try {
      await transport.mountArchives(missing);
      this.lastAction = "PLFA cache ready";
    } finally {
      this.mounting -= 1;
      this.driveArchiveLoading = this.mounting > 0;
    }
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
    const answer = result.result as { goal: number; type: string; context: AgdaGoalInfo["context"] };
    const context = answer.context.map((entry) => ({ name: entry.name, type: entry.type, inScope: entry.inScope }));
    this.goalInfo = { ...this.goalInfo, [answer.goal]: { id: answer.goal, type: answer.type, context } };
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

  persistDocument(source: string) {
    localStorage.setItem(this.currentStorageKey, source);
  }

  setDocument(
    source: string,
    filePath: string = PLAYGROUND.file,
    storageKey = LS_DOC_KEY,
  ) {
    if (!this.editorView) return;
    const pathChanged = filePath !== this.currentFilePath;
    this.documentEpoch += 1;
    // The editor no longer shows what Agda holds, nor its highlighting.
    this.session?.reloadNext("the editor's text was replaced");
    this.currentFilePath = filePath;
    this.currentStorageKey = storageKey;
    this.checked = false;
    this.problems = [];
    this.interactionPoints = [];
    this.goalInfo = {};
    this.activeGoalId = undefined;
    this.lastResult = null;
    this.lastCheckDurationMs = undefined;
    const length = this.editorView.state.doc.length;
    this.editorView.dispatch({
      changes: { from: 0, to: length, insert: source },
      selection: { anchor: 0 },
      effects:
        pathChanged && this.alsWorkerStatus === "active"
          ? this.lspClientCompartment.reconfigure(
              this.lspClient!.plugin(`file://${this.currentFilePath}`),
            )
          : undefined,
    });
    this.persistDocument(source);
  }
}
