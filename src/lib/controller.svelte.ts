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
// the transport reads only when started with --raw; the standard library
// is 2.3 patched to check under 2.9.0 (stdlib/patches/; issue 58).
//
// The page runs the server's reactor build, in one worker with the drive
// (src/lib/worker/als.ts; issue 59): the controller talks to the server
// through a message port, and to the drive through the worker's functions,
// where it wrote to rings in shared memory, so the page allocates no
// SharedArrayBuffer.  The worker compiles the compiler while the page
// fetches the archives; then it lays out the drive, runs the setup the
// reactor exports in place of `als --setup`, and starts the server.  A
// reactor cannot answer `--version`, and the server reports no version of
// its own, so the controller asks Agda for its version with
// Cmd_show_version once the server is ready, and the page shows Agda's
// answer.
//
// When Agda cannot start, the controller says why (issue 8): a failure to
// fetch the compiler, to decompress or compile it, to fetch an archive,
// to lay out the drive or to run the setup rejects the start with a
// message the page shows, where it used to leave the page saying "Agda
// ready" with nothing checked.  The fallback to the raw compiler is gone:
// the built site has not shipped it since issue 3, and a browser without
// DecompressionStream is not supported (src/lib/support.ts).
//
// The editor takes its text as the one Agda's positions refer to (the
// offsets' commit) when the page sends Cmd_load, and only then: after a
// give or a case split, Agda goes on giving the remaining goals' ranges in
// the text it loaded, which the editor maps through the edits made since
// (issue 59).  The controller committed after every write to the drive,
// so a give's edit, written while Agda was still answering the give,
// could be committed before Agda's interaction points arrived, which then
// fell outside the text (a RangeError that stopped the transport), seen
// in Firefox.  Writes to the drive are messages to the server's worker,
// handled in order, so they need no lock.
//
// The server starts without the fork's +RTS -A64m -RTS: the reactor's
// runtime takes the option from its argv, and measured on the page it
// added 70 to 90 MiB to the heap and made no check faster (issue 59).

import * as Comlink from "comlink";

import type { EditorView } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { LSPClient, languageServerExtensions } from "@codemirror/lsp-client";

import { hoverTooltips } from "$lib/codemirror/lsp-hover";

import {
  createPortByteStreams,
  makeLspWorker,
  traceFetchProgress,
} from "$lib";
import type {
  ALSWorkerInitResultProxied,
  WASMLoadingProgress,
} from "$lib/worker/types";
import { asset } from "$app/paths";
import { cacheTokens, compilerBytes, driveCacheNamespace } from "$lib/assets";
import {
  ALSMessageRouter,
  makeLSPTransport,
  type AgdaIOTCMStatus,
} from "./agda/transport";
import { commit } from "./codemirror/offsets";
import {
  getActiveAgdaGoal,
  getAgdaGoalById,
  getAgdaGoalContents,
  getAgdaGoals,
} from "./agda/goals";
import { browserAgdaSource } from "./agda/browser-source";

const isSafari =
  typeof navigator !== "undefined" &&
  /Apple Computer/.test((navigator as any).vendor);

type ALSWorkerStatus =
  | "initial"
  | "errored"
  | "loading"
  | "loaded"
  | "active"
  | "deactivating"
  | "terminated"
  | "exited";

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

export async function fetchWASMAndData(agdaVersion: SupportedAgdaVersion) {
  if (!(agdaVersion in agdaVersionMap)) {
    throw new Error(
      `version ${agdaVersion} not in list of supported versions: ${JSON.stringify(supportedAgdaVersion)}`,
    );
  }

  const { compressedPath, byteLength, dataPath } = agdaVersionMap[agdaVersion];

  const compressed = await fetchOrFail(compressedPath, "the compiler");
  if (!compressed.body)
    throw new Error("the compiler could not be downloaded (an empty response)");
  const headers = new Headers({ "Content-Type": "application/wasm" });
  if (byteLength) headers.set("Content-Length", String(byteLength));
  // Some static servers attach Content-Encoding to .gz files, so fetch
  // has already decoded the response body. Others serve the gzip bytes as
  // an opaque file and need an explicit DecompressionStream.
  const body = compressed.headers
    .get("Content-Encoding")
    ?.toLowerCase()
    .includes("gzip")
    ? compressed.body
    : compressed.body.pipeThrough(new DecompressionStream("gzip"));
  const wasm = new Response(body, { headers });

  const dataFile = dataPath
    ? await fetchOrFail(dataPath, "Agda's builtin library")
    : null;

  return { wasm, dataFile };
}

