// File: packages/tools/src/index.test.ts
//
// The tool surface's contract, over a session whose transport a script
// answers as Agda did (the conformance suite runs the real engines): how
// a goal is addressed, what names the tree, and what is refused.

import { describe, expect, it } from "vitest";
import { openSession, type EngineTransport, type TransportEvent } from "@agda-native-ide/engine";

import { createToolSurface, tools } from "./index.js";

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
  readonly engine = "browser" as const;
  readonly capabilities = {
    interaction: { supported: true },
    batch: { supported: false, reason: "the page's batch lane is issue #30" },
  };
  readonly sent: string[] = [];
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private files = new Map<string, string>();
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

async function prepared() {
  const transport = new Scripted();
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

  it("refuses a tool it does not have, naming the issue that adds the table", async () => {
    const { tools: surface } = await prepared();
    expect(await surface.call("search_by_name", { pattern: "x" })).toMatchObject({
      status: "refused",
      reason: "unknown-tool",
    });
  });
});
