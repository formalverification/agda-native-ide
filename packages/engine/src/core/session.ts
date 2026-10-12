// File: packages/engine/src/core/session.ts
//
// A session with one running Agda, over either engine's transport.  It
// owns what the protocol leaves to its client:
//
//   +  one command at a time, in order, each ended by the transport's
//      verified boundary, from a queue of bounded length;
//   +  a deadline for every operation, from the moment it reaches the
//      head of the queue until its answer is read: at its expiry an
//      operation not yet sent fails unsent; one whose command Agda is
//      running is aborted (`Cmd_abort`), and if Agda has not ended the
//      command within a grace period, the session stops Agda; one whose
//      answer is being read (a load reads its source back) fails, and its
//      load is not taken; either way the operation fails, and nothing
//      waits on it;
//   +  the basis of every answer (the session, the file, the digest of
//      the text Agda read, the load's generation), and the goals that are
//      live in it, so a goal of another session, file or load is refused
//      before anything is sent;
//   +  the snapshot, the text Agda's live state reflects: the loaded text
//      with the edits Agda's own answers made (a give, a refine, a case
//      split, a `?` shown as a goal), whose positions Agda still reports
//      in the loaded text's coordinates until the next load;
//   +  the give rule (./give-rule.ts);
//   +  the batch lane's verdicts, where the transport has one: a fresh Agda
//      per check, queued with the lane's commands so that the two never
//      write a checkout's interfaces at once, whose exit code the session
//      reads into a verdict, with the text it ran on.
//
// It reads no file and runs no process itself: the transport does.

import { iotcm, isRewrite, type Command, type HighlightingLevel, type Rewrite } from "./commands.js";
import { parseDiagnostics } from "./diagnostics.js";
import { planCheck, type CheckPlan, type GoalSpan } from "./give-rule.js";
import {
  failure,
  refusal,
  type Answer,
  type Failure,
  type Outcome,
  type Refusal,
  type SourceBasis,
  type Verdict,
  type VerdictOutcome,
} from "./outcome.js";
import {
  parseResponse,
  type AgdaContextEntry,
  type AgdaInterval,
  type AgdaResponse,
} from "./responses.js";
import { OffsetTable, preservesPositions, sourceDigest } from "./text.js";
import type { BatchHandle, BatchRun, Capabilities, EngineTransport, TransportEvent } from "./transport.js";

/** What a `?` becomes when Agda reports it as a goal, as editors write it. */
export const QUESTION_MARK_GOAL = "{!  !}";

export type OperationKind =
  | "version"
  | "load"
  | "give"
  | "refine"
  | "makeCase"
  | "goal"
  | "infer"
  | "normalize"
  | "verdict";

export interface SessionOptions {
  /** The highlighting Agda sends with each answer (default
   * `NonInteractive`, which the page colors its editor from). */
  highlighting?: HighlightingLevel;
  /** Each operation's deadline, in ms. */
  deadlines?: Partial<Record<OperationKind, number>>;
  /** How long Agda has to end a command after `Cmd_abort`, in ms, before
   * the session stops it. */
  abortGraceMs?: number;
  /** How many operations may wait behind the one running. */
  maxQueue?: number;
  /** Record a `?` that Agda reports as a goal as `{!  !}` in the snapshot,
   * as an editor shows it (default true). */
  expandQuestionMarks?: boolean;
  /** A host's conversion of a source before Agda reads it (the page's
   * aliases for PLFA's imports); it must keep every position, which the
   * session checks. */
  convertSource?: (path: string, text: string) => string;
  /** Extra arguments of every `Cmd_load`. */
  loadArgs?: readonly string[];
}

const DEFAULT_DEADLINES: Record<OperationKind, number> = {
  version: 60_000,
  load: 600_000,
  give: 120_000,
  refine: 120_000,
  makeCase: 120_000,
  goal: 120_000,
  infer: 120_000,
  normalize: 120_000,
  verdict: 600_000,
};

/** How much of a batch run's output a verdict keeps. */
const VERDICT_OUTPUT = 65_536;

/** A goal as an answer reports it. */
export interface GoalView {
  id: number;
  /** Its type, as Agda's goal list shows it (not normalized). */
  type?: string;
  /** Agda's range for it, in the loaded text. */
  agdaRange?: AgdaInterval;
  /** Where it is in the snapshot, in UTF-16 offsets, braces included;
   * absent for a goal a give or a refine introduced, which Agda places in
   * the candidate's text rather than the file's. */
  span?: { from: number; to: number };
}

/** A replacement in the snapshot, UTF-16 offsets into the snapshot as it
 * was before the edit; a host that shows the text applies it too. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface LoadValue {
  goals: GoalView[];
  /** Agda's errors, in its words. */
  errors: string[];
  warnings: string[];
  /** The modules Agda type-checked, from its `Checking` lines: the count
   * of interfaces it did not accept, plus the file. */
  checking: string[];
  /** Agda's own Status; `checked` is Agda's flag, which is not a verdict. */
  status?: { checked: boolean; showImplicitArguments: boolean; showIrrelevantArguments: boolean };
  /** The `?` goals recorded as `{!  !}`, in order. */
  expansions: TextEdit[];
}

export type CheckValue =
  | { plan: "unchanged" }
  | { plan: "give"; give: GiveValue }
  | { plan: "load"; reason: string; load: LoadValue };

export interface GiveValue {
  goal: number;
  /** Whether Agda took the term (it answered with a GiveAction).  A give
   * Agda takes is not a verdict on the module. */
  accepted: boolean;
  /** Agda's error, when it refused the term (or reported one with it). */
  error?: string;
  /** The text that replaces the goal, and where, when Agda took it. */
  edit?: TextEdit;
  goals: GoalView[];
  /** Goals the term introduced. */
  newGoals: number[];
}

export interface MakeCaseValue {
  goal: number;
  clauses: string[];
  variant: string;
  error?: string;
  edit?: TextEdit;
}

export interface GoalValue {
  goal: number;
  type: string;
  context: Array<{ name: string; originalName: string; type: string; inScope: boolean }>;
}

export interface ExpressionValue {
  /** The goal the expression was read at, or none for the top level. */
  goal?: number;
  /** Agda's answer: the type, or the normal form. */
  expression?: string;
  /** Agda's error, when it could not answer. */
  error?: string;
}

/** A goal, with the load it belongs to. */
export interface GoalRef {
  id: number;
  basis: SourceBasis;
}

export interface SessionStatus {
  state: "ready" | "busy" | "ended";
  operation?: OperationKind;
  queued: number;
}

export interface ResponseEvent {
  operation: { id: number; kind: OperationKind; path: string; command: Command };
  response: AgdaResponse;
}

/** What replaces a goal Agda has taken a term for: Agda's own rendering
 * when it sends one, else the term sent, parenthesized when Agda says. */
export function giveReplacement(expression: string, result: { str: string } | { paren: boolean }): string {
  return "str" in result ? result.str : result.paren ? `(${expression})` : expression;
}

