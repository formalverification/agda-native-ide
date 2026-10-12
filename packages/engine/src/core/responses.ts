// File: packages/engine/src/core/responses.ts
//
// Agda's answers, validated.  Both engines deliver the same objects:
// Agda's own JSON encoding of each response (JSONTop.hs at the pinned
// commit), one per line of `agda --interaction-json`, and in the page the
// `contents` of the language server's `ResponseJSONRaw`, which the server
// sends when started with `--raw`.  Each adapter unwraps its envelope and
// nothing else; this module checks the kinds the engine reads, field by
// field, and keeps any other kind as it came.  A known kind with a
// malformed payload is a protocol failure of the command that received it,
// never a guess.

import { z } from "zod";

const position = z.object({ pos: z.number().int(), line: z.number().int(), col: z.number().int() });

/** An interval of Agda's positions, 1-based, `pos` counting code points. */
export const intervalSchema = z.object({ start: position, end: position });
export type AgdaInterval = z.infer<typeof intervalSchema>;

/** An interaction point, `{id, range}`; Agda writes a bare number in a few
 * answers (SolveAll), and an empty range for a point a give introduced. */
const interactionPoint = z.union([
  z.object({ id: z.number().int(), range: z.array(intervalSchema) }),
  z.number().int().transform((id) => ({ id, range: [] as AgdaInterval[] })),
]);

const message = z.object({ message: z.string() }).loose();

const contextEntry = z.object({
  originalName: z.string(),
  reifiedName: z.string(),
  binding: z.string(),
  inScope: z.boolean(),
});
export type AgdaContextEntry = z.infer<typeof contextEntry>;

const goalInfo = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("GoalType"),
    rewrite: z.string(),
    type: z.string(),
    entries: z.array(contextEntry),
    typeAux: z.object({ kind: z.string() }).loose(),
    boundary: z.array(z.string()),
    outputForms: z.array(z.string()),
  }),
  z.object({ kind: z.literal("CurrentGoal"), rewrite: z.string(), type: z.string() }),
  z.object({ kind: z.literal("InferredType"), expr: z.string() }),
  z.object({ kind: z.literal("NormalForm"), computeMode: z.string(), expr: z.string() }),
  z.object({ kind: z.literal("HelperFunction"), signature: z.string() }),
]);

const visibleGoal = z
  .object({
    kind: z.string(),
    constraintObj: z.union([
      z.object({ id: z.number().int(), range: z.array(intervalSchema) }),
      z.object({ name: z.string(), range: z.array(intervalSchema) }),
    ]),
    type: z.string().optional(),
  })
  .loose();

const displayInfo = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("AllGoalsWarnings"),
    visibleGoals: z.array(visibleGoal),
    invisibleGoals: z.array(z.unknown()),
    warnings: z.array(message),
    errors: z.array(message),
  }),
  z.object({ kind: z.literal("Error"), error: message, warnings: z.array(z.unknown()) }),
  z.object({ kind: z.literal("GoalSpecific"), interactionPoint, goalInfo }),
  z.object({ kind: z.literal("Context"), interactionPoint, context: z.array(contextEntry) }),
  z.object({ kind: z.literal("InferredType"), expr: z.string() }).loose(),
  z.object({ kind: z.literal("NormalForm"), expr: z.string(), computeMode: z.string() }).loose(),
  z.object({ kind: z.literal("Version"), version: z.string() }),
  z.object({ kind: z.literal("IntroNotFound") }),
]);

const highlightingItem = z.object({
  range: z.tuple([z.number().int(), z.number().int()]),
  atoms: z.array(z.string()),
  tokenBased: z.enum(["TokenBased", "NotOnlyTokenBased"]),
  note: z.string(),
  definitionSite: z.object({ filepath: z.string(), position: z.number().int() }).nullable(),
});
export type AgdaHighlightingItem = z.infer<typeof highlightingItem>;

/** The kinds the engine reads. */
const known = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("Status"),
    status: z.object({
      checked: z.boolean(),
      showImplicitArguments: z.boolean(),
      showIrrelevantArguments: z.boolean(),
    }),
  }),
  z.object({ kind: z.literal("ClearRunningInfo") }),
  z.object({ kind: z.literal("RunningInfo"), debugLevel: z.number().int(), message: z.string() }),
  z.object({
    kind: z.literal("ClearHighlighting"),
    tokenBased: z.enum(["TokenBased", "NotOnlyTokenBased"]),
  }),
  // `direct` is false only for highlighting written to a file, which the
  // engine never asks for (every command is sent `Direct`).
  z.object({
    kind: z.literal("HighlightingInfo"),
    direct: z.literal(true),
    info: z.object({ remove: z.boolean(), payload: z.array(highlightingItem) }),
  }),
  z.object({ kind: z.literal("InteractionPoints"), interactionPoints: z.array(interactionPoint) }),
  z.object({
    kind: z.literal("GiveAction"),
    interactionPoint,
    giveResult: z.union([z.object({ str: z.string() }), z.object({ paren: z.boolean() })]),
  }),
  z.object({
    kind: z.literal("MakeCase"),
    interactionPoint,
    variant: z.string(),
    clauses: z.array(z.string()),
  }),
  z.object({ kind: z.literal("DisplayInfo"), info: displayInfo }),
  z.object({ kind: z.literal("DoneAborting") }),
  z.object({ kind: z.literal("DoneExiting") }),
  z.object({ kind: z.literal("JumpToError"), filepath: z.string(), position: z.number().int() }),
]);

/** The DisplayInfo kinds Agda has and the engine does not read: carried as
 * they came, under their kind, inside an `Unread` answer. */
export type AgdaKnownResponse = z.infer<typeof known>;
export type AgdaDisplayInfo = z.infer<typeof displayInfo>;

/** A response the engine does not interpret: kept whole, with its kind. */
export interface AgdaUnreadResponse {
  kind: "Unread";
  agdaKind: string;
  raw: unknown;
}

export type AgdaResponse = AgdaKnownResponse | AgdaUnreadResponse;

const knownKinds = new Set([
  "Status", "ClearRunningInfo", "RunningInfo", "ClearHighlighting", "HighlightingInfo",
  "InteractionPoints", "GiveAction", "MakeCase", "DisplayInfo", "DoneAborting",
  "DoneExiting", "JumpToError",
]);
const knownInfoKinds = new Set([
  "AllGoalsWarnings", "Error", "GoalSpecific", "Context", "InferredType", "NormalForm",
  "Version", "IntroNotFound",
]);

export type ParsedResponse =
  | { ok: true; response: AgdaResponse }
  | { ok: false; error: string; raw: unknown };

/** Validate one of Agda's responses.  A kind (or a DisplayInfo kind) the
 * engine does not read comes back `Unread`; a kind it reads must have
 * every field it reads, or the answer is refused with Zod's account of
 * what is wrong. */
export function parseResponse(raw: unknown): ParsedResponse {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "a response is not a JSON object", raw };
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== "string") return { ok: false, error: "a response has no kind", raw };
  const infoKind = (raw as { info?: { kind?: unknown } }).info?.kind;
  if (!knownKinds.has(kind) || (kind === "DisplayInfo" && !knownInfoKinds.has(String(infoKind))))
    return {
      ok: true,
      response: { kind: "Unread", agdaKind: kind === "DisplayInfo" ? `DisplayInfo/${String(infoKind)}` : kind, raw },
    };
  const parsed = known.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      error: `${kind}${kind === "DisplayInfo" ? `/${String(infoKind)}` : ""}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
      raw,
    };
  return { ok: true, response: parsed.data };
}
