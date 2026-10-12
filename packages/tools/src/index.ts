// File: packages/tools/src/index.ts
//
// The tool surface: agda-mcp's tools as functions with JSON schemas, over
// the engine interface (@agda-native-ide/engine), for any host: the page's
// inspector today, a model's tool calls and the editor later (issues 29,
// 38, 65).  The contract is agda-native-air ADR 0002's:
//
//   +  a verdict is a batch run's exit code, never a reading of Agda's
//      messages, and an answer of the interaction lane carries none;
//   +  every answer names the tree it is about: the engine, the session,
//      Agda's version, the file, the digest of the text Agda read, and the
//      load's generation;
//   +  a goal is addressed by its number, or by a line and column inside
//      it, or by nothing when the file has exactly one, and every answer
//      says which goal it used and how (`addressed`);
//   +  a refusal and a failure are not answers, and say why.
//
// This is the initial surface: the lane's three questions (get_goal,
// type_of, normalize) and the two verdict tools, check_file and fill_hole,
// which answer from the batch lane (a fresh Agda whose exit code is the
// verdict) where the engine has one, natively (issue 64), and refuse where
// it has none, in the page (issue 30).  The rest of the table
// (resolve_name, exports_of, get_diagnostics, the searches, definition_of,
// get_dependencies, check_project) is issue 29's.

import { z } from "zod";
import {
  sourceDigest,
  type AgdaSession,
  type BatchCommand,
  type Diagnostic,
  type ExpressionValue,
  type GoalRef,
  type GoalValue,
  type GoalView,
  type Outcome,
  type SourceBasis,
  type Verdict,
  type VerdictOutcome,
} from "@agda-native-ide/engine";

/** The tree an answer is about. */
export interface Tree {
  engine: "browser" | "native";
  session: string;
  agdaVersion: string;
  file: string;
  digest: string;
  generation: number;
}

/** Which goal a call used, and how it was found. */
export interface Addressed {
  goal: number;
  /** Agda's position of the goal in the text it loaded, 1-based. */
  line?: number;
  col?: number;
  resolvedBy: "number" | "span" | "only hole";
}

/** The tree a verdict is about: the file, and the text the run read. */
export interface VerdictTree {
  engine: "browser" | "native";
  agdaVersion: string;
  file: string;
  digest: string;
}

/** What a verdict is, as agda-native-air's tools echo it. */
export interface VerdictEcho {
  /** Agda's own exit code. */
  exitCode: number;
  /** A command line that reproduces the run, in its directory. */
  equivalentTo: string;
  /** What `success` (check_file) or `status` (fill_hole) means. */
  meaning: string;
}

export type ToolResult<T = unknown> =
  | {
      tool: string;
      status: "answer";
      /** The interaction lane's: knowledge, never a verdict. */
      lane: "interaction";
      tree: Tree;
      elapsedMs: number;
      addressed?: Addressed;
      result: T;
    }
  | {
      tool: string;
      status: "verdict";
      /** The batch lane's: a fresh Agda's exit code. */
      lane: "batch";
      tree: VerdictTree;
      command: BatchCommand;
      elapsedMs: number;
      addressed?: Addressed;
      verdict: VerdictEcho;
      result: T;
    }
  | { tool: string; status: "refused"; reason: string; message: string; capability?: string }
  | { tool: string; status: "failed"; reason: string; message: string };

export interface ToolDefinition {
  name: string;
  description: string;
  /** The input's JSON Schema, for model tool calling. */
  inputSchema: Record<string, unknown>;
}

const rewrite = z
  .enum(["AsIs", "Instantiated", "HeadNormal", "Simplified", "Normalised"])
  .describe("How Agda normalizes what it shows (default Normalised).");

const address = {
  goal: z.number().int().min(0).optional().describe("The goal's number, as the last load numbered it."),
  line: z.number().int().min(1).optional().describe("A line inside the goal, 1-based, in the text as loaded."),
  column: z.number().int().min(1).optional().describe("A column inside the goal, 1-based, counting code points."),
};

