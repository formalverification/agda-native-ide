// File: scripts/library-archives/gate/vite.config.js
//
// The gate's page (issue 13): the engine's browser transport, bundled with
// its worker as the page bundles them, served under /__gate__/ beside a
// built site, whose compiler and archives it loads
// (scripts/library-archives/gate.mjs).

import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/__gate__/",
  logLevel: "warn",
  clearScreen: false,
  build: {
    outDir: process.env.LIBRARY_GATE_OUT,
    emptyOutDir: true,
    target: "es2022",
  },
  worker: { format: "es" },
});
