// File: scripts/check-bundle.mjs
//
// The built site's JavaScript must not carry the engine's native
// transport, node's process API, or VS Code's API (issue 62): those belong
// to the editor's host.  The engine package exports its native transport
// under the `node` condition alone, so a browser bundle cannot resolve it;
// this check reads what the build wrote, so that neither a new export nor
// a new import can carry them in unseen.  `make build` runs it on build/.
//
//   node scripts/check-bundle.mjs <site>

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** What only the native transport, node or VS Code would put in a bundle. */
const FORBIDDEN = [
  ["--interaction-json", "the native transport's command line"],
  ["child_process", "node's process API"],
  ["node:fs", "node's filesystem API"],
  ["acquireVsCodeApi", "VS Code's webview API"],
  ['require("vscode")', "VS Code's extension API"],
  ['from "vscode"', "VS Code's extension API"],
];

function* files(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(m?js)$/.test(name)) yield path;
  }
}

const site = process.argv[2];
if (!site) {
  console.error("usage: node scripts/check-bundle.mjs <site>");
  process.exit(2);
}
const found = [];
let scanned = 0;
for (const file of files(site)) {
  scanned += 1;
  const text = readFileSync(file, "utf8");
  for (const [marker, what] of FORBIDDEN)
    if (text.includes(marker)) found.push(`${relative(site, file)}: ${what} (${JSON.stringify(marker)})`);
}
if (found.length) {
  console.error(`check-bundle: the browser bundle carries what belongs to the editor's host:\n  ${found.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-bundle: ${scanned} scripts, none with the native transport, node's APIs or VS Code's`);