const getGoalInput = z.object({ ...address, rewrite: rewrite.optional() }).strict();
const expressionInput = z
  .object({ expression: z.string().min(1).describe("An Agda expression."), ...address })
  .strict();
const checkFileInput = z
  .object({
    file: z
      .string()
      .min(1)
      .optional()
      .describe("The file, as the engine knows it (default: the loaded file)."),
  })
  .strict();
const fillHoleInput = z
  .object({
    candidate: z.string().min(1).describe("The term that replaces the goal, braces and all, as it is written."),
    ...address,
  })
  .strict();

/** What check_file's `success` means: agda-native-air's sentence, less its
 * clause that its server has no interaction mode, which this surface has. */
export const CHECK_MEANING =
  "success is true if and only if that command exited 0, so it means exactly what green means in a batch build.  Unsolved metavariables, unsolved constraints, and open holes all make agda exit non-zero and so make success false.  The verdict is read from the exit code alone, never from the diagnostics text, so a change in Agda's message format can empty the diagnostics list but cannot turn a failing build green.";

/** What fill_hole's `status` means: agda-native-air's sentence, with this
 * surface's names for a run that outran its deadline or never started. */
export const FILL_MEANING =
  'status is "ok" if and only if that command exited 0, or failed with nothing but [UnsolvedInteractionMetas] (holes still open in the file), including any new sub-hole the candidate itself introduced, which is a successful refinement.  Every other failure is "type_error", including [UnsolvedMetaVariables] and [UnsolvedConstraints]: a candidate that leaves a meta unsolved does not pass the build and is not ok here either.  A run that outran its deadline, or an agda that could not be started, is a failure, not a status: the candidate was never judged.';

const definitions = {
  get_goal: {
    description:
      "A goal's type and context, from the interaction lane (Cmd_goal_type_context): knowledge, never a verdict.  Address the goal by its number, or by a line and column inside it, or by nothing when the file has one goal.",
    schema: getGoalInput,
  },
  type_of: {
    description:
      "An expression's type, in a goal's scope or at the top level of the loaded file, from the interaction lane: knowledge, never a verdict.",
    schema: expressionInput,
  },
  normalize: {
    description:
      "An expression's normal form, in a goal's scope or at the top level of the loaded file, from the interaction lane: knowledge, never a verdict.",
    schema: expressionInput,
  },
  fill_hole: {
    description:
      "Whether a candidate fills a goal: a fresh batch check of the loaded file with the candidate written over the goal (braces and all, as given), whose exit code is the verdict; the file is put back afterwards, byte for byte.  The goal is addressed as get_goal's is.  Refused where the engine has no batch lane: a give on the interaction lane is not a verdict.",
    schema: fillHoleInput,
  },
  check_file: {
    description:
      "Whether a file checks: a fresh batch check of it as it is on disk, whose exit code is the verdict, with Agda's diagnostics.  The file defaults to the loaded one.  Refused where the engine has no batch lane.",
    schema: checkFileInput,
  },
} as const;

export type ToolName = keyof typeof definitions;

/** The tools, with their JSON Schemas. */
export const tools: ToolDefinition[] = Object.entries(definitions).map(([name, definition]) => ({
  name,
  description: definition.description,
  inputSchema: z.toJSONSchema(definition.schema) as Record<string, unknown>,
}));

function treeOf(basis: SourceBasis): Tree {
  return {
    engine: basis.engine,
    session: basis.session,
    agdaVersion: basis.agdaVersion,
    file: basis.path,
    digest: basis.digest,
    generation: basis.generation,
  };
}

function refused(tool: string, reason: string, message: string, capability?: string): ToolResult<never> {
  return capability === undefined
    ? { tool, status: "refused", reason, message }
    : { tool, status: "refused", reason, message, capability };
}

/** A goal from a call's address: its number, a position inside it, or
 * the only goal there is. */
