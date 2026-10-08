// File: src/lib/support.ts
//
// What the page needs from a browser, checked before it starts (issue 8).
// A browser that lacks any of it is not supported: the page says what is
// missing and which browsers it is tested in, and does not try to work
// around it (no polyfill, no fallback).  IndexedDB is not here: the drive
// uses it as a cache, and runs uncached without it.

/** The browsers the page is tested in (the README names their versions). */
export const TESTED_BROWSERS = "Chromium and Firefox";

/** A function using one WebAssembly feature that the compiler (the
 * language server's reactor build) uses, so that WebAssembly.validate
 * accepts it only where the feature is supported.  Each module is the
 * binary of one line of WebAssembly text, given beside it. */
const WASM_FEATURES: Record<string, number[]> = {
  // (func (result v128) (v128.const i32x4 0 0 0 0))
  "WebAssembly SIMD": [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 22,
    1, 20, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11,
  ],
  // (func (param externref))
  "WebAssembly reference types": [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 1, 111, 0, 3, 2, 1, 0, 10, 4, 1,
    2, 0, 11,
  ],
  // (memory 1) (func (memory.fill (i32.const 0) (i32.const 0) (i32.const 0)))
  "WebAssembly bulk memory": [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1,
    10, 13, 1, 11, 0, 65, 0, 65, 0, 65, 0, 252, 11, 0, 11,
  ],
  // (func (result i32) (i32.extend8_s (i32.const 0)))
  "WebAssembly sign extension": [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 10, 7, 1,
    5, 0, 65, 0, 192, 11,
  ],
  // (func (result i32) (i32.trunc_sat_f32_s (f32.const 0)))
  "WebAssembly non-trapping float-to-int conversions": [
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 10, 11,
    1, 9, 0, 67, 0, 0, 0, 0, 252, 0, 11,
  ],
};

/** Whether the browser starts a module worker: one that reads the `type`
 * of its options, and does not refuse "module". */
function supportsModuleWorkers() {
  if (typeof Worker === "undefined") return false;
  let readType = false;
  const url = URL.createObjectURL(
    new Blob([""], { type: "text/javascript" }),
  );
  try {
    const options = {
      get type() {
        readType = true;
        return "module" as const;
      },
    };
    new Worker(url, options).terminate();
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
  return readType;
}

/** What the page needs and this browser lacks, by name; empty when the
 * browser has everything. */
export function missingFeatures(): string[] {
  const missing: string[] = [];
  if (!supportsModuleWorkers()) missing.push("module workers");
  if (typeof DecompressionStream === "undefined")
    missing.push("DecompressionStream");
  if (
    typeof WebAssembly !== "object" ||
    typeof WebAssembly.validate !== "function"
  ) {
    missing.push("WebAssembly");
  } else {
    for (const [name, bytes] of Object.entries(WASM_FEATURES))
      if (!WebAssembly.validate(new Uint8Array(bytes))) missing.push(name);
  }
  return missing;
}

/** The page's notice for a browser that lacks what it needs. */
export function unsupportedBrowserNotice(missing: string[]) {
  return (
    `This browser cannot run Agda here: it lacks ${missing.join(", ")}. ` +
    `The page is tested in ${TESTED_BROWSERS}; other browsers are not supported.`
  );
}
