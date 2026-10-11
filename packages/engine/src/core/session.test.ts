// File: packages/engine/src/core/session.test.ts
//
// The session against a scripted transport: malformed payloads, lifecycle
// faults, and the basis rules.  These supplement the conformance suite,
// which runs the real engines (packages/engine/src/conformance); a script
// stands in for Agda here only to make faults that a real Agda cannot be
// asked for.

import { describe, expect, it } from "vitest";

import { AgdaSession, openSession } from "./session.js";
import type { EngineTransport, TransportEvent } from "./transport.js";

const PATH = "/work/Goals.agda";
const TEXT = "module Goals where\n\nidentity : {A : Set} → A → A\nidentity x = {! !}\n";
// Agda's own answers to loading TEXT (positions as Agda counts them).
const goalRange = [{ start: { pos: 63, line: 4, col: 14 }, end: { pos: 68, line: 4, col: 19 } }];
const LOADED = [
  { kind: "Status", status: { checked: false, showImplicitArguments: false, showIrrelevantArguments: false } },
  { kind: "ClearRunningInfo" },
  { kind: "RunningInfo", debugLevel: 1, message: "Checking Goals (/work/Goals.agda).\n" },
  {
    kind: "DisplayInfo",
    info: {
      kind: "AllGoalsWarnings",
      visibleGoals: [{ kind: "OfType", constraintObj: { id: 0, range: goalRange }, type: "A" }],
      invisibleGoals: [],
      warnings: [],
      errors: [],
    },
  },
  { kind: "InteractionPoints", interactionPoints: [{ id: 0, range: goalRange }] },
];
const VERSION = [{ kind: "DisplayInfo", info: { kind: "Version", version: "2.9.0" } }];

type Script = (line: string, transport: FakeTransport) => void;

class FakeTransport implements EngineTransport {
  readonly engine = "native" as const;
  readonly capabilities = {
    interaction: { supported: true },
    batch: { supported: false, reason: "no batch lane here" },
  };
  readonly sent: string[] = [];
  readonly aborts: string[] = [];
  files = new Map<string, string>();
  terminated = 0;
  /** What reading a file returns after a load, if not the file. */
  readBack: string | undefined;
  private readonly listeners = new Set<(event: TransportEvent) => void>();

  constructor(private readonly script: Script) {}