/** An error in its own words, with its kind when it names one, and
 * without a closing period, since the page's sentence adds one. */
function describeError(error: unknown) {
  if (!(error instanceof Error)) return String(error).trim().replace(/\.$/, "");
  const message = error.message.trim().replace(/\.$/, "");
  return error.name && error.name !== "Error"
    ? `${error.name}: ${message}`
    : message;
}

/** Fetch a file Agda needs, or fail saying which file and why. */
async function fetchOrFail(url: string, what: string) {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`${what} could not be downloaded (${describeError(error)})`, {
      cause: error,
    });
  }
  if (!response.ok)
    throw new Error(
      `${what} could not be downloaded (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""})`,
    );
  return response;
}

export const LS_DOC_KEY = "agda-web-ide-beta:doc";

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

export class AgdaController {
  editorView?: EditorView;
  lspClient?: LSPClient;
  alsRouter?: ALSMessageRouter;
  workerInitData?: ALSWorkerInitResultProxied;
  runningWASM?: Promise<number>;
  agdaDataZip?: Promise<Uint8Array>;

  lspClientCompartment = new Compartment();

  alsWorkerStatus = $state<ALSWorkerStatus>("initial");
  wasmLoadingProgress = $state<WASMLoadingProgress | null>(null);
  // What Agda answered to Cmd_show_version, which the controller sends
  // once, when the server is first ready, before the page may send
  // anything (queryAgdaVersion).
  reportedAgdaVersion = $state<string | undefined>();
  versionQuery: "unsent" | "pending" | "answered" = "unsent";
  driveIsCreated = $state(false);
  driveArchiveLoading = $state(false);
  currentFilePath = $state("/Main.agda");
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
  pendingExpression: string | undefined;
  pendingCheckStartedAt: number | undefined;
  pendingGoalCheck = false;
  loadedSnapshot?: { filePath: string; source: string };
  pendingLoadSnapshot?: { filePath: string; source: string };

  _lspWorker: Worker | undefined;
  _archiveMountPromise: Promise<void> | undefined;
  _mountedDriveArchives = new Set<string>();

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

  onInteractionEdit = () => {
    const source = this.editorView?.state.doc.toString();
    if (source != null) {
      // Give/refine/case-split already changed Agda's live interaction state.
      // Treat the response edit as the new checked snapshot instead of
      // immediately throwing that state away with another Cmd_load.
      this.loadedSnapshot = {
        filePath: this.currentFilePath,
        source,
      };
      this.checked = this.getGoals().length === 0;
    }
    void this.syncEditorToDrive()
      .then(() => this.workerInitData?.persist())
      .catch((error) =>
        console.warn("Could not persist the Agda cache", error),
      );
  };