/** The edit a case split makes in `text`, whose goal is at `span`: the
 * clauses Agda proposed replace the goal's clause, as Agda's Emacs mode
 * replaces it (agda2-mode.el's agda2-make-case-action and
 * agda2-make-case-action-extendlam), as follows:
 *
 *   +  a function's clause: the goal's line, after its indentation, gives
 *      way to the clauses, each on a line of its own with that
 *      indentation;
 *   +  an extended lambda's clause (`λ { x → {! !} }`): the text from the
 *      `;` or the unmatched `{` before the goal to the goal's end gives
 *      way to the clauses, after a space, joined by ` ; `; when nothing
 *      but the indentation is before it on its line (a `λ where`), the
 *      clauses go on lines of their own, as a function's do.
 *
 * Undefined when Agda proposed no clause. */
export function caseSplitEdit(
  text: string,
  span: { from: number; to: number },
  clauses: readonly string[],
  variant: string,
): TextEdit | undefined {
  if (!clauses.length) return undefined;
  const lineFrom = text.lastIndexOf("\n", span.from - 1) + 1;
  const indentation = /^[ \t]*/.exec(text.slice(lineFrom, span.from))![0];
  const start = lineFrom + indentation.length;
  const onLines = clauses.join(`\n${indentation}`);
  if (variant !== "ExtendedLambda") {
    const newline = text.indexOf("\n", span.from);
    return { from: start, to: newline < 0 ? text.length : newline, insert: onLines };
  }
  let at = span.from;
  let depth = 0;
  while (text[at - 1] !== ";" && depth >= 0 && at > start) {
    at -= 1;
    if (text[at - 1] === "}") depth += 1;
    if (text[at - 1] === "{") depth -= 1;
  }
  return at === start
    ? { from: start, to: span.to, insert: onLines }
    : { from: at, to: span.to, insert: ` ${clauses.join(" ; ")}` };
}

/** What a check is about to send, told synchronously once the session has
 * taken it, before anything is sent: a host that takes its text as Agda's
 * on a load (the page's offsets) does so here, in the tick it read the
 * text.  A check refused at once (a full queue, a conversion that moves
 * positions) tells nothing. */
export interface CheckHooks {
  onPlan?: (plan: CheckPlan) => void;
}

interface LiveGoal {
  id: number;
  type?: string;
  agdaRange?: AgdaInterval;
  span?: { from: number; to: number };
}

interface Loaded {
  basis: SourceBasis;
  /** The text whose positions Agda reports (what the host gave). */
  text: string;
  snapshot: string;
  goals: Map<number, LiveGoal>;
  /** Agda refused the file (an `Error`, not the errors it reports among
   * its warnings, such as a termination problem, after which it keeps the
   * file), so it holds none. */
  failed: boolean;
  /** Counts the snapshot's changes, so a plan made against one snapshot is
   * not carried out against another. */
  version: number;
  /** The snapshot holds text Agda proposed and has not checked (a case
   * split's clauses), so the next check must load it. */
  unchecked?: string;
}

/** A batch run as an operation: started when the operation reaches the
 * head of the queue, and read once its Agda is gone. */
interface BatchOperation {
  /** Reads the file (and writes a given text over it), then starts the
   * run; or says why it could not, having put back anything it wrote. */
  start(): Promise<BatchHandle | Failure>;
  handle?: BatchHandle;
  /** Reads the run into its verdict, after putting back a text it wrote;
   * runs however the operation ended, so the file is always put back. */
  finish(run: BatchRun): Promise<VerdictOutcome>;
}

interface Operation<T> {
  id: number;
  kind: OperationKind;
  path: string;
  /** The command it sends; none for a batch run. */
  command?: Command;
  batch?: BatchOperation;
  deadlineMs: number;
  /** Runs when the operation reaches the head of the queue, before its
   * command is sent; an outcome here ends it unsent. */
  prepare?: () => Promise<Refusal | Failure | undefined>;
  /** The load the operation was asked about: if another load, an abort or
   * a failed load has replaced it by the time the operation reaches the
   * head of the queue, the operation is refused unsent. */
  requires?: Loaded;
  /** The goal it was asked about, which must still be open then. */
  goal?: number;
  /** Reads Agda's answer; `live` says whether the operation is still the
   * session's (its deadline or the session's end can settle it first). */
  finish: (responses: AgdaResponse[], elapsedMs: number, live: () => boolean) => Promise<Outcome<T>> | Outcome<T>;
  resolve: (outcome: Outcome<T> | Verdict) => void;
  responses: AgdaResponse[];
  problems: string[];
  sent: boolean;
  /** Agda has ended the command, and its answer is being read. */
  reading: boolean;
  startedAt: number;
  timer?: unknown;
  graceTimer?: unknown;
  abortCause?: "timeout" | "caller";
  settled: boolean;
}

let sessionCounter = 0;

function sessionId(engine: string) {
  sessionCounter += 1;
  const random = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return `${engine}-${sessionCounter}-${random}`;
}

function goalSpanOf(goal: LiveGoal): GoalSpan | undefined {
  return goal.span ? { id: goal.id, from: goal.span.from, to: goal.span.to } : undefined;
}

function view(goal: LiveGoal): GoalView {
  const out: GoalView = { id: goal.id };
  if (goal.type !== undefined) out.type = goal.type;
  if (goal.agdaRange) out.agdaRange = goal.agdaRange;
  if (goal.span) out.span = { ...goal.span };
  return out;
}

/** Agda's errors and warnings among the responses, in its words. */
export function messagesOf(responses: readonly AgdaResponse[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const response of responses) {
    if (response.kind !== "DisplayInfo") continue;
    const info = response.info;
    if (info.kind === "Error") errors.push(info.error.message);
    else if (info.kind === "AllGoalsWarnings") {
      errors.push(...info.errors.map((error) => error.message));
      warnings.push(...info.warnings.map((warning) => warning.message));
    }
  }
  return { errors, warnings };
}

/** The modules Agda says it type-checks in `text`: one `Checking M
 * (path).` line each, indented when nested. */
