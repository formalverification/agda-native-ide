// File: packages/engine/src/core/outcome.ts
//
// What every operation returns: Agda's answer, the engine's refusal to
// ask, or a failure to get an answer.  The three are distinct types, so a
// caller cannot read a refusal or a failure as something Agda said.  No
// answer of the interaction lane carries a verdict: interaction-mode Agda
// loads a file with open goals and succeeds, so "it loaded" is knowledge,
// never "it checks"; the verdict of record is a batch run's exit code,
// which no engine here has yet (Capabilities.batch).

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
  | "position-shift";

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
  | "startup";

export interface Failure {
  kind: "failure";
  reason: FailureReason;
  message: string;
  responses?: AgdaResponse[];
  detail?: Record<string, unknown>;
}

export type Outcome<T> = Answer<T> | Refusal | Failure;

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
