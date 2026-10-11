// File: packages/views/src/types.ts
//
// What the views show: plain data, which any host can give them (the
// page from its controller, a webview from a message).

export interface GoalSummary {
  id: number;
  /** As Agda's goal list shows it, when known. */
  type?: string;
}

export interface ContextEntry {
  name: string;
  type: string;
  inScope?: boolean;
}

export interface Result {
  /** Agda's kind of answer (GoalType, Context, InferredType, NormalForm,
   * Error, ...). */
  kind: string;
  title: string;
  body: string;
}

export interface Problem {
  severity: "error" | "warning";
  message: string;
}