  async startALSWASM() {
    if (this.runningWASM) {
      throw new Error("WASM is already running");
    }

    if (this.workerInitData) {
      if (!this._lspWorker) {
        throw new Error("runaway worker");
      }
      console.warn("reusing worker");
      return this._startALSWASM(this.workerInitData);
    }

    if (this.wasmLoadingProgress) {
      throw new Error("wasm is already loading");
    }

    this.alsWorkerStatus = "loading";
    let wasmAndData: Awaited<ReturnType<typeof fetchWASMAndData>>;
    try {
      wasmAndData = await fetchWASMAndData(this.config.agdaVersion);
    } catch (error) {
      throw this.startupFailure(error);
    }

    const progressCtx = traceFetchProgress(wasmAndData.wasm, (loaded) => {
      this.wasmLoadingProgress!.bytesLoaded = loaded;
    });

    if (isSafari) {
      // Safari does not support transfering a ReadableStream, so we consume the stream and pass its object URL to worker
      this.wasmLoadingProgress = {
        ...progressCtx,
        source: { type: "url", url: "fakeurl" },
        bytesLoaded: 0,
        // we read it till end; by the time "finished" is awaited, the object is replaced with the real one below
      };

      const resp = new Response(progressCtx.source.stream, {
        headers: { "Content-Type": "application/wasm" },
      });
      const blob = await resp.blob().catch((error) => {
        throw this.startupFailure(
          new Error(
            `the compiler could not be loaded (${describeError(error)})`,
          ),
        );
      });
      this.wasmLoadingProgress = {
        source: { type: "url", url: URL.createObjectURL(blob) },
        bytesLoaded: blob.size,
        bytesTotal: blob.size,
        finished: Promise.resolve(),
      };
    } else {
      this.wasmLoadingProgress = { ...progressCtx, bytesLoaded: 0 };
    }

    this.wasmLoadingProgress.finished.then(
      () => (this.alsWorkerStatus = "loaded"),
    );

    return this.runALSWASM(wasmAndData.dataFile);
  }

  /** What a failure to start Agda raises, for the page to show; the
   * worker, if any, is stopped. */
  private startupFailure(error: unknown) {
    if (this.alsWorkerStatus !== "terminated") {
      this.alsWorkerStatus = "errored";
      this._lspWorker?.terminate();
    }
    return new Error(`Agda could not start: ${describeError(error)}.`, {
      cause: error,
    });
  }

  async restartALSWASM() {
    await this.stopALSWASM();
    // FIXME: make one tick for the status transition, is it required?
    await new Promise((r) => setTimeout(r));
    return this.startALSWASM();
  }

  async _startALSWASM(workerInitData: ALSWorkerInitResultProxied) {
    this.alsWorkerStatus = "active";

    this.runningWASM = workerInitData.start();

    this.lspClient!.connect(this.alsRouter!.transport);
    this.editorView!.dispatch({
      effects: this.lspClientCompartment.reconfigure(
        this.lspClient!.plugin(`file://${this.currentFilePath}`),
      ),
    });

    const ret = await this.runningWASM;
    this.runningWASM = undefined;
    this.deactivate();

    this.alsWorkerStatus = "exited";
    console.log("ALS worker exited with code", ret);
    return ret;
  }

  makeALSTransport(port: MessagePort) {
    if (!this.editorView) {
      throw new Error("EditorView not ready");
    }

    const { readable: lspClientReadable, writable: lspClientWritable } =
      createPortByteStreams(port);

    const router = makeLSPTransport(
      this.editorView,
      (status) => this.updateIOTCMStatus(status),
      (tag: string, contents: any) => this.handleAgdaResponse(tag, contents),
      this,
    );

    router.intercept(lspClientReadable, lspClientWritable);

    return router;
  }

