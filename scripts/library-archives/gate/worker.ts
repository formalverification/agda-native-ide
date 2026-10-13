// File: scripts/library-archives/gate/worker.ts
//
// The browser engine's worker, as the gate bundles it: the engine
// package's worker entry, imported as a module worker's script, after
// ./memory.ts, which reports the reactor's heap.

import "./memory.ts";
import "@agda-native-ide/engine/browser/worker";
