// File: vite.config.js
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// vite.config.js at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
// (docs/provenance.md).  A build records SITE_REVISION, the source
// revision the Makefile and the flake pass in, as its commit, and falls
// back to `git describe` without it; in the Nix sandbox, which has no
// .git, the fallback recorded "WORKTREE" for every commit.  It also
// defines AGDA_ASSETS, what the page needs to know about the files it
// fetches, derived from them by scripts/asset-manifest.mjs (issue 3).  The
// dev and preview servers no longer send the two headers that made the
// page cross-origin isolated, which it no longer needs (issue 59).  The dev
// server serves the compiler gzipped, compressing the raw file in static/,
// since the page fetches only the gzip the build writes (issue 8).

import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";
import { exec } from "child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, gzipSync } from "node:zlib";
import { ASSETS, assetManifest } from "./scripts/asset-manifest.mjs";

const staticDir = fileURLToPath(new URL("./static", import.meta.url));

/** A build refuses to run without the files the page fetches.  The check
 * is a build hook, not part of the configuration, since svelte-check and
 * `svelte-kit sync` resolve this configuration as a build too, and they
 * need no binaries (issue 3).
 * @returns {import('vite').Plugin<unknown>} */
const requireAssets = () => ({
  name: "require-assets",
  apply: "build",
  buildStart() {
    assetManifest(staticDir);
  },
});

/** The dev server answers the compiler's gzip, which only the build writes
 * (scripts/prepare-cloudflare-assets.mjs), with the raw compiler in
 * static/ compressed, once per version of the file.
 * @returns {import('vite').Plugin<unknown>} */
const serveCompilerGzip = () => {
  /** @type {{ mtimeMs: number, body: Buffer } | undefined} */
  let cached;
  return {
    name: "serve-compiler-gzip",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const raw = join(staticDir, ASSETS.compiler);
        if (!path.endsWith(`/${ASSETS.compiler}.gz`) || !existsSync(raw))
          return next();
        const { mtimeMs } = statSync(raw);
        if (cached?.mtimeMs !== mtimeMs)
          cached = {
            mtimeMs,
            body: gzipSync(readFileSync(raw), { level: constants.Z_BEST_SPEED }),
          };
        res.setHeader("Content-Type", "application/gzip");
        res.setHeader("Content-Length", cached.body.length);
        res.end(cached.body);
      });
    },
  };
};

/** @type {() => Promise<string>} */
const getGitCommitHash = () =>
  new Promise((resolve, reject) => {
    exec("git describe --tags --always --abbrev=8 --dirty", (err, result) => {
      if (err) return resolve("WORKTREE");
      resolve(result.trim());
    });
  });

export default defineConfig(async ({ command }) => {
  const GIT_COMMIT_HASH = JSON.stringify(
    command === "serve"
      ? "DEV"
      : process.env.SITE_REVISION || (await getGitCommitHash()),
  );

  console.log(`GIT_COMMIT_HASH is ${GIT_COMMIT_HASH}`);

  // The page's cache tokens, the compiler's length and the drive's cache
  // namespace, from the files in static/.  Without them (the dev server,
  // vitest, svelte-check) the tokens read "missing"; requireAssets stops a
  // build that lacks them.
  const AGDA_ASSETS = JSON.stringify(
    assetManifest(staticDir, { strict: false }),
  );

  return {
    server: {
      port: 5173,
      watch: {
        ignored: [
          "**/.build-tmp/**",
          "**/.compiler-toolchain/**",
          "**/research/**",
        ],
      },
    },
    define: {
      // XXX: is using env better?
      AGDA_PLAYGROUND_COMMIT: GIT_COMMIT_HASH,
      AGDA_ASSETS,
    },
    optimizeDeps: {
      include: ["@runno/wasi", "jszip"],
    },
    clearScreen: false,
    plugins: [requireAssets(), serveCompilerGzip(), sveltekit()],
    build: {
      // bumped for TLA
      target: ["es2022", "edge89", "firefox89", "chrome89", "safari15"],
    },
    worker: {
      format: "es",
    },
    test: {
      globals: true,
      include: ["src/**/*.{test,spec}.{js,ts}"],
    },
  };
});