  async runALSWASM(dataFile: Response | null) {
    if (!this.wasmLoadingProgress) {
      throw new Error("No active loading wasm");
    }

    const lspChannel = new MessageChannel();

    this.alsRouter = this.makeALSTransport(lspChannel.port1);

    const { initPromise } = makeLspWorker(
      {
        wasmSource: { ...this.wasmLoadingProgress.source },
        // Absolute: the worker resolves URLs against itself.
        glueUrl: new URL(
          agdaVersionMap[this.config.agdaVersion].gluePath,
          location.href,
        ).href,
        port: lspChannel.port2,
        // ALS drives Agda through its interactive command loop, but unlike the
        // `agda --interaction` executable it does not enable Agda's loaded-file
        // cache by default. Pass the matching Agda option explicitly so repeat
        // checks can reuse declarations that have not changed.
        // --raw: the server answers in Agda's own JSON (ResponseJSONRaw),
        // which the transport reads.  The fork's +RTS -A64m -RTS (a 64 MB
        // nursery) is gone: the reactor's runtime takes it, and it made no
        // check faster while it grew the heap by 70 to 90 MiB (issue 59).
        args: ["--raw", "+AGDA", "--interaction", "-AGDA"],
      },
      (worker) => {
        this._lspWorker = worker;
        worker.addEventListener("error", (evt) => {
          console.error(evt);
          debugger;
        });
      },
    );

    // Each step names itself when it fails.
    const step = <T>(what: string, promise: Promise<T>) =>
      promise.catch((error) => {
        throw new Error(`${what} (${describeError(error)})`, { cause: error });
      });

    try {
      // The worker compiles the compiler while the page fetches the
      // archives.
      const [workerInitData, dataFileData, stdlibData, plfaData] =
        await Promise.all([
          step("the compiler could not be loaded", initPromise),
          dataFile ? dataFile.arrayBuffer() : Promise.resolve(null),
          fetchOrFail(
            `${asset("/agda-stdlib-2.3-patched.zip")}?cache=${cacheTokens.stdlib}`,
            "the standard library",
          ).then((x) => x.arrayBuffer()),
          fetchOrFail(
            `${asset("/plfa/project.zip")}?cache=${cacheTokens.plfaProject}`,
            "PLFA",
          ).then((x) => x.arrayBuffer()),
        ]);
      this.workerInitData = workerInitData;

      const archives = [dataFileData, stdlibData, plfaData].filter(
        (x): x is ArrayBuffer => x != null,
      );
      await step(
        "the drive could not be set up",
        this.workerInitData.mount(
          Comlink.transfer(
            {
              builtin: dataFileData,
              stdlib: stdlibData,
              plfa: plfaData,
              cacheNamespace: driveCacheNamespace,
            },
            archives,
          ),
        ),
      );
      this.driveIsCreated = true;

      await step("Agda's setup failed", this.workerInitData.setup());
    } catch (error) {
      throw this.startupFailure(error);
    }

    // revoke object url after it is consumed
    if (
      this.wasmLoadingProgress.source.type === "url" &&
      this.wasmLoadingProgress.source.url.startsWith("blob:")
    ) {
      URL.revokeObjectURL(this.wasmLoadingProgress.source.url);
    }

    return this._startALSWASM(this.workerInitData!);
  }

  async stopALSWASM() {
    if (this.alsWorkerStatus !== "active") {
      throw new Error("cannot stop if the status is not active");
    }
    // FIXME: cannot reuse the worker, transport just deadlock
    this.alsWorkerStatus = "deactivating";
    await this.lspClient!.request("shutdown", null);
    this.lspClient!.notification("exit", null);
    await this.runningWASM;
    this.runningWASM = undefined;
    this.alsWorkerStatus = "exited";
    this.deactivate();
  }

  terminateALSWASM() {
    console.log("attempting to terminate the worker");
    if (this.wasmLoadingProgress) {
      this.wasmLoadingProgress.cancel?.();
    }
    this.wasmLoadingProgress = null;

    this._lspWorker?.terminate();
    this._lspWorker = undefined;
    this.workerInitData = undefined;
    this.runningWASM = undefined;

    this.driveIsCreated = false;
    this.driveArchiveLoading = false;
    this._archiveMountPromise = undefined;
    this._mountedDriveArchives.clear();
    this.loadedSnapshot = undefined;
    this.pendingLoadSnapshot = undefined;
    this.pendingGoalCheck = false;

    this.alsWorkerStatus = "terminated";
    this.deactivate();
  }

  deactivate() {
    this.lspClient!.disconnect();
    this.editorView!.dispatch({
      effects: this.lspClientCompartment.reconfigure([]),
    });
  }

