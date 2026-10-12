// File: packages/engine/src/browser/worker/protocol.ts
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// src/lib/worker/types.d.ts at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
// (docs/provenance.md).  The language server's worker hosts the server's
// reactor build and the drive (issue 59): it takes a message port and the
// reactor's JavaScript glue where it took shared buffers for standard
// input, standard output and the drive, and the drive worker's own types
// are gone with it.  The file moved with the worker into the engine
// package's browser transport (issue 62), whose main thread and worker
// share it, and gained the drive's readFile.  The drive takes a list of
// libraries where it took PLFA's archive alone (issue 13).

export type WASMSource =
  | { type: "stream"; stream: ReadableStream<Uint8Array> }
  | { type: "url"; url: string };

export interface WASMLoadingProgress {
  source: WASMSource;
  bytesLoaded: number;
  bytesTotal: number;
  finished: Promise<void>;
  cancel?: () => void;
}

export interface ALSWorkerInitObject {
  wasmSource: WASMSource;
  /** The URL of the JavaScript glue GHC's post-linker wrote for the
   * reactor, absolute, since the worker resolves URLs against itself. */
  glueUrl: string;
  /** The server's argv after the program's name. */
  args?: string[];
  /** The worker's end of the language server's messages: one JSON-RPC
   * message per event, as a string, with no Content-Length framing. */
  port: MessagePort;
}

/** A library the drive is laid out with: an archive whose entries are at
 * their paths on the drive, and its `.agda-lib` there (issue 13). */
export interface DriveLibrary {
  data: ArrayBuffer;
  /** Its `.agda-lib` on the drive, which the libraries file names. */
  agdaLib: string;
  /** Its name, as a `depend:` line names it, and the defaults file. */
  name: string;
}

/** The archives the drive is laid out from (./drive.ts, layOutDrive). */
export interface DriveArchives {
  builtin: ArrayBuffer | null;
  stdlib: ArrayBuffer | null;
  libraries: DriveLibrary[];
}

export interface DriveMount extends DriveArchives {
  /** The namespace of the drive's IndexedDB cache (src/lib/assets.ts). */
  cacheNamespace: string;
}

export interface ALSWorkerInitResultProxied {
  /** Lay out the drive and instantiate the reactor over it. */
  mount: (archives: DriveMount) => Promise<void>;
  /** Agda's --setup: write the data files the server embeds. */
  setup: () => Promise<void>;
  /** Start the server; settles with its exit code when it exits. */
  start: () => Promise<number>;
  writeFile: (path: string, content: string) => Promise<void>;
  /** A file's text, or undefined when the drive has none. */
  readFile: (path: string) => Promise<string | undefined>;
  mountArchive: (data: ArrayBuffer) => Promise<void>;
  persist: () => Promise<void>;
}
