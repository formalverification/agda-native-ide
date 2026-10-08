// File: src/lib/index.js
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// src/lib/index.js at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
// (docs/provenance.md).  The page speaks to the language server's worker
// through a message port, one JSON-RPC message per event, where it read
// and wrote the server's standard input and output through two rings in
// shared memory; the drive worker, and the functions that wrote to it
// through a third ring under a lock, are gone, since the drive is the
// server's worker's own (issue 59).

/** @import { ALSWorkerInitObject, ALSWorkerInitResultProxied } from '$lib/worker/types' */
import * as Comlink from "comlink";

/**
 * The language server's messages over a MessagePort, as the byte streams
 * the router reads and writes (src/lib/agda/transport.js): each message
 * from the worker is framed with its Content-Length, and each framed
 * message to it is unframed, since the server's reactor build takes and
 * gives one message per call, with no framing.
 * @param {MessagePort} port
 */
export function createPortByteStreams(port) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  /** @type {ReadableStream<Uint8Array>} */
  const readable = new ReadableStream({
    start(controller) {
      port.onmessage = (/** @type {MessageEvent<string>} */ event) => {
        const body = encoder.encode(event.data);
        controller.enqueue(
          encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`),
        );
        controller.enqueue(body);
      };
    },
  });
  let pending = new Uint8Array(0);
  /** @type {WritableStream<Uint8Array>} */
  const writable = new WritableStream({
    write(chunk) {
      const joined = new Uint8Array(pending.byteLength + chunk.byteLength);
      joined.set(pending);
      joined.set(chunk, pending.byteLength);
      pending = joined;
      for (;;) {
        // The header is ASCII, so its characters are its bytes.
        const head = decoder.decode(
          pending.subarray(0, Math.min(pending.byteLength, 64)),
        );
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(
          head.slice(0, end).match(/Content-Length: (\d+)/i)?.[1],
        );
        if (!Number.isInteger(length))
          throw new Error(`no Content-Length in ${JSON.stringify(head)}`);
        const start = end + 4;
        if (pending.byteLength < start + length) return;
        port.postMessage(decoder.decode(pending.subarray(start, start + length)));
        pending = pending.slice(start + length);
      }
    },
  });
  return { readable, writable };
}

/**
 * @param {ALSWorkerInitObject} initObject
 * @param {(worker: Worker) => void} workerPreCallback
 */
export function makeLspWorker(initObject, workerPreCallback) {
  const worker = new Worker(
    new URL("$lib/worker/als.js?worker&inline", import.meta.url),
    { name: "ALS LSP Worker", type: "module" },
  );

  /**
   * @type {Comlink.Remote<{
   *          init: (initObj: ALSWorkerInitObject) =>
   *            ALSWorkerInitResultProxied}>} */
  const endpoint = Comlink.wrap(worker);
  workerPreCallback?.(worker);

  const { wasmSource, port } = initObject;

  const initPromise = endpoint.init(
    Comlink.transfer(initObject, [
      ...(wasmSource.type === "stream" ? [wasmSource.stream] : []),
      port,
    ]),
  );

  return { endpoint, initPromise };
}

/**
 * @param {Response} resp
 * @param {(loaded: number) => void} callback */
export function traceFetchProgress(resp, callback) {
  if (resp.body == null) {
    throw new Error("Fetched no body");
  }
  if (resp.bodyUsed) {
    throw new Error("body has been consumed");
  }

  let loaded = 0,
    bytesTotal = -1;

  const contentLength = resp.headers.get("content-length");
  if (contentLength != null) {
    bytesTotal = Number.parseInt(contentLength, 10);
  }

  /** @type {(arg: unknown) => void} */
  let dispatchFinish;
  const finished = new Promise((r) => (dispatchFinish = r));

  let cancelled = false;
  const reader = resp.body.getReader();

  // NOTE: transform stream cannot give precise progress report; seemingly because it is pull-based
  /** @type {ReadableStream<Uint8Array>} */
  const stream = new ReadableStream({
    start(controller) {
      const drainStream = async () => {
        while (true) {
          const iter = await reader.read();
          if (cancelled) {
            throw new Error("cancelled");
          }
          if (iter.done) break;
          loaded += iter.value.byteLength;
          callback(loaded);
          controller.enqueue(iter.value);
        }
        controller.close();
      };

      drainStream()
        .then(dispatchFinish, (err) => {
          controller.error(err);
        })
        .finally(() => {
          reader.releaseLock();
        });
    },
  });

  return {
    source: { type: /** @type {const} */ ("stream"), stream },
    bytesTotal,
    finished,
    // it is preferable to call the stream's cancel method, but the worker
    // might have locked and terminating the worker would not help
    // https://github.com/whatwg/streams/issues/1256
    cancel: () => {
      cancelled = true;
    },
  };
}
