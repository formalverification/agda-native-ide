// File: packages/engine/src/browser/index.test.ts
//
// The browser transport keeps its sources under its root, as the native
// transport does, before it touches the drive.

import { describe, expect, it } from "vitest";

import { BrowserTransport } from "./index.js";

const transport = (root?: string) =>
  new BrowserTransport({
    createWorker: () => {
      throw new Error("no worker in this test");
    },
    compiler: { url: "unused" },
    glueUrl: "unused",
    archives: {},
    cacheNamespace: "test",
    args: [],
    ...(root === undefined ? {} : { root }),
  });

describe("the browser transport's root", () => {
  it("resolves relative paths under it, and normalizes them", () => {
    const t = transport("/conformance/");
    expect(t.resolvePath("Goals.agda")).toBe("/conformance/Goals.agda");
    expect(t.resolvePath("./sub/../Goals.agda")).toBe("/conformance/Goals.agda");
    expect(t.resolvePath("/conformance/x/../Second.agda")).toBe("/conformance/Second.agda");
  });

  it("refuses a path outside it, before the drive is asked", async () => {
    const t = transport("/conformance");
    expect(() => t.resolvePath("../Main.agda")).toThrow(/outside the project's root/);
    expect(() => t.resolvePath("/Main.agda")).toThrow(/outside the project's root/);
    expect(() => t.resolvePath("/conformance-other/Main.agda")).toThrow(/outside the project's root/);
    await expect(t.writeSource("/stdlib/src/Data/Nat.agda", "")).rejects.toThrow(/outside the project's root/);
    await expect(t.readSource("/conformance/../home/root/.config/agda/libraries")).rejects.toThrow(
      /outside the project's root/,
    );
    // Inside the root, the drive is next, and it is not ready here.
    await expect(t.writeSource("/conformance/Goals.agda", "")).rejects.toThrow(/the drive is not ready/);
  });

  it("holds the whole drive when the root is the drive's own", () => {
    const t = transport();
    expect(t.resolvePath("/plfa/part1/Naturals.lagda.md")).toBe("/plfa/part1/Naturals.lagda.md");
    expect(t.resolvePath("../../Main.agda")).toBe("/Main.agda");
  });
});
