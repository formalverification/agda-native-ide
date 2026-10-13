// File: packages/engine/src/browser/mount.test.ts
//
// The transport's mount of archives after the engine has started (issue
// 14): an archive with its digest is read from the store or fetched,
// checked and kept; one by its URL alone is fetched as before; a failure
// names the archive, and what was mounted stays.  A fake drive records
// what reaches the worker, and fetch is a stub.

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { memoryArchiveStore } from "./archive-store.js";
import { forgetOtherDriveCaches, type DriveCacheHost } from "./drive-caches.js";
import { BrowserTransport, type ArchiveRef, type MountProgress } from "./index.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Archives a server holds, by URL, with their digests. */
const ARCHIVES = Object.fromEntries(
  ["a", "b", "c", "d", "e", "f", "g", "h"].map((name) => {
    const data = bytes(`the archive ${name} `.repeat(100));
    return [`/lib/interfaces/${name}.zip`, { data, sha256: digest(data) }];
  }),
);
const ref = (name: string): ArchiveRef => {
  const url = `/lib/interfaces/${name}.zip`;
  const { data, sha256 } = ARCHIVES[url];
  return { url, sha256, bytes: data.byteLength, library: "lib", path: `interfaces/${name}.zip`, what: `the archive ${name}` };
};

/** A server: every request recorded, the archives above answered, and the
 * most requests in flight at once, and the requests aborted, counted.  A
 * request waits `delay(url)` ms, and ends at once if it is aborted. */
