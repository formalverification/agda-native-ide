// File: packages/engine/src/browser/worker/als.ts
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// src/lib/worker/als.ts at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
// (docs/provenance.md).  The worker hosts the language server's reactor
// build and the drive together (issue 59).  The reactor exports functions
// the worker calls with messages (agda-language-server's app/Reactor.hs),
// so nothing blocks on standard input; the drive is this worker's own WASI
// drive (./drive.ts), so a file call is a function call on this thread.
// No memory is shared, so the worker no longer requires cross-origin
// isolation.  The throwaway instances that ran `--version` and `--setup`
// are gone: a reactor cannot run as a command, and its run_setup export is
// `--setup`.  The WASI debug hook is upstream's.
//
// It is the engine package's browser transport's worker (issue 62),
// moved from the page with the drive: the transport (../index.ts) creates
// it through the host, which bundles it, and it reads one more function,
// a source's text as Agda would read it.  It writes the host's files over
// what the cache restores (issue 11).

import * as Comlink from "comlink";
import * as Runno from "@runno/wasi";

import { attachDrive, openCacheDatabase, prepareDrive } from "./drive.js";
import type {
  ALSWorkerInitObject,
  ALSWorkerInitResultProxied,
  DriveMount,
  WASMSource,
} from "./protocol.js";

/** What the reactor exports (agda-language-server's app/Reactor.hs, at
 * v8), each through GHC's JavaScript FFI, so each returns a promise. */
interface Reactor {
  run_setup(): Promise<void>;
  new_language_server(): Promise<number>;
  run_language_server(server: number): Promise<number>;
  send_message(server: number, message: string): Promise<void>;
  recv_message(server: number): Promise<string>;
}

async function compileWasm(wasmSource: WASMSource) {
  if (wasmSource.type === "url") {
    return WebAssembly.compile(
      await fetch(wasmSource.url).then((x) => x.arrayBuffer()),
    );
  }
  return WebAssembly.compileStreaming(
    new Response(wasmSource.stream, {
      headers: { "Content-Type": "application/wasm" },
    }),
  );
}

const runnoInterceptor: Runno.DebugFn = (name, args_, ret, _data) => {
  const args = args_ as unknown as number[];

  // hide the warn failing to set stdin to nonblocking mode
  if (name === "fd_fdstat_set_flags" && args[0] === 0 && args[1] === 4) {
    return 0; // success
  }
  // fake that readlink always finds something that is not a symlink
  if (name === "path_readlink") {
    return 28; // EINVAL
  }

  // stat-ing a non-existent path
  if (name === "path_filestat_get" && ret === 76) {
    return 44; // ENOENT
  }
  // workaround a bug where mkdir's error code is wrong
  if (name === "path_create_directory" && ret === 76) {
    return 20; // EEXIST
  }
  return ret;
};

let stderrBuf = "";

function stderr(str: string) {
  // FIXME: the output will not be consumed by the main thread
  let nl;
  while (((nl = str.indexOf("\n")), nl >= 0)) {
    console.warn(">>> " + stderrBuf + str.slice(0, nl));
    stderrBuf = "";
    str = str.slice(nl + 1);
  }
  stderrBuf += str;
}

async function init({
  wasmSource,
  glueUrl,
  args = [],
  port,
}: ALSWorkerInitObject): Promise<ALSWorkerInitResultProxied> {
  const [module, glue] = await Promise.all([
    compileWasm(wasmSource),
    import(/* @vite-ignore */ glueUrl),
  ]);
  // The reactor's exports, filled in once it is instantiated: the glue's
  // imports call back into them.
  const exports: Record<string, unknown> = {};
  const reactor = exports as unknown as Reactor;
  let drive: ReturnType<typeof attachDrive> | undefined;

  const env = {
    HOME: "/home/root",
    Agda_datadir: "/",
  };

  /** Lay out the drive, then instantiate the reactor over it; its
   * _initialize starts GHC's runtime, which reads the argv (the program's
   * name first, then any +RTS ... -RTS) and the environment. */
  async function mount({ cacheNamespace, files, ...archives }: DriveMount) {
    const database = await openCacheDatabase(cacheNamespace);
    const fs = await prepareDrive(archives, files, database);

    const wasi = new Runno.WASI({
      args: ["als", ...args],
      env,
      fs,
      debug: runnoInterceptor,
      stderr,
    });
    drive = attachDrive(wasi.drive, database);

    const instance = await WebAssembly.instantiate(module, {
      ...wasi.getImportObject(),
      ghc_wasm_jsffi: glue.default(exports),
    });
    Object.assign(exports, instance.exports);
    wasi.initialize({ module, instance });
  }

  /** Start a server; the promise settles with its exit code when it exits.
   * Each message is one JSON-RPC message, with no Content-Length framing:
   * the reactor's prepareOutwards is the identity, and its parseInwards
   * takes the whole message. */
  async function start() {
    const server = await reactor.new_language_server();
    const exited = reactor.run_language_server(server);

    // One message at a time, in order: send_message settles once the
    // server has taken the message.
    let sending: Promise<unknown> = Promise.resolve();
    port.onmessage = (event: MessageEvent<string>) => {
      sending = sending.then(() => reactor.send_message(server, event.data));
    };
    // Keep one recv_message pending until the server exits.
    let running = true;
    void exited.finally(() => (running = false)).catch(() => {});
    void (async () => {
      try {
        while (running) port.postMessage(await reactor.recv_message(server));
      } catch (error) {
        if (running) console.error("The language server stopped answering", error);
      }
    })();
    return exited;
  }

  return Comlink.proxy({
    mount,
    setup: () => reactor.run_setup(),
    start,
    writeFile: async (path: string, content: string) =>
      drive!.writeFile(path, new TextEncoder().encode(content)),
    readFile: async (path: string) => drive!.readFile(path),
    mountArchive: (data: ArrayBuffer) => drive!.mountArchive(data),
    persist: () => drive!.persist(),
  });
}

Comlink.expose({
  init,
});
