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
// from `@agda-native-ide/engine/browser/worker`), the sources the drive
// starts with (its project's own `.agda-lib`, issue 11), and when to
// persist.
//
// Parts are the fork's: the startup and its failure messages from
// src/lib/controller.svelte.ts and src/lib/index.js, the router's
// acknowledgements from src/lib/agda/transport.js (plfa-playground
// ae0aa84c, with this repository's changes for issues 8, 13, 58 and 59).

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
import { openArchiveStore, type ArchiveStore } from "./archive-store.js";

export type { WASMSource } from "./worker/protocol.js";
export { ARCHIVE_STORE, memoryArchiveStore, openArchiveStore } from "./archive-store.js";
export type { ArchiveStore, StoredArchive } from "./archive-store.js";
export { DRIVE_NAMESPACES_KEY, browserDriveCacheHost, forgetOtherDriveCaches } from "./drive-caches.js";
export type { DriveCacheHost } from "./drive-caches.js";

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
   * standard library, and more libraries, in order. */
  archives: {
    builtin?: string | null;
    stdlib?: string | null;
    libraries?: readonly LibraryArchive[];
  };
  /** Sources the drive starts with, at their paths under the root: a
   * project's own `.agda-lib`, which Agda finds beside the module it checks
   * (issue 11).  Written after the archives and over what the drive's
   * cache restores, before Agda starts, so a cached copy never stands in
   * for one. */
  files?: readonly { path: string; text: string }[];
  /** The namespace of the drive's IndexedDB cache. */
  cacheNamespace: string;
  /** Where the archives mounted by their SHA-256 are kept (issue 14): a
   * store, or the name of its IndexedDB database
   * (./archive-store.ts).  Without it nothing is kept, and an archive is
   * fetched every time it is mounted. */
  archiveStore?: string | ArchiveStore;
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

/** A library on the drive (issue 13): a zip whose entries are at their
 * paths on the drive, extracted at its root, as agda-algebras' sources
 * archive is, or PLFA's.  Agda's libraries file names its `.agda-lib`, and
 * the defaults file its name, after the standard library's. */
export interface LibraryArchive {
  url: string;
  /** Its `.agda-lib` on the drive. */
  agdaLib: string;
  /** Its name, as a `depend:` line names it. */
  name: string;
  /** What a failure to fetch it calls it (default "the library NAME"; the
   * page calls PLFA's "PLFA"). */
  what?: string;
}

/** An archive to mount after the engine has started (issue 14): a zip
 * whose entries are at their paths on the drive, extracted at its root.
 * With its SHA-256, its bytes are checked before they are mounted, and it
 * is kept in the transport's archive store under that digest, so that a
 * later mount reads it there instead of fetching it. */
export interface ArchiveRef {
  url: string;
  /** Its SHA-256, in hex. */
  sha256?: string;
  /** Its length in bytes, for the progress. */
  bytes?: number;
  /** What a failure calls it (default "the archive URL"). */
  what?: string;
  /** The library whose index names it, and its path there, kept with it. */
  library?: string;
  path?: string;
  /** False: the archive must come from the store, since the reader was
   * told it would not be downloaded; a miss fails with `ArchiveNotKept`. */
  fetch?: false;
}

/** An archive planned as kept that the store no longer has (another tab
 * evicted it, or the browser did): the host plans again, and asks. */
export class ArchiveNotKept extends Error {
  constructor(what: string) {
    super(`${what} is no longer kept in this browser`);
    this.name = "ArchiveNotKept";
  }
}

/** How a mount is going: its bytes, read from the store or fetched, of the
 * total its archives name (undefined when one names none), and its
 * archives mounted. */
export interface MountProgress {
  loaded: number;
  total: number | undefined;
  mounted: number;
  archives: number;
}

/** What a mount read: from the network, and from the archive store. */
export interface MountReport {
  fetched: number;
  fetchedBytes: number;
  kept: number;
  keptBytes: number;
}

export interface MountOptions {
  onProgress?: (progress: MountProgress) => void;
  /** Aborting it stops the mount's downloads; what was mounted stays. */
  signal?: AbortSignal;
}

/** How many archives are fetched at once. */
const PARALLEL_FETCHES = 6;

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

/** A response's body, read whole, reporting each chunk's bytes as it
 * arrives; or a failure saying which file and why. */
async function readCounting(response: Response, what: string, onBytes: (count: number) => void) {
  if (!response.body) {
    const data = await readOrFail(response, what);
    onBytes(data.byteLength);
    return data;
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
      onBytes(value.byteLength);
    }
  } catch (error) {
    throw new Error(`${what} could not be downloaded (${describeError(error)})`, { cause: error });
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data.buffer;
}

