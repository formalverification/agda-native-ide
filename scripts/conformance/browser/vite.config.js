// File: scripts/conformance/browser/vite.config.js
//
// The conformance harness's page: the engine's browser transport and the
// shared suite, bundled with the worker as the page bundles it, served
// under /__conformance__/ beside a built site, whose compiler and archives
// it loads.

import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/__conformance__/",
  logLevel: "warn",
  clearScreen: false,
  build: {
    outDir: process.env.CONFORMANCE_OUT,
    emptyOutDir: true,
    target: "es2022",
  },
  worker: { format: "es" },
});
