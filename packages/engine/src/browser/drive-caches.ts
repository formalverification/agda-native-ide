// File: packages/engine/src/browser/drive-caches.ts
//
// The drive's caches that no page will read again (issue 14).  The drive
// keeps what Agda wrote in an IndexedDB database named by its namespace, a
// digest of every asset Agda reads (src/lib/assets.ts), so a deploy that
// changes an asset starts a new database, and the old one, which may hold
// tens of MB of interfaces built in the browser, would stay for ever.  The
// page deletes every drive database but its own when it starts.
//
// It finds them two ways: `indexedDB.databases()`, where the browser has it
// (Chromium; Firefox from 126), and a list of the namespaces this page has
// used, kept in localStorage, for the browsers without it (Firefox 114 to
// 125).  The list finds only what this code recorded: a database a deploy
// made before it shipped stays in those browsers.

import { DRIVE_CACHE_PREFIX } from "./worker/protocol.js";

/** The localStorage key of the namespaces this page has used. */
export const DRIVE_NAMESPACES_KEY = "agda-native-ide:drive-namespaces";

/** What the cleanup needs of the browser, so that a test can stand in. */
export interface DriveCacheHost {
  /** The names of the origin's IndexedDB databases, or undefined where
   * the browser cannot list them. */
  databases(): Promise<string[] | undefined>;
  /** Delete a database; settles when it is gone, or when another tab's
   * open connection blocks it (the deletion then completes when that tab
   * lets go). */
  deleteDatabase(name: string): Promise<"deleted" | "blocked">;
  /** The localStorage item, or null; undefined where storage is refused. */
  read(key: string): string | null | undefined;
  write(key: string, value: string): void;
}

/** The browser's own IndexedDB and localStorage, each where it works. */
export function browserDriveCacheHost(): DriveCacheHost {
  return {
    async databases() {
      if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return undefined;
      try {
        return (await indexedDB.databases()).flatMap((database) => (database.name ? [database.name] : []));
      } catch {
        return undefined;
      }
    },
    deleteDatabase(name) {
      return new Promise((resolve, reject) => {
        const deleting = indexedDB.deleteDatabase(name);
        deleting.onsuccess = () => resolve("deleted");
        deleting.onblocked = () => resolve("blocked");
        deleting.onerror = () => reject(deleting.error);
      });
    },
    read(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return undefined;
      }
    },
    write(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Storage refused: the list is lost, and only databases() finds them.
      }
    },
  };
}

/** Delete every drive cache but `current`'s, and record `current` among the
 * namespaces used; the databases deleted, blocked by another tab, or whose
 * deletion failed. */
export async function forgetOtherDriveCaches(
  current: string,
  host: DriveCacheHost = browserDriveCacheHost(),
): Promise<{ deleted: string[]; blocked: string[]; failed: string[] }> {
  let recorded: string[] = [];
  try {
    const parsed = JSON.parse(host.read(DRIVE_NAMESPACES_KEY) ?? "[]");
    if (Array.isArray(parsed)) recorded = parsed.filter((name): name is string => typeof name === "string");
  } catch {
    // A list that does not parse lists nothing.
  }
  const listed = (await host.databases()) ?? [];
  const names = new Set([
    ...listed.filter((name) => name.startsWith(DRIVE_CACHE_PREFIX)),
    ...recorded.map((namespace) => `${DRIVE_CACHE_PREFIX}${namespace}`),
  ]);
  names.delete(`${DRIVE_CACHE_PREFIX}${current}`);
  const deleted: string[] = [];
  const blocked: string[] = [];
  const failed: string[] = [];
  for (const name of [...names].sort()) {
    try {
      (await host.deleteDatabase(name)) === "deleted" ? deleted.push(name) : blocked.push(name);
    } catch (error) {
      console.warn(`Could not delete the stale drive cache ${name}`, error);
      failed.push(name);
    }
  }
  // A blocked deletion completes when the other tab lets go, unless this
  // page closes first, and one that failed does not: both stay on the
  // list, for the next start to try again (deleting a database that is
  // gone succeeds).
  host.write(
    DRIVE_NAMESPACES_KEY,
    JSON.stringify([current, ...[...blocked, ...failed].map((name) => name.slice(DRIVE_CACHE_PREFIX.length))]),
  );
  return { deleted, blocked, failed };
}