/** The SHA-256 of `data`, in hex, by the browser's own implementation,
 * which only a secure context offers (https, or localhost). */
async function sha256Of(data: ArrayBuffer, what: string) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle)
    throw new Error(
      `${what} cannot be checked: the page is not served from a secure origin (https, or localhost), so the browser computes no SHA-256 for it`,
    );
  const digest = new Uint8Array(await subtle.digest("SHA-256", data));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Run `work` on each item, at most `width` at once; the first failure
 * stops the start of more, is told to `onFail` at once (to abort what is
 * under way), and is thrown once those under way settle. */
async function inPool<T>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<void>,
  onFail: () => void = () => {},
) {
  let next = 0;
  let failed: { error: unknown } | undefined;
  const lane = async () => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await work(item);
      } catch (error) {
        if (!failed) {
          failed = { error };
          onFail();
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  if (failed) throw failed.error;
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
  /** The archive store, once asked for. */
  private opening: Promise<ArchiveStore | null> | undefined;
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

  /** The archives among `archives` not yet mounted, each once (by URL). */
  unmounted<T extends string | ArchiveRef>(archives: readonly T[]): T[] {
    const url = (archive: T) => (typeof archive === "string" ? archive : archive.url);
    const seen = new Set<string>();
    return archives.filter((archive) => {
      const key = url(archive);
      if (this.mounted.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** The archive store, opened once, or null. */
  private store(): Promise<ArchiveStore | null> {
    const configured = this.config.archiveStore;
    if (configured === undefined) return Promise.resolve(null);
    this.opening ??= typeof configured === "string" ? openArchiveStore(configured) : Promise.resolve(configured);
    return this.opening;
  }

  /** Delete the library's archives from the archive store whose digests
   * are not in `keep` (its index's, when the page reads it); the digests
   * deleted. */
  async retainArchives(library: string, keep: Iterable<string>): Promise<string[]> {
    const store = await this.store();
    return store ? store.retain(library, keep) : [];
  }

  /** Which of these digests the archive store holds (none without one). */
  async kept(digests: readonly string[]): Promise<Set<string>> {
    const store = await this.store();
    if (!store || !digests.length) return new Set();
    const keys = await store.keys().catch((error: unknown) => {
      console.warn("Could not read the archive store", error);
      return new Set<string>();
    });
    return new Set(digests.filter((digest) => keys.has(digest)));
  }

  /** Mount zips at the drive's root, once each: an archive given by its
   * URL alone is fetched; one with its SHA-256 is read from the archive
   * store if it is there, and otherwise fetched, checked against its
   * digest and kept.  At most six are fetched at once, and each is
   * extracted as it arrives.  A failure stops the rest; what was mounted
   * before it stays mounted, so a second try fetches only what is left. */
  async mountArchives(archives: readonly (string | ArchiveRef)[], options: MountOptions = {}): Promise<MountReport> {
    if (this.mounting) {
      await this.mounting.catch(() => {});
      return this.mountArchives(archives, options);
    }
    const report: MountReport = { fetched: 0, fetchedBytes: 0, kept: 0, keptBytes: 0 };
    const missing = this.unmounted(archives).map((archive) =>
      typeof archive === "string" ? { url: archive } : archive,
    );
    if (!missing.length) return report;
    if (this.exited) throw new Error("the language server has stopped");
    const drive = this.drive;
    if (!drive) throw new Error("Agda's filesystem is not ready");
    const mount = async () => {
      const store = missing.some((archive) => archive.sha256) ? await this.until(this.store()) : null;
      const kept = await this.until(this.kept(missing.flatMap((archive) => archive.sha256 ?? [])));
      const progress: MountProgress = {
        loaded: 0,
        total: missing.every((archive) => archive.bytes !== undefined)
          ? missing.reduce((sum, archive) => sum + (archive.bytes ?? 0), 0)
          : undefined,
        mounted: 0,
        archives: missing.length,
      };
      const tell = () => options.onProgress?.({ ...progress });
      tell();
      // This mount's downloads stop with the caller's signal or the
      // transport's own.
      const stopping = new AbortController();
      const stop = () => stopping.abort();
      options.signal?.addEventListener("abort", stop, { once: true });
      this.downloads.signal.addEventListener("abort", stop, { once: true });
      if (options.signal?.aborted || this.downloads.signal.aborted) stop();
      // One extraction at a time, in the order the archives arrive.
      let extracting: Promise<void> = Promise.resolve();
      const puts: Promise<void>[] = [];
      const stopped = (what: string) => new Error(`${what} was not mounted: the mount was stopped`);
      const extract = (archive: ArchiveRef, data: ArrayBuffer, what: string) => {
        const extracted = extracting.then(async () => {
          if (stopping.signal.aborted) throw stopped(what);
          await this.until(drive.mountArchive(Comlink.transfer(data, [data])));
          this.mounted.add(archive.url);
          progress.mounted += 1;
          tell();
        });
        extracting = extracted.catch(() => {});
        return extracted;
      };
      try {
        await inPool(missing, PARALLEL_FETCHES, async (archive) => {
          const what = archive.what ?? `the archive ${archive.url}`;
          if (stopping.signal.aborted) throw stopped(what);
          const digest = archive.sha256;
          let data: ArrayBuffer | undefined;
          if (digest && store && kept.has(digest)) {
            data = await store.get(digest).catch((error: unknown) => {
              console.warn(`Could not read ${what} from the archive store`, error);
              return undefined;
            });
            // A record that cannot be read is no use kept.
            if (!data) await store.forget([digest]).catch(() => {});
          }
          if (data) {
            report.kept += 1;
            report.keptBytes += data.byteLength;
            progress.loaded += data.byteLength;
            tell();
          } else {
            // An archive planned as kept is not fetched: its bytes were
            // never stated to the reader.
            if (archive.fetch === false) throw new ArchiveNotKept(what);
            if (stopping.signal.aborted) throw new Error(`${what} was not downloaded: the mount was stopped`);
            const response = await fetchOrFail(archive.url, what, stopping.signal);
            data = await readCounting(response, what, (count) => {
              progress.loaded += count;
              tell();
            });
            if (archive.sha256) {
              const digest = await sha256Of(data, what);
              if (digest !== archive.sha256)
                throw new Error(
                  `${what} is not the archive its index names (its SHA-256 is ${digest.slice(0, 16)}, not ${archive.sha256.slice(0, 16)}): the site may have changed since this page was loaded, so reload it`,
                );
              // Kept before its buffer is handed to the worker: the store
              // copies it when put is called, and the mount settles only
              // once it is written.
              if (store)
                puts.push(
                  store
                    .put({
                      sha256: archive.sha256,
                      library: archive.library ?? "",
                      path: archive.path ?? archive.url,
                      bytes: data.byteLength,
                      data,
                      stored: Date.now(),
                    })
                    .catch((error: unknown) => console.warn(`Could not keep ${what} in the archive store`, error)),
                );
            }
            report.fetched += 1;
            report.fetchedBytes += data.byteLength;
          }
          try {
            await extract(archive, data, what);
          } catch (error) {
            // An archive the drive could not extract is not kept for the
            // next try; one the mount never reached, since it was stopped
            // or the engine is gone, is sound, and stays.
            if (digest && store && !stopping.signal.aborted && !this.exited)
              await store.forget([digest]).catch(() => {});
            throw error;
          }
        }, stop);
      } catch (error) {
        stop();
        throw error;
      } finally {
        // Nothing is left extracting, or being written to the store, when
        // the mount settles.
        await extracting;
        await Promise.all(puts);
        options.signal?.removeEventListener("abort", stop);
        this.downloads.signal.removeEventListener("abort", stop);
      }
    };
    this.mounting = mount();
    try {
      await this.mounting;
    } finally {
      this.mounting = undefined;
    }
    return report;
  }

  /** Which of `paths` the drive holds (an interface an earlier check
   * wrote, which the drive's cache restored, or an archive's). */
  async present(paths: readonly string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    return new Set(await this.until(this.ready().present([...paths])));
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
    // A file outside the root is refused before anything is fetched.
    const files = (config.files ?? []).map(({ path, text }) => ({ path: this.inside(path), text }));
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
    const listed = config.archives.libraries ?? [];
    const [drive, builtin, stdlib, ...data] = await until(Promise.all([
      step("the compiler could not be loaded", initPromise),
      archive(config.archives.builtin, "Agda's builtin library"),
      archive(config.archives.stdlib, "the standard library"),
      ...listed.map((library) => {
        const what = library.what ?? `the library ${library.name}`;
        // A library is on the drive, or the start fails: none is skipped.
        return library.url ? archive(library.url, what) : Promise.reject(new Error(`${what} has no URL`));
      }),
    ]));
    this.drive = drive;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    config.onProgress?.({ phase: "starting" });

    const libraries = listed.map(({ agdaLib, name }, index) => ({
      // Fetched above: a library without a URL has already failed the start.
      data: data[index] as ArrayBuffer,
      agdaLib,
      name,
    }));
    const buffers = [builtin, stdlib, ...data].filter((x): x is ArrayBuffer => x != null);
    await until(step(
      "the drive could not be set up",
      drive.mount(
        Comlink.transfer(
          { builtin, stdlib, libraries, files, cacheNamespace: config.cacheNamespace },
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
