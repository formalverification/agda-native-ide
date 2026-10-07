// File: scripts/prepare-cloudflare-assets.mjs
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// scripts/prepare-cloudflare-assets.mjs at
// ae0aa84c24363a8d6dadc292b6eb8f88f7f38705 (docs/provenance.md).  The
// compiler's name comes from scripts/asset-manifest.mjs, which names the
// file the page fetches, instead of a literal (issue 58).

import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip, constants } from "node:zlib";
import { ASSETS } from "./asset-manifest.mjs";

const wasmPath = new URL(`../build/${ASSETS.compiler}`, import.meta.url);
const compressedPath = new URL(`../build/${ASSETS.compiler}.gz`, import.meta.url);

await pipeline(
  createReadStream(wasmPath),
  createGzip({ level: constants.Z_BEST_COMPRESSION }),
  createWriteStream(compressedPath),
);

await unlink(wasmPath);

const compressed = await stat(compressedPath);
console.log(
  `Prepared Cloudflare compiler asset: ${(compressed.size / 1024 / 1024).toFixed(1)} MiB`,
);
