// File: src/lib/assets.ts
//
// What the page knows about the files it fetches, derived from the files
// when the site is built (scripts/asset-manifest.mjs, which vite.config.js
// hands to the page as AGDA_ASSETS), where upstream maintained each value
// by hand (issue 3).  agda-algebras' sources joined them with the
// playground's project (issue 11), the list of its modules with the
// Explorer (issue 9), and its archive index with the mount of what a
// check's imports need (issue 14), whose description of the library reads
// their lengths and digests here.

declare const AGDA_ASSETS: {
  tokens: {
    compiler: string;
    glue: string;
    builtins: string;
    stdlib: string;
    agdaAlgebras: string;
    agdaAlgebrasModules: string;
    agdaAlgebrasIndex: string;
    plfaProject: string;
    plfaInterfaces: string;
  };
  compilerBytes: number | null;
  driveCacheNamespace: string;
  files: Partial<Record<"agdaAlgebras" | "agdaAlgebrasIndex", { bytes: number; sha256: string }>>;
};

/** The `?cache=` token of each asset: a digest of its content, so its URL
 * changes exactly when it does. */
export const cacheTokens = AGDA_ASSETS.tokens;

/** The compiler's length in bytes, for the download's progress. */
export const compilerBytes = AGDA_ASSETS.compilerBytes ?? undefined;

/** The namespace of the drive's IndexedDB cache: a digest of everything
 * Agda reads, so a cache is never restored against other assets. */
export const driveCacheNamespace = AGDA_ASSETS.driveCacheNamespace;

/** Each file's length and SHA-256, or undefined where the file was absent
 * when the page was built (the dev server before `make assets`). */
export const assetFiles = AGDA_ASSETS.files;
