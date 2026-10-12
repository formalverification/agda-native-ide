// File: packages/engine/src/conformance/index.ts
//
// One conformance suite for every engine: the same scenarios and the same
// assertions, run through the engine interface alone, against a real
// Agda (the reactor in headless Chromium, `agda --interaction-json` under
// node).  A target opens fresh sessions and writes the fixtures where its
// Agda reads them; nothing else differs.  Each scenario also records a
// transcript of what Agda answered, with host paths and session names
// replaced by placeholders, so that two engines' runs can be compared
// field by field, and the runners archive it.
//
// Faults whose resources a runner owns (a startup that fails, a deadline,
// a crash, the disposal of a worker or a child) are the runners' own
// checks, beside this suite (scripts/conformance/).

import type { AgdaSession } from "../core/session.js";
import type { Answer, Failure, Outcome } from "../core/outcome.js";
import { sourceDigest } from "../core/text.js";
import { CRLF, FIXTURES, GOALS, LITERATE, SECOND, UNICODE } from "./fixtures.js";

export { FIXTURES, SLOW_TERM } from "./fixtures.js";

/** One engine under test. */
export interface ConformanceTarget {
  engine: "browser" | "native";
  /** Open a fresh session, with the fixtures written. */
  open(): Promise<OpenedTarget | Failure>;
}

export interface OpenedTarget {
  session: AgdaSession;
  /** A fixture's path as Agda knows it. */
  path(relative: string): string;
  /** The engine's prefix of those paths, ending in "/". */
  root: string;
  close(): Promise<void>;
}

export interface ScenarioResult {
  name: string;
  ok: boolean;
  error?: string;
  elapsedMs: number;
  transcript: unknown;
}

export interface ConformanceReport {
  engine: "browser" | "native";
  agdaVersion: string;
  fixtures: Record<string, string>;
  scenarios: ScenarioResult[];
  passed: number;
  failed: number;
}

class Mismatch extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Mismatch(message);
}

function equal(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${what}: expected ${e}, got ${a}`);
}

function answered<T>(outcome: Outcome<T>, what: string): Answer<T> {
  check(outcome.kind === "answer", `${what}: expected Agda's answer, got ${JSON.stringify(outcome)}`);
  return outcome;
}

type Context = OpenedTarget & { normalize: (value: unknown) => unknown };

interface Scenario {
  name: string;
  run(context: Context): Promise<unknown>;
}

