// File: packages/views/src/tree.test.ts
//
// The Explorer's tree as data (issue 9): a library's items from its module
// list, with a folder beside a module of its name as one row; the rows
// shown, expanded or filtered; and what each key of the W3C tree view
// pattern does.  The shape of agda-algebras' tree is checked on the list
// the site ships, when `make assets` has put it in static/.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { filterTerms, findItem, findPath, keyAction, moduleTree, treeRows, typeAhead, type TreeItem } from "./tree";

const modules = [
  { name: "agda-algebras", path: "/aa/src/agda-algebras.lagda.md", title: "The library" },
  { name: "Legacy.Base", path: "/aa/src/Legacy/Base.lagda.md" },
  { name: "Legacy.Base.Old", path: "/aa/src/Legacy/Base/Old.lagda.md" },
  { name: "Setoid", path: "/aa/src/Setoid.lagda.md" },
  { name: "Setoid.Algebras", path: "/aa/src/Setoid/Algebras.lagda.md" },
  { name: "Setoid.Algebras.Basic", path: "/aa/src/Setoid/Algebras/Basic.lagda.md" },
  { name: "Setoid.Algebras.HSP", path: "/aa/src/Setoid/Algebras/HSP.lagda.md" },
  { name: "Setoid.Terms", path: "/aa/src/Setoid/Terms.lagda.md" },
];

const library = (): TreeItem[] => [
  { id: "play", label: "Playground", kind: "section", children: [{ id: "play:Main", label: "Main.agda", kind: "file", path: "/play/Main.agda", name: "Main" }] },
  { id: "aa", label: "agda-algebras", kind: "section", children: moduleTree(modules, "aa:") },
];

const ids = (rows: ReturnType<typeof treeRows>["rows"]) => rows.map((row) => row.item.id);
const all = () => true;

describe("a library's items", () => {
  it("are its folders and modules, a folder beside its module as the module's row", () => {
    const [root, legacy, setoid] = moduleTree(modules, "aa:");
    expect(root).toMatchObject({ id: "aa:agda-algebras", kind: "module", label: "agda-algebras", title: "agda-algebras\nThe library" });
    expect(root.children).toBeUndefined();
    // Legacy has no module of its own: a folder.
    expect(legacy).toMatchObject({ id: "aa:Legacy", kind: "folder", label: "Legacy" });
    expect(legacy.path).toBeUndefined();
    expect(legacy.children?.map((item) => item.id)).toEqual(["aa:Legacy.Base"]);
    expect(legacy.children?.[0]).toMatchObject({ kind: "module", path: "/aa/src/Legacy/Base.lagda.md" });
    expect(setoid).toMatchObject({ kind: "module", path: "/aa/src/Setoid.lagda.md", name: "Setoid" });
    expect(setoid.children?.map((item) => item.label)).toEqual(["Algebras", "Terms"]);
  });

  it("takes a module listed after its folder's rows as that folder's row", () => {
    const [folder] = moduleTree([modules[5], modules[4]], "aa:");
    expect(folder).toMatchObject({ id: "aa:Setoid", kind: "folder" });
    expect(folder.children?.[0]).toMatchObject({ id: "aa:Setoid.Algebras", kind: "module", path: "/aa/src/Setoid/Algebras.lagda.md" });
    expect(folder.children?.[0].children?.map((item) => item.id)).toEqual(["aa:Setoid.Algebras.Basic"]);
  });
});

describe("the rows shown", () => {
  it("are the roots and the rows of what is expanded, with their levels and places", () => {
    const { rows } = treeRows(library(), (id) => ["play", "aa", "aa:Setoid"].includes(id));
    expect(ids(rows)).toEqual(["play", "play:Main", "aa", "aa:agda-algebras", "aa:Legacy", "aa:Setoid", "aa:Setoid.Algebras", "aa:Setoid.Terms"]);
    const setoid = rows[5];
    expect(setoid).toMatchObject({ level: 2, setsize: 3, posinset: 3, parent: "aa", expanded: true });
    expect(rows[4]).toMatchObject({ expanded: false });
    expect(rows[3].expanded).toBeUndefined();
    expect(rows[6]).toMatchObject({ level: 3, setsize: 2, posinset: 1, parent: "aa:Setoid", expanded: false });
  });

  it("while filtering, are what holds every word, with its ancestors, whatever is expanded", () => {
    const { rows, matches } = treeRows(library(), () => true, filterTerms("  ALG  basic "));
    expect(ids(rows)).toEqual(["aa", "aa:Setoid", "aa:Setoid.Algebras", "aa:Setoid.Algebras.Basic"]);
    expect(matches).toBe(1);
    expect(rows.map((row) => row.found)).toEqual([false, false, false, true]);
    expect(rows[2].hits).toEqual([[0, 3]]);
    expect(rows[3].hits).toEqual([[0, 5]]);
    expect(rows[3]).toMatchObject({ level: 4, setsize: 1, posinset: 1 });
    // A module found whose own rows are not is shown as a leaf.
    const hsp = treeRows(library(), all, filterTerms("algebras")).rows;
    expect(hsp.find((row) => row.item.id === "aa:Setoid.Algebras")).toMatchObject({ found: true, expanded: true });
    expect(treeRows(library(), all, filterTerms("Setoid.Algebras.HSP")).rows.at(-1)).toMatchObject({ found: true });
    expect(treeRows(library(), all, filterTerms("nothing")).rows).toEqual([]);
  });

  it("while filtering, match a file's label as the row shows it, and not a section's", () => {
    expect(ids(treeRows(library(), all, filterTerms("main.agda")).rows)).toEqual(["play", "play:Main"]);
    expect(ids(treeRows(library(), all, filterTerms("main")).rows)).toEqual(["play", "play:Main"]);
    expect(treeRows(library(), all, filterTerms("playground")).rows).toEqual([]);
  });

  it("finds an open file, or any item, and its ancestors", () => {
    expect(findItem(library(), (item) => item.id === "aa:Legacy.Base.Old")).toMatchObject({
      ancestors: ["aa", "aa:Legacy", "aa:Legacy.Base"],
    });
    expect(findPath(library(), "/aa/src/Setoid/Algebras/HSP.lagda.md")).toMatchObject({
      item: { id: "aa:Setoid.Algebras.HSP" },
      ancestors: ["aa", "aa:Setoid", "aa:Setoid.Algebras"],
    });
    expect(findPath(library(), "/nowhere.agda")).toBeUndefined();
  });
});