  async loadAgdaFile() {
    if (this.alsWorkerStatus !== "active") {
      throw new Error("Agda is still starting");
    }

    const source = this.editorView?.state.doc.toString();
    if (source == null) throw new Error("The Agda editor is not ready");

    if (
      this.loadedSnapshot?.filePath === this.currentFilePath &&
      this.loadedSnapshot.source === source &&
      !this.problems.some((problem) => problem.severity === "error")
    ) {
      this.lastAction = "Already checked";
      return;
    }

    const fastGoal = this.getFastGoalCheck(source);
    if (fastGoal) {
      this.lastAction = `Checking goal ${fastGoal.id}…`;
      this.lastCheckDurationMs = undefined;
      this.pendingCheckStartedAt = performance.now();
      this.problems = [];
      this.lastResult = null;
      this.activeGoalId = fastGoal.id;
      this.pendingExpression = fastGoal.value;
      this.pendingGoalCheck = true;
      try {
        await this.sendInteraction(
          `Cmd_give WithoutForce ${fastGoal.id} noRange ${JSON.stringify(fastGoal.value)}`,
        );
      } catch (error) {
        this.pendingCheckStartedAt = undefined;
        this.pendingGoalCheck = false;
        throw error;
      }
      return;
    }

    this.lastAction = "Checking source…";
    this.lastCheckDurationMs = undefined;
    this.pendingCheckStartedAt = performance.now();
    this.problems = [];
    this.lastResult = null;
    this.goalInfo = {};
    this.interactionPoints = [];
    this.activeGoalId = undefined;

    await this.syncEditorToDrive({ forLoad: true });

    const encodedFilePath = JSON.stringify(this.currentFilePath);
    this.pendingLoadSnapshot = {
      filePath: this.currentFilePath,
      source,
    };
    try {
      await this.sendInteraction(`Cmd_load ${encodedFilePath} []`);
    } catch (error) {
      this.pendingLoadSnapshot = undefined;
      this.pendingCheckStartedAt = undefined;
      throw error;
    }
  }

  /**
   * A single edit wholly inside one live goal can be checked by stock Agda's
   * Cmd_give. Everything else deliberately falls back to Cmd_load, so edits
   * to declarations, imports, or more than one hole always recheck the module.
   */
  private getFastGoalCheck(source: string) {
    const snapshot = this.loadedSnapshot;
    if (
      !this.editorView ||
      !snapshot ||
      snapshot.filePath !== this.currentFilePath
    ) {
      return undefined;
    }

    const previous = snapshot.source;
    let prefix = 0;
    const shortest = Math.min(previous.length, source.length);
    while (prefix < shortest && previous[prefix] === source[prefix]) prefix++;
    if (prefix === previous.length && prefix === source.length)
      return undefined;

    let suffix = 0;
    while (
      suffix < previous.length - prefix &&
      suffix < source.length - prefix &&
      previous[previous.length - 1 - suffix] ===
        source[source.length - 1 - suffix]
    ) {
      suffix++;
    }

    const previousChangeEnd = previous.length - suffix;
    const sourceChangeEnd = source.length - suffix;
    const delta = source.length - previous.length;

    for (const goal of this.getGoals()) {
      const previousGoalTo = goal.to - delta;
      const sourceInnerFrom = goal.from + 2;
      const sourceInnerTo = goal.to - 2;
      const previousInnerFrom = goal.from + 2;
      const previousInnerTo = previousGoalTo - 2;
      if (
        source.slice(goal.from, goal.from + 2) !== "{!" ||
        source.slice(goal.to - 2, goal.to) !== "!}" ||
        previous.slice(goal.from, goal.from + 2) !== "{!" ||
        previous.slice(previousGoalTo - 2, previousGoalTo) !== "!}" ||
        prefix < sourceInnerFrom ||
        sourceChangeEnd > sourceInnerTo ||
        prefix < previousInnerFrom ||
        previousChangeEnd > previousInnerTo
      ) {
        continue;
      }

      const value = source.slice(sourceInnerFrom, sourceInnerTo).trim();
      if (value) return { id: goal.id, value };
    }
    return undefined;
  }