const scenarios: Scenario[] = [
  {
    name: "a session names its engine and Agda, and has no verdict to give",
    async run({ session }) {
      equal(session.agdaVersion, "2.9.0", "Agda's version");
      check(session.capabilities.interaction.supported, "the interaction lane is supported");
      check(!session.capabilities.batch.supported, "the batch lane is not");
      const verdict = await session.checkFile();
      equal(verdict.kind, "refusal", "a verdict is refused");
      equal(verdict.reason, "unsupported-capability", "for want of the batch lane");
      check(!("verdict" in verdict), "a refusal carries no verdict field");
      check(/#(30|64)\b/.test(verdict.message), `the refusal names the issue: ${verdict.message}`);
      return { agdaVersion: session.agdaVersion, batch: session.capabilities.batch.supported };
    },
  },
  {
    name: "a load with open goals answers them, and is not a verdict",
    async run({ session, path, normalize }) {
      const load = answered(await session.load(path("Goals.agda"), GOALS), "load");
      equal(load.lane, "interaction", "the lane");
      check(!("verdict" in load) && !("verdict" in load.value), "a load carries no verdict");
      equal(load.basis?.digest, sourceDigest(GOALS), "the basis names the text Agda read");
      equal(load.basis?.generation, 1, "the first load");
      equal(load.value.errors, [], "no errors");
      check(load.value.checking.includes("Goals"), `Goals was checked: ${load.value.checking}`);
      equal(load.value.goals.map((goal) => goal.id), [0, 1], "the goals' numbers");
      equal(load.value.goals.map((goal) => goal.type), ["A", "suc n + 0 ≡ suc n"], "the goals' types");
      const snapshot = session.snapshot!;
      equal(
        load.value.goals.map((goal) => snapshot.slice(goal.span!.from, goal.span!.to)),
        ["{! !}", "{!  !}"],
        "the goals' text, with the ? shown as a goal",
      );
      equal(load.value.expansions.length, 1, "one ? expanded");
      // Agda's own flag: the module has open goals, so it is not checked.
      equal(load.value.status?.checked, false, "Agda's status");
      return normalize({
        goals: load.value.goals,
        checking: load.value.checking,
        status: load.value.status,
        digest: load.basis?.digest,
      });
    },
  },
  {
    name: "Agda's goal type and context",
    async run({ session, path, normalize }) {
      answered(await session.load(path("Goals.agda"), GOALS), "load");
      const goal = answered(await session.goal(session.goalRef(0)!), "goal 0");
      equal(goal.value.type, "A", "goal 0's type");
      equal(
        goal.value.context.map((entry) => [entry.name, entry.type, entry.inScope]),
        [
          ["A", "Set", false],
          ["x", "A", true],
        ],
        "goal 0's context",
      );
      // Normalised, as asked: the goal list shows the type as it is.
      const second = answered(await session.goal(session.goalRef(1)!), "goal 1");
      equal(second.value.type, "suc (n + 0) ≡ suc n", "goal 1's normalised type");
      return normalize({ goal0: goal.value, goal1: second.value });
    },
  },
  {
    name: "a valid give edits the goal and keeps the loaded basis",
    async run({ session, path, normalize }) {
      const load = answered(await session.load(path("Goals.agda"), GOALS), "load");
      const give = answered(await session.give(session.goalRef(0)!, "x"), "give");
      equal(give.value.accepted, true, "Agda took the term");
      equal(give.value.edit?.insert, "x", "the replacement");
      equal(give.basis, load.basis, "the basis is the load's");
      equal(session.snapshot, GOALS.replace("{! !}", "x").replace("= ?", "= {!  !}"), "the snapshot");
      equal(give.value.goals.map((goal) => goal.id), [1], "goal 1 remains");
      // Agda still places goal 1 in the text it loaded.
      const remaining = answered(await session.goal(session.goalRef(1)!), "goal 1 after the give");
      equal(remaining.value.type, "suc (n + 0) ≡ suc n", "goal 1's normalised type");
      return normalize({ give: give.value, remaining: remaining.value.type });
    },
  },
  {
    name: "a rejected term is Agda's answer, and leaves the goal open",
    async run({ session, path, normalize }) {
      answered(await session.load(path("Goals.agda"), GOALS), "load");
      const give = answered(await session.give(session.goalRef(0)!, "zero"), "give");
      equal(give.value.accepted, false, "Agda refused the term");
      check(/error: \[UnequalTypes\]/.test(give.value.error ?? ""), `with its error: ${give.value.error}`);
      check(session.goalRef(0) !== undefined, "goal 0 is still open");
      equal(session.snapshot, GOALS.replace("= ?", "= {!  !}"), "the snapshot is unchanged");
      return normalize({ accepted: give.value.accepted, error: give.value.error });
    },
  },
  {
    name: "an edit inside one goal is a give; any other edit is a reload, which retires the old goals",
    async run({ session, path, normalize }) {
      const file = path("Goals.agda");
      const first = answered(await session.check(file, GOALS), "first check");
      equal(first.value.plan, "load", "the first check loads");
      const unchanged = answered(await session.check(file, session.snapshot!), "check again");
      equal(unchanged.value.plan, "unchanged", "nothing to send");
      const old = session.goalRef(0)!;
      const inGoal = session.snapshot!.replace("{! !}", "{! x !}");
      const give = answered(await session.check(file, inGoal), "an edit in goal 0");
      check(give.value.plan === "give" && give.value.give.accepted, "the edit is given");
      const declaration = `${session.snapshot!}\nanswer : Nat\nanswer = 42\n`;
      const reload = answered(await session.check(file, declaration), "a new declaration");
      check(reload.value.plan === "load", "a declaration reloads");
      equal(reload.basis?.generation, 2, "a second load");
      const refused = await session.goal(old);
      equal(refused.kind === "refusal" && refused.reason, "stale-goal", "the old goal is refused");
      return normalize({ plans: [first.value.plan, unchanged.value.plan, give.value.plan, reload.value.plan], refused });
    },
  },
  {
    name: "a module switch cannot reuse the previous module's goals",
    async run({ session, path, normalize }) {
      answered(await session.load(path("Goals.agda"), GOALS), "load Goals");
      const goalsRef = session.goalRef(1)!;
      const second = answered(await session.load(path("Second.agda"), SECOND), "load Second");
      equal(second.value.goals.map((goal) => [goal.id, goal.type]), [[0, "Nat"]], "Second's goal");
      const refused = await session.goal(goalsRef);
      equal(refused.kind === "refusal" && refused.reason, "stale-goal", "Goals' goal is refused");
      const goal = answered(await session.goal(session.goalRef(0)!), "Second's goal 0");
      equal(
        goal.value.context.map((entry) => [entry.name, entry.type]),
        [["c", "Colour"]],
        "its context",
      );
      const inferred = answered(await session.infer("choose red"), "infer at the top level");
      equal(inferred.value.expression, "Nat", "the type of choose red");
      return normalize({ second: second.value.goals, refused, goal: goal.value, inferred: inferred.value });
    },
  },
  {
    name: "a case split rewrites the clause, which a check then loads; a refine opens a goal",
    async run({ session, path, normalize }) {
      const file = path("Second.agda");
      answered(await session.load(file, SECOND), "load");
      const split = answered(await session.makeCase(session.goalRef(0)!, "c"), "case split");
      equal(split.value.clauses, ["choose red = ?", "choose green = ?"], "Agda's clauses");
      equal(
        session.snapshot,
        SECOND.replace("choose c = {! !}", "choose red = ?\nchoose green = ?"),
        "the clauses replace the goal's line",
      );
      const reload = answered(await session.check(file, session.snapshot!), "check the split");
      check(reload.value.plan === "load", "Agda has not checked the clauses, so the check loads them");
      equal(reload.value.load.goals.map((goal) => [goal.id, goal.type]), [[0, "Nat"], [1, "Nat"]], "two goals");
      const refine = answered(await session.refine(session.goalRef(1)!, "suc"), "refine");
      equal(refine.value.accepted, true, "Agda took suc");
      equal(refine.value.newGoals.length, 1, "it opened one goal");
      check(session.snapshot!.includes("choose green = suc ?"), `the snapshot: ${session.snapshot}`);
      return normalize({ clauses: split.value.clauses, refine: refine.value });
    },
  },
  {
    name: "positions in Unicode text, and terms outside ASCII",
    async run({ session, path, normalize }) {
      const load = answered(await session.load(path("Unicode.agda"), UNICODE), "load");
      const [goal] = load.value.goals;
      equal(UNICODE.slice(goal.span!.from, goal.span!.to), "{! !}", "the goal's text");
      // Agda counts code points: 𝕓 is one, and two UTF-16 units.
      equal(goal.agdaRange?.start.col, 13, "Agda's column");
      equal(goal.span!.from, UNICODE.indexOf("{! !}"), "the UTF-16 offset");
      equal(goal.type, "𝔹", "the goal's type");
      const give = answered(await session.give(session.goalRef(goal.id)!, "f (f 𝕓)"), "give");
      equal(give.value.accepted, true, "Agda took the term");
      equal(session.snapshot, UNICODE.replace("{! !}", "f (f 𝕓)"), "the snapshot");
      const normal = answered(await session.normalize("not (not 𝕥)"), "normalize");
      equal(normal.value.expression, "𝕥", "the normal form");
      const inferred = answered(await session.infer("twice not"), "infer");
      equal(inferred.value.expression, "𝔹 → 𝔹", "the type");
      return normalize({ goal, give: give.value, normal: normal.value, inferred: inferred.value });
    },
  },
  {
    name: "positions in a text whose line ends are CR LF, which Agda reads as LF",
    async run({ session, path, normalize }) {
      const load = answered(await session.load(path("Crlf.agda"), CRLF), "load");
      equal(load.value.errors, [], "no errors");
      const [first, second] = load.value.goals;
      // Agda's count is one fewer per line end before the goal.
      equal(first.agdaRange?.start.pos, CRLF.indexOf("{! !}") + 1 - 7, "Agda's position");
      equal(first.span!.from, CRLF.indexOf("{! !}"), "the first goal's UTF-16 offset");
      equal(second.span!.from, CRLF.lastIndexOf("{! !}"), "the second goal's UTF-16 offset");
      const give = answered(await session.give(session.goalRef(first.id)!, "zero"), "give");
      equal(give.value.accepted, true, "Agda took the term");
      const snapshot = CRLF.replace("{! !}", "zero");
      equal(session.snapshot, snapshot, "the snapshot");
      const [left] = give.value.goals;
      equal(snapshot.slice(left.span!.from, left.span!.to), "{! !}", "the other goal, moved by the give");
      const refine = answered(await session.give(session.goalRef(left.id)!, "n"), "the other give");
      equal(refine.value.accepted, true, "Agda took that term too");
      equal(session.snapshot, snapshot.replace("{! !}", "n"), "the snapshot after both");
      return normalize({ goals: load.value.goals, give: give.value, other: refine.value });
    },
  },
  {
    name: "a literate module: goals in its code, none in its prose",
    async run({ session, path, normalize }) {
      const load = answered(await session.load(path("Literate.lagda.md"), LITERATE), "load");
      equal(load.value.goals.length, 1, "one goal");
      const [goal] = load.value.goals;
      equal(goal.type, "Nat", "its type");
      equal(goal.span!.from, LITERATE.indexOf("{! !}\n```"), "the code's goal, not the prose's");
      check(load.value.checking.includes("Literate"), "Literate was checked");
      const give = answered(await session.give(session.goalRef(goal.id)!, "n + n"), "give");
      equal(give.value.accepted, true, "Agda took the term");
      equal(session.snapshot, LITERATE.replace("{! !}\n```", "n + n\n```"), "the snapshot");
      const normal = answered(await session.normalize("double 21"), "normalize");
      equal(normal.value.expression, "42", "the given term computes");
      return normalize({ goal, give: give.value, normal: normal.value });
    },
  },
  {
    name: "an abort with nothing running is nothing",
    async run({ session }) {
      equal(session.abort(), { aborting: undefined }, "nothing to abort");
      const version = answered(await session.version(), "version");
      equal(version.value.version, "2.9.0", "the session answers");
      return { aborting: null };
    },
  },
];

/** Run every scenario, each in a session of its own. */
export async function runConformance(
  target: ConformanceTarget,
  log: (line: string) => void = () => {},
): Promise<ConformanceReport> {
  const report: ConformanceReport = {
    engine: target.engine,
    agdaVersion: "",
    fixtures: Object.fromEntries(Object.entries(FIXTURES).map(([name, text]) => [name, sourceDigest(text)])),
    scenarios: [],
    passed: 0,
    failed: 0,
  };
  for (const scenario of scenarios) {
    const started = performance.now();
    const result: ScenarioResult = { name: scenario.name, ok: false, elapsedMs: 0, transcript: null };
    const opened = await target.open();
    if ("kind" in opened && opened.kind === "failure") {
      result.error = `the session did not open: ${opened.message}`;
    } else {
      const target = opened as OpenedTarget;
      report.agdaVersion = target.session.agdaVersion;
      const sessionId = target.session.id;
      const normalize = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value)
            .split(target.root)
            .join("<root>/")
            .split(sessionId)
            .join("<session>"),
        );
      try {
        result.transcript = await scenario.run({ ...target, normalize });
        result.ok = true;
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      } finally {
        await target.close();
      }
    }
    result.elapsedMs = Math.round(performance.now() - started);
    report.scenarios.push(result);
    if (result.ok) report.passed += 1;
    else report.failed += 1;
    log(`${result.ok ? "ok  " : "FAIL"} ${scenario.name} (${result.elapsedMs} ms)${result.error ? `: ${result.error}` : ""}`);
  }
  return report;
}

/** The scenarios' names, in order. */
export const scenarioNames = scenarios.map((scenario) => scenario.name);

export { Mismatch };