describe("the keys", () => {
  const { rows } = treeRows(library(), (id) => ["play", "aa", "aa:Setoid"].includes(id));
  const act = (id: string, key: string) => keyAction(rows, id, key);

  it("move up and down the rows shown, to the first and the last", () => {
    expect(act("play", "ArrowDown")).toEqual({ kind: "focus", id: "play:Main" });
    expect(act("aa", "ArrowUp")).toEqual({ kind: "focus", id: "play:Main" });
    expect(act("play", "ArrowUp")).toEqual({ kind: "none" });
    expect(act("aa:Setoid.Terms", "ArrowDown")).toEqual({ kind: "none" });
    expect(act("aa:Setoid", "Home")).toEqual({ kind: "focus", id: "play" });
    expect(act("play", "End")).toEqual({ kind: "focus", id: "aa:Setoid.Terms" });
  });

  it("open a closed parent, enter an open one, and do nothing on a leaf", () => {
    expect(act("aa:Legacy", "ArrowRight")).toEqual({ kind: "expand", ids: ["aa:Legacy"] });
    expect(act("aa:Setoid", "ArrowRight")).toEqual({ kind: "focus", id: "aa:Setoid.Algebras" });
    expect(act("aa:agda-algebras", "ArrowRight")).toEqual({ kind: "none" });
  });

  it("close an open parent, or go to the parent", () => {
    expect(act("aa:Setoid", "ArrowLeft")).toEqual({ kind: "collapse", id: "aa:Setoid" });
    expect(act("aa:Setoid.Terms", "ArrowLeft")).toEqual({ kind: "focus", id: "aa:Setoid" });
    expect(act("aa:Legacy", "ArrowLeft")).toEqual({ kind: "focus", id: "aa" });
    expect(act("play", "ArrowLeft")).toEqual({ kind: "collapse", id: "play" });
  });

  it("open every closed sibling, activate, and select", () => {
    expect(act("aa:agda-algebras", "*")).toEqual({ kind: "expand", ids: ["aa:Legacy"] });
    expect(act("aa:Setoid.Terms", "*")).toEqual({ kind: "expand", ids: ["aa:Setoid.Algebras"] });
    expect(act("play:Main", "Enter")).toEqual({ kind: "activate", id: "play:Main" });
    expect(act("play:Main", " ")).toEqual({ kind: "select", id: "play:Main" });
    expect(act("play:Main", "x")).toEqual({ kind: "none" });
  });

  it("move to the next row a typed prefix starts, wrapping, a repeated letter stepping", () => {
    expect(typeAhead(rows, "play", "a")).toBe("aa");
    expect(typeAhead(rows, "aa", "a")).toBe("aa:agda-algebras");
    expect(typeAhead(rows, "aa:agda-algebras", "a")).toBe("aa:Setoid.Algebras");
    expect(typeAhead(rows, "aa:Setoid.Algebras", "a")).toBe("aa");
    expect(typeAhead(rows, "aa", "aa")).toBe("aa:agda-algebras");
    expect(typeAhead(rows, "play", "agda-algebras")).toBe("aa");
    expect(typeAhead(rows, "aa", "agda-algebras")).toBe("aa");
    expect(typeAhead(rows, "play", "q")).toBeUndefined();
  });
});

const shipped = new URL("../../../static/agda-algebras-modules.json", import.meta.url);
describe.skipIf(!existsSync(shipped))("agda-algebras' tree (after make assets)", () => {
  it("lists every module once, a folder beside its module as one row, Legacy the one folder alone", () => {
    const list = JSON.parse(readFileSync(shipped, "utf8"));
    const items = moduleTree(list.modules, "aa:");
    const { rows } = treeRows(items, all);
    const opened = rows.filter((row) => row.item.path);
    expect(opened.map((row) => row.item.name)).toEqual(list.modules.map((entry: { name: string }) => entry.name));
    const folders = rows.filter((row) => row.item.kind === "folder").map((row) => row.item.id);
    expect(folders).toEqual(["aa:Legacy"]);
    const paired = rows.filter((row) => row.item.kind === "module" && row.expanded !== undefined);
    expect({ rows: rows.length, modules: opened.length, paired: paired.length, deepest: Math.max(...rows.map((row) => row.level)) }).toEqual({
      rows: 351,
      modules: 350,
      paired: 64,
      deepest: 5,
    });
  });
});