function server(answer: (url: string) => Response | undefined = () => undefined, delay = (_url: string) => 5) {
  const requests: string[] = [];
  let inFlight = 0;
  let most = 0;
  let aborted = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    requests.push(url);
    inFlight += 1;
    most = Math.max(most, inFlight);
    try {
      await new Promise<void>((done, fail) => {
        let settled = false;
        const timer = setTimeout(() => ((settled = true), done()), delay(url));
        init?.signal?.addEventListener("abort", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          aborted += 1;
          fail(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
      const answered = answer(url);
      if (answered) return answered;
      const found = ARCHIVES[url];
      return found ? new Response(found.data.slice()) : new Response("not found", { status: 404, statusText: "Not Found" });
    } finally {
      inFlight -= 1;
    }
  });
  return { requests, most: () => most, aborted: () => aborted };
}

/** A transport whose drive is a fake that keeps what it is given, and
 * takes it as postMessage does, detaching the buffer; each extraction
 * takes `extracting` ms. */
function started(store = memoryArchiveStore(), extracting = 0) {
  const t = new BrowserTransport({
    createWorker: () => {
      throw new Error("no worker in this test");
    },
    compiler: { url: "unused" },
    glueUrl: "unused",
    archives: {},
    cacheNamespace: "test",
    args: [],
    archiveStore: store,
  });
  const mounted: string[] = [];
  (t as unknown as { drive: unknown }).drive = {
    mountArchive: async (data: ArrayBuffer) => {
      const taken = structuredClone(data, { transfer: [data] });
      await new Promise((done) => setTimeout(done, extracting));
      mounted.push(new TextDecoder().decode(taken));
    },
  };
  return { t, store, mounted };
}

describe("the transport's mount", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches an archive given by its URL alone, once", async () => {
    const { requests } = server();
    const { t, store, mounted } = started();
    const report = await t.mountArchives(["/lib/interfaces/a.zip", "/lib/interfaces/a.zip"]);
    expect(requests).toEqual(["/lib/interfaces/a.zip"]);
    expect(mounted).toHaveLength(1);
    expect(report).toEqual({ fetched: 1, fetchedBytes: ARCHIVES["/lib/interfaces/a.zip"].data.byteLength, kept: 0, keptBytes: 0 });
    expect(store.records.size).toBe(0);
    expect(t.unmounted(["/lib/interfaces/a.zip", "/lib/interfaces/b.zip"])).toEqual(["/lib/interfaces/b.zip"]);
    await t.mountArchives(["/lib/interfaces/a.zip"]);
    expect(requests).toHaveLength(1);
  });

  it("keeps a fetched archive by its digest, and a later session reads it there", async () => {
    const { requests } = server();
    const first = started();
    const progress: MountProgress[] = [];
    await first.t.mountArchives([ref("a"), ref("b")], { onProgress: (p) => progress.push(p) });
    expect(requests).toHaveLength(2);
    expect([...first.store.records.keys()].sort()).toEqual([ref("a").sha256, ref("b").sha256].sort());
    expect(first.store.records.get(ref("a").sha256 as string)).toMatchObject({ library: "lib", path: "interfaces/a.zip" });
    const total = (ref("a").bytes as number) + (ref("b").bytes as number);
    expect(progress.at(-1)).toEqual({ loaded: total, total, mounted: 2, archives: 2 });

    const second = started(first.store);
    expect(await second.t.kept([ref("a").sha256 as string, ref("c").sha256 as string])).toEqual(new Set([ref("a").sha256]));
    const report = await second.t.mountArchives([ref("a"), ref("b"), ref("c")]);
    // The first session fetched a and b; the second, c alone.
    expect(requests).toEqual(["/lib/interfaces/a.zip", "/lib/interfaces/b.zip", "/lib/interfaces/c.zip"]);
    expect(report).toMatchObject({ fetched: 1, kept: 2, keptBytes: total });
    expect(second.mounted).toHaveLength(3);
    // The worker took the second session's copies; the store still has its own.
    const third = started(first.store);
    await third.t.mountArchives([ref("a"), ref("b"), ref("c")]);
    expect(requests).toHaveLength(3);
    expect(third.mounted).toEqual(second.mounted);
  });

  it("refuses an archive whose bytes are not its digest's, and keeps nothing of it", async () => {
    server((url) => (url.endsWith("/b.zip") ? new Response(bytes("something else")) : undefined));
    const { t, store, mounted } = started();
    await expect(t.mountArchives([ref("b")])).rejects.toThrow(
      `the archive b is not the archive its index names (its SHA-256 is ${digest(bytes("something else")).slice(0, 16)}, not ${(ref("b").sha256 as string).slice(0, 16)}): the site may have changed since this page was loaded, so reload it`,
    );
    expect(store.records.size).toBe(0);
    expect(mounted).toEqual([]);
    expect(t.unmounted([ref("b")])).toHaveLength(1);
  });

  it("names an archive it cannot fetch, keeps what it mounted and fetched, and fetches only the rest again", async () => {
    let broken = true;
    const { requests } = server((url) =>
      broken && url.endsWith("/c.zip") ? new Response("not found", { status: 404, statusText: "Not Found" }) : undefined,
    );
    const { t } = started();
    await expect(t.mountArchives([ref("a"), ref("b"), ref("c")])).rejects.toThrow(
      "the archive c could not be downloaded (HTTP 404 Not Found)",
    );
    const left = t.unmounted([ref("a"), ref("b"), ref("c")]).map((archive) => archive.url);
    expect(left).toContain("/lib/interfaces/c.zip");
    broken = false;
    requests.length = 0;
    await t.mountArchives([ref("a"), ref("b"), ref("c")]);
    // What was fetched and checked before the failure is kept, mounted or
    // not: the second try fetches the failed archive alone.
    expect(requests).toEqual(["/lib/interfaces/c.zip"]);
    expect(t.unmounted([ref("a"), ref("b"), ref("c")])).toEqual([]);
  });

  it("fetches at most six at once", async () => {
    const { most } = server();
    const { t, mounted } = started();
    await t.mountArchives(["a", "b", "c", "d", "e", "f", "g", "h"].map(ref));
    expect(mounted).toHaveLength(8);
    expect(most()).toBe(6);
  });

  it("stops the downloads under way when one fails", async () => {
    const { aborted } = server(
      (url) => (url.endsWith("/a.zip") ? new Response("not found", { status: 404, statusText: "Not Found" }) : undefined),
      (url) => (url.endsWith("/a.zip") ? 5 : 200),
    );
    const { t } = started();
    await expect(t.mountArchives(["a", "b", "c", "d"].map(ref))).rejects.toThrow("HTTP 404");
    expect(aborted()).toBe(3);
  });

  it("stops a mount of kept archives, and one waiting on extractions", async () => {
    server();
    const first = started();
    await first.t.mountArchives(["a", "b", "c", "d"].map(ref));
    // Read from the store only, each extraction slow.
    const kept = started(first.store, 50);
    const stopping = new AbortController();
    const mounting = kept.t.mountArchives(["a", "b", "c", "d"].map((name) => ({ ...ref(name), fetch: false as const })), {
      signal: stopping.signal,
    });
    setTimeout(() => stopping.abort(), 60);
    await expect(mounting).rejects.toThrow(/the mount was stopped/);
    expect(kept.mounted.length).toBeLessThan(4);
    // A stop is not the archives' fault: the store keeps every one.
    expect(first.store.records.size).toBe(4);
  });

  it("keeps the archives in the store when the engine stops during a mount", async () => {
    server();
    const { t, store } = started(memoryArchiveStore(), 100);
    const mounting = t.mountArchives(["a", "b", "c"].map(ref));
    setTimeout(() => void t.terminate(), 50);
    await expect(mounting).rejects.toThrow();
    expect(store.records.size).toBe(3);
  });

  it("stops when its signal aborts, and mounts nothing more", async () => {
    server();
    const { t, mounted } = started();
    const stopping = new AbortController();
    const mounting = t.mountArchives(["a", "b", "c", "d", "e", "f", "g", "h"].map(ref), { signal: stopping.signal });
    stopping.abort();
    await expect(mounting).rejects.toThrow(/aborted|stopped/);
    expect(mounted.length).toBeLessThan(8);
  });
});

