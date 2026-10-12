// File: packages/engine/src/browser/index.test.ts
//
// The browser transport keeps its sources under its root, as the native
// transport does, before it touches the drive; and nothing waits on a
// worker that is gone.  A fake worker and a MessageChannel stand in for
// the reactor, to make faults the conformance runner cannot ask for.

import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserTransport, startBrowserSession } from "./index.js";

const transport = (root?: string) =>
  new BrowserTransport({
    createWorker: () => {
      throw new Error("no worker in this test");
    },
    compiler: { url: "unused" },
    glueUrl: "unused",
    archives: {},
    cacheNamespace: "test",
    args: [],
    ...(root === undefined ? {} : { root }),
  });

describe("the browser transport's root", () => {
  it("resolves relative paths under it, and normalizes them", () => {
    const t = transport("/conformance/");
    expect(t.resolvePath("Goals.agda")).toBe("/conformance/Goals.agda");
    expect(t.resolvePath("./sub/../Goals.agda")).toBe("/conformance/Goals.agda");
    expect(t.resolvePath("/conformance/x/../Second.agda")).toBe("/conformance/Second.agda");
  });

  it("refuses a path outside it, before the drive is asked", async () => {
    const t = transport("/conformance");
    expect(() => t.resolvePath("../Main.agda")).toThrow(/outside the project's root/);
    expect(() => t.resolvePath("/Main.agda")).toThrow(/outside the project's root/);
    expect(() => t.resolvePath("/conformance-other/Main.agda")).toThrow(/outside the project's root/);
    await expect(t.writeSource("/stdlib/src/Data/Nat.agda", "")).rejects.toThrow(/outside the project's root/);
    await expect(t.readSource("/conformance/../home/root/.config/agda/libraries")).rejects.toThrow(
      /outside the project's root/,
    );
    // Inside the root, the drive is next, and it is not ready here.
    await expect(t.writeSource("/conformance/Goals.agda", "")).rejects.toThrow(/the drive is not ready/);
  });

  it("holds the whole drive when the root is the drive's own", () => {
    const t = transport();
    expect(t.resolvePath("/plfa/part1/Naturals.lagda.md")).toBe("/plfa/part1/Naturals.lagda.md");
    expect(t.resolvePath("../../Main.agda")).toBe("/Main.agda");
  });
});

/** A worker whose script fails to load: an error event, and no answer. */
class FailingWorker extends EventTarget {
  terminated = false;
  constructor() {
    super();
    setTimeout(() => this.dispatchEvent(Object.assign(new Event("error"), { message: "the script was not found" })), 20);
  }
  postMessage() {}
  terminate() {
    this.terminated = true;
  }
}

/** The transport's side of the server's port, and what reaches the server. */
function wired() {
  const t = transport();
  const { port1, port2 } = new MessageChannel();
  const inner = t as unknown as { port: MessagePort; receive(data: string): void };
  inner.port = port1;
  port1.onmessage = (event: MessageEvent<string>) => inner.receive(event.data);
  const server: { method?: string; id?: unknown; params?: { id?: unknown } }[] = [];
  const events: string[] = [];
  t.subscribe((event) => events.push(event.type));
  return { t, port2, server, events };
}

const settled = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((done) => setTimeout(() => done("still waiting"), ms)),
  ]);

describe("the browser transport when the engine fails", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("ends its start when the worker fails before it answers, and releases it", async () => {
    vi.stubGlobal("fetch", async () => new Response(gzipSync(Buffer.alloc(64, 1))));
    let worker: FailingWorker | undefined;
    const started = await Promise.race([
      startBrowserSession({
        createWorker: () => (worker = new FailingWorker()) as unknown as Worker,
        compiler: { url: "compiler.wasm.gz" },
        glueUrl: "glue.js",
        archives: {},
        cacheNamespace: "test",
        args: ["--raw"],
      }),
      new Promise((done) => setTimeout(() => done("still waiting"), 2_000)),
    ]);
    expect(started).toMatchObject({ kind: "failure", reason: "startup" });
    expect((started as { message: string }).message).toMatch(/the worker failed \(the script was not found\)/);
    expect(worker?.terminated).toBe(true);
  });

  it("names a library it cannot fetch in the host's words, or by its name", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith(".zip") ? new Response("not found", { status: 404, statusText: "Not Found" }) : new Response(gzipSync(Buffer.alloc(64, 1))),
    );
    // A worker that never answers: the library's failure comes first.
    const silent = () => Object.assign(new EventTarget(), { postMessage() {}, terminate() {} }) as unknown as Worker;
    const start = (what?: string) =>
      startBrowserSession({
        createWorker: silent,
        compiler: { url: "compiler.wasm.gz" },
        glueUrl: "glue.js",
        archives: { libraries: [{ url: "plfa.zip", agdaLib: "/plfa.agda-lib", name: "plfa", ...(what ? { what } : {}) }] },
        cacheNamespace: "test",
        args: ["--raw"],
      });
    expect(await start("PLFA")).toMatchObject({
      kind: "failure",
      reason: "startup",
      message: "PLFA could not be downloaded (HTTP 404 Not Found)",
    });
    expect(await start()).toMatchObject({ message: "the library plfa could not be downloaded (HTTP 404 Not Found)" });
  });

  it("refuses a library with no URL, by name, rather than leaving it off the drive", async () => {
    vi.stubGlobal("fetch", async () => new Response(gzipSync(Buffer.alloc(64, 1))));
    const silent = () => Object.assign(new EventTarget(), { postMessage() {}, terminate() {} }) as unknown as Worker;
    const started = await startBrowserSession({
      createWorker: silent,
      compiler: { url: "compiler.wasm.gz" },
      glueUrl: "glue.js",
      archives: { libraries: [{ url: "", agdaLib: "/agda-algebras/agda-algebras.agda-lib", name: "agda-algebras" }] },
      cacheNamespace: "test",
      args: ["--raw"],
    });
    expect(started).toMatchObject({ kind: "failure", reason: "startup", message: "the library agda-algebras has no URL" });
  });

  it("refuses a file the drive starts with outside its root, before it fetches anything", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return new Response(gzipSync(Buffer.alloc(64, 1)));
    });
    const started = await startBrowserSession({
      createWorker: () => {
        throw new Error("no worker in this test");
      },
      compiler: { url: "compiler.wasm.gz" },
      glueUrl: "glue.js",
      archives: {},
      files: [{ path: "/stdlib/standard-library.agda-lib", text: "name: other\n" }],
      cacheNamespace: "test",
      args: ["--raw"],
      root: "/play/",
    });
    expect(started).toMatchObject({ kind: "failure", reason: "startup" });
    expect((started as { message: string }).message).toMatch(/outside the project's root on the drive, \/play\//);
    expect(fetched).toEqual([]);
  });

  it("ends a command the server fails, rather than waiting for its deadline", async () => {
    const { t, port2, server, events } = wired();
    port2.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data);
      server.push(message);
      if (message.method === "agda")
        port2.postMessage(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "internal error" } }));
    };
    t.send('IOTCM "/x.agda" None Direct (Cmd_show_version)');
    await new Promise((done) => setTimeout(done, 50));
    expect(events).toEqual(["noise", "end"]);
    await t.terminate();
  });

  it("cancels the editor's request under the id it travels under", async () => {
    const { t, port2, server } = wired();
    port2.onmessage = (event: MessageEvent<string>) => server.push(JSON.parse(event.data));
    t.editorChannel.send(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "textDocument/hover", params: {} }));
    t.editorChannel.send(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 7 } }));
    // A request already answered, or never made, is not the server's to cancel.
    t.editorChannel.send(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 8 } }));
    await new Promise((done) => setTimeout(done, 50));
    const hover = server.find((message) => message.method === "textDocument/hover");
    const cancels = server.filter((message) => message.method === "$/cancelRequest");
    expect(hover?.id).toMatch(/^editor-/);
    expect(cancels.map((message) => message.params?.id)).toEqual([hover?.id]);
    await t.terminate();
  });

  it("stops waiting on the drive when the engine stops", async () => {
    const t = transport("/p/");
    const never = () => new Promise<never>(() => {});
    (t as unknown as { drive: unknown }).drive = { writeFile: never, readFile: never, mountArchive: never, persist: never };
    vi.stubGlobal("fetch", async () => new Response(new ArrayBuffer(8)));
    const calls = [t.writeSource("/p/A.agda", "x"), t.readSource("/p/A.agda"), t.mountArchives(["a.zip"]), t.persist()];
    await new Promise((done) => setTimeout(done, 20));
    await t.terminate();
    expect(await Promise.all(calls.map((call) => settled(call, 1_000)))).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    await expect(t.writeSource("/p/A.agda", "x")).rejects.toThrow(/the language server has stopped/);
  });
});
