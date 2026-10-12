// File: vscode/scripts/build.mjs
//
// Build the companion: each entry point a CommonJS bundle of its own, for
// the extension host's node, with the workspace's packages inside it
// (@agda-native-ide/engine, its native entry and zod, and
// @agda-native-ide/tools) and only VS Code's API and node's built-in
// modules left outside.  The engine is ECMAScript modules and the
// extension host loads a CommonJS main; a bundle joins them without
// relying on require() of an ECMAScript module, and holds no workspace
// symlink, so a package of the companion (issue 70) needs nothing but out/
// and media/.  `tsc -p tsconfig.json` type-checks the same sources
// (`npm run check`); rolldown only transpiles.
//
//   node scripts/build.mjs        (npm --workspace vscode run build)

import { rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entries = {
  "extension.js": "src/extension.ts",
  "test/host.js": "src/test/host.ts",
  "test/reload.js": "src/test/reload.ts",
  "test/unit.js": "src/test/unit.ts",
};
const external = new Set(["vscode", ...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

await rm(join(root, "out"), { recursive: true, force: true });
for (const [file, input] of Object.entries(entries)) {
  const bundle = await rolldown({
    input: join(root, input),
    platform: "node",
    external: (id) => external.has(id),
    // The engine's native entry is exported under "node" alone.
    resolve: { conditionNames: ["node", "import", "default"] },
  });
  try {
    await bundle.write({ file: join(root, "out", file), format: "cjs", exports: "named", sourcemap: true });
  } finally {
    await bundle.close();
  }
}
console.log(`built ${Object.keys(entries).map((file) => `out/${file}`).join(", ")}`);