/** The browser's databases and storage, in memory. */
function host(databases: string[] | undefined, list: string | null, blocked: string[] = []) {
  const storage = new Map<string, string>(list === null ? [] : [["agda-native-ide:drive-namespaces", list]]);
  const deleted: string[] = [];
  const fake: DriveCacheHost = {
    databases: async () => databases,
    deleteDatabase: async (name) => {
      deleted.push(name);
      return blocked.includes(name) ? "blocked" : "deleted";
    },
    read: (key) => storage.get(key) ?? null,
    write: (key, value) => void storage.set(key, value),
  };
  return { fake, deleted, storage };
}

describe("the drive's stale caches", () => {
  it("deletes every drive cache but the current one, wherever the browser lists them", async () => {
    const h = host(
      ["agda-playground-drive-old1", "agda-playground-drive-now", "agda-native-ide-archives", "agda-playground-drive-old2"],
      null,
      ["agda-playground-drive-old2"],
    );
    expect(await forgetOtherDriveCaches("now", h.fake)).toEqual({
      deleted: ["agda-playground-drive-old1"],
      blocked: ["agda-playground-drive-old2"],
      failed: [],
    });
    expect(h.deleted).toEqual(["agda-playground-drive-old1", "agda-playground-drive-old2"]);
    expect(h.storage.get("agda-native-ide:drive-namespaces")).toBe('["now"]');
  });

  it("keeps on its list a namespace whose database it failed to delete", async () => {
    const h = host(undefined, '["old", "now"]');
    h.fake.deleteDatabase = async () => Promise.reject(new Error("UnknownError"));
    expect(await forgetOtherDriveCaches("now", h.fake)).toEqual({ deleted: [], blocked: [], failed: ["agda-playground-drive-old"] });
    expect(h.storage.get("agda-native-ide:drive-namespaces")).toBe('["now","old"]');
  });

  it("finds them by the namespaces it recorded where the browser cannot list them", async () => {
    const h = host(undefined, '["old", "now"]');
    expect(await forgetOtherDriveCaches("now", h.fake)).toEqual({ deleted: ["agda-playground-drive-old"], blocked: [], failed: [] });
    const garbled = host(undefined, "{not json");
    expect(await forgetOtherDriveCaches("now", garbled.fake)).toEqual({ deleted: [], blocked: [], failed: [] });
    expect(garbled.storage.get("agda-native-ide:drive-namespaces")).toBe('["now"]');
  });
});

describe("the archive store in memory", () => {
  it("evicts what the library's index no longer names, and nothing of another library's", async () => {
    const store = memoryArchiveStore();
    const put = (sha256: string, library: string) =>
      store.put({ sha256, library, path: `${sha256}.zip`, bytes: 1, data: new ArrayBuffer(1), stored: 0 });
    await put("old", "lib");
    await put("kept", "lib");
    await put("other", "elsewhere");
    expect(await store.retain("lib", ["kept", "new"])).toEqual(["old"]);
    expect(await store.keys()).toEqual(new Set(["kept", "other"]));
  });
});

describe("an archive planned as kept", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is never fetched: a store that lost it fails the mount, which the host plans again", async () => {
    const { requests } = server();
    const { t } = started();
    await expect(t.mountArchives([{ ...ref("a"), fetch: false }])).rejects.toMatchObject({
      name: "ArchiveNotKept",
      message: "the archive a is no longer kept in this browser",
    });
    expect(requests).toEqual([]);
  });

  it("whose record cannot be read is forgotten, and not fetched", async () => {
    const { requests } = server();
    const store = memoryArchiveStore();
    await store.put({ sha256: ref("a").sha256 as string, library: "lib", path: "interfaces/a.zip", bytes: 1, data: new ArrayBuffer(1), stored: 0 });
    const broken = { ...store, get: async () => Promise.reject(new Error("NotReadableError")) };
    const { t } = started(broken as typeof store);
    await expect(t.mountArchives([{ ...ref("a"), fetch: false }])).rejects.toMatchObject({ name: "ArchiveNotKept" });
    expect(store.records.size).toBe(0);
    expect(requests).toEqual([]);
  });

  it("whose record cannot be read is forgotten and, when the plan allows, fetched", async () => {
    const { requests } = server();
    const store = memoryArchiveStore();
    const broken = { ...store, get: async () => Promise.reject(new Error("NotReadableError")) };
    await store.put({ sha256: ref("a").sha256 as string, library: "lib", path: "interfaces/a.zip", bytes: 1, data: new ArrayBuffer(1), stored: 0 });
    const { t } = started(broken as typeof store);
    await t.mountArchives([ref("a")]);
    expect(requests).toEqual(["/lib/interfaces/a.zip"]);
    // Forgotten, then kept again from the fetch, with the right bytes.
    expect(store.records.get(ref("a").sha256 as string)?.bytes).toBe(ref("a").bytes);
  });
});