  /** Write the buffer to the drive.  For a load (`forLoad`), the text
   * written becomes the one Agda's positions refer to, until the next
   * load. */
  async syncEditorToDrive({ forLoad = false } = {}) {
    if (!this.editorView || !this.driveIsCreated) return;

    const doc = this.editorView!.state.doc.toString();
    this.persistDocument(doc);
    if (forLoad) this.editorView!.dispatch({ effects: commit.of() });

    await this.workerInitData!.writeFile(
      this.currentFilePath,
      browserAgdaSource(this.currentFilePath, doc),
    );

    this.lspClient!.notification("textDocument/didSave", {
      textDocument: {
        uri: "file://" + this.currentFilePath,
      },
    });
  }

  async mountDriveArchives(urls: string[]): Promise<void> {
    if (this._archiveMountPromise) {
      await this._archiveMountPromise;
      return this.mountDriveArchives(urls);
    }

    const missing = urls.filter(
      (url, index) =>
        !this._mountedDriveArchives.has(url) && urls.indexOf(url) === index,
    );
    if (!missing.length) return;
    if (!this.driveIsCreated) throw new Error("Agda filesystem is not ready");

    this.driveArchiveLoading = true;
    this.lastAction = `Loading ${missing.length} PLFA cache ${missing.length === 1 ? "bundle" : "bundles"}…`;
    const mount = async () => {
      const archives = await Promise.all(
        missing.map(async (url) => {
          const response = await fetch(url);
          if (!response.ok)
            throw new Error(`Could not load Agda cache: ${response.status}`);
          return { url, data: await response.arrayBuffer() };
        }),
      );
      this.lastAction = "Installing PLFA cache…";
      for (const archive of archives) {
        await this.workerInitData!.mountArchive(
          Comlink.transfer(archive.data, [archive.data]),
        );
        this._mountedDriveArchives.add(archive.url);
      }
    };
    this._archiveMountPromise = mount();
    try {
      await this._archiveMountPromise;
      this.lastAction = "PLFA cache ready";
    } finally {
      this._archiveMountPromise = undefined;
      this.driveArchiveLoading = false;
    }
  }

  /** Follow the router's status, except that when the server is first
   * ready, the controller asks Agda for its version (the reactor has no
   * `--version`, and the server reports no version of its own), and the
   * page sees the server ready only once Agda has answered. */
  private updateIOTCMStatus(status: AgdaIOTCMStatus) {
    if (this.versionQuery === "unsent" && status === "ready") {
      this.versionQuery = "pending";
      // After the router has sent the message that made it ready.
      queueMicrotask(() =>
        this.sendInteraction("Cmd_show_version").catch((error) => {
          console.warn("Could not ask Agda for its version", error);
          this.versionQuery = "answered";
          this.iotcmStatus = "ready";
        }),
      );
      return;
    }
    if (this.versionQuery === "pending") {
      if (status !== "ready") return;
      this.versionQuery = "answered";
    }
    this.iotcmStatus = status;
  }

  async sendInteraction(command: string) {
    if (!this.lspClient || this.alsWorkerStatus !== "active") {
      throw new Error("Agda is not ready");
    }
    const encodedFilePath = JSON.stringify(this.currentFilePath);
    return this.lspClient.request("agda", {
      tag: "CmdReq",
      contents: `IOTCM ${encodedFilePath} NonInteractive Direct (${command})`,
    });
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
    return goal;
  }

  async queryGoalType(id?: number) {
    if (id != null) this.selectGoal(id);
    const goal = this.requireGoal();
    this.lastAction = `Inspecting goal ${goal.id}…`;
    return this.sendInteraction(
      `Cmd_goal_type Normalised ${goal.id} noRange ""`,
    );
  }

  async queryContext(id?: number) {
    if (id != null) this.selectGoal(id);
    const goal = this.requireGoal();
    this.lastAction = `Loading context for goal ${goal.id}…`;
    return this.sendInteraction(`Cmd_context Normalised ${goal.id} noRange ""`);
  }

  async give(expression?: string) {
    const goal = this.requireGoal();
    const value =
      expression?.trim() || getAgdaGoalContents(this.editorView!.state, goal);
    if (!value) throw new Error("Enter an expression to give");
    this.pendingExpression = value;
    this.lastAction = `Giving goal ${goal.id}…`;
    return this.sendInteraction(
      `Cmd_give WithoutForce ${goal.id} noRange ${JSON.stringify(value)}`,
    );
  }

