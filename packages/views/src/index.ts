// File: packages/views/src/index.ts
//
// The views (issue 62): display components with explicit data and event
// props, which import nothing from a host.  The page's inspector uses
// them; the theory and proof views (issues 41 and 44), and their
// hosting in the editor's webview (issue 66), are later work.

export { default as GoalList } from "./GoalList.svelte";
export { default as ProblemList } from "./ProblemList.svelte";
export { default as ResultView } from "./ResultView.svelte";
export type { ContextEntry, GoalSummary, Problem, Result } from "./types";
