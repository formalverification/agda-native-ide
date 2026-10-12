// File: packages/tools/src/index.test.ts
//
// The tool surface's contract, over a session whose transport a script
// answers as Agda did (the conformance suite runs the real engines): how
// a goal is addressed, what names the tree, and what is refused.

import { describe, expect, it } from "vitest";
import {
  openSession,
  sourceDigest,
  type BatchHandle,
  type BatchRun,
  type Capabilities,
  type EngineTransport,
  type TransportEvent,
} from "@agda-native-ide/engine";

import { CHECK_MEANING, FILL_MEANING, createToolSurface, tools } from "./index.js";

const PATH = "/work/Two.agda";
const TEXT = "module Two where\n\nf : Set → Set\nf x = {! !}\n\ng : Set\ng = {! !}\n";
const range = (line: number, col: number, pos: number) => [
  { start: { pos, line, col }, end: { pos: pos + 5, line, col: col + 5 } },
];
const goals = [
  { id: 0, range: range(4, 7, 39) },
  { id: 1, range: range(7, 5, 58) },
];

class Scripted implements EngineTransport {
  readonly engine: "browser" | "native" = "browser";
  capabilities: Capabilities = {
    interaction: { supported: true },
    batch: { supported: false, reason: "the page's batch lane is issue #30" },
  };
  readonly sent: string[] = [];
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  files = new Map<string, string>();
  subscribe(listener: (event: TransportEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private answer(responses: unknown[]) {
    for (const json of responses) for (const listener of this.listeners) listener({ type: "response", json });
    for (const listener of this.listeners) listener({ type: "end" });
  }
  send(line: string) {
    this.sent.push(line);
    queueMicrotask(() => {
      if (line.includes("Cmd_show_version"))
        return this.answer([{ kind: "DisplayInfo", info: { kind: "Version", version: "2.9.0" } }]);
      if (line.includes("Cmd_load"))
        return this.answer([{ kind: "InteractionPoints", interactionPoints: goals }]);
      const goal = /Cmd_goal_type_context Normalised (\d+)/.exec(line);
      if (goal)
        return this.answer([
          {
            kind: "DisplayInfo",
            info: {
              kind: "GoalSpecific",
              interactionPoint: { id: Number(goal[1]), range: goals[Number(goal[1])].range },
              goalInfo: {
                kind: "GoalType",
                rewrite: "Normalised",
                type: "Set",
                entries: [{ originalName: "x", reifiedName: "x", binding: "Set", inScope: true }],
                typeAux: { kind: "GoalOnly" },
                boundary: [],
                outputForms: [],
              },
            },
          },
        ]);
      if (line.includes("Cmd_infer_toplevel"))
        return this.answer([{ kind: "DisplayInfo", info: { kind: "InferredType", expr: "Set → Set" } }]);
      if (line.includes("Cmd_compute"))
        return this.answer([
          { kind: "DisplayInfo", info: { kind: "Error", error: { message: "Not in scope: h" }, warnings: [] } },
        ]);
      this.answer([]);
    });
  }
  abort() {}
  resolvePath(relative: string) {
    return `/work/${relative}`;
  }
  async writeSource(path: string, text: string) {
    this.files.set(path, text);
  }
  async readSource(path: string) {
    return this.files.get(path);
  }
  async terminate() {}
}

/** Scripted, with a batch lane that answers as Agda would: 0 for a text
 * with no goal, 42 with the goals' error for one with goals, and 42 with a
 * type error for a text that gives `Set` a term of another type. */
class Batched extends Scripted {
  override readonly engine = "native" as const;
  readonly runs: string[] = [];
  constructor() {
    super();
    this.capabilities = { interaction: { supported: true }, batch: { supported: true } };
  }
  runBatch(path: string): BatchHandle {
    const text = this.files.get(path) ?? "";
    this.runs.push(text);
    const run: BatchRun = /\bzero\b/.test(text)
      ? { exitCode: 42, stdout: `${path}:4.7-11: error: [UnequalTypes]\nNat !=< Set\n`, stderr: "", elapsedMs: 9 }
      : text.includes("{!")
        ? { exitCode: 42, stdout: `${path}:7.5-10: error: [UnsolvedInteractionMetas]\nUnsolved interaction metas at the following locations:\n  ${path}:7.5-10\n`, stderr: "", elapsedMs: 9 }
        : { exitCode: 0, stdout: "", stderr: "", elapsedMs: 9 };
    return { command: { executable: "/bin/agda", args: [path], cwd: "/work" }, done: Promise.resolve(run), stop: async () => {} };
  }
}

async function prepared(transport: Scripted = new Scripted()) {
  const opened = await openSession(transport);
  if (opened.kind !== "session") throw new Error(opened.message);
  await opened.session.load(PATH, TEXT);
  return { transport, session: opened.session, tools: createToolSurface(opened.session) };
}

describe("the tool surface", () => {
  it("describes each tool with a JSON Schema", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["get_goal", "type_of", "normalize", "fill_hole", "check_file"]);
    const getGoal = tools.find((tool) => tool.name === "get_goal")!;
    expect(getGoal.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys(getGoal.inputSchema.properties as object)).toEqual(["goal", "line", "column", "rewrite"]);
  });

  it("answers get_goal by number, naming the tree and no verdict", async () => {
    const { tools: surface, session } = await prepared();
    const answer = await surface.get_goal({ goal: 1 });
    expect(answer).toMatchObject({
      status: "answer",
      lane: "interaction",
      addressed: { goal: 1, line: 7, col: 5, resolvedBy: "number" },
      result: { goal: 1, type: "Set" },
      tree: { engine: "browser", file: PATH, generation: 1, session: session.id, agdaVersion: "2.9.0" },
    });
    expect(JSON.stringify(answer)).not.toContain("verdict");
  });

  it("finds a goal by a position inside it, and refuses one outside every goal", async () => {
    const { tools: surface } = await prepared();
    expect(await surface.get_goal({ line: 4, column: 9 })).toMatchObject({
      status: "answer",
      addressed: { goal: 0, resolvedBy: "span" },
    });
    expect(await surface.get_goal({ line: 4, column: 1 })).toMatchObject({
      status: "refused",
      reason: "no-goal-at-position",
    });
  });

  it("asks for a goal when the file has two, and refuses a mixed address", async () => {
    const { tools: surface } = await prepared();
    expect(await surface.get_goal({})).toMatchObject({ status: "refused", reason: "invalid-input" });
    expect(await surface.get_goal({ goal: 0, line: 4 })).toMatchObject({ status: "refused", reason: "invalid-input" });
    expect(await surface.get_goal({ goal: 7 })).toMatchObject({ status: "refused", reason: "unknown-goal" });
  });

  it("refuses input its schema does not admit, before asking Agda", async () => {
    const { tools: surface, transport } = await prepared();
    const before = transport.sent.length;
    expect(await surface.call("type_of", { expression: "" })).toMatchObject({ status: "refused", reason: "invalid-input" });
    expect(await surface.call("get_goal", { goal: 0, extra: true })).toMatchObject({ status: "refused", reason: "invalid-input" });
    expect(transport.sent.length).toBe(before);
  });

  it("answers type_of at the top level", async () => {
    const { tools: surface } = await prepared();
    expect(await surface.type_of({ expression: "f" })).toMatchObject({
      status: "answer",
      result: { type: "Set → Set" },
    });
  });

  it("reports Agda's error about an expression as its answer", async () => {
    const { tools: surface } = await prepared();
    const answer = await surface.normalize({ expression: "h", goal: 0 });
    expect(answer).toMatchObject({ status: "answer", result: { goal: 0, error: "Not in scope: h" } });
  });

  it("refuses the verdict tools for want of a batch lane", async () => {
    const { tools: surface } = await prepared();
    for (const name of ["fill_hole", "check_file"]) {
      const answer = await surface.call(name, {});
      expect(answer).toMatchObject({ status: "refused", reason: "unsupported-capability", capability: "batch" });
      expect(answer.status === "refused" && answer.message).toMatch(/#30/);
      expect("verdict" in answer).toBe(false);
    }
  });

  it("answers check_file with the batch lane's verdict on the loaded file", async () => {
    const transport = new Batched();
    const { tools: surface } = await prepared(transport);
    const answer = await surface.check_file();
    expect(answer).toMatchObject({
      tool: "check_file",
      status: "verdict",
      lane: "batch",
      tree: { engine: "native", agdaVersion: "2.9.0", file: PATH, digest: sourceDigest(TEXT) },
      command: { executable: "/bin/agda", args: [PATH], cwd: "/work" },
      verdict: { exitCode: 42, equivalentTo: `cd /work && /bin/agda ${PATH}`, meaning: CHECK_MEANING },
      result: { success: false, diagnostics: [{ code: "UnsolvedInteractionMetas" }] },
    });
    expect(CHECK_MEANING).not.toMatch(/\u2014/);
    expect(await surface.call("check_file", { file: PATH, extra: 1 })).toMatchObject({ status: "refused", reason: "invalid-input" });
  });

  it("answers fill_hole with a verdict on the candidate in place, and puts the file back", async () => {
    const transport = new Batched();
    const { tools: surface } = await prepared(transport);
    const ok = await surface.fill_hole({ goal: 0, candidate: "x" });
    // Goal 1 is still open, which is all the run failed on: the candidate is ok.
    expect(ok).toMatchObject({
      status: "verdict",
      lane: "batch",
      addressed: { goal: 0, resolvedBy: "number" },
      verdict: { exitCode: 42, meaning: FILL_MEANING },
      result: { status: "ok", candidate: "x", success: false },
    });
    expect(ok.status === "verdict" && ok.verdict.equivalentTo).toMatch(/with the candidate written over goal 0 \(the file on disk is put back/);
    expect(transport.runs.at(-1)).toBe(TEXT.replace("f x = {! !}", "f x = x"));
    expect(transport.files.get(PATH)).toBe(TEXT);
    const wrong = await surface.fill_hole({ line: 7, column: 6, candidate: "zero" });
    expect(wrong).toMatchObject({ addressed: { goal: 1, resolvedBy: "span" }, result: { status: "type_error" } });
    expect(transport.files.get(PATH)).toBe(TEXT);
  });

  it("refuses fill_hole when the file is not the text the goal was found in", async () => {
    const transport = new Batched();
    const { tools: surface } = await prepared(transport);
    transport.files.set(PATH, `${TEXT}-- edited\n`);
    expect(await surface.fill_hole({ goal: 0, candidate: "x" })).toMatchObject({ status: "failed", reason: "source-changed" });
    expect(transport.runs).toEqual([]);
    expect(await surface.call("fill_hole", { goal: 0 })).toMatchObject({ status: "refused", reason: "invalid-input" });
  });

  it("refuses a tool it does not have, naming the issue that adds the table", async () => {
    const { tools: surface } = await prepared();
    expect(await surface.call("search_by_name", { pattern: "x" })).toMatchObject({
      status: "refused",
      reason: "unknown-tool",
    });
  });
});
