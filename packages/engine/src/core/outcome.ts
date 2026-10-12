// File: packages/engine/src/core/outcome.ts
//
// What every operation returns: Agda's answer, the engine's refusal to
// ask, or a failure to get an answer; and, from the batch lane, a verdict.
// The four are distinct types, so a caller cannot read a refusal or a
// failure as something Agda said, nor an answer as a verdict.  No answer
// of the interaction lane carries a verdict: interaction-mode Agda loads a
// file with open goals and succeeds, so "it loaded" is knowledge, never
// "it checks"; the verdict of record is a batch run's exit code, which only
// a verdict carries (Capabilities.batch says which engines have one).

import type { AgdaResponse } from "./responses.js";

/** Which text an answer is about, and who answered: every answer names
 * it, so an answer about another file, an older load or another session
 * is recognizable as such. */
export interface SourceBasis {
  engine: "browser" | "native";
  /** One running Agda; a new session is a new Agda with no goals. */
  session: string;
  /** What Agda reported to `Cmd_show_version`. */
  agdaVersion: string;
  /** The path Agda knows the file by. */
  path: string;
  /** `sha256:` and the SHA-256 of the UTF-8 text Agda read. */
  digest: string;
  /** The session's count of loads; positions and goal numbers are valid
   * for one generation. */
  generation: number;
}

export interface Answer<T> {
  kind: "answer";
  /** The lane that answered; never a verdict. */
  lane: "interaction";
  engine: "browser" | "native";
  session: string;
  agdaVersion: string;
  /** The loaded text the answer is about; absent for an answer about no
   * file (Agda's version). */
  basis?: SourceBasis;
  elapsedMs: number;
  value: T;
  /** Every response Agda sent for the command, validated, in order. */
  responses: AgdaResponse[];
}

export type RefusalReason =
  /** The engine has no such lane or feature (`capability` names it). */
  | "unsupported-capability"
  /** A goal from another session, file or load. */
  | "stale-goal"
  /** A goal the current load does not have, or no longer has. */
  | "unknown-goal"
  /** Nothing is loaded, or its last load failed, so Agda would load the
   * file again, silently, before answering. */
  | "no-loaded-file"
  /** The input is not what the operation takes. */
  | "invalid-input"
  /** Too many operations are waiting. */
  | "busy"
  /** The session has ended. */
  | "session-ended"
  /** The host's conversion of a source moves Agda's positions. */
  | "position-shift"
  /** The host's configuration names no Agda that can be run, or one of
   * another version than the project expects; the message names the
   * setting. */
  | "configuration";

export interface Refusal {
  kind: "refusal";
  reason: RefusalReason;
  message: string;
  /** For `unsupported-capability`: which. */
  capability?: string;
}

export type FailureReason =
  /** The operation outran its deadline; `detail.terminated` says whether
   * Agda had to be stopped. */
  | "timeout"
  /** The caller aborted it. */
  | "aborted"
  /** Agda exited or was stopped while it ran. */
  | "session-ended"
  /** Agda's output was not what its protocol says. */
  | "protocol"
  /** The source changed while Agda read it. */
  | "source-changed"
  /** A file could not be read or written. */
  | "io"
  /** Agda could not be started. */
  | "startup"
  /** A batch run ended without an exit code (a signal the engine did not
   * send stopped it), so it has no verdict. */
  | "no-exit-code";

export interface Failure {
  kind: "failure";
  reason: FailureReason;
  message: string;
  responses?: AgdaResponse[];
  detail?: Record<string, unknown>;
}

export type Outcome<T> = Answer<T> | Refusal | Failure;

/** One of Agda's messages in a batch run's output, as Agda printed it: a
 * block that begins `<file>:<range>: error: [Code]` or `<file>:<range>:
 * warning: -W[no]Code`.  The verdict is the exit code; these say why. */
export interface Diagnostic {
  severity: "error" | "warning";
  /** Agda's name for it (`UnequalTypes`, `UnsolvedInteractionMetas`, a
   * warning's `UnreachableClauses`), when its header names one. */
  code?: string;
  /** The file Agda names, as it names it. */
  file?: string;
  /** Where, 1-based, as Agda prints it (columns count code points). */
  range?: { startLine: number; startCol: number; endLine: number; endCol: number };
  /** The text after the header line. */
  message: string;
}

/** What ran for a verdict: the executable, its arguments (the file last),
 * and the directory it ran in. */
export interface BatchCommand {
  executable: string;
  args: string[];
  cwd: string;
}

/** The batch lane's verdict: a fresh Agda's exit code on a file.  Its own
 * type, never an answer: it says whether the file checks, which nothing
 * the interaction lane says can. */
export interface Verdict {
  kind: "verdict";
  lane: "batch";
  engine: "browser" | "native";
  /** The version the lane's Agda reported. */
  agdaVersion: string;
  /** The file, as Agda knows it. */
  path: string;
  /** `sha256:` and the SHA-256 of the text the run read: the file before
   * the run and after it held the same text. */
  digest: string;
  command: BatchCommand;
  /** Agda's own exit code: 0 when the file checks with nothing open; 42
   * for an error, an open goal or an unsolved meta; 71 for options Agda
   * refused. */
  exitCode: number;
  /** `exitCode === 0`, and nothing else: what green means in a batch
   * build.  The diagnostics never change it. */
  success: boolean;
  diagnostics: Diagnostic[];
  /** The last of what Agda printed (its standard output, then its
   * standard error). */
  output: string;
  elapsedMs: number;
}

export type VerdictOutcome = Verdict | Refusal | Failure;

export function refusal(reason: RefusalReason, message: string, capability?: string): Refusal {
  return capability === undefined
    ? { kind: "refusal", reason, message }
    : { kind: "refusal", reason, message, capability };
}

export function failure(
  reason: FailureReason,
  message: string,
  extra: { responses?: AgdaResponse[]; detail?: Record<string, unknown> } = {},
): Failure {
  return { kind: "failure", reason, message, ...extra };
}
