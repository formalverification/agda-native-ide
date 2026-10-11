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
// type_of, normalize) and the two verdict tools, which refuse until an
// engine has a batch lane (issues 30 and 64).  The rest of the table
// (resolve_name, exports_of, get_diagnostics, the searches, definition_of,
// get_dependencies, check_project) is issue 29's.

import { z } from "zod";
import type {
  AgdaSession,
  ExpressionValue,
  GoalRef,
  GoalValue,
  GoalView,
  Outcome,
  SourceBasis,
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

export type ToolResult<T = unknown> =
  | {
      tool: string;
      status: "answer";
      /** Never "batch": no tool here has a verdict to give. */
      lane: "interaction";
      tree: Tree;
      elapsedMs: number;
      addressed?: Addressed;
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
const verdictInput = z.object({}).loose();

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
      "Whether a candidate fills a hole, by a fresh batch check of the file with the candidate in place, whose exit code is the verdict.  Refused until the engine has a batch lane: a give on the interaction lane is not a verdict.",
    schema: verdictInput,
  },
  check_file: {
    description:
      "Whether the file checks, by a fresh batch check whose exit code is the verdict.  Refused until the engine has a batch lane.",
    schema: verdictInput,
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

export interface ToolSurface {
  tools: ToolDefinition[];
  call(name: string, input: unknown): Promise<ToolResult>;
  get_goal(input: z.input<typeof getGoalInput>): Promise<ToolResult<GoalResult>>;
  type_of(input: z.input<typeof expressionInput>): Promise<ToolResult<ExpressionResult>>;
  normalize(input: z.input<typeof expressionInput>): Promise<ToolResult<ExpressionResult>>;
  fill_hole(input?: unknown): Promise<ToolResult<never>>;
  check_file(input?: unknown): Promise<ToolResult<never>>;
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

  const verdict = async (tool: "fill_hole" | "check_file") => {
    const refusal = await session.checkFile();
    return refused(
      tool,
      refusal.reason,
      tool === "fill_hole"
        ? `fill_hole's answer is a verdict: a fresh batch check of the file with the candidate in place.  ${refusal.message}.  A give on the interaction lane is not a verdict.`
        : `check_file's answer is a verdict: a fresh batch check of the file.  ${refusal.message}.`,
      refusal.capability,
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
    fill_hole: () => verdict("fill_hole"),
    check_file: () => verdict("check_file"),
    async call(name, input) {
      switch (name) {
        case "get_goal":
          return surface.get_goal(input as z.input<typeof getGoalInput>);
        case "type_of":
        case "normalize":
          return expression(name, input);
        case "fill_hole":
        case "check_file":
          return verdict(name);
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
