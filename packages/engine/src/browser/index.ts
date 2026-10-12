// File: packages/engine/src/browser/index.ts
//
// The browser engine: the Agda Language Server's reactor build, compiled
// to WebAssembly, in a worker with the in-memory drive Agda reads (issue
// 59), reached over a MessagePort, one JSON-RPC message per event.  It owns
// what the page's controller and transport did to start and reach Agda:
// the compiler's download and its progress, the archives the drive is laid
// out from, the worker, the Language Server Protocol session, the `agda`
// request that carries each command, and the acknowledgement of each of
// the server's requests, without which it sends no more.
//
// The language server wraps Agda's interaction protocol: a command is the
// `contents` of an `agda` request (`CmdReq`), its acknowledgement
// (`CmdRes`) says only that the command was queued, and Agda's responses
// come back as `agda` requests from the server, `ResponseJSONRaw` carrying
// Agda's own JSON (the server must be started with `--raw`), until
// `ResponseEnd`, which the server sends when the command has ended
// (agda-language-server's src/Agda.hs and src/Monad.hs at v8).  This
// transport unwraps that envelope and nothing more.
//
// An editor may speak to the same server, for its own features (the
// page's hover tooltips): `editorChannel` is a transport in the shape
// CodeMirror's language-server client takes, multiplexed onto this
// session.  The server's `initialize` is the engine's; the editor's is
// answered with its result, and its requests' ids are kept apart.
//
// The host supplies what is its own: the URLs (nothing is fetched that
// the host has not named), the worker (which the host's bundler builds
// from `@agda-native-ide/engine/browser/worker`), and when to persist.
// Parts are the fork's: the startup and its failure messages from
// src/lib/controller.svelte.ts and src/lib/index.js, the router's
// acknowledgements from src/lib/agda/transport.js (plfa-playground
// ae0aa84c, with this repository's changes for issues 8, 58 and 59).

import * as Comlink from "comlink";

import {
  failure,
  openSession,
  type AgdaSession,
  type Capabilities,
  type EngineTransport,
  type Failure,
  type SessionOptions,
  type TransportEvent,
} from "../core/index.js";
import type {
  ALSWorkerInitObject,
  ALSWorkerInitResultProxied,
  WASMSource,
} from "./worker/protocol.js";

export type { WASMSource } from "./worker/protocol.js";

export interface BrowserConfig {
  /** A new worker running `@agda-native-ide/engine/browser/worker`, as the
   * host's bundler builds it. */
  createWorker: () => Worker;
  /** The compiler (the reactor), gzipped, and its length unzipped. */
  compiler: { url: string; byteLength?: number };
  /** The reactor's JavaScript glue, by an absolute URL: the worker
   * imports it as it is. */
  glueUrl: string;
  /** The archives the drive is laid out from: Agda's builtin library, the
   * standard library, and a project at the root. */
  archives: { builtin?: string | null; stdlib?: string | null; project?: string | null };
  /** What a failure to fetch the project's archive calls it (default "the
   * project's archive"; the page's is "PLFA"). */
  projectName?: string;
  /** The namespace of the drive's IndexedDB cache. */
  cacheNamespace: string;
  /** The server's arguments after its name; `--raw` is required. */
  args: readonly string[];
  /** The project's root on the drive (default "/"): where relative paths
   * resolve, and the only tree the transport reads or writes sources in,
   * as the native transport's project root is. */
  root?: string;
  /** Follows the startup: the compiler's bytes as they arrive, and each
   * phase. */
  onProgress?: (progress: BrowserProgress) => void;
  /** Aborting it stops the engine, during its startup or after, and the
   * downloads it started. */
  signal?: AbortSignal;
}

export type BrowserProgress =
  | { phase: "downloading"; loaded: number; total: number }
  | { phase: "downloaded" }
  | { phase: "starting" }
  | { phase: "ready" };

/** What the editor's language-server client exchanges: one JSON-RPC
 * message per string (CodeMirror's `Transport`). */
export interface EditorChannel {
  send(message: string): void;
  subscribe(handler: (message: string) => void): void;
  unsubscribe(handler: (message: string) => void): void;
}

export const browserCapabilities: Capabilities = {
  interaction: { supported: true },
  batch: {
    supported: false,
    reason:
      "the page's batch lane (the plain agda compiled to WebAssembly, one process per check, whose exit code is the verdict) is issue #30; this engine has the interaction lane only",
  },
};

