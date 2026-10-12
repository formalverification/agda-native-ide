// File: packages/engine/src/core/platform.d.ts
//
// The only globals the engine's core uses.  Every JavaScript host the core
// runs in (a page, a worker, node, a webview) has them; the core's
// tsconfig gives it no DOM and no node types, so a use of anything else
// fails to compile.

declare function setTimeout(callback: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;

declare const performance: { now(): number };

declare const console: {
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};