function resolveGoal(
  tool: string,
  session: AgdaSession,
  input: { goal?: number; line?: number; column?: number },
  required: boolean,
): { ref?: GoalRef; addressed?: Addressed } | ToolResult<never> {
  const goals = session.goals();
  const describe = (goal: GoalView) =>
    goal.agdaRange ? `${goal.id} (line ${goal.agdaRange.start.line}, column ${goal.agdaRange.start.col})` : `${goal.id}`;
  const open = goals.length ? `the open goals are ${goals.map(describe).join(", ")}` : "no goal is open";
  const at = (goal: GoalView, resolvedBy: Addressed["resolvedBy"]) => {
    const ref = session.goalRef(goal.id);
    if (!ref) return refused(tool, "unknown-goal", `goal ${goal.id} is not open; ${open}`);
    const addressed: Addressed = { goal: goal.id, resolvedBy };
    if (goal.agdaRange) {
      addressed.line = goal.agdaRange.start.line;
      addressed.col = goal.agdaRange.start.col;
    }
    return { ref, addressed };
  };
  const hasPosition = input.line !== undefined || input.column !== undefined;
  if (input.goal !== undefined && hasPosition)
    return refused(tool, "invalid-input", "name a goal by its number or by a position, not both");
  if (input.goal !== undefined) {
    const goal = goals.find((candidate) => candidate.id === input.goal);
    return goal ? at(goal, "number") : refused(tool, "unknown-goal", `there is no goal ${input.goal}; ${open}`);
  }
  if (hasPosition) {
    if (input.line === undefined || input.column === undefined)
      return refused(tool, "invalid-input", "a position needs both a line and a column");
    const goal = goals.find((candidate) => {
      const range = candidate.agdaRange;
      if (!range) return false;
      const after = input.line! > range.start.line || (input.line === range.start.line && input.column! >= range.start.col);
      const before = input.line! < range.end.line || (input.line === range.end.line && input.column! < range.end.col);
      return after && before;
    });
    return goal
      ? at(goal, "span")
      : refused(tool, "no-goal-at-position", `no goal is at line ${input.line}, column ${input.column}; ${open}`);
  }
  if (!required) return {};
  if (goals.length === 1) return at(goals[0], "only hole");
  return refused(tool, "invalid-input", `name a goal; ${open}`);
}

function fromOutcome<T, R>(
  tool: string,
  outcome: Outcome<T>,
  addressed: Addressed | undefined,
  result: (value: T) => R,
): ToolResult<R> {
  if (outcome.kind === "refusal")
    return outcome.capability === undefined
      ? { tool, status: "refused", reason: outcome.reason, message: outcome.message }
      : { tool, status: "refused", reason: outcome.reason, message: outcome.message, capability: outcome.capability };
  if (outcome.kind === "failure") return { tool, status: "failed", reason: outcome.reason, message: outcome.message };
  if (!outcome.basis) return { tool, status: "failed", reason: "protocol", message: "the answer names no tree" };
  const answer: ToolResult<R> = {
    tool,
    status: "answer",
    lane: "interaction",
    tree: treeOf(outcome.basis),
    elapsedMs: Math.round(outcome.elapsedMs * 10) / 10,
    result: result(outcome.value),
  };
  if (addressed) answer.addressed = addressed;
  return answer;
}

export interface GoalResult {
  goal: number;
  type: string;
  context: GoalValue["context"];
}

export interface ExpressionResult {
  /** The goal whose scope the expression was read in, or none for the
   * top level. */
  goal?: number;
  /** Agda's answer (the type, or the normal form), when it gave one. */
  type?: string;
  normalForm?: string;
  /** Agda's error, when the expression does not check there. */
  error?: string;
}

export interface CheckFileResult {
  /** `exitCode === 0`. */
  success: boolean;
  diagnostics: Diagnostic[];
}

export interface FillHoleResult {
  status: "ok" | "type_error";
  candidate: string;
  /** `exitCode === 0`: the file checks with the candidate in place. */
  success: boolean;
  diagnostics: Diagnostic[];
}

