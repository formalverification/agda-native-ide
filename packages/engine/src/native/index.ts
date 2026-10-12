// File: packages/engine/src/native/index.ts
//
// The native engine, `@agda-native-ide/engine/native`: the engine package's
// only entry point that imports node, which the package exports under the
// `node` condition alone, so a browser bundle cannot take it in.  It is
// three modules, as follows:
//
//   +  ./transport.ts: `agda --interaction-json` as a child process (the
//      interaction lane), and a fresh `agda` per verdict (the batch lane);
//   +  ./registry.ts: one interaction lane per project root, with
//      agda-native-air's persistence rules (issue 64);
//   +  ./resolve.ts: which Agda a project uses, and its root (issue 64).

export * from "./transport.js";
export * from "./registry.js";
export * from "./resolve.js";