/** An error in its own words, with its kind when it names one, and
 * without a closing period, since the host's sentence adds one. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error).trim().replace(/\.$/, "");
  const message = error.message.trim().replace(/\.$/, "");
  return error.name && error.name !== "Error" ? `${error.name}: ${message}` : message;
}

/** Fetch a file Agda needs, or fail saying which file and why. */
async function fetchOrFail(url: string, what: string, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(url, signal ? { signal } : undefined);
  } catch (error) {
    throw new Error(`${what} could not be downloaded (${describeError(error)})`, { cause: error });
  }
  if (!response.ok)
    throw new Error(
      `${what} could not be downloaded (HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""})`,
    );
  return response;
}

/** Read a file's body, or fail saying which file and why: a transfer can
 * break off after its headers have arrived. */
async function readOrFail(response: Response, what: string) {
  try {
    return await response.arrayBuffer();
  } catch (error) {
    throw new Error(`${what} could not be downloaded (${describeError(error)})`, { cause: error });
  }
}

/** A stream of a response's body that reports its bytes as they pass,
 * and its end. */
function traceProgress(
  body: ReadableStream<Uint8Array>,
  onBytes: (loaded: number) => void,
  onDone: () => void,
) {
  let loaded = 0;
  let cancelled = false;
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const drain = async () => {
        for (;;) {
          const chunk = await reader.read();
          if (cancelled) throw new Error("cancelled");
          if (chunk.done) break;
          loaded += chunk.value.byteLength;
          onBytes(loaded);
          controller.enqueue(chunk.value);
        }
        controller.close();
        onDone();
      };
      drain()
        .catch((error) => controller.error(error))
        .finally(() => reader.releaseLock());
    },
  });
  return { stream, cancel: () => (cancelled = true) };
}

/** An absolute drive path with its `.` and `..` segments resolved (`..`
 * never climbs above the drive's root). */