export interface ToolSurface {
  tools: ToolDefinition[];
  call(name: string, input: unknown): Promise<ToolResult>;
  get_goal(input: z.input<typeof getGoalInput>): Promise<ToolResult<GoalResult>>;
  type_of(input: z.input<typeof expressionInput>): Promise<ToolResult<ExpressionResult>>;
  normalize(input: z.input<typeof expressionInput>): Promise<ToolResult<ExpressionResult>>;
  fill_hole(input: z.input<typeof fillHoleInput>): Promise<ToolResult<FillHoleResult>>;
  check_file(input?: z.input<typeof checkFileInput>): Promise<ToolResult<CheckFileResult>>;
}

/** A command line for a batch run, each word quoted for a POSIX shell
 * where it needs it. */
export function commandLine(command: BatchCommand): string {
  const quote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
  return `cd ${quote(command.cwd)} && ${[command.executable, ...command.args].map(quote).join(" ")}`;
}

function fromVerdict<R>(
  tool: string,
  outcome: VerdictOutcome,
  addressed: Addressed | undefined,
  echo: { meaning: string; patched?: string },
  result: (verdict: Verdict) => R,
): ToolResult<R> {
  if (outcome.kind === "refusal")
    return outcome.capability === undefined
      ? { tool, status: "refused", reason: outcome.reason, message: outcome.message }
      : { tool, status: "refused", reason: outcome.reason, message: outcome.message, capability: outcome.capability };
  if (outcome.kind === "failure") return { tool, status: "failed", reason: outcome.reason, message: outcome.message };
  const line = commandLine(outcome.command);
  const answer: ToolResult<R> = {
    tool,
    status: "verdict",
    lane: "batch",
    tree: { engine: outcome.engine, agdaVersion: outcome.agdaVersion, file: outcome.path, digest: outcome.digest },
    command: outcome.command,
    elapsedMs: Math.round(outcome.elapsedMs * 10) / 10,
    verdict: {
      exitCode: outcome.exitCode,
      equivalentTo: echo.patched
        ? `${line}, run against that file with ${echo.patched} (the file on disk is put back afterwards, byte for byte)`
        : line,
      meaning: echo.meaning,
    },
    result: result(outcome),
  };
  if (addressed) answer.addressed = addressed;
  return answer;
}