  async refine(expression?: string) {
    const goal = this.requireGoal();
    const value =
      expression?.trim() || getAgdaGoalContents(this.editorView!.state, goal);
    this.pendingExpression = value;
    this.lastAction = `Refining goal ${goal.id}…`;
    return this.sendInteraction(
      `Cmd_refine_or_intro False ${goal.id} noRange ${JSON.stringify(value)}`,
    );
  }

  async caseSplit(patterns = "") {
    const goal = this.requireGoal();
    this.lastAction = `Splitting goal ${goal.id}…`;
    return this.sendInteraction(
      `Cmd_make_case ${goal.id} noRange ${JSON.stringify(patterns)}`,
    );
  }

  async infer(expression: string) {
    if (!expression.trim()) throw new Error("Enter an expression to infer");
    this.lastAction = "Inferring type…";
    return this.sendInteraction(
      `Cmd_infer_toplevel Normalised ${JSON.stringify(expression)}`,
    );
  }

  async normalize(expression: string) {
    if (!expression.trim()) throw new Error("Enter an expression to normalize");
    const goal = this.getActiveGoal();
    this.lastAction = "Normalizing expression…";
    if (goal) {
      this.activeGoalId = goal.id;
      return this.sendInteraction(
        `Cmd_compute DefaultCompute ${goal.id} noRange ${JSON.stringify(expression)}`,
      );
    }
    return this.sendInteraction(
      `Cmd_compute_toplevel DefaultCompute ${JSON.stringify(expression)}`,
    );
  }

  async abort() {
    this.lastAction = "Aborting…";
    return this.sendInteraction("Cmd_abort");
  }

  persistDocument(source: string) {
    localStorage.setItem(this.currentStorageKey, source);
  }