function normalize(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/** A promise, or a rejection after `ms`. */
function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const isSafari =
  typeof navigator !== "undefined" && /Apple Computer/.test((navigator as { vendor?: string }).vendor ?? "");

type JsonRpcId = number | string;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export class BrowserTransport implements EngineTransport {
  readonly engine = "browser" as const;
  readonly capabilities = browserCapabilities;
  readonly editorChannel: EditorChannel;

  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private readonly editorHandlers = new Set<(message: string) => void>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** The editor's request ids, by the ids they travel under. */
  private readonly editorIds = new Map<string, JsonRpcId>();
  private counter = 0;
  private initializeResult: unknown;
  private readonly initialized: Promise<void>;
  private markInitialized!: () => void;
  private exited = false;
  private worker: Worker | undefined;
  private port: MessagePort | undefined;
  private drive: ALSWorkerInitResultProxied | undefined;
  private cancelDownload: (() => void) | undefined;
  /** Stops every download the transport started. */
  private readonly downloads = new AbortController();
  /** The compiler's object URL, on Safari, until the worker has it. */
  private objectUrl: string | undefined;
  private readonly mounted = new Set<string>();
  private mounting: Promise<void> | undefined;
  private readonly root: string;
  /** Rejects when the transport is terminated or the engine exits, so a
   * start or a drive call in progress stops waiting on a worker that is
   * gone (a call to a dead worker never settles). */
  private readonly stopped: Promise<never>;
  private stop!: (error: Error) => void;

  constructor(private readonly config: BrowserConfig) {
    this.root = normalize(config.root ?? "/").replace(/\/?$/, "/");
    this.initialized = new Promise((resolve) => (this.markInitialized = resolve));
    this.stopped = new Promise<never>((_resolve, reject) => (this.stop = reject));
    this.stopped.catch(() => {});
    const handlers = this.editorHandlers;
    this.editorChannel = {
      send: (message) => this.fromEditor(message),
      subscribe: (handler) => void handlers.add(handler),
      unsubscribe: (handler) => void handlers.delete(handler),
    };
  }

  // ---- EngineTransport ----------------------------------------------------

  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(line: string): void {
    if (this.exited) throw new Error("the language server has stopped");
    void this.agda(line, false);
  }

  abort(line: string): void {
    if (!this.exited) void this.agda(line, true);
  }

  resolvePath(relative: string): string {
    return this.inside(relative);
  }

  async writeSource(path: string, text: string): Promise<void> {
    const target = this.inside(path);
    await this.until(this.ready().writeFile(target, text));
  }

  async readSource(path: string): Promise<string | undefined> {
    const target = this.inside(path);
    return this.until(this.ready().readFile(target));
  }

  /** The drive, or why it cannot be asked. */
  private ready(): ALSWorkerInitResultProxied {
    if (this.exited) throw new Error("the language server has stopped");
    if (!this.drive) throw new Error("the drive is not ready");
    return this.drive;
  }

  /** A promise, unless the engine stops first. */
  private until<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.stopped]);
  }

  /** A path on the drive, normalized, if it lies under the root; a
   * relative path resolves against the root. */
  private inside(path: string): string {
    const absolute = normalize(path.startsWith("/") ? path : this.root + path);
    if (absolute !== this.root.replace(/\/$/, "") && !absolute.startsWith(this.root) && this.root !== "/")
      throw new Error(`${path} is outside the project's root on the drive, ${this.root}`);
    return absolute;
  }

  async terminate(): Promise<void> {
    this.stop(new Error("the page stopped Agda"));
    this.exit({ type: "exit", code: null, signal: "terminated", detail: "the language server was stopped" });
  }

  /** Release the worker, its port and the downloads. */
  private release() {
    this.cancelDownload?.();
    this.downloads.abort();
    this.worker?.terminate();
    this.worker = undefined;
    this.drive = undefined;
    if (this.port) {
      this.port.onmessage = null;
      this.port.close();
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }

  // ---- What the page asks of the drive ------------------------------------

  /** Fetch zips by URL and extract them at the drive's root, once each. */
  async mountArchives(urls: readonly string[]): Promise<void> {
    if (this.mounting) {
      await this.mounting;
      return this.mountArchives(urls);
    }
    const missing = urls.filter((url, index) => !this.mounted.has(url) && urls.indexOf(url) === index);
    if (!missing.length) return;
    if (this.exited) throw new Error("the language server has stopped");
    const drive = this.drive;
    if (!drive) throw new Error("Agda's filesystem is not ready");
    const mount = async () => {
      const archives = await this.until(
        Promise.all(
          missing.map(async (url) => {
            const response = await fetch(url, { signal: this.downloads.signal });
            if (!response.ok) throw new Error(`Could not load Agda cache: ${response.status}`);
            return { url, data: await response.arrayBuffer() };
          }),
        ),
      );
      for (const archive of archives) {
        await this.until(drive.mountArchive(Comlink.transfer(archive.data, [archive.data])));
        this.mounted.add(archive.url);
      }
    };
    this.mounting = mount();
    try {
      await this.mounting;
    } finally {
      this.mounting = undefined;
    }
  }

  /** Persist the sources written and the interfaces Agda wrote, in the
   * drive's IndexedDB cache. */
  async persist(): Promise<void> {
    if (this.drive && !this.exited) await this.until(this.drive.persist());
  }

  // ---- Startup ----------------------------------------------------------------

  /** Download the compiler and the archives, start the worker, lay out the
   * drive, run Agda's setup, start the server and open its session.
   * Resolves once the server has answered `initialize`; when the server
   * later stops, an exit event says so. */
  async start(): Promise<void> {
    const { config } = this;
    const until = <T>(promise: Promise<T>) => this.until(promise);
    const signal = this.downloads.signal;
    const compressed = await until(fetchOrFail(config.compiler.url, "the compiler", signal));
    if (!compressed.body) throw new Error("the compiler could not be downloaded (an empty response)");
    // Some static servers attach Content-Encoding to .gz files, so fetch
    // has already decoded the response body; others serve the gzip bytes
    // as an opaque file and need an explicit DecompressionStream.
    const body = compressed.headers.get("Content-Encoding")?.toLowerCase().includes("gzip")
      ? compressed.body
      : compressed.body.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    const total = config.compiler.byteLength ?? -1;
    const traced = traceProgress(
      body,
      (loaded) => config.onProgress?.({ phase: "downloading", loaded, total }),
      () => config.onProgress?.({ phase: "downloaded" }),
    );
    this.cancelDownload = traced.cancel;
    config.onProgress?.({ phase: "downloading", loaded: 0, total });

    let wasmSource: WASMSource;
    if (isSafari) {
      // Safari cannot transfer a ReadableStream, so the compiler is read
      // whole and passed by an object URL.
      const blob = await until(
        new Response(traced.stream, { headers: { "Content-Type": "application/wasm" } })
          .blob()
          .catch((error) => {
            throw new Error(`the compiler could not be loaded (${describeError(error)})`, { cause: error });
          }),
      );
      this.objectUrl = URL.createObjectURL(blob);
      wasmSource = { type: "url", url: this.objectUrl };
    } else {
      wasmSource = { type: "stream", stream: traced.stream };
    }

    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (event: MessageEvent<string>) => this.receive(event.data);

    const worker = config.createWorker();
    this.worker = worker;
    worker.addEventListener("error", (event) => {
      const detail = `the worker failed (${event.message || "an error"})`;
      this.stop(new Error(detail));
      this.exit({ type: "exit", code: null, detail });
    });
    const endpoint = Comlink.wrap<{ init: (init: ALSWorkerInitObject) => ALSWorkerInitResultProxied }>(worker);
    const init: ALSWorkerInitObject = {
      wasmSource,
      glueUrl: config.glueUrl,
      port: channel.port2,
      args: [...config.args],
    };
    const initPromise = endpoint.init(
      Comlink.transfer(init, [...(wasmSource.type === "stream" ? [wasmSource.stream] : []), channel.port2]),
    ) as unknown as Promise<ALSWorkerInitResultProxied>;

    // Each step names itself when it fails.
    const step = <T>(what: string, promise: Promise<T>) =>
      promise.catch((error) => {
        throw new Error(`${what} (${describeError(error)})`, { cause: error });
      });
    const archive = (url: string | null | undefined, what: string) =>
      url ? fetchOrFail(url, what, signal).then((response) => readOrFail(response, what)) : Promise.resolve(null);

    // The worker compiles the compiler while the page fetches the archives.
    const [drive, builtin, stdlib, project] = await until(Promise.all([
      step("the compiler could not be loaded", initPromise),
      archive(config.archives.builtin, "Agda's builtin library"),
      archive(config.archives.stdlib, "the standard library"),
      archive(config.archives.project, config.projectName ?? "the project's archive"),
    ]));
    this.drive = drive;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    config.onProgress?.({ phase: "starting" });

    const buffers = [builtin, stdlib, project].filter((x): x is ArrayBuffer => x != null);
    await until(step(
      "the drive could not be set up",
      drive.mount(
        Comlink.transfer(
          { builtin, stdlib, plfa: project, cacheNamespace: config.cacheNamespace },
          buffers,
        ),
      ),
    ));
    await until(step("Agda's setup failed", drive.setup()));

    // The server runs until it exits; its exit is the session's end.
    void drive.start().then(
      (code) => this.exit({ type: "exit", code, detail: `the language server exited with code ${code}` }),
      (error) => this.exit({ type: "exit", code: null, detail: `the language server failed (${describeError(error)})` }),
    );

    const initialize = await until(step(
      "the language server did not start",
      within(
        this.request("initialize", {
          processId: null,
          clientInfo: { name: "agda-native-ide" },
          rootUri: null,
          capabilities: {},
        }),
        60_000,
        "it did not answer initialize within 60 s",
      ),
    ));
    this.initializeResult = initialize;
    this.notify("initialized", {});
    this.markInitialized();
    config.onProgress?.({ phase: "ready" });
  }

  // ---- JSON-RPC ---------------------------------------------------------------

  private post(message: JsonRpcMessage) {
    this.port?.postMessage(JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = `engine-${++this.counter}`;
    return new Promise((resolve, reject) => {
      if (this.exited) return reject(new Error("the language server has stopped"));
      this.pending.set(id, { resolve, reject });
      this.post({ id, method, params });
    });
  }

  private notify(method: string, params: unknown) {
    this.post({ method, params });
  }

  private async agda(line: string, isAbort: boolean) {
    const id = `engine-${++this.counter}`;
    let result: unknown;
    try {
      result = await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.post({ id, method: "agda", params: { tag: "CmdReq", contents: line } });
      });
    } catch (error) {
      // The engine's exit ends what was in flight; anything else is the
      // server failing the request, so Agda never ran the command.
      if (this.exited) return;
      result = { contents: describeError(error) };
    }
    const refused = (result as { tag?: string; contents?: unknown } | undefined)?.contents;
    if (refused != null) {
      // The server could not read the command, so Agda never ran it.
      this.emit({ type: "noise", text: `the language server refused the command: ${JSON.stringify(refused)}` });
      if (!isAbort) this.emit({ type: "end" });
    }
  }

  private receive(data: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(data);
    } catch {
      this.emit({ type: "noise", text: `not JSON: ${data.slice(0, 200)}` });
      return;
    }
    if (message.method !== undefined && message.id !== undefined && message.id !== null) {
      // A request from the server: acknowledge it, or the server waits.
      this.post({ id: message.id, result: null });
      if (message.method !== "agda") return;
      const params = message.params as { tag?: string; contents?: unknown } | undefined;
      if (params?.tag === "ResponseJSONRaw") this.emit({ type: "response", json: params.contents });
      else if (params?.tag === "ResponseEnd") this.emit({ type: "end" });
      else this.emit({ type: "noise", text: `a response the engine does not read: ${String(params?.tag)}` });
      return;
    }
    if (message.method !== undefined) {
      // A notification: the editor's, if it listens.
      for (const handler of this.editorHandlers) handler(data);
      return;
    }
    const id = String(message.id);
    const editorId = this.editorIds.get(id);
    if (editorId !== undefined) {
      this.editorIds.delete(id);
      const forwarded = JSON.stringify({ ...message, id: editorId });
      for (const handler of this.editorHandlers) handler(forwarded);
      return;
    }
    const waiting = this.pending.get(id);
    if (!waiting) return;
    this.pending.delete(id);
    if (message.error !== undefined) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  }

  private fromEditor(text: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const reply = (result: unknown) => {
      const answer = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      for (const handler of this.editorHandlers) handler(answer);
    };
    if (message.method === undefined) return; // A reply to a server request: the engine acknowledged it.
    if (message.id === undefined || message.id === null) {
      if (message.method === "initialized" || message.method === "exit") return;
      if (this.exited) return;
      if (message.method === "$/cancelRequest") {
        // The server knows the request by the id it travels under.
        const cancelled = (message.params as { id?: JsonRpcId } | undefined)?.id;
        const travelling = [...this.editorIds].find(([, id]) => id === cancelled)?.[0];
        if (travelling !== undefined) this.post({ ...message, params: { id: travelling } });
        return;
      }
      this.post(message);
      return;
    }
    if (message.method === "initialize") {
      void this.initialized.then(() => reply(this.initializeResult));
      return;
    }
    if (message.method === "shutdown") return reply(null);
    if (this.exited) return;
    const id = `editor-${++this.counter}`;
    this.editorIds.set(id, message.id);
    this.post({ ...message, id });
  }

  private emit(event: TransportEvent) {
    for (const listener of this.listeners) listener(event);
  }

  /** The engine is over, however it ended: stop what waits on it, release
   * the worker, and say so once. */
  private exit(event: Extract<TransportEvent, { type: "exit" }>) {
    if (this.exited) return;
    this.exited = true;
    this.stop(new Error(event.detail ?? "the language server has stopped"));
    for (const waiting of this.pending.values()) waiting.reject(new Error("the language server has stopped"));
    this.pending.clear();
    this.editorIds.clear();
    this.release();
    this.emit(event);
  }
}

/** Start the browser engine and open a session on it.  A failure says
 * which step of the startup failed, in the words the page shows after
 * "Agda could not start:". */
export async function startBrowserSession(
  config: BrowserConfig,
  options: SessionOptions = {},
): Promise<{ kind: "session"; session: AgdaSession; transport: BrowserTransport } | Failure> {
  const transport = new BrowserTransport(config);
  const stop = () => void transport.terminate();
  config.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (config.signal?.aborted) throw new Error("the page stopped Agda");
    await transport.start();
  } catch (error) {
    await transport.terminate();
    return failure("startup", describeError(error));
  }
  const opened = await openSession(transport, options);
  if (opened.kind !== "session") return opened;
  return { kind: "session", session: opened.session, transport };
}