/** The tool surface over one session. */
export function createToolSurface(session: AgdaSession): ToolSurface {
  const parse = <S extends z.ZodType>(tool: string, schema: S, input: unknown) => {
    const parsed = schema.safeParse(input ?? {});
    if (parsed.success) return { ok: true as const, value: parsed.data as z.output<S> };
    return {
      ok: false as const,
      refusal: refused(
        tool,
        "invalid-input",
        parsed.error.issues.map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`).join("; "),
      ),
    };
  };

  const expression = async (
    tool: "type_of" | "normalize",
    input: unknown,
  ): Promise<ToolResult<ExpressionResult>> => {
    const parsed = parse(tool, expressionInput, input);
    if (!parsed.ok) return parsed.refusal;
    const goal = resolveGoal(tool, session, parsed.value, false);
    if ("status" in goal) return goal;
    const outcome =
      tool === "type_of"
        ? await session.infer(parsed.value.expression, goal.ref)
        : await session.normalize(parsed.value.expression, goal.ref);
    return fromOutcome(tool, outcome, goal.addressed, (value: ExpressionValue) => {
      const result: ExpressionResult = {};
      if (value.goal !== undefined) result.goal = value.goal;
      if (value.expression !== undefined) {
        if (tool === "type_of") result.type = value.expression;
        else result.normalForm = value.expression;
      }
      if (value.error !== undefined) result.error = value.error;
      return result;
    });
  };

  /** A tool's refusal for want of the batch lane, before anything else is
   * asked of the input. */
  const noBatch = (tool: "fill_hole" | "check_file"): ToolResult<never> | undefined => {
    const batch = session.capabilities.batch;
    if (batch.supported) return undefined;
    const why = batch.reason ?? "this engine has no batch lane, so it cannot give a verdict";
    return refused(
      tool,
      "unsupported-capability",
      tool === "fill_hole"
        ? `fill_hole's answer is a verdict: a fresh batch check of the file with the candidate in place.  ${why}.  A give on the interaction lane is not a verdict.`
        : `check_file's answer is a verdict: a fresh batch check of the file.  ${why}.`,
      "batch",
    );
  };

  const checkFile = async (input: unknown): Promise<ToolResult<CheckFileResult>> => {
    const lacking = noBatch("check_file");
    if (lacking) return lacking;
    const parsed = parse("check_file", checkFileInput, input);
    if (!parsed.ok) return parsed.refusal;
    const file = parsed.value.file ?? session.basis?.path;
    if (!file) return refused("check_file", "invalid-input", "name a file, or load one first");
    const outcome = await session.checkFile(file);
    return fromVerdict("check_file", outcome, undefined, { meaning: CHECK_MEANING }, (verdict) => ({
      success: verdict.success,
      diagnostics: verdict.diagnostics,
    }));
  };

  const fillHole = async (input: unknown): Promise<ToolResult<FillHoleResult>> => {
    const lacking = noBatch("fill_hole");
    if (lacking) return lacking;
    const parsed = parse("fill_hole", fillHoleInput, input);
    if (!parsed.ok) return parsed.refusal;
    const goal = resolveGoal("fill_hole", session, parsed.value, true);
    if ("status" in goal) return goal;
    const snapshot = session.snapshot;
    const span = session.goals().find((candidate) => candidate.id === goal.ref!.id)?.span;
    if (snapshot === undefined || !span)
      return refused(
        "fill_hole",
        "unknown-goal",
        `goal ${goal.ref!.id} has no place in the loaded text (a give made it); load the file again`,
      );
    const { candidate } = parsed.value;
    const text = snapshot.slice(0, span.from) + candidate + snapshot.slice(span.to);
    // The file must hold the text the goal was found in.
    const outcome = await session.checkFile(goal.ref!.basis.path, { text, expect: sourceDigest(snapshot) });
    return fromVerdict(
      "fill_hole",
      outcome,
      goal.addressed,
      { meaning: FILL_MEANING, patched: `the candidate written over goal ${goal.ref!.id}` },
      (verdict) => {
        const errors = verdict.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
        const onlyHoles =
          verdict.exitCode === 42 &&
          errors.length > 0 &&
          errors.every((diagnostic) => diagnostic.code === "UnsolvedInteractionMetas");
        return {
          status: verdict.success || onlyHoles ? "ok" : "type_error",
          candidate,
          success: verdict.success,
          diagnostics: verdict.diagnostics,
        };
      },
    );
  };

  const surface: ToolSurface = {
    tools,
    async get_goal(input) {
      const parsed = parse("get_goal", getGoalInput, input);
      if (!parsed.ok) return parsed.refusal;
      const goal = resolveGoal("get_goal", session, parsed.value, true);
      if ("status" in goal) return goal;
      const outcome = await session.goal(goal.ref!, parsed.value.rewrite ?? "Normalised");
      return fromOutcome("get_goal", outcome, goal.addressed, (value: GoalValue) => ({
        goal: value.goal,
        type: value.type,
        context: value.context,
      }));
    },
    type_of: (input) => expression("type_of", input),
    normalize: (input) => expression("normalize", input),
    fill_hole: (input) => fillHole(input),
    check_file: (input) => checkFile(input),
    async call(name, input) {
      switch (name) {
        case "get_goal":
          return surface.get_goal(input as z.input<typeof getGoalInput>);
        case "type_of":
        case "normalize":
          return expression(name, input);
        case "fill_hole":
          return fillHole(input);
        case "check_file":
          return checkFile(input);
        default:
          return refused(
            name,
            "unknown-tool",
            `there is no tool ${name}; this surface has ${tools.map((tool) => tool.name).join(", ")}, and issue 29 adds the rest of agda-mcp's table`,
          );
      }
    },
  };
  return surface;
}
