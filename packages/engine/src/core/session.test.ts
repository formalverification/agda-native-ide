// File: packages/engine/src/core/session.test.ts
//
// The session against a scripted transport: malformed payloads, lifecycle
// faults, and the basis rules.  These supplement the conformance suite,
// which runs the real engines (packages/engine/src/conformance); a script
// stands in for Agda here only to make faults that a real Agda cannot be
// asked for.

import { describe, expect, it } from "vitest";

import { AgdaSession, caseSplitEdit, openSession } from "./session.js";
import { sourceDigest } from "./text.js";
import type { BatchHandle, BatchRun, Capabilities, EngineTransport, TransportEvent } from "./transport.js";

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
  capabilities: Capabilities = {
    interaction: { supported: true },
    batch: { supported: false, reason: "no batch lane here" },
  };
  readonly sent: string[] = [];
  readonly aborts: string[] = [];
  files = new Map<string, string>();
  terminated = 0;
  /** What reading a file returns after a load, if not the file. */
  readBack: string | undefined;
  /** Reading a file waits for this, when set. */
  readHold: Promise<void> | undefined;
  /** What terminate does instead of exiting, when set. */
  onTerminate: (() => Promise<void>) | undefined;
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
    if (this.readHold) await this.readHold;
    return this.readBack ?? this.files.get(path);
  }
  async terminate() {
    this.terminated += 1;
    if (this.onTerminate) return this.onTerminate();
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

const never = new Promise<void>(() => {});
const tick = (ms = 0) => new Promise((done) => setTimeout(done, ms));

describe("the session's corners", () => {
  it("holds no load once a load's answer is malformed, and refuses the old goals unsent", async () => {
    const { session, transport } = await started((line, transport) => {
      if (line.includes("Cmd_load") && transport.sent.filter((l) => l.includes("Cmd_load")).length === 2)
        return transport.answer([{ kind: "InteractionPoints", interactionPoints: "not a list" }]);
      agda(line, transport);
    });
    await session.load(PATH, TEXT);
    const old = session.goalRef(0)!;
    expect(await session.load("/work/Other.agda", TEXT)).toMatchObject({ kind: "failure", reason: "protocol" });
    expect(session.basis).toBeUndefined();
    expect(await session.give(old, "x")).toMatchObject({ kind: "refusal", reason: "stale-goal" });
    expect(transport.sent.filter((line) => line.includes("Cmd_give"))).toEqual([]);
  });

  it("holds no load while a load's source is read back", async () => {
    const { session, transport } = await started();
    await session.load(PATH, TEXT);
    let release!: () => void;
    transport.readHold = new Promise((done) => (release = done));
    const reload = session.load(PATH, TEXT);
    await tick(10);
    expect(session.basis).toBeUndefined();
    expect(session.plan(PATH, TEXT)).toMatchObject({ kind: "load", reason: "nothing is loaded" });
    release();
    expect(await reload).toMatchObject({ kind: "answer", basis: { generation: 2 } });
    expect(session.basis?.generation).toBe(2);
  });

  it("fails a load whose source is not read back by its deadline, and runs the next", async () => {
    const { session, transport } = await started(agda, { deadlines: { load: 40 } });
    transport.readHold = never;
    const load = await session.load(PATH, TEXT);
    expect(load).toMatchObject({ kind: "failure", reason: "timeout" });
    expect((load as { message: string }).message).toMatch(/was not read within its deadline of 40 ms/);
    expect(session.basis).toBeUndefined();
    expect((await session.version()).kind).toBe("answer");
    expect(transport.aborts).toEqual([]);
    expect(transport.terminated).toBe(0);
  });

  it("fails, unsent, an operation that cannot start by its deadline", async () => {
    const { session, transport } = await started(agda, { deadlines: { load: 40 } });
    transport.writeSource = () => never;
    expect(await session.load(PATH, TEXT)).toMatchObject({ kind: "failure", reason: "timeout" });
    expect(transport.sent.filter((line) => line.includes("Cmd_load"))).toEqual([]);
    expect((await session.version()).kind).toBe("answer");
  });

  it("is not stopped by a listener that throws", async () => {
    const { session } = await started();
    const quiet = console.error;
    console.error = () => {};
    try {
      session.onStatus(() => {
        throw new Error("a status listener failed");
      });
      session.onResponse(() => {
        throw new Error("a response listener failed");
      });
      const [load, version] = await Promise.all([session.load(PATH, TEXT), session.version()]);
      expect(load.kind).toBe("answer");
      expect(version.kind).toBe("answer");
    } finally {
      console.error = quiet;
    }
  });

  it("keeps a file Agda reported errors among its warnings for, and refuses after a refused one", async () => {
    const termination = [
      ...LOADED.slice(0, 3),
      {
        kind: "DisplayInfo",
        info: {
          kind: "AllGoalsWarnings",
          visibleGoals: [{ kind: "OfType", constraintObj: { id: 0, range: goalRange }, type: "A" }],
          invisibleGoals: [],
          warnings: [],
          errors: [{ message: "Termination checking failed for identity" }],
        },
      },
      LOADED[4],
    ];
    const refused = [{ kind: "DisplayInfo", info: { kind: "Error", error: { message: "Set is not a type" }, warnings: [] } }];
    let answer = termination;
    const { session } = await started((line, transport) => {
      if (line.includes("Cmd_load")) return transport.answer(answer);
      if (line.includes("Cmd_infer_toplevel"))
        return transport.answer([{ kind: "DisplayInfo", info: { kind: "InferredType", expr: "A → A" } }]);
      agda(line, transport);
    });
    const load = await session.load(PATH, TEXT);
    expect(load).toMatchObject({ kind: "answer", value: { errors: ["Termination checking failed for identity"] } });
    expect(session.plan(PATH, TEXT.replace("{! !}", "{! x !}"))).toMatchObject({ kind: "give" });
    expect(await session.infer("identity")).toMatchObject({ kind: "answer", value: { expression: "A → A" } });
    answer = refused;
    await session.load(PATH, TEXT);
    expect(await session.infer("identity")).toMatchObject({ kind: "refusal", reason: "no-loaded-file" });
  });

  it("tells a check's plan only once it is taken", async () => {
    const plans: string[] = [];
    const shifted = await started(agda, { convertSource: (_path: string, text: string) => `${text}\n` });
    expect(await shifted.session.check(PATH, TEXT, { onPlan: (plan) => plans.push(plan.kind) })).toMatchObject({
      kind: "refusal",
      reason: "position-shift",
    });
    // Agda answers the session's opening, then runs the next command on.
    const { session } = await started((line, transport) => {
      if (transport.sent.length === 1) transport.answer(VERSION);
    }, { maxQueue: 0 });
    void session.version();
    expect(await session.check(PATH, TEXT, { onPlan: (plan) => plans.push(plan.kind) })).toMatchObject({
      kind: "refusal",
      reason: "busy",
    });
    expect(plans).toEqual([]);
    const taken = await started();
    await taken.session.check(PATH, TEXT, { onPlan: (plan) => plans.push(plan.kind) });
    expect(plans).toEqual(["load"]);
  });

  it("refuses, unsent, a goal operation whose goal closed while it waited", async () => {
    const { session, transport } = await started();
    await session.load(PATH, TEXT);
    const ref = session.goalRef(0)!;
    const [give, goal] = await Promise.all([session.give(ref, "x"), session.goal(ref)]);
    expect(give.kind).toBe("answer");
    expect(goal).toMatchObject({ kind: "refusal", reason: "unknown-goal" });
    expect(transport.sent.filter((line) => line.includes("Cmd_goal_type_context"))).toEqual([]);
  });

  it("says who ended a command it was aborting", async () => {
    // Agda exits by itself during the grace period: nothing stopped it.
    const exits = await started((line, transport) => {
      if (line.includes("Cmd_show_version")) return transport.answer(VERSION);
    }, { deadlines: { load: 20 }, abortGraceMs: 5_000 });
    const load = exits.session.load(PATH, TEXT);
    await tick(40);
    exits.transport.emit({ type: "exit", code: 1 });
    const exited = await load;
    expect(exited).toMatchObject({ kind: "failure", reason: "timeout", detail: { terminated: false } });
    expect((exited as { message: string }).message).toMatch(/Agda stopped while it was aborted/);
    expect(exits.transport.terminated).toBe(0);

    // The session stops Agda, which ends the command as it goes: the kill
    // is what ended it.
    const late = await started((line, transport) => {
      if (line.includes("Cmd_show_version")) return transport.answer(VERSION);
    }, { deadlines: { load: 20 }, abortGraceMs: 20 });
    late.transport.onTerminate = async () => {
      late.transport.answer([{ kind: "DoneAborting" }]);
      late.transport.emit({ type: "exit", code: null, signal: "SIGTERM" });
    };
    expect(await late.session.load(PATH, TEXT)).toMatchObject({
      kind: "failure",
      reason: "timeout",
      detail: { terminated: true },
    });

    // A terminate that rejects still ends the operation.
    const rejects = await started((line, transport) => {
      if (line.includes("Cmd_show_version")) return transport.answer(VERSION);
    }, { deadlines: { load: 20 }, abortGraceMs: 20 });
    rejects.transport.onTerminate = () => Promise.reject(new Error("no such process"));
    expect(await rejects.session.load(PATH, TEXT)).toMatchObject({ kind: "failure", reason: "timeout" });
    expect(rejects.session.status.state).toBe("ended");
  });

  it("says a closed session was closed, and has nothing to abort while it reads an answer", async () => {
    const { session, transport } = await started((line, transport) => {
      if (line.includes("Cmd_show_version")) return transport.answer(VERSION);
    });
    const load = session.load(PATH, TEXT);
    await tick(10);
    await session.dispose();
    expect((await load as { message: string }).message).toBe("the session was closed during the load");

    const reading = await started();
    let release!: () => void;
    reading.transport.readHold = new Promise((done) => (release = done));
    const pending = reading.session.load(PATH, TEXT);
    await tick(10);
    expect(reading.session.abort()).toEqual({ aborting: undefined });
    release();
    expect((await pending).kind).toBe("answer");
    expect(transport.aborts).toEqual([]);
  });

  it("ignores an end while a load's answer is read", async () => {
    const { session, transport } = await started();
    let release!: () => void;
    transport.readHold = new Promise((done) => (release = done));
    const load = session.load(PATH, TEXT);
    await tick(10);
    transport.emit({ type: "end" });
    release();
    const answer = await load;
    expect(answer).toMatchObject({ kind: "answer", basis: { generation: 1 } });
    expect(session.goalRef(0)).toBeDefined();
  });

  it("takes its options as given, and the defaults for the rest", async () => {
    const { session } = await started(agda, { deadlines: { load: undefined }, maxQueue: 0 });
    expect(session.agdaVersion).toBe("2.9.0");
    expect((await session.load(PATH, TEXT)).kind).toBe("answer");
    expect(await session.infer("identity", undefined, "Normalised\nIOTCM" as never)).toMatchObject({
      kind: "refusal",
      reason: "invalid-input",
    });
    const opened = await openSession(new FakeTransport(agda));
    expect(opened.kind === "session" && (await opened.session.start())).toMatchObject({ agdaVersion: "2.9.0" });
  });
});

describe("a case split's edit", () => {
  it("keeps the line's indentation for every clause", () => {
    const text = "f : ℕ → ℕ\nf n = g n\n  where\n    g : ℕ → ℕ\n    g n = {! !}\n";
    const span = { from: text.indexOf("{! !}"), to: text.indexOf("{! !}") + 5 };
    const edit = caseSplitEdit(text, span, ["g zero = ?", "g (suc n) = ?"], "Function")!;
    const after = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
    expect(after).toBe("f : ℕ → ℕ\nf n = g n\n  where\n    g : ℕ → ℕ\n    g zero = ?\n    g (suc n) = ?\n");
  });

  it("replaces only an extended lambda's clause, as Emacs mode does", () => {
    const apply = (text: string, clauses: string[]) => {
      const from = text.indexOf("{!");
      const span = { from, to: text.indexOf("!}", from) + 2 };
      const edit = caseSplitEdit(text, span, clauses, "ExtendedLambda")!;
      return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
    };
    expect(apply("f = λ { x → {! x !} }", ["true → ?", "false → ?"])).toBe("f = λ { true → ? ; false → ? }");
    expect(apply("f = λ { zero → 0 ; (suc n) → {! n !} }", ["(suc zero) → ?", "(suc (suc n)) → ?"])).toBe(
      "f = λ { zero → 0 ; (suc zero) → ? ; (suc (suc n)) → ? }",
    );
    expect(apply("f = λ where\n  x → {! x !}\n", ["true → ?", "false → ?"])).toBe(
      "f = λ where\n  true → ?\n  false → ?\n",
    );
    expect(caseSplitEdit("f = {! !}", { from: 4, to: 9 }, [], "Function")).toBeUndefined();
  });
});

/** What a scripted batch run does: its result, or a promise of it that the
 * run's stop() overtakes. */
type BatchScript = (text: string | undefined, transport: BatchTransport) => Partial<BatchRun> | Promise<Partial<BatchRun>>;

/** A transport with the batch lane, whose runs a script answers. */
class BatchTransport extends FakeTransport {
  /** The file's text at the start of each run. */
  readonly runs: Array<string | undefined> = [];
  stops = 0;
  /** What happened, in order: lane commands and runs. */
  readonly log: string[] = [];

  constructor(script: Script, private readonly batch: BatchScript) {
    super(script);
    this.capabilities = { interaction: { supported: true }, batch: { supported: true } };
  }

  override send(line: string) {
    this.log.push(line.replace(/^IOTCM "[^"]*" \w+ Direct \((\w+).*$/, "$1"));
    super.send(line);
  }

  runBatch(path: string): BatchHandle {
    const text = this.files.get(path);
    this.runs.push(text);
    this.log.push("run");
    let stopped!: () => void;
    const stopping = new Promise<Partial<BatchRun>>((done) => (stopped = () => done({ exitCode: null, signal: "SIGTERM" })));
    const done = Promise.race([Promise.resolve(this.batch(text, this)), stopping]).then((result): BatchRun => {
      this.log.push("run ended");
      return { exitCode: 0, stdout: "", stderr: "", elapsedMs: 5, ...result };
    });
    return {
      command: { executable: "/bin/agda", args: [path], cwd: "/work" },
      done,
      stop: async () => {
        this.stops += 1;
        stopped();
        await done;
      },
    };
  }
}

async function batched(batch: BatchScript, options = {}, script: Script = agda) {
  const transport = new BatchTransport(script, batch);
  transport.files.set(PATH, TEXT);
  const opened = await openSession(transport, options);
  if (opened.kind !== "session") throw new Error(opened.message);
  return { transport, session: opened.session };
}

const HOLE_OUTPUT = `Checking Goals (/work/Goals.agda).
/work/Goals.agda:4.14-19: error: [UnsolvedInteractionMetas]
Unsolved interaction metas at the following locations:
  /work/Goals.agda:4.14-19
`;
const FILLED = TEXT.replace("{! !}", "x");

describe("the session's batch lane", () => {
  it("gives a verdict from a fresh run's exit code, on the file as it is", async () => {
    const { session, transport } = await batched((text) =>
      text?.includes("{!") ? { exitCode: 42, stdout: HOLE_OUTPUT } : { exitCode: 0 },
    );
    const verdict = await session.checkFile(PATH);
    expect(verdict).toMatchObject({
      kind: "verdict",
      lane: "batch",
      engine: "native",
      agdaVersion: "2.9.0",
      path: PATH,
      digest: sourceDigest(TEXT),
      command: { executable: "/bin/agda", args: [PATH], cwd: "/work" },
      exitCode: 42,
      success: false,
      diagnostics: [{ severity: "error", code: "UnsolvedInteractionMetas", range: { startLine: 4, startCol: 14 } }],
    });
    expect(verdict.kind === "verdict" && verdict.output).toBe(HOLE_OUTPUT);
    expect("value" in verdict || "basis" in verdict).toBe(false);
    expect(transport.runs).toEqual([TEXT]);
    // Nothing was asked of the lane.
    expect(transport.sent.filter((line) => !line.includes("Cmd_show_version"))).toEqual([]);
    transport.files.set(PATH, FILLED);
    expect(await session.checkFile(PATH)).toMatchObject({ kind: "verdict", exitCode: 0, success: true, diagnostics: [] });
  });

  it("checks a text written over the file, and puts the file back", async () => {
    const { session, transport } = await batched(() => ({ exitCode: 0 }));
    const verdict = await session.checkFile(PATH, { text: FILLED, expect: sourceDigest(TEXT) });
    expect(verdict).toMatchObject({ kind: "verdict", exitCode: 0, digest: sourceDigest(FILLED) });
    expect(transport.runs).toEqual([FILLED]);
    expect(transport.files.get(PATH)).toBe(TEXT);
  });

  it("refuses to run when the file is not the text expected, and writes nothing", async () => {
    const { session, transport } = await batched(() => ({ exitCode: 0 }));
    const verdict = await session.checkFile(PATH, { text: FILLED, expect: sourceDigest("another text") });
    expect(verdict).toMatchObject({ kind: "failure", reason: "source-changed" });
    expect(transport.runs).toEqual([]);
    expect(transport.files.get(PATH)).toBe(TEXT);
  });

  it("has no verdict for a run a signal ended, or one that never started, and puts the file back", async () => {
    const signalled = await batched(() => ({ exitCode: null, signal: "SIGKILL" }));
    expect(await signalled.session.checkFile(PATH, { text: FILLED })).toMatchObject({
      kind: "failure",
      reason: "no-exit-code",
      detail: { signal: "SIGKILL" },
    });
    expect(signalled.transport.files.get(PATH)).toBe(TEXT);
    const unstarted = await batched(() => ({ exitCode: null, startError: "spawn /bin/agda ENOENT" }));
    const failed = await unstarted.session.checkFile(PATH, { text: FILLED });
    expect(failed).toMatchObject({ kind: "failure", reason: "startup" });
    expect(failed.kind === "failure" && failed.message).toMatch(/ENOENT/);
    expect(unstarted.transport.files.get(PATH)).toBe(TEXT);
  });

  it("fails a run whose file changed while it read it", async () => {
    const { session } = await batched((_text, transport) => {
      transport.files.set(PATH, `${TEXT}-- edited\n`);
      return { exitCode: 0 };
    });
    expect(await session.checkFile(PATH)).toMatchObject({ kind: "failure", reason: "source-changed" });
  });

  it("refuses a verdict on no file, or on a missing one", async () => {
    const { session, transport } = await batched(() => ({ exitCode: 0 }));
    expect(await session.checkFile()).toMatchObject({ kind: "refusal", reason: "invalid-input" });
    expect(await session.checkFile("/work/Missing.agda")).toMatchObject({ kind: "failure", reason: "io" });
    expect(transport.runs).toEqual([]);
  });

  it("stops a run at its deadline, and reports it once the run is gone and the file is back", async () => {
    const { session, transport } = await batched(() => never.then(() => ({})), { deadlines: { verdict: 40 } });
    const verdict = await session.checkFile(PATH, { text: FILLED });
    expect(verdict).toMatchObject({ kind: "failure", reason: "timeout", detail: { terminated: true } });
    expect(transport.stops).toBe(1);
    expect(transport.log.slice(-1)).toEqual(["run ended"]);
    expect(transport.files.get(PATH)).toBe(TEXT);
    // The lane goes on.
    expect((await session.version()).kind).toBe("answer");
    expect(transport.aborts).toEqual([]);
  });

  it("aborts a run by stopping it, and tells the lane nothing", async () => {
    const { session, transport } = await batched(() => never.then(() => ({})));
    const verdict = session.checkFile(PATH, { text: FILLED });
    await tick(10);
    expect(session.abort()).toEqual({ aborting: "verdict" });
    expect(await verdict).toMatchObject({ kind: "failure", reason: "aborted" });
    expect(transport.files.get(PATH)).toBe(TEXT);
    expect(transport.aborts).toEqual([]);
  });

  it("queues a run with the lane's commands, so the two never run at once", async () => {
    let release!: () => void;
    const { session, transport } = await batched(async () => {
      await tick(20);
      return { exitCode: 42, stdout: HOLE_OUTPUT };
    }, {}, (line, transport) => {
      if (line.includes("Cmd_load") && !release) {
        release = () => transport.answer(LOADED);
        return;
      }
      agda(line, transport);
    });
    const load = session.load(PATH, TEXT);
    const verdict = session.checkFile(PATH);
    await tick(10);
    expect(transport.runs).toEqual([]);
    release();
    await load;
    const goal = session.goal(session.goalRef(0)!);
    await Promise.all([verdict, goal]);
    expect(transport.log.filter((entry) => entry !== "Cmd_show_version")).toEqual([
      "Cmd_load",
      "run",
      "run ended",
      "Cmd_goal_type_context",
    ]);
  });

  it("stops a run when the session ends, and puts the file back before dispose resolves", async () => {
    const { session, transport } = await batched(() => never.then(() => ({})));
    const verdict = session.checkFile(PATH, { text: FILLED });
    await tick(10);
    expect(transport.files.get(PATH)).toBe(FILLED);
    await session.dispose();
    expect(transport.files.get(PATH)).toBe(TEXT);
    expect(transport.stops).toBeGreaterThanOrEqual(1);
    expect(await verdict).toMatchObject({ kind: "failure", reason: "session-ended" });
  });
});
