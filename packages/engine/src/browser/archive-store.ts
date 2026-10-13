// File: packages/engine/src/browser/archive-store.ts
//
// The archives of interfaces the page has fetched, kept in the browser by
// their SHA-256 (issue 14), so that a second visit mounts them with no
// request, and a deploy that leaves an archive as it was leaves its copy
// good.  Unlike the drive's own cache (./worker/drive.ts), which holds
// what one set of assets wrote and is named by their digest, this store is
// named once: its keys are the archives' contents, so no copy can stand
// for another archive.  What an index no longer names is evicted when the
// page reads that index (`retain`).
//
// It runs on the page's thread, where the transport fetches.  A browser
// that refuses IndexedDB, by an error or by throwing at once, has no store,
// and every archive is fetched.

/** The database's name, which no deploy changes. */
export const ARCHIVE_STORE = "agda-native-ide-archives";

/** An archive as the store keeps it. */
export interface StoredArchive {
  /** Its SHA-256, in hex: the key. */
  sha256: string;
  /** The library whose index names it. */
  library: string;
  /** Its path in that index. */
  path: string;
  bytes: number;
  data: ArrayBuffer;
  /** When it was stored, in ms since the epoch. */
  stored: number;
}

export interface ArchiveStore {
  /** The digests of every archive kept, without reading one. */
  keys(): Promise<Set<string>>;
  /** An archive's bytes, or undefined: a copy of its own, which the caller
   * may transfer. */
  get(sha256: string): Promise<ArrayBuffer | undefined>;
  /** Keep an archive.  The bytes are copied when this is called, so the
   * caller may transfer its buffer at once. */
  put(archive: StoredArchive): Promise<void>;
  /** Delete the library's archives whose digests are not in `keep`; the
   * digests deleted.  An archive is kept under one library: when a second
   * library's index names the same digest (issue 24's plugins), this is to
   * keep what any known index names. */
  retain(library: string, keep: Iterable<string>): Promise<string[]>;
  /** Delete these archives (one that cannot be read or extracted). */
  forget(digests: readonly string[]): Promise<void>;
}

function request<T>(target: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    target.onsuccess = () => resolve(target.result);
    target.onerror = () => reject(target.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("the transaction was aborted"));
  });
}

/** The store in IndexedDB, or null where the browser has none or refuses
 * it. */
export function openArchiveStore(name: string = ARCHIVE_STORE): Promise<ArchiveStore | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let opening: IDBOpenDBRequest;
    try {
      opening = indexedDB.open(name, 1);
    } catch (error) {
      console.warn("The archive store is unavailable", error);
      return resolve(null);
    }
    opening.onupgradeneeded = () => {
      const archives = opening.result.createObjectStore("archives", { keyPath: "sha256" });
      archives.createIndex("library", "library");
    };
    opening.onerror = () => {
      console.warn("The archive store is unavailable", opening.error);
      resolve(null);
    };
    opening.onsuccess = () => {
      const database = opening.result;
      // Another tab's upgrade or deletion waits on no open connection here.
      database.onversionchange = () => database.close();
      const archives = (mode: IDBTransactionMode) => {
        const transaction = database.transaction("archives", mode);
        return { transaction, store: transaction.objectStore("archives") };
      };
      resolve({
        async keys() {
          const { store } = archives("readonly");
          return new Set((await request(store.getAllKeys())).map(String));
        },
        async get(sha256) {
          const { store } = archives("readonly");
          const found = (await request(store.get(sha256))) as StoredArchive | undefined;
          return found?.data;
        },
        async put(archive) {
          const { transaction, store } = archives("readwrite");
          // IndexedDB clones the value here, before put returns.
          store.put(archive);
          await done(transaction);
        },
        async retain(library, keep) {
          const kept = new Set(keep);
          const { transaction, store } = archives("readwrite");
          const deleted: string[] = [];
          const cursor = store.index("library").openKeyCursor(IDBKeyRange.only(library));
          cursor.onsuccess = () => {
            const at = cursor.result;
            if (!at) return;
            const key = String(at.primaryKey);
            if (!kept.has(key)) {
              store.delete(at.primaryKey);
              deleted.push(key);
            }
            at.continue();
          };
          await done(transaction);
          return deleted;
        },
        async forget(digests) {
          const { transaction, store } = archives("readwrite");
          for (const digest of digests) store.delete(digest);
          await done(transaction);
        },
      });
    };
  });
}

/** A store in memory, for a host that keeps archives for one page's life
 * only, and for tests. */
export function memoryArchiveStore(): ArchiveStore & { readonly records: Map<string, StoredArchive> } {
  const records = new Map<string, StoredArchive>();
  return {
    records,
    async keys() {
      return new Set(records.keys());
    },
    async get(sha256) {
      return records.get(sha256)?.data.slice(0);
    },
    async put(archive) {
      records.set(archive.sha256, { ...archive, data: archive.data.slice(0) });
    },
    async retain(library, keep) {
      const kept = new Set(keep);
      const deleted = [...records.values()]
        .filter((archive) => archive.library === library && !kept.has(archive.sha256))
        .map((archive) => archive.sha256);
      for (const key of deleted) records.delete(key);
      return deleted;
    },
    async forget(digests) {
      for (const digest of digests) records.delete(digest);
    },
  };
}