  setDocument(
    source: string,
    filePath = "/Main.agda",
    storageKey = LS_DOC_KEY,
  ) {
    if (!this.editorView) return;
    const pathChanged = filePath !== this.currentFilePath;
    this.currentFilePath = filePath;
    this.currentStorageKey = storageKey;
    this.checked = false;
    this.problems = [];
    this.interactionPoints = [];
    this.goalInfo = {};
    this.activeGoalId = undefined;
    this.lastResult = null;
    this.lastCheckDurationMs = undefined;
    this.pendingCheckStartedAt = undefined;
    this.pendingGoalCheck = false;
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

  private handleAgdaResponse(tag: string, contents: any) {
    if (tag === "ResponseEnd") {
      if (this.pendingGoalCheck) {
        this.checked =
          this.getGoals().length === 0 &&
          !this.problems.some((problem) => problem.severity === "error");
        this.pendingGoalCheck = false;
      }
      if (this.pendingCheckStartedAt != null) {
        this.lastCheckDurationMs =
          performance.now() - this.pendingCheckStartedAt;
        this.pendingCheckStartedAt = undefined;
      }
      if (this.pendingLoadSnapshot) {
        let completedLoad = false;
        if (!this.problems.some((problem) => problem.severity === "error")) {
          this.loadedSnapshot = {
            filePath: this.pendingLoadSnapshot.filePath,
            // Cmd_load may expand a `?` into an interaction hole. Store the
            // editor's actual post-response text so the next diff is exact.
            source:
              this.editorView?.state.doc.toString() ??
              this.pendingLoadSnapshot.source,
          };
          completedLoad = true;
        }
        this.pendingLoadSnapshot = undefined;
        if (completedLoad) {
          void this.workerInitData?.persist().catch((error: unknown) =>
            console.warn("Could not persist the Agda cache", error),
          );
        }
      }
      this.lastAction = this.problems.some(
        (problem) => problem.severity === "error",
      )
        ? "Check failed"
        : this.checked
          ? "Checked successfully"
          : "Ready";
      return;
    }
    if (tag !== "ResponseJSONRaw" || !contents) return;

    if (contents.kind === "RunningInfo") {
      this.runningMessages = [
        ...this.runningMessages.slice(-49),
        contents.message,
      ];
      return;
    }
    if (contents.kind === "ClearRunningInfo") {
      this.runningMessages = [];
      return;
    }
    if (contents.kind === "InteractionPoints") {
      this.interactionPoints = contents.interactionPoints.map(
        (point: any) => point.id,
      );
      if (
        this.activeGoalId == null ||
        !this.interactionPoints.includes(this.activeGoalId)
      ) {
        this.activeGoalId = this.interactionPoints[0];
      }
      return;
    }
    if (contents.kind !== "DisplayInfo") return;

    const info = contents.info;
    if (info.kind === "Error") {
      this.problems = [
        {
          severity: "error",
          message: info.error?.message ?? "Agda reported an error",
        },
        ...(info.warnings ?? []).map((warning: any) => ({
          severity: "warning" as const,
          message: warning.message ?? String(warning),
        })),
      ];
      this.lastResult = {
        kind: "Error",
        title: "Type checking failed",
        body: info.error?.message ?? "",
      };
    } else if (info.kind === "AllGoalsWarnings") {
      this.problems = [
        ...(info.errors ?? []).map((error: any) => ({
          severity: "error" as const,
          message: error.message ?? String(error),
        })),
        ...(info.warnings ?? []).map((warning: any) => ({
          severity: "warning" as const,
          message: warning.message ?? String(warning),
        })),
      ];
      this.goalInfo = Object.fromEntries(
        (info.visibleGoals ?? []).flatMap((goal: any) => {
          const id = goal.constraintObj?.id;
          if (typeof id !== "number") return [];
          return [
            [
              id,
              {
                id,
                type: goal.type,
                context: this.goalInfo[id]?.context ?? [],
              },
            ],
          ];
        }),
      );
    } else if (info.kind === "GoalSpecific") {
      const id = info.interactionPoint.id;
      const goalInfo = info.goalInfo;
      if (typeof goalInfo.type === "string") {
        this.goalInfo = {
          ...this.goalInfo,
          [id]: {
            id,
            type: goalInfo.type,
            context:
              goalInfo.kind === "GoalType"
                ? (goalInfo.entries ?? []).map((entry: any) => ({
                    name: entry.reifiedName || entry.originalName,
                    type: entry.binding,
                    inScope: entry.inScope,
                  }))
                : (this.goalInfo[id]?.context ?? []),
          },
        };
        this.lastResult = {
          kind: goalInfo.kind,
          title: `Goal ${id}`,
          body: goalInfo.type,
        };
      } else {
        this.lastResult = {
          kind: goalInfo.kind,
          title: `Goal ${id}`,
          body:
            goalInfo.expr ?? goalInfo.type ?? JSON.stringify(goalInfo, null, 2),
        };
      }
    } else if (info.kind === "InferredType") {
      this.lastResult = {
        kind: info.kind,
        title: "Inferred type",
        body: info.expr,
      };
    } else if (info.kind === "NormalForm") {
      this.lastResult = {
        kind: info.kind,
        title: "Normal form",
        body: info.expr,
      };
    } else if (info.kind === "Context") {
      const context = (info.context ?? []).map((entry: any) => ({
        name: entry.reifiedName || entry.originalName,
        type: entry.binding,
        inScope: entry.inScope,
      }));
      const id = info.interactionPoint.id;
      this.goalInfo = {
        ...this.goalInfo,
        [id]: { id, type: this.goalInfo[id]?.type, context },
      };
      this.lastResult = {
        kind: info.kind,
        title: `Context for goal ${id}`,
        body:
          context
            .map((entry: any) => `${entry.name} : ${entry.type}`)
            .join("\n") || "Empty context",
      };
    } else if (info.kind === "Version") {
      if (this.versionQuery === "pending") {
        // The controller's own question, not the reader's.
        this.reportedAgdaVersion = info.version;
        return;
      }
      this.lastResult = {
        kind: info.kind,
        title: "Agda version",
        body: info.version,
      };
    }
  }
}
