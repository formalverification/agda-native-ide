// File: packages/views/src/index.ts
//
// The views (issue 62): display components with explicit data and event
// props, which import nothing from a host.  The page's inspector uses
// them, and its Explorer the tree (issue 9); the theory and proof views
// (issues 41 and 44), and their hosting in the editor's webview (issue
// 66), are later work.

export { default as ExplorerTree } from "./ExplorerTree.svelte";
export { default as GoalList } from "./GoalList.svelte";
export { default as ProblemList } from "./ProblemList.svelte";
export { default as ResultView } from "./ResultView.svelte";
export { filterTerms, findItem, findPath, keyAction, moduleTree, treeRows, typeAhead } from "./tree";
export type { ModuleEntry, TreeAction, TreeItem, TreeKind, TreeRow } from "./tree";
export type { ContextEntry, GoalSummary, Problem, Result } from "./types";
