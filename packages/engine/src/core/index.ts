// File: packages/engine/src/core/index.ts
//
// The engine client's public interface: `@agda-native-ide/engine`.  It
// imports no platform: no DOM, no node, no editor.  The two transports
// are the package's `./browser` and `./native` entry points.

export { haskellString, iotcm, commandText } from "./commands.js";
export type { Command, HighlightingLevel, Rewrite } from "./commands.js";
export { planCheck } from "./give-rule.js";
export type { CheckPlan, GoalSpan } from "./give-rule.js";
export { failure, refusal } from "./outcome.js";
export type {
  Answer,
  Failure,
  FailureReason,
  Outcome,
  Refusal,
  RefusalReason,
  SourceBasis,
} from "./outcome.js";
export { parseResponse } from "./responses.js";
export type {
  AgdaContextEntry,
  AgdaDisplayInfo,
  AgdaHighlightingItem,
  AgdaInterval,
  AgdaKnownResponse,
  AgdaResponse,
  AgdaUnreadResponse,
  ParsedResponse,
} from "./responses.js";
export {
  AgdaSession,
  caseSplitText,
  giveReplacement,
  messagesOf,
  openSession,
  QUESTION_MARK_GOAL,
} from "./session.js";
export type {
  CheckHooks,
  CheckValue,
  ExpressionValue,
  GiveValue,
  GoalRef,
  GoalValue,
  GoalView,
  LoadValue,
  MakeCaseValue,
  OperationKind,
  ResponseEvent,
  SessionOptions,
  SessionStatus,
  TextEdit,
} from "./session.js";
export {
  OffsetTable,
  codePointLength,
  preservesPositions,
  sha256Hex,
  sourceDigest,
  utf8,
} from "./text.js";
export type { Capabilities, Capability, EngineTransport, TransportEvent } from "./transport.js";
export { sourceKind, isSourcePath } from "./paths.js";
export type { SourceKind } from "./paths.js";
