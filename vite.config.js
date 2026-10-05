// File: vite.config.js
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// vite.config.js at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
// (docs/provenance.md).  A build records SITE_REVISION, the source
// revision the Makefile and the flake pass in, as its commit, and falls
// back to `git describe` without it; in the Nix sandbox, which has no
// .git, the fallback recorded "WORKTREE" for every commit.  It also
// defines AGDA_ASSETS, what the page needs to know about the files it
// fetches, derived from them by scripts/asset-manifest.mjs (issue 3).

import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";
import { exec } from "child_process";
import { fileURLToPath } from "node:url";
import { assetManifest } from "./scripts/asset-manifest.mjs";

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

/** @returns {import('vite').Plugin<unknown>} */
const coiPlugin = () => ({
  name: "coi-plugin",
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      next();
    });
  },
});

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
    plugins: [requireAssets(), sveltekit(), coiPlugin()],
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
