/// <reference types="vitest/globals" />
// File: packages/engine/src/browser/worker/drive.test.ts
//
// The drive gives back the text it was given, as the native engine's
// filesystem does: the session compares the two after every load.

import * as Runno from "@runno/wasi";

import { attachDrive } from "./drive.js";

describe("the drive's sources", () => {
  it("reads back a source as it was written, with its byte order mark", () => {
    const wasi = new Runno.WASI({ args: ["agda"], env: {}, fs: {} });
    const drive = attachDrive(wasi.drive, null);
    for (const text of ["﻿module Bom where\n", "module Plain where\n", "﻿", ""]) {
      drive.writeFile("/project/M.agda", new TextEncoder().encode(text));
      expect(drive.readFile("/project/M.agda")).toBe(text);
    }
    expect(drive.readFile("/project/Missing.agda")).toBeUndefined();
  });
});