function checkedIn(text: string): string[] {
  return [...text.matchAll(/Checking (\S+) \(/g)].map((match) => match[1]);
}

/** The modules a load type-checked, from Agda's running info. */
function checkingOf(responses: readonly AgdaResponse[]) {
  return responses.flatMap((response) => (response.kind === "RunningInfo" ? checkedIn(response.message) : []));
}

function lastOf<K extends AgdaResponse["kind"]>(
  responses: readonly AgdaResponse[],
  kind: K,
): Extract<AgdaResponse, { kind: K }> | undefined {
  for (let index = responses.length - 1; index >= 0; index--)
    if (responses[index].kind === kind) return responses[index] as Extract<AgdaResponse, { kind: K }>;
  return undefined;
}

/** Tell a host's listener, which must not stop the session if it throws:
 * the queue would stall, or the transport's delivery would. */
function heard(tell: () => void) {
  try {
    tell();
  } catch (error) {
    console.error("A session listener failed:", error);
  }
}

/** The last of a batch run's output. */
function tail(text: string): string {
  return text.length > VERDICT_OUTPUT ? text.slice(-VERDICT_OUTPUT) : text;
}

function shiftAfter(goals: Map<number, LiveGoal>, at: number, delta: number) {
  if (!delta) return;
  for (const goal of goals.values())
    if (goal.span && goal.span.from >= at)
      goal.span = { from: goal.span.from + delta, to: goal.span.to + delta };
}

export class AgdaSession {
  readonly id: string;
  readonly engine: "browser" | "native";
  readonly capabilities: Capabilities;
  agdaVersion = "";

  private readonly transport: EngineTransport;
  private readonly options: {
    highlighting: HighlightingLevel;
    abortGraceMs: number;
    maxQueue: number;
    expandQuestionMarks: boolean;
    loadArgs: readonly string[];
    convertSource?: (path: string, text: string) => string;
    deadlines: Record<OperationKind, number>;
  };
  private readonly queue: Operation<unknown>[] = [];
  private current: Operation<unknown> | undefined;
  private loaded: Loaded | undefined;
  private generation = 0;
  private operationCounter = 0;
  private ended = false;
  /** Agda is being stopped: nothing more is sent. */
  private stopping = false;
  /** Why the session stopped Agda, if it did. */
  private stopCause: Record<string, unknown> | undefined;
  private endDetail: Record<string, unknown> | undefined;
  private readonly responseListeners = new Set<(event: ResponseEvent) => void>();
  private readonly statusListeners = new Set<(status: SessionStatus) => void>();
  private readonly unsubscribe: () => void;
  /** The batch run in progress, until its Agda is gone and its file put
   * back. */
  private batchRunning: Promise<void> | undefined;

  constructor(transport: EngineTransport, options: SessionOptions = {}) {
    this.transport = transport;
    this.engine = transport.engine;
    this.capabilities = transport.capabilities;
    this.id = sessionId(transport.engine);
    this.options = {
      highlighting: options.highlighting ?? "NonInteractive",
      abortGraceMs: options.abortGraceMs ?? 5_000,
      maxQueue: options.maxQueue ?? 16,
      expandQuestionMarks: options.expandQuestionMarks ?? true,
      loadArgs: options.loadArgs ?? [],
      convertSource: options.convertSource,
      deadlines: Object.fromEntries(
        Object.entries(DEFAULT_DEADLINES).map(([kind, ms]) => [kind, options.deadlines?.[kind as OperationKind] ?? ms]),
      ) as Record<OperationKind, number>,
    };
    this.unsubscribe = transport.subscribe((event) => this.onEvent(event));
  }

  /** Ask Agda its version; the session is usable once it has answered. */
  async start(): Promise<Outcome<{ version: string }>> {
    const outcome = await this.version();
    if (outcome.kind === "answer") this.agdaVersion = outcome.value.version;
    return outcome;
  }

  // ---- What the host reads -------------------------------------------

  /** The current load's basis, if any. */
  get basis(): SourceBasis | undefined {
    return this.loaded?.basis;
  }

  /** The text Agda's live state reflects, if a load holds. */
  get snapshot(): string | undefined {
    return this.loaded?.snapshot;
  }

  get status(): SessionStatus {
    return {
      state: this.ended || this.stopping ? "ended" : this.current ? "busy" : "ready",
      ...(this.current ? { operation: this.current.kind } : {}),
      queued: this.queue.length,
    };
  }

  /** The live goals of the current load. */
  goals(): GoalView[] {
    if (!this.loaded) return [];
    return [...this.loaded.goals.values()].map(view);
  }

  /** A reference to a live goal of the current load. */
  goalRef(id: number): GoalRef | undefined {
    if (!this.loaded?.goals.has(id)) return undefined;
    return { id, basis: this.loaded.basis };
  }

  onResponse(listener: (event: ResponseEvent) => void): () => void {
    this.responseListeners.add(listener);
    return () => this.responseListeners.delete(listener);
  }

  onStatus(listener: (status: SessionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // ---- Operations --------------------------------------------------------

  version(): Promise<Outcome<{ version: string }>> {
    const path = this.loaded?.basis.path ?? this.transport.resolvePath("Main.agda");
    return this.enqueue<{ version: string }>("version", path, { kind: "showVersion" }, (responses, elapsedMs) => {
      for (const response of responses)
        if (response.kind === "DisplayInfo" && response.info.kind === "Version") {
          this.agdaVersion ||= response.info.version;
          return this.answer({ version: response.info.version }, responses, elapsedMs, undefined);
        }
      return failure("protocol", "Agda did not report its version", { responses });
    });
  }

  /** Load a file, as `text` when given (written where Agda reads it, after
   * the host's conversion), or as it is on disk. */
  load(path: string, text?: string): Promise<Outcome<LoadValue>> {
    return this.loadText(path, text);
  }

  /** A load; `accepted` runs in the same tick, once the load is queued. */
  private loadText(path: string, text?: string, accepted?: () => void): Promise<Outcome<LoadValue>> {
    if (typeof path !== "string" || !path)
      return Promise.resolve(refusal("invalid-input", "a load needs a path"));
    if (text !== undefined && typeof text !== "string")
      return Promise.resolve(refusal("invalid-input", "a load's text must be a string"));
    // The conversion runs now, so that one that moves positions is refused
    // before the load is queued or a host is told of it.
    const converted =
      text !== undefined && this.options.convertSource ? this.options.convertSource(path, text) : text;
    if (text !== undefined && converted !== undefined && !preservesPositions(text, converted))
      return Promise.resolve(
        refusal(
          "position-shift",
          `the conversion of ${path} moves positions, so Agda's answers could not be placed in the text`,
        ),
      );
    let read = { text: "", converted: "" };
    const prepare = async (): Promise<Refusal | Failure | undefined> => {
      if (text === undefined || converted === undefined) {
        let found: string | undefined;
        try {
          found = await this.transport.readSource(path);
        } catch (error) {
          return failure("io", `${path} could not be read (${String(error)})`);
        }
        if (found === undefined) return failure("io", `there is no source at ${path}`);
        read = { text: found, converted: found };
        return undefined;
      }
      try {
        await this.transport.writeSource(path, converted);
      } catch (error) {
        return failure("io", `${path} could not be written (${String(error)})`);
      }
      read = { text, converted };
      return undefined;
    };
    return this.enqueue<LoadValue>(
      "load",
      path,
      { kind: "load", path, args: this.options.loadArgs },
      (responses, elapsedMs, live) => this.finishLoad(path, read, responses, elapsedMs, live),
      { prepare, accepted },
    );
  }

  /** Check `text` by the give rule: nothing when Agda's live state already
   * reflects it, a give when the one edit is inside one live goal, and a
   * load otherwise. */
  async check(path: string, text: string, hooks: CheckHooks = {}): Promise<Outcome<CheckValue>> {
    if (typeof text !== "string") return refusal("invalid-input", "a check needs the text");
    const plan = this.plan(path, text);
    // The host hears of the plan only once it is taken (a full queue or a
    // conversion that moves positions refuses it first).
    const told = () => hooks.onPlan?.(plan);
    const loaded = this.loaded;
    if (plan.kind === "unchanged") {
      told();
      return this.answer({ plan: "unchanged" }, [], 0, loaded!.basis);
    }
    if (plan.kind === "give") {
      const give = await this.giveAt(
        loaded!,
        plan.goal,
        plan.expression,
        { text, span: plan.span, version: loaded!.version },
        told,
      );
      return give.kind === "answer" ? { ...give, value: { plan: "give", give: give.value } } : give;
    }
    const load = await this.loadText(path, text, told);
    return load.kind === "answer"
      ? { ...load, value: { plan: "load", reason: plan.reason, load: load.value } }
      : load;
  }

  /** What a check of `text` would send now: the give rule against the
   * snapshot, or a load when nothing (or another file) is loaded, or the
   * last load failed. */
  plan(path: string, text: string): CheckPlan {
    const loaded = this.loaded;
    if (!loaded) return { kind: "load", reason: "nothing is loaded" };
    if (loaded.basis.path !== path) return { kind: "load", reason: `${loaded.basis.path} is loaded, not ${path}` };
    if (loaded.failed) return { kind: "load", reason: "the last load failed" };
    if (loaded.unchecked) return { kind: "load", reason: loaded.unchecked };
    const spans = [...loaded.goals.values()].flatMap((goal) => goalSpanOf(goal) ?? []);
    return planCheck(loaded.snapshot, spans, text);
  }

  give(ref: GoalRef, expression: string): Promise<Outcome<GiveValue>> {
    const checked = this.checkRef(ref);
    if (checked) return Promise.resolve(checked);
    if (typeof expression !== "string" || !expression.trim())
      return Promise.resolve(refusal("invalid-input", "a give needs a term"));
    return this.giveAt(this.loaded!, ref.id, expression.trim());
  }

  refine(ref: GoalRef, expression: string): Promise<Outcome<GiveValue>> {
    const checked = this.checkRef(ref);
    if (checked) return Promise.resolve(checked);
    if (typeof expression !== "string")
      return Promise.resolve(refusal("invalid-input", "a refine takes a term, or an empty one"));
    const loaded = this.loaded!;
    const value = expression.trim();
    return this.enqueue<GiveValue>(
      "refine",
      loaded.basis.path,
      { kind: "refine", goal: ref.id, expression: value },
      (responses, elapsedMs) => this.finishGive(loaded, ref.id, value, responses, elapsedMs),
      { requires: loaded, goal: ref.id },
    );
  }

  makeCase(ref: GoalRef, patterns: string): Promise<Outcome<MakeCaseValue>> {
    const checked = this.checkRef(ref);
    if (checked) return Promise.resolve(checked);
    if (typeof patterns !== "string")
      return Promise.resolve(refusal("invalid-input", "a case split takes variables, or none"));
    const loaded = this.loaded!;
    return this.enqueue<MakeCaseValue>(
      "makeCase",
      loaded.basis.path,
      { kind: "makeCase", goal: ref.id, patterns: patterns.trim() },
      (responses, elapsedMs) => this.finishMakeCase(loaded, ref.id, responses, elapsedMs),
      { requires: loaded, goal: ref.id },
    );
  }

  /** A goal's type and context (`Cmd_goal_type_context`). */
  goal(ref: GoalRef, rewrite: Rewrite = "Normalised"): Promise<Outcome<GoalValue>> {
    const checked = this.checkRef(ref);
    if (checked) return Promise.resolve(checked);
    if (!isRewrite(rewrite)) return Promise.resolve(refusal("invalid-input", `${String(rewrite)} is not a rewrite mode`));
    const loaded = this.loaded!;
    return this.enqueue<GoalValue>(
      "goal",
      loaded.basis.path,
      { kind: "goalTypeContext", goal: ref.id, rewrite },
      (responses, elapsedMs) => {
        for (const response of responses) {
          if (response.kind !== "DisplayInfo") continue;
          const info = response.info;
          if (info.kind === "GoalSpecific" && info.goalInfo.kind === "GoalType") {
            const context = info.goalInfo.entries.map((entry: AgdaContextEntry) => ({
              name: entry.reifiedName || entry.originalName,
              originalName: entry.originalName,
              type: entry.binding,
              inScope: entry.inScope,
            }));
            return this.answer({ goal: ref.id, type: info.goalInfo.type, context }, responses, elapsedMs, loaded.basis);
          }
        }
        const { errors } = messagesOf(responses);
        if (errors.length) return failure("protocol", `Agda answered goal ${ref.id} with an error: ${errors[0]}`, { responses });
        return failure("protocol", `Agda did not report goal ${ref.id}`, { responses });
      },
      { requires: loaded, goal: ref.id },
    );
  }

  /** An expression's type, at a goal or at the top level of the loaded
   * file. */
  infer(expression: string, at?: GoalRef, rewrite: Rewrite = "Normalised"): Promise<Outcome<ExpressionValue>> {
    if (!isRewrite(rewrite)) return Promise.resolve(refusal("invalid-input", `${String(rewrite)} is not a rewrite mode`));
    return this.expression("infer", expression, at, (goal) =>
      goal === undefined
        ? { kind: "inferToplevel", expression: expression.trim(), rewrite }
        : { kind: "infer", goal, expression: expression.trim(), rewrite },
    );
  }

  /** An expression's normal form, at a goal or at the top level. */
  normalize(expression: string, at?: GoalRef): Promise<Outcome<ExpressionValue>> {
    return this.expression("normalize", expression, at, (goal) =>
      goal === undefined
        ? { kind: "computeToplevel", expression: expression.trim() }
        : { kind: "compute", goal, expression: expression.trim() },
    );
  }

  /** A verdict on a file: a fresh Agda's exit code (the batch lane), on
   * the file as it is, or on `text` written over it and put back
   * afterwards, whatever comes of the run.  `expect`, a digest, is the text
   * the file must hold before the run (the text a candidate was made from).
   * Refused where the engine has no batch lane.  The run is queued with the
   * lane's commands, so the two never write the checkout's interfaces at
   * once. */
  async checkFile(path?: string, options: { text?: string; expect?: string } = {}): Promise<VerdictOutcome> {
    const batch = this.capabilities.batch;
    const runBatch = this.transport.runBatch?.bind(this.transport);
    if (!batch.supported || !runBatch)
      return refusal(
        "unsupported-capability",
        batch.reason ?? "this engine has no batch lane, so it cannot give a verdict",
        "batch",
      );
    if (typeof path !== "string" || !path) return refusal("invalid-input", "a verdict needs the file's path");
    const { text, expect } = options ?? {};
    if (text !== undefined && typeof text !== "string")
      return refusal("invalid-input", "a verdict's text must be a string");
    const converted = text !== undefined && this.options.convertSource ? this.options.convertSource(path, text) : text;
    if (text !== undefined && converted !== undefined && !preservesPositions(text, converted))
      return refusal("position-shift", `the conversion of ${path} moves positions, so Agda's messages could not be placed in the text`);
    if (this.ended || this.stopping) return refusal("session-ended", "the session has ended");

    // What the file held before a given text was written over it, to put
    // back; and the digest of the text the run is to read.
    let original: string | undefined;
    let digest = "";
    const restore = async (): Promise<Failure | undefined> => {
      if (original === undefined) return undefined;
      const back = original;
      original = undefined;
      try {
        await this.transport.writeSource(path, back);
        return undefined;
      } catch (error) {
        return failure(
          "io",
          `${path} could not be put back (${String(error)}); it holds the text the verdict was asked about, and the text it held before is this failure's detail`,
          { detail: { original: back } },
        );
      }
    };
    const start = async (): Promise<BatchHandle | Failure> => {
      let current: string | undefined;
      try {
        current = await this.transport.readSource(path);
      } catch (error) {
        return failure("io", `${path} could not be read (${String(error)})`);
      }
      if (current === undefined) return failure("io", `there is no source at ${path}`);
      if (expect !== undefined && sourceDigest(current) !== expect)
        return failure("source-changed", `${path} no longer holds the text the verdict was asked about; ask again`);
      if (converted !== undefined) {
        original = current;
        try {
          await this.transport.writeSource(path, converted);
        } catch (error) {
          return (await restore()) ?? failure("io", `${path} could not be written (${String(error)})`);
        }
        digest = sourceDigest(converted);
      } else digest = sourceDigest(current);
      try {
        return runBatch(path);
      } catch (error) {
        return (await restore()) ?? failure("startup", `the batch run could not be started (${String(error)})`);
      }
    };
    const finish = async (run: BatchRun): Promise<VerdictOutcome> => {
      // The text the run read is the text the file holds after it, before
      // anything is put back.
      let after: string | undefined;
      try {
        after = await this.transport.readSource(path);
      } catch {
        after = undefined;
      }
      const unrestored = await restore();
      if (unrestored) return unrestored;
      const ran = (handle: BatchHandle | undefined) => handle?.command;
      if (run.startError)
        return failure("startup", `the batch run could not be started (${run.startError})`, {
          detail: { command: ran(operation.handle), stderr: run.stderr },
        });
      if (run.exitCode === null)
        return failure(
          "no-exit-code",
          `the batch run of ${path} ended by ${run.signal ?? "a signal"}, with no exit code, so it has no verdict`,
          { detail: { signal: run.signal ?? null, output: tail(run.stdout + run.stderr) } },
        );
      if (after === undefined || sourceDigest(after) !== digest)
        return failure("source-changed", `${path} changed while the batch run read it; ask again`);
      const output = run.stderr ? `${run.stdout}${run.stdout.endsWith("\n") ? "" : "\n"}${run.stderr}` : run.stdout;
      const verdict: Verdict = {
        kind: "verdict",
        lane: "batch",
        engine: this.engine,
        agdaVersion: this.agdaVersion,
        path,
        digest,
        command: operation.handle!.command,
        exitCode: run.exitCode,
        success: run.exitCode === 0,
        diagnostics: parseDiagnostics(output),
        checking: checkedIn(run.stdout),
        output: tail(output),
        elapsedMs: run.elapsedMs,
      };
      return verdict;
    };
    const operation: BatchOperation = { start, finish };
    return this.enqueueBatch(path, operation);
  }

  /** The host no longer shows what Agda holds (it replaced its text, and
   * with it the goals and the highlighting), so the next check loads,
   * whatever the text. */
  reloadNext(reason: string): void {
    if (this.loaded) this.loaded.unchecked = reason;
  }

  /** Abort the operation that is running, if any: Agda ends it with
   * `DoneAborting`, and forgets the loaded file. */
  abort(): { aborting: OperationKind | undefined } {
    const op = this.current;
    if (!op || !op.sent || op.reading || op.abortCause || this.ended || this.stopping) return { aborting: undefined };
    op.abortCause = "caller";
    // A batch run is its own Agda: it is stopped, and the lane is not told.
    if (op.batch) void op.batch.handle?.stop();
    else this.transport.abort(iotcm(op.path, { kind: "abort" }, "None"));
    return { aborting: op.kind };
  }

  /** Stop Agda, failing whatever runs or waits. */
  async dispose(): Promise<void> {
    this.stopping = true;
    this.stopCause ??= { reason: "disposed" };
    if (!this.ended) this.end({ reason: "disposed" });
    this.unsubscribe();
    await this.transport.terminate();
    // A batch run's text is put back before the session is gone.
    await this.batchRunning;
  }

  // ---- Internals ---------------------------------------------------------

  private answer<T>(value: T, responses: AgdaResponse[], elapsedMs: number, basis: SourceBasis | undefined): Answer<T> {
    const out: Answer<T> = {
      kind: "answer",
      lane: "interaction",
      engine: this.engine,
      session: this.id,
      agdaVersion: this.agdaVersion,
      elapsedMs,
      value,
      responses,
    };
    if (basis) out.basis = basis;
    return out;
  }

  private checkRef(ref: GoalRef): Refusal | undefined {
    if (this.ended) return refusal("session-ended", "the session has ended");
    if (!ref || typeof ref.id !== "number" || !ref.basis)
      return refusal("invalid-input", "a goal is named by its number and the load it belongs to");
    const loaded = this.loaded;
    const where = `goal ${ref.id} of ${ref.basis.path} (session ${ref.basis.session}, load ${ref.basis.generation})`;
    if (ref.basis.session !== this.id) return refusal("stale-goal", `${where} belongs to another session`);
    if (!loaded) return refusal("stale-goal", `${where} belongs to a load this session no longer holds`);
    if (ref.basis.generation !== loaded.basis.generation || ref.basis.path !== loaded.basis.path)
      return refusal(
        "stale-goal",
        `${where} belongs to an earlier load; the session now holds ${loaded.basis.path} (load ${loaded.basis.generation})`,
      );
    if (!loaded.goals.has(ref.id)) return refusal("unknown-goal", `${where} is not open`);
    return undefined;
  }

  private expression(
    kind: "infer" | "normalize",
    expression: string,
    at: GoalRef | undefined,
    command: (goal: number | undefined) => Command,
  ): Promise<Outcome<ExpressionValue>> {
    if (typeof expression !== "string" || !expression.trim())
      return Promise.resolve(refusal("invalid-input", `${kind === "infer" ? "an inference" : "a normalization"} needs an expression`));
    if (at) {
      const checked = this.checkRef(at);
      if (checked) return Promise.resolve(checked);
    } else if (this.ended) return Promise.resolve(refusal("session-ended", "the session has ended"));
    const loaded = this.loaded;
    if (!loaded || loaded.failed)
      return Promise.resolve(
        refusal(
          "no-loaded-file",
          loaded
            ? `the last load of ${loaded.basis.path} failed, and Agda would check it again first; load it`
            : "load a file first",
        ),
      );
    return this.enqueue<ExpressionValue>(kind, loaded.basis.path, command(at?.id), (responses, elapsedMs) => {
      for (const response of responses) {
        if (response.kind !== "DisplayInfo") continue;
        const info = response.info;
        const value: ExpressionValue = at ? { goal: at.id } : {};
        if (info.kind === "InferredType" || info.kind === "NormalForm")
          return this.answer({ ...value, expression: info.expr }, responses, elapsedMs, loaded.basis);
        if (info.kind === "GoalSpecific" && (info.goalInfo.kind === "InferredType" || info.goalInfo.kind === "NormalForm"))
          return this.answer({ ...value, expression: info.goalInfo.expr }, responses, elapsedMs, loaded.basis);
        if (info.kind === "Error")
          return this.answer({ ...value, error: info.error.message }, responses, elapsedMs, loaded.basis);
      }
      return failure("protocol", `Agda gave no ${kind === "infer" ? "type" : "normal form"}`, { responses });
    }, { requires: loaded, goal: at?.id });
  }

  private giveAt(
    loaded: Loaded,
    goal: number,
    expression: string,
    inGoalEdit?: { text: string; span: GoalSpan; version: number },
    accepted?: () => void,
  ): Promise<Outcome<GiveValue>> {
    const prepare = inGoalEdit
      ? async () =>
          this.loaded !== loaded || loaded.version !== inGoalEdit.version
            ? refusal("stale-goal", "the snapshot changed after the check was planned; check again")
            : undefined
      : undefined;
    return this.enqueue<GiveValue>(
      "give",
      loaded.basis.path,
      { kind: "give", goal, expression },
      (responses, elapsedMs) => this.finishGive(loaded, goal, expression, responses, elapsedMs, inGoalEdit),
      { prepare, requires: loaded, goal, accepted },
    );
  }

  private finishGive(
    loaded: Loaded,
    goal: number,
    expression: string,
    responses: AgdaResponse[],
    elapsedMs: number,
    inGoalEdit?: { text: string; span: GoalSpan },
  ): Outcome<GiveValue> {
    const { errors } = messagesOf(responses);
    const action = lastOf(responses, "GiveAction");
    const value: GiveValue = { goal, accepted: false, goals: [], newGoals: [] };
    if (errors.length) value.error = errors[0];
    if (action && action.interactionPoint.id === goal && this.loaded === loaded) {
      value.accepted = true;
      // The host's in-goal edit is now Agda's: take it into the snapshot
      // before the give's own edit replaces the goal.
      if (inGoalEdit) {
        const live = loaded.goals.get(goal);
        const delta = inGoalEdit.text.length - loaded.snapshot.length;
        if (live?.span) {
          shiftAfter(loaded.goals, live.span.to, delta);
          live.span = { from: inGoalEdit.span.from, to: inGoalEdit.span.to };
        }
        loaded.snapshot = inGoalEdit.text;
        loaded.version += 1;
      }
      const live = loaded.goals.get(goal);
      const replacement = giveReplacement(expression, action.giveResult);
      if (live?.span) {
        const edit = { from: live.span.from, to: live.span.to, insert: replacement };
        loaded.snapshot = loaded.snapshot.slice(0, edit.from) + replacement + loaded.snapshot.slice(edit.to);
        loaded.version += 1;
        loaded.goals.delete(goal);
        shiftAfter(loaded.goals, edit.to, replacement.length - (edit.to - edit.from));
        value.edit = edit;
      } else loaded.goals.delete(goal);
      // Agda then lists the goals that remain: the old ones keep the
      // ranges of the text it loaded; new ones come from the term.
      const points = lastOf(responses, "InteractionPoints");
      if (points) {
        const listed = new Set(points.interactionPoints.map((point) => point.id));
        for (const id of [...loaded.goals.keys()]) if (!listed.has(id)) loaded.goals.delete(id);
        for (const point of points.interactionPoints)
          if (!loaded.goals.has(point.id)) {
            loaded.goals.set(point.id, { id: point.id });
            value.newGoals.push(point.id);
          }
      }
      this.applyGoalTypes(loaded, responses);
    }
    value.goals = [...loaded.goals.values()].map(view);
    return this.answer(value, responses, elapsedMs, loaded.basis);
  }

  private finishMakeCase(loaded: Loaded, goal: number, responses: AgdaResponse[], elapsedMs: number): Outcome<MakeCaseValue> {
    const { errors } = messagesOf(responses);
    const action = lastOf(responses, "MakeCase");
    const value: MakeCaseValue = { goal, clauses: [], variant: "" };
    if (errors.length) value.error = errors[0];
    if (action && action.interactionPoint.id === goal && this.loaded === loaded) {
      value.clauses = action.clauses;
      value.variant = action.variant;
      const live = loaded.goals.get(goal);
      const edit = live?.span && caseSplitEdit(loaded.snapshot, live.span, action.clauses, action.variant);
      if (edit) {
        const text = loaded.snapshot;
        loaded.snapshot = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
        loaded.version += 1;
        loaded.unchecked = `goal ${goal}'s case split rewrote its clauses, which Agda checks only when it loads them`;
        for (const other of [...loaded.goals.values()])
          if (other.span && other.span.from >= edit.from && other.span.to <= edit.to) loaded.goals.delete(other.id);
        shiftAfter(loaded.goals, edit.to, edit.insert.length - (edit.to - edit.from));
        value.edit = edit;
      }
      loaded.goals.delete(goal);
    }
    return this.answer(value, responses, elapsedMs, loaded.basis);
  }

  private applyGoalTypes(loaded: Loaded, responses: readonly AgdaResponse[]) {
    for (const response of responses) {
      if (response.kind !== "DisplayInfo" || response.info.kind !== "AllGoalsWarnings") continue;
      for (const goal of response.info.visibleGoals) {
        const obj = goal.constraintObj;
        if ("id" in obj && loaded.goals.has(obj.id) && goal.type !== undefined)
          loaded.goals.get(obj.id)!.type = goal.type;
      }
    }
  }

  private async finishLoad(
    path: string,
    read: { text: string; converted: string },
    responses: AgdaResponse[],
    elapsedMs: number,
    live: () => boolean,
  ): Promise<Outcome<LoadValue>> {
    this.generation += 1;
    const digest = sourceDigest(read.converted);
    const basis: SourceBasis = {
      engine: this.engine,
      session: this.id,
      agdaVersion: this.agdaVersion,
      path,
      digest,
      generation: this.generation,
    };
    const { errors, warnings } = messagesOf(responses);
    const loaded: Loaded = {
      basis,
      text: read.text,
      snapshot: read.text,
      goals: new Map(),
      failed: responses.some((response) => response.kind === "DisplayInfo" && response.info.kind === "Error"),
      version: 0,
    };

    // The text must be the one Agda read: a source rewritten while Agda
    // read it leaves no basis to place answers in.  Until it is read back,
    // and unless the load is still the session's then, no load holds.
    let after: string | undefined;
    try {
      after = await this.transport.readSource(path);
    } catch {
      after = undefined;
    }
    if (!live()) return failure("session-ended", `the load of ${path} ended before its source was read back`, { responses });
    if (after === undefined || sourceDigest(after) !== digest)
      return failure("source-changed", `${path} changed while Agda read it; load it again`, { responses });

    const table = new OffsetTable(read.text);
    const points = lastOf(responses, "InteractionPoints");
    for (const point of points?.interactionPoints ?? []) {
      const range = point.range[0];
      const goal: LiveGoal = { id: point.id };
      if (range) {
        goal.agdaRange = range;
        try {
          goal.span = { from: table.fromAgdaPos(range.start.pos), to: table.fromAgdaPos(range.end.pos) };
        } catch {
          // A range outside the text: the goal stays unplaced.
        }
      }
      loaded.goals.set(point.id, goal);
    }
    this.applyGoalTypes(loaded, responses);

    const expansions: TextEdit[] = [];
    if (this.options.expandQuestionMarks) {
      const questions = [...loaded.goals.values()]
        .filter((goal) => goal.span && loaded.snapshot.slice(goal.span.from, goal.span.to) === "?")
        .sort((a, b) => a.span!.from - b.span!.from);
      // First to last: each edit is in the snapshot as the earlier ones
      // leave it, and moves the goals after it.
      for (const goal of questions) {
        const { from, to } = goal.span!;
        loaded.snapshot = loaded.snapshot.slice(0, from) + QUESTION_MARK_GOAL + loaded.snapshot.slice(to);
        shiftAfter(loaded.goals, to, QUESTION_MARK_GOAL.length - (to - from));
        goal.span = { from, to: from + QUESTION_MARK_GOAL.length };
        expansions.push({ from, to, insert: QUESTION_MARK_GOAL });
      }
    }

    this.loaded = loaded;
    const status = lastOf(responses, "Status")?.status;
    const value: LoadValue = {
      goals: [...loaded.goals.values()].map(view),
      errors,
      warnings,
      checking: checkingOf(responses),
      expansions,
    };
    if (status) value.status = status;
    return this.answer(value, responses, elapsedMs, basis);
  }

  private enqueue<T>(
    kind: OperationKind,
    path: string,
    command: Command,
    finish: Operation<T>["finish"],
    {
      prepare,
      requires,
      goal,
      accepted,
    }: {
      prepare?: Operation<T>["prepare"];
      requires?: Loaded;
      goal?: number;
      /** Runs in this tick once the operation is queued. */
      accepted?: () => void;
    } = {},
  ): Promise<Outcome<T>> {
    if (this.ended || this.stopping) return Promise.resolve(refusal("session-ended", "the session has ended"));
    // The bound is on what waits behind a running operation.
    if (this.current && this.queue.length >= this.options.maxQueue)
      return Promise.resolve(
        refusal("busy", `${this.queue.length} operations are already waiting; try again when they have run`),
      );
    const outcome = new Promise<Outcome<T>>((resolve) => {
      this.operationCounter += 1;
      const op: Operation<T> = {
        id: this.operationCounter,
        kind,
        path,
        command,
        deadlineMs: this.options.deadlines[kind],
        prepare,
        requires,
        goal,
        finish,
        // Only a batch operation settles with a verdict.
        resolve: resolve as Operation<T>["resolve"],
        responses: [],
        problems: [],
        sent: false,
        reading: false,
        startedAt: 0,
        settled: false,
      };
      this.queue.push(op as Operation<unknown>);
    });
    accepted?.();
    this.emitStatus();
    void this.pump();
    return outcome;
  }

  private enqueueBatch(path: string, batch: BatchOperation): Promise<VerdictOutcome> {
    if (this.ended || this.stopping) return Promise.resolve(refusal("session-ended", "the session has ended"));
    if (this.current && this.queue.length >= this.options.maxQueue)
      return Promise.resolve(
        refusal("busy", `${this.queue.length} operations are already waiting; try again when they have run`),
      );
    const outcome = new Promise<VerdictOutcome>((resolve) => {
      this.operationCounter += 1;
      const op: Operation<unknown> = {
        id: this.operationCounter,
        kind: "verdict",
        path,
        batch,
        deadlineMs: this.options.deadlines.verdict,
        finish: () => failure("protocol", "a batch run reads no responses"),
        resolve: resolve as Operation<unknown>["resolve"],
        responses: [],
        problems: [],
        sent: false,
        reading: false,
        startedAt: 0,
        settled: false,
      };
      this.queue.push(op);
    });
    this.emitStatus();
    void this.pump();
    return outcome;
  }

  /** Run a batch operation that has reached the head of the queue: it
   * stays the current operation until its Agda is gone and its file is
   * put back, however it ends (a deadline or an abort stops its Agda; the
   * session's end settles it at once and stops its Agda too). */
  private async runBatch(op: Operation<unknown>) {
    const batch = op.batch!;
    const started = await batch.start();
    if (!("done" in started)) return this.settle(op, started);
    batch.handle = started;
    // A deadline, an abort or the session's end while it started.
    if (op.settled || op.abortCause) void started.stop();
    const run = await started.done;
    const outcome = await batch.finish(run);
    if (op.settled) return;
    if (op.abortCause === "timeout")
      return this.settle(
        op,
        failure("timeout", `the verdict on ${op.path} outran its deadline of ${op.deadlineMs} ms, and its Agda was stopped`, {
          detail: { terminated: true, lane: "batch" },
        }),
      );
    if (op.abortCause === "caller") return this.settle(op, failure("aborted", `the verdict on ${op.path} was aborted`));
    this.settle(op, outcome);
  }

  private async pump() {
    if (this.current || this.ended || this.stopping) return;
    const op = this.queue.shift();
    if (!op) {
      this.emitStatus();
      return;
    }
    this.current = op;
    op.startedAt = performance.now();
    op.timer = setTimeout(() => this.expire(op), op.deadlineMs);
    this.emitStatus();
    if (op.requires && this.loaded !== op.requires)
      return this.settle(
        op,
        refusal(
          "stale-goal",
          `the ${op.kind} was asked about load ${op.requires.basis.generation} of ${op.requires.basis.path}, which ${
            this.loaded ? `load ${this.loaded.basis.generation} of ${this.loaded.basis.path} replaced` : "Agda no longer holds"
          } while it waited; ask again`,
        ),
      );
    if (op.requires && op.goal !== undefined && !op.requires.goals.has(op.goal))
      return this.settle(op, refusal("unknown-goal", `goal ${op.goal} was closed while the ${op.kind} waited`));
    if (op.prepare) {
      let stop: Refusal | Failure | undefined;
      try {
        stop = await op.prepare();
      } catch (error) {
        stop = failure("io", `the operation could not be prepared (${String(error)})`);
      }
      if (op.settled) return;
      if (stop) return this.settle(op, stop);
    }
    if (this.ended || this.stopping || op.settled) return;
    if (op.batch) {
      op.sent = true;
      const running: Promise<void> = this.runBatch(op)
        .catch((error) => this.settle(op, failure("io", `the verdict on ${op.path} failed (${String(error)})`)))
        .finally(() => {
          if (this.batchRunning === running) this.batchRunning = undefined;
        });
      this.batchRunning = running;
      return;
    }
    // From here Agda's state is the new load's, whatever comes of it: no
    // load holds until its answer is read.
    if (op.kind === "load") this.loaded = undefined;
    op.sent = true;
    try {
      this.transport.send(iotcm(op.path, op.command!, this.options.highlighting));
    } catch (error) {
      this.settle(op, failure("session-ended", `the command could not be sent (${String(error)})`));
    }
  }

  private settle(op: Operation<unknown>, outcome: Outcome<unknown> | Verdict) {
    if (op.settled) return;
    op.settled = true;
    clearTimeout(op.timer);
    clearTimeout(op.graceTimer);
    if (this.current === op) this.current = undefined;
    op.resolve(outcome);
    this.emitStatus();
    void this.pump();
  }

  private expire(op: Operation<unknown>) {
    if (op.settled || this.current !== op) return;
    if (!op.sent) {
      // A source still being written may yet be; the next load's read-back
      // would see it.
      this.settle(op, failure("timeout", `the ${op.kind} did not start within ${op.deadlineMs} ms`));
      return;
    }
    if (op.batch) {
      // The run's Agda is stopped; the operation ends once it is gone and
      // its file is put back.
      op.abortCause = "timeout";
      void op.batch.handle?.stop();
      return;
    }
    if (op.reading) {
      // Agda has ended the command; the host has not read its answer back.
      this.settle(
        op,
        failure("timeout", `the answer to the ${op.kind} was not read within its deadline of ${op.deadlineMs} ms`, {
          responses: op.responses,
        }),
      );
      return;
    }
    op.abortCause = "timeout";
    this.transport.abort(iotcm(op.path, { kind: "abort" }, "None"));
    op.graceTimer = setTimeout(() => {
      if (op.settled) return;
      // Agda did not end the command: stop it, and report it stopped only
      // once it is gone.
      this.stopping = true;
      this.stopCause = { reason: "timeout", operation: op.kind };
      this.emitStatus();
      const stopped = () => this.end(this.stopCause!);
      void this.transport.terminate().then(stopped, stopped);
    }, this.options.abortGraceMs);
  }

  private end(detail: Record<string, unknown>) {
    if (this.ended) return;
    this.ended = true;
    this.endDetail = detail;
    this.loaded = undefined;
    const current = this.current;
    const waiting = this.queue.splice(0);
    // Who ended it: the session at a deadline, the host, or Agda itself.
    const killed = this.stopCause?.reason === "timeout";
    const disposed = detail.reason === "disposed";
    const ended = disposed ? "the session was closed" : "Agda stopped";
    // A batch run outlives nothing: its Agda is stopped, and its file put
    // back once that Agda is gone.
    if (current?.batch) void current.batch.handle?.stop();
    if (current) {
      this.settle(
        current,
        killed && current.abortCause === "timeout"
          ? failure("timeout", `the ${current.kind} outran its deadline of ${current.deadlineMs} ms, and Agda was stopped`, {
              responses: current.responses,
              detail: { terminated: true, ...detail },
            })
          : current.abortCause === "timeout"
            ? failure("timeout", `the ${current.kind} outran its deadline of ${current.deadlineMs} ms, and ${ended} while it was aborted`, {
                responses: current.responses,
                detail: { terminated: false, ...detail },
              })
            : failure("session-ended", `${ended} during the ${current.kind}`, { responses: current.responses, detail }),
      );
    }
    for (const op of waiting) this.settle(op, failure("session-ended", `${ended} before the ${op.kind} ran`, { detail }));
    this.emitStatus();
  }

  private onEvent(event: TransportEvent) {
    // While a batch run is current, the lane has nothing in flight.
    const op = this.current?.batch ? undefined : this.current;
    switch (event.type) {
      case "response": {
        const parsed = parseResponse(event.json);
        if (!op || !op.sent) return; // Nothing asked: not an answer to anything.
        if (!parsed.ok) {
          op.problems.push(parsed.error);
          return;
        }
        op.responses.push(parsed.response);
        const answered = {
          operation: { id: op.id, kind: op.kind, path: op.path, command: op.command! },
          response: parsed.response,
        };
        for (const listener of this.responseListeners) heard(() => listener(answered));
        return;
      }
      case "noise":
        if (op?.sent) op.problems.push(`unexpected output: ${event.text}`);
        return;
      case "end":
        // Once Agda is being stopped, its exit ends the operation.
        if (op?.sent && !this.stopping) void this.complete(op);
        return;
      case "exit":
        this.end({
          reason: "exit",
          code: event.code,
          ...(event.signal ? { signal: event.signal } : {}),
          ...(event.detail ? { detail: event.detail } : {}),
          // When the session stopped Agda, why.
          ...(this.stopCause ?? {}),
        });
        return;
    }
  }

  private async complete(op: Operation<unknown>) {
    // An end while the answer is read is not this command's.
    if (op.settled || op.reading) return;
    const elapsedMs = performance.now() - op.startedAt;
    const aborted = op.abortCause !== undefined || op.responses.some((response) => response.kind === "DoneAborting");
    if (aborted) {
      // Agda restores its state and forgets its file on an abort.
      this.loaded = undefined;
      return this.settle(
        op,
        op.abortCause === "timeout"
          ? failure("timeout", `the ${op.kind} outran its deadline of ${op.deadlineMs} ms and was aborted`, {
              responses: op.responses,
              detail: { terminated: false },
            })
          : failure("aborted", `the ${op.kind} was aborted`, { responses: op.responses }),
      );
    }
    if (op.problems.length) {
      this.forgetAfter(op);
      return this.settle(
        op,
        failure("protocol", `Agda's answer to the ${op.kind} was malformed: ${op.problems.join("; ")}`, {
          responses: op.responses,
        }),
      );
    }
    // The command is over; its deadline still bounds reading the answer.
    op.reading = true;
    const live = () => !op.settled && this.current === op && !this.ended;
    let outcome: Outcome<unknown>;
    try {
      outcome = await op.finish(op.responses, elapsedMs, live);
    } catch (error) {
      this.forgetAfter(op);
      outcome = failure("protocol", `Agda's answer to the ${op.kind} could not be read (${String(error)})`, {
        responses: op.responses,
      });
    }
    this.settle(op, outcome);
  }

  /** An operation that changes Agda's file and whose answer could not be
   * read leaves the snapshot unknown: no load holds. */
  private forgetAfter(op: Operation<unknown>) {
    if (op.kind === "load" || op.kind === "give" || op.kind === "refine" || op.kind === "makeCase")
      this.loaded = undefined;
  }

  private emitStatus() {
    const status = this.status;
    for (const listener of this.statusListeners) heard(() => listener(status));
  }

  /** Why the session ended, once it has. */
  get ending(): Record<string, unknown> | undefined {
    return this.endDetail;
  }
}

/** Open a session over a started transport: ask Agda its version. */
export async function openSession(
  transport: EngineTransport,
  options: SessionOptions = {},
): Promise<{ kind: "session"; session: AgdaSession } | Failure> {
  const session = new AgdaSession(transport, options);
  const started = await session.start();
  if (started.kind === "answer") return { kind: "session", session };
  await session.dispose();
  return started.kind === "failure"
    ? failure("startup", `Agda did not answer: ${started.message}`, { detail: { cause: started.reason } })
    : failure("startup", `Agda could not be asked: ${started.message}`);
}
