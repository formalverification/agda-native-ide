// File: src/lib/assets.ts
//
// What the page knows about the files it fetches, derived from the files
// when the site is built (scripts/asset-manifest.mjs, which vite.config.js
// hands to the page as AGDA_ASSETS), where upstream maintained each value
// by hand (issue 3).  agda-algebras' sources joined them with the
// playground's project (issue 11), and the list of its modules with the
// Explorer (issue 9).

declare const AGDA_ASSETS: {
  tokens: {
    compiler: string;
    glue: string;
    builtins: string;
    stdlib: string;
    agdaAlgebras: string;
    agdaAlgebrasModules: string;
    plfaProject: string;
    plfaInterfaces: string;
  };
  compilerBytes: number | null;
  driveCacheNamespace: string;
};

/** The `?cache=` token of each asset: a digest of its content, so its URL
 * changes exactly when it does. */
export const cacheTokens = AGDA_ASSETS.tokens;

/** The compiler's length in bytes, for the download's progress. */
export const compilerBytes = AGDA_ASSETS.compilerBytes ?? undefined;

/** The namespace of the drive's IndexedDB cache: a digest of everything
 * Agda reads, so a cache is never restored against other assets. */
export const driveCacheNamespace = AGDA_ASSETS.driveCacheNamespace;