  subscribe(listener: (event: TransportEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: TransportEvent) {
    for (const listener of this.listeners) listener(event);
  }
  answer(responses: unknown[]) {
    for (const json of responses) this.emit({ type: "response", json });
    this.emit({ type: "end" });
  }
  send(line: string) {
    this.sent.push(line);
    queueMicrotask(() => this.script(line, this));
  }
  abort(line: string) {
    this.aborts.push(line);
  }
  resolvePath(relative: string) {
    return `/work/${relative}`;
  }
  async writeSource(path: string, text: string) {
    this.files.set(path, text);
  }
  async readSource(path: string) {
    return this.readBack ?? this.files.get(path);
  }
  async terminate() {
    this.terminated += 1;
    this.emit({ type: "exit", code: null, signal: "SIGKILL" });
  }
}

/** A script that answers like Agda for TEXT. */
const agda: Script = (line, transport) => {
  if (line.includes("Cmd_show_version")) return transport.answer(VERSION);
  if (line.includes("Cmd_load")) return transport.answer(LOADED);
  if (line.includes("Cmd_give")) {
    if (line.endsWith('"zero")'))
      return transport.answer([
        { kind: "DisplayInfo", info: { kind: "Error", error: { message: "zero is not of type A" }, warnings: [] } },
      ]);
    return transport.answer([
      { kind: "GiveAction", interactionPoint: { id: 0, range: goalRange }, giveResult: { paren: false } },
      { kind: "InteractionPoints", interactionPoints: [] },
    ]);
  }
  transport.answer([]);
};

async function started(script: Script = agda, options = {}) {
  const transport = new FakeTransport(script);
  const opened = await openSession(transport, options);
  if (opened.kind !== "session") throw new Error(opened.message);
  return { transport, session: opened.session };
}

describe("the session", () => {
  it("loads, names the basis, and places goals in the text", async () => {
    const { session } = await started();
    const load = await session.load(PATH, TEXT);
    expect(load.kind).toBe("answer");
    if (load.kind !== "answer") return;
    expect(load.lane).toBe("interaction");
    expect(load.value.checking).toEqual(["Goals"]);
    expect(load.basis).toMatchObject({ path: PATH, generation: 1, agdaVersion: "2.9.0", session: session.id });
    const goal = load.value.goals[0];
    expect(TEXT.slice(goal.span!.from, goal.span!.to)).toBe("{! !}");
    expect("verdict" in load).toBe(false);
    expect("verdict" in load.value).toBe(false);
  });

  it("gives, edits the snapshot, and keeps the basis", async () => {
    const { session } = await started();
    const load = await session.load(PATH, TEXT);
    const give = await session.give(session.goalRef(0)!, "x");
    expect(give.kind === "answer" && give.value.accepted).toBe(true);
    expect(session.snapshot).toBe(TEXT.replace("{! !}", "x"));
    expect(session.basis).toEqual(load.kind === "answer" ? load.basis : undefined);
  });

  it("reports a rejected term as Agda's answer, not a failure", async () => {
    const { session } = await started();
    await session.load(PATH, TEXT);
    const give = await session.give(session.goalRef(0)!, "zero");
    expect(give.kind).toBe("answer");
    if (give.kind !== "answer") return;
    expect(give.value).toMatchObject({ accepted: false, error: "zero is not of type A" });
    expect(session.snapshot).toBe(TEXT);
  });

  it("refuses a goal of another session, of an earlier load, or one given", async () => {
    const first = await started();
    const second = await started();
    await first.session.load(PATH, TEXT);
    await second.session.load(PATH, TEXT);
    const ref = first.session.goalRef(0)!;
    expect(await second.session.goal(ref)).toMatchObject({ kind: "refusal", reason: "stale-goal" });
    await first.session.load(PATH, TEXT);
    expect(await first.session.goal(ref)).toMatchObject({ kind: "refusal", reason: "stale-goal" });
    const fresh = first.session.goalRef(0)!;
    await first.session.give(fresh, "x");
    expect(await first.session.goal(fresh)).toMatchObject({ kind: "refusal", reason: "unknown-goal" });
    // Nothing reached Agda for the refusals.
    expect(first.transport.sent.filter((line) => line.includes("Cmd_goal_type_context"))).toEqual([]);
  });

  it("checks by the give rule", async () => {
    const { session, transport } = await started();
    expect(await session.check(PATH, TEXT)).toMatchObject({ kind: "answer", value: { plan: "load" } });
    expect(await session.check(PATH, TEXT)).toMatchObject({ kind: "answer", value: { plan: "unchanged" } });
    const edited = TEXT.replace("{! !}", "{! x !}");
    const check = await session.check(PATH, edited);
    expect(check).toMatchObject({ kind: "answer", value: { plan: "give", give: { accepted: true } } });
    expect(transport.sent.at(-1)).toContain('Cmd_give WithoutForce 0 noRange "x"');
    expect(session.snapshot).toBe(TEXT.replace("{! !}", "x"));
    const declaration = `${session.snapshot}\nmore : Set\nmore = Set\n`;
    expect(await session.check(PATH, declaration)).toMatchObject({ kind: "answer", value: { plan: "load" } });
  });

  it("loads after a case split, whose clauses Agda has not checked", async () => {
    const { session, transport } = await started((line, transport) => {
      if (line.includes("Cmd_make_case"))
        return transport.answer([
          { kind: "MakeCase", interactionPoint: { id: 0, range: goalRange }, variant: "Function", clauses: ["identity x = ?"] },
        ]);
      agda(line, transport);
    });
    await session.load(PATH, TEXT);
    const split = await session.makeCase(session.goalRef(0)!, "");
    expect(split).toMatchObject({ kind: "answer", value: { clauses: ["identity x = ?"] } });
    expect(session.snapshot).toBe(TEXT.replace("identity x = {! !}", "identity x = ?"));
    expect(session.plan(PATH, session.snapshot!)).toMatchObject({ kind: "load" });
    expect(await session.check(PATH, session.snapshot!)).toMatchObject({ value: { plan: "load" } });
    expect(transport.sent.filter((line) => line.includes("Cmd_load"))).toHaveLength(2);
  });

  it("refuses, unsent, a goal operation whose load was replaced while it waited", async () => {
    let release: (() => void) | undefined;
    const { session, transport } = await started((line, transport) => {
      // The second load waits until the test releases it.
      if (line.includes("Cmd_load") && transport.sent.filter((l) => l.includes("Cmd_load")).length === 2)
        release = () => transport.answer(LOADED);
      else agda(line, transport);
    });
    await session.load(PATH, TEXT);
    const old = session.goalRef(0)!;
    const reload = session.load(PATH, TEXT);
    const waiting = [session.goal(old), session.give(old, "x"), session.infer("identity")];
    await new Promise((done) => setTimeout(done, 20));
    release!();
    await reload;
    for (const outcome of await Promise.all(waiting))
      expect(outcome).toMatchObject({ kind: "refusal", reason: "stale-goal" });
    expect(transport.sent.filter((line) => /Cmd_goal_type_context|Cmd_give|Cmd_infer/.test(line))).toEqual([]);
  });

  it("refuses, unsent, a goal operation queued behind an aborted command", async () => {
    const { session, transport } = await started((line, transport) => {
      if (line.includes("Cmd_load") && transport.sent.filter((l) => l.includes("Cmd_load")).length === 2) return;
      agda(line, transport);
    });
    await session.load(PATH, TEXT);
    const old = session.goalRef(0)!;
    const slow = session.load(PATH, TEXT);
    const waiting = session.goal(old);
    await new Promise((done) => setTimeout(done, 20));
    session.abort();
    transport.answer([{ kind: "DoneAborting" }]);
    expect(await slow).toMatchObject({ kind: "failure", reason: "aborted" });
    expect(await waiting).toMatchObject({ kind: "refusal", reason: "stale-goal" });
    expect(transport.sent.filter((line) => line.includes("Cmd_goal_type_context"))).toEqual([]);
  });

  it("refuses a malformed payload as a protocol failure", async () => {
    const { session } = await started((line, transport) => {
      if (line.includes("Cmd_show_version")) return transport.answer(VERSION);
      transport.answer([{ kind: "InteractionPoints", interactionPoints: [{ id: "zero", range: [] }] }]);
    });
    const load = await session.load(PATH, TEXT);
    expect(load).toMatchObject({ kind: "failure", reason: "protocol" });
    expect(load.kind === "failure" && load.message).toMatch(/InteractionPoints: interactionPoints\.0/);
    // The stream goes on: the next command is answered.
    expect((await session.version()).kind).toBe("answer");
  });

  it("keeps a response of a kind it does not read", async () => {
    const { session } = await started((line, transport) => {
      if (line.includes("Cmd_show_version"))
        return transport.answer([{ kind: "SomethingNew", detail: 1 }, ...VERSION]);
      transport.answer([]);
    });
    const version = await session.version();
    expect(version.kind === "answer" && version.responses[0]).toEqual({
      kind: "Unread",
      agdaKind: "SomethingNew",
      raw: { kind: "SomethingNew", detail: 1 },
    });
  });

  it("refuses output that is not an answer", async () => {
    const { session } = await started((line, transport) => {
      if (line.includes("Cmd_show_version")) return transport.answer(VERSION);
      transport.emit({ type: "noise", text: "cannot read: IOTCM ..." });
      transport.emit({ type: "end" });
    });
    expect(await session.load(PATH, TEXT)).toMatchObject({ kind: "failure", reason: "protocol" });
  });

  it("bounds the queue", async () => {
    const { session } = await started((line, transport) => {
      if (line.includes("Cmd_show_version")) return transport.answer(VERSION);
      // Never answers a load.
    }, { maxQueue: 2, deadlines: { load: 60_000 }, abortGraceMs: 10 });
    const running = session.load(PATH, TEXT);
    const waiting = [session.version(), session.version()];
    expect(await session.version()).toMatchObject({ kind: "refusal", reason: "busy" });
    await session.dispose();
    expect(await running).toMatchObject({ kind: "failure", reason: "session-ended" });
    for (const op of waiting) expect(await op).toMatchObject({ kind: "failure", reason: "session-ended" });
  });

  it("aborts at the deadline, and Agda ends the command", async () => {
    const { session, transport } = await started((line, transport) => {
      if (line.includes("Cmd_show_version")) return transport.answer(VERSION);
      if (line.includes("Cmd_load") && transport.sent.filter((l) => l.includes("Cmd_load")).length === 1)
        return transport.answer(LOADED);
      // The second load runs until it is aborted.
    }, { deadlines: { load: 30 }, abortGraceMs: 5_000 });
    await session.load(PATH, TEXT);
    const slow = session.load(PATH, TEXT);
    // Agda answers the abort the way it does.
    await new Promise((done) => setTimeout(done, 60));
    expect(transport.aborts).toHaveLength(1);
    transport.answer([{ kind: "DoneAborting" }]);
    expect(await slow).toMatchObject({ kind: "failure", reason: "timeout", detail: { terminated: false } });
    // Agda forgot its file: no goal survives.
    expect(session.basis).toBeUndefined();
    expect((await session.version()).kind).toBe("answer");
    expect(transport.terminated).toBe(0);
  });

  it("stops Agda when it does not end an aborted command", async () => {
    const { session, transport } = await started((line, transport) => {
      if (line.includes("Cmd_show_version")) return transport.answer(VERSION);
    }, { deadlines: { load: 20 }, abortGraceMs: 20 });
    const slow = session.load(PATH, TEXT);
    const waiting = session.version();
    expect(await slow).toMatchObject({ kind: "failure", reason: "timeout", detail: { terminated: true } });
    expect(await waiting).toMatchObject({ kind: "failure", reason: "session-ended" });
    expect(transport.terminated).toBe(1);
    expect(await session.version()).toMatchObject({ kind: "refusal", reason: "session-ended" });
  });

  it("fails what runs when Agda exits", async () => {
    const { session } = await started((line, transport) => {
      if (line.includes("Cmd_show_version")) return transport.answer(VERSION);
      transport.emit({ type: "response", json: LOADED[0] });
      transport.emit({ type: "exit", code: 1, detail: "agda: out of memory" });
    });
    const load = await session.load(PATH, TEXT);
    expect(load).toMatchObject({ kind: "failure", reason: "session-ended", detail: { code: 1 } });
    expect(session.status.state).toBe("ended");
  });

  it("refuses a load whose text changed while Agda read it", async () => {
    const { session, transport } = await started();
    transport.readBack = `${TEXT}-- edited\n`;
    expect(await session.load(PATH, TEXT)).toMatchObject({ kind: "failure", reason: "source-changed" });
    expect(session.basis).toBeUndefined();
  });

  it("refuses a conversion that moves positions", async () => {
    const { session, transport } = await started(agda, {
      convertSource: (_path: string, text: string) => text.replace("module Goals", "module G"),
    });
    expect(await session.load(PATH, TEXT)).toMatchObject({ kind: "refusal", reason: "position-shift" });
    expect(transport.sent.some((line) => line.includes("Cmd_load"))).toBe(false);
  });

  it("refuses a verdict, and says why, with no verdict field", async () => {
    const { session } = await started();
    const check = await session.checkFile();
    expect(check).toEqual({
      kind: "refusal",
      reason: "unsupported-capability",
      capability: "batch",
      message: "no batch lane here",
    });
  });

  it("refuses an expression before anything is loaded", async () => {
    const { session, transport } = await started();
    expect(await session.infer("zero")).toMatchObject({ kind: "refusal", reason: "no-loaded-file" });
    expect(transport.sent).toHaveLength(1);
  });

  it("is a session of its own engine's", () => {
    const session = new AgdaSession(new FakeTransport(agda));
    expect(session.id).toMatch(/^native-\d+-[0-9a-f]{8}$/);
    expect(session.capabilities.batch.supported).toBe(false);
  });
});
