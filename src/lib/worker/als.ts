// File: src/lib/worker/als.ts
//
// The page's bundle of the engine's worker (issue 62): the language
// server's reactor and the drive run in @agda-native-ide/engine's worker,
// which the controller starts through the engine's browser transport;
// Vite builds it from this entry as a module worker of its own file.

import "@agda-native-ide/engine/browser/worker";
