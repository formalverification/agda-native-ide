// File: scripts/conformance/native.mjs
//
// The engine's conformance suite against native Agda (issues 62 and 64):
// the shared scenarios (@agda-native-ide/engine/conformance), each in a
// fresh lane under a temporary project root, opened as an editor host opens
// one, through the lane registry with the root and the Agda resolved
// (findProjectRoot, resolveAgda); and then the checks of the resources this
// runner owns: a start that fails, a deadline that aborts, a child that
// cannot answer and is killed, a child that crashes, a disposal that leaves
// no process, the registry's rules against the real Agda (one lane per
// root, a crash told once and a new lane next, an idle lane closed by its
// input, every lane closed at disposal), a resolution that refuses, and a
// verdict stopped at its deadline.  It writes native.json (what ran, the
// Agda and the sources it checked, every scenario's transcript) into
// --out, and exits 1 if anything failed.
//
//   AGDA=<agda> node scripts/conformance/native.mjs [--out DIR]
//   nix develop .#vscode --command make conformance-native

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runConformance, FIXTURES, SLOW_TERM } from "@agda-native-ide/engine/conformance";
import { LaneRegistry, findProjectRoot, resolveAgda, startNativeSession } from "@agda-native-ide/engine/native";

const { values: options } = parseArgs({
  options: { out: { type: "string", default: "conformance/native" } },
});
const agda = process.env.AGDA;
if (!agda) {
  console.error("Set AGDA to the native agda (nix develop .#vscode sets it).");
  process.exit(2);
}
const out = resolve(options.out);
mkdirSync(out, { recursive: true });
// A run that does not finish leaves no record for the comparison to read.
rmSync(join(out, "native.json"), { force: true });

// Each Agda runs in a process group of its own, so a signal that ends this
// runner (Ctrl-C, or make's `timeout`) does not reach it: stop them first.
const running = new Set();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, async () => {
    await Promise.allSettled([...running].map((each) => (each.dispose ? each.dispose() : each.terminate())));
    process.exit(128 + os.constants.signals[signal]);
  });

/** A fresh project root, with its library and its own empty Agda directory
 * so that no library of this machine's reaches the check. */
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "engine-conformance-"));
  mkdirSync(join(root, ".agda"));
  writeFileSync(join(root, "conformance.agda-lib"), FIXTURES["conformance.agda-lib"]);
  return root;
}

const probes = new Map();

/** A registry as an editor host makes one: each file's root is its nearest
 * .agda-lib's directory, and its Agda is AGDA, at the version the suite
 * expects. */
function registryFor(env, { sessionOptions = {}, args = [], ...options } = {}) {
  const registry = new LaneRegistry({
    resolve: async (path) => {
      const project = await findProjectRoot(path);
      const resolved = await resolveAgda([{ source: "AGDA", executable: agda, args }], {
        expectedVersion: "2.9.0",
        env,
        cache: probes,
      });
      if ("kind" in resolved) return resolved;
      return { root: project.root, executable: resolved.executable, args: resolved.args, env };
    },
    // The suite's contract is the session's defaults, `?` shown as a goal.
    session: { expandQuestionMarks: true, ...sessionOptions },
    ...options,
  });
  running.add(registry);
  return registry;
}

async function open(sessionOptions = {}, options = {}) {
  const root = freshRoot();
  const env = { ...process.env, AGDA_DIR: join(root, ".agda") };
  const registry = registryFor(env, { sessionOptions, ...options });
  const lane = await registry.withLane(join(root, "Goals.agda"), async (use) => use);
  if (lane.kind === "refusal" || lane.kind === "failure") {
    running.delete(registry);
    rmSync(root, { recursive: true, force: true });
    return lane;
  }
  const { session, transport } = lane;
  return {
    session,
    transport,
    registry,
    root: `${transport.root}/`,
    path: (relative) => transport.resolvePath(relative),
    close: async () => {
      await registry.dispose();
      running.delete(registry);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The transport's own start, outside any registry. */
async function openDirect(config) {
  const root = freshRoot();
  const started = await startNativeSession({
    executable: agda,
    projectRoot: root,
    env: { ...process.env, AGDA_DIR: join(root, ".agda") },
    ...config,
  });
  rmSync(root, { recursive: true, force: true });
  return started;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const lifecycle = [];
async function check(name, run) {
  const started = performance.now();
  try {
    const detail = await run();
    lifecycle.push({ name, ok: true, elapsedMs: Math.round(performance.now() - started), detail });
    console.log(`ok   ${name}`);
  } catch (error) {
    lifecycle.push({ name, ok: false, elapsedMs: Math.round(performance.now() - started), error: String(error?.message ?? error) });
    console.log(`FAIL ${name}: ${error?.message ?? error}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const version = execFileSync(agda, ["--version"], { encoding: "utf8" }).trim();
console.log(`native conformance: ${agda}\n${version}`);

const report = await runConformance({ engine: "native", open: () => open() }, (line) => console.log(line));

await check("a start that cannot find its executable fails, and says so", async () => {
  const failed = await openDirect({ executable: "/nonexistent/agda" });
  assert(failed.kind === "failure" && failed.reason === "startup", `expected a startup failure: ${JSON.stringify(failed)}`);
  return { message: failed.message };
});

await check("a start whose Agda exits at once fails, with Agda's words", async () => {
  const failed = await openDirect({ args: ["--no-such-option"] });
  assert(failed.kind === "failure" && failed.reason === "startup", `expected a startup failure: ${JSON.stringify(failed)}`);
  assert(/no-such-option/.test(JSON.stringify(failed.detail)), `Agda's error is kept: ${JSON.stringify(failed)}`);
  return { message: failed.message, detail: failed.detail };
});

await check("a deadline aborts the command, and the session goes on", async () => {
  const target = await open({ deadlines: { normalize: 500 } });
  assert(target.session, "opened");
  try {
    await target.session.load(target.path("Slow.agda"), FIXTURES["Slow.agda"]);
    const slow = await target.session.normalize(SLOW_TERM);
    assert(slow.kind === "failure" && slow.reason === "timeout", `expected a timeout: ${JSON.stringify(slow)}`);
    assert(slow.detail?.terminated === false, "Agda ended the command itself");
    assert(slow.responses.some((r) => r.kind === "DoneAborting"), "with DoneAborting");
    assert(target.session.basis === undefined, "Agda forgot its file");
    const after = await target.session.version();
    assert(after.kind === "answer", "the session still answers");
    assert(target.transport.pid !== undefined, "the same child runs");
    return { failure: slow.message };
  } finally {
    await target.close();
  }
});

await check("a child that cannot answer the abort is killed, and nothing waits", async () => {
  const target = await open({ deadlines: { normalize: 400 }, abortGraceMs: 400 }, { killGraceMs: 300 });
  const pid = target.transport.pid;
  try {
    await target.session.load(target.path("Slow.agda"), FIXTURES["Slow.agda"]);
    process.kill(pid, "SIGSTOP");
    const slow = target.session.normalize(SLOW_TERM);
    const waiting = target.session.version();
    const [stuck, queued] = await Promise.all([slow, waiting]);
    assert(stuck.kind === "failure" && stuck.reason === "timeout" && stuck.detail?.terminated === true, `expected a kill: ${JSON.stringify(stuck)}`);
    assert(queued.kind === "failure" && queued.reason === "session-ended", `the queued operation fails: ${JSON.stringify(queued)}`);
    await new Promise((done) => setTimeout(done, 100));
    assert(!alive(pid), `process ${pid} is gone`);
    const refused = await target.session.version();
    assert(refused.kind === "refusal" && refused.reason === "session-ended", "the session refuses");
    return { pid, failure: stuck.message };
  } finally {
    await target.close();
  }
});

await check("a child that crashes ends the session, naming the signal", async () => {
  const target = await open({ deadlines: { normalize: 60_000 } });
  const pid = target.transport.pid;
  try {
    await target.session.load(target.path("Slow.agda"), FIXTURES["Slow.agda"]);
    const slow = target.session.normalize(SLOW_TERM);
    setTimeout(() => process.kill(pid, "SIGKILL"), 300);
    const crashed = await slow;
    assert(crashed.kind === "failure" && crashed.reason === "session-ended", `expected the session to end: ${JSON.stringify(crashed)}`);
    assert(crashed.detail?.signal === "SIGKILL", `the signal is named: ${JSON.stringify(crashed.detail)}`);
    assert(target.session.status.state === "ended", "the session has ended");
    return { pid, detail: crashed.detail };
  } finally {
    await target.close();
  }
});

await check("disposal leaves no process", async () => {
  const target = await open();
  const pid = target.transport.pid;
  assert(alive(pid), "the child runs");
  await target.close();
  await new Promise((done) => setTimeout(done, 100));
  assert(!alive(pid), `process ${pid} is gone`);
  return { pid };
});

/** Fresh roots with the suite's modules written, and a registry over them
 * that tells its lanes' ends. */
function lanesOver(count, options = {}) {
  const roots = Array.from({ length: count }, () => {
    const root = freshRoot();
    for (const name of ["Goals.agda", "Second.agda"]) writeFileSync(join(root, name), FIXTURES[name]);
    return root;
  });
  const ended = [];
  const env = { ...process.env, AGDA_DIR: join(roots[0], ".agda") };
  const registry = registryFor(env, {
    sessionOptions: { expandQuestionMarks: false },
    onLaneEnded: (event) => ended.push(event),
    ...options,
  });
  const ask = async (file, options) => {
    const use = await registry.withFile(
      file,
      async ({ pid, load, spawned, session }) => ({ pid, load, spawned, goals: session.goals().length }),
      options,
    );
    assert(!use.kind, `${file}: ${JSON.stringify(use)}`);
    return use;
  };
  const close = async () => {
    await registry.dispose();
    running.delete(registry);
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  };
  return { roots, registry, ended, ask, close };
}

const until = async (condition, ms) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
};

await check("a root's files share one lane, another root has its own, and a file loads only when its text is not Agda's", async () => {
  const { roots, registry, ask, close } = lanesOver(2);
  const [a, b] = roots;
  try {
    const first = await ask(join(a, "Goals.agda"));
    const again = await ask(join(a, "Goals.agda"));
    const other = await ask(join(a, "Second.agda"));
    const elsewhere = await ask(join(b, "Goals.agda"));
    assert(first.load === "first" && first.spawned && first.goals === 2, `the first request starts a lane and loads: ${JSON.stringify(first)}`);
    assert(again.load === "reused" && again.pid === first.pid, `the same text is reused, in the same lane: ${JSON.stringify(again)}`);
    assert(other.load === "switch" && other.pid === first.pid, `another file of the root switches, in the same lane: ${JSON.stringify(other)}`);
    assert(elsewhere.load === "first" && elsewhere.pid !== first.pid, `another root has its own lane: ${JSON.stringify(elsewhere)}`);
    // The same length, another text.
    writeFileSync(join(a, "Second.agda"), FIXTURES["Second.agda"].replace("red green", "green red"));
    const changed = await ask(join(a, "Second.agda"));
    assert(changed.load === "changed" && changed.pid === first.pid, `a rewrite of the same length is a change: ${JSON.stringify(changed)}`);
    const asked = await ask(join(a, "Second.agda"), { reload: true });
    assert(asked.load === "requested", "a request may ask for a load");
    assert(registry.lanes().length === 2, "two lanes run");
    return { loads: [first, again, other, elsewhere, changed, asked].map((use) => use.load) };
  } finally {
    await close();
  }
});

await check("a lane that crashes is told once, and the next request starts another", async () => {
  const { roots, ended, ask, close } = lanesOver(1);
  const file = join(roots[0], "Goals.agda");
  try {
    const before = await ask(file);
    process.kill(before.pid, "SIGKILL");
    await until(() => ended.length > 0, 5_000);
    assert(ended.length === 1 && ended[0].reason === "crashed", `told once: ${JSON.stringify(ended)}`);
    assert(ended[0].detail?.signal === "SIGKILL", `naming the signal: ${JSON.stringify(ended[0])}`);
    const after = await ask(file);
    assert(after.spawned && after.load === "first" && after.pid !== before.pid, `a new lane: ${JSON.stringify(after)}`);
    assert(ended.length === 1, "told once only");
    return { ended: ended[0].reason, signal: ended[0].detail.signal };
  } finally {
    await close();
  }
});

await check("an idle lane is closed by closing its input, and Agda exits with code 0", async () => {
  const { roots, registry, ended, ask, close } = lanesOver(1, { idleMs: 300 });
  try {
    const { pid } = await ask(join(roots[0], "Goals.agda"));
    await until(() => ended.length > 0, 10_000);
    assert(ended[0]?.reason === "idle", `closed as idle: ${JSON.stringify(ended)}`);
    assert(ended[0].exit?.code === 0 && ended[0].exit?.signal === null, `Agda exited 0: ${JSON.stringify(ended[0])}`);
    assert(!alive(pid) && registry.lanes().length === 0, "the lane is gone");
    return { exit: ended[0].exit };
  } finally {
    await close();
  }
});

await check("disposal closes every lane, and the registry refuses from then on", async () => {
  const { roots, registry, ended, ask, close } = lanesOver(2);
  try {
    const pids = [(await ask(join(roots[0], "Goals.agda"))).pid, (await ask(join(roots[1], "Goals.agda"))).pid];
    await registry.dispose();
    await new Promise((done) => setTimeout(done, 100));
    assert(pids.every((pid) => !alive(pid)), `processes ${pids} are gone`);
    assert(ended.length === 2 && ended.every((event) => event.reason === "disposed"), `told: ${JSON.stringify(ended)}`);
    const refused = await registry.withFile(join(roots[0], "Goals.agda"), async () => "ran");
    assert(refused.kind === "refusal" && refused.reason === "session-ended", `refused: ${JSON.stringify(refused)}`);
    return { pids: pids.length };
  } finally {
    await close();
  }
});

await check("options the project's Agda refuses are refused before any lane starts, with Agda's words", async () => {
  const { roots, registry, close } = lanesOver(1, { args: ["--no-such-option"] });
  try {
    const refused = await registry.withFile(join(roots[0], "Goals.agda"), async () => "ran");
    assert(refused.kind === "refusal" && refused.reason === "configuration", `refused: ${JSON.stringify(refused)}`);
    assert(/no-such-option/.test(refused.message), `with Agda's words: ${refused.message}`);
    assert(registry.lanes().length === 0, "no lane started");
    return { message: refused.message.replace(agda, "<agda>") };
  } finally {
    await close();
  }
});

await check("a verdict that outruns its deadline has its Agda stopped, and the lane goes on", async () => {
  const target = await open({ deadlines: { verdict: 1_500 } });
  const handles = [];
  const runBatch = target.transport.runBatch.bind(target.transport);
  target.transport.runBatch = (path) => {
    const handle = runBatch(path);
    handles.push(handle);
    return handle;
  };
  try {
    // A billion reductions, in constant space, before a type error.
    const file = target.path("Endless.agda");
    await target.transport.writeSource(
      file,
      [
        "module Endless where",
        "open import Agda.Builtin.Nat",
        "open import Agda.Builtin.Equality",
        "count : Nat → Nat",
        "count zero = zero",
        "count (suc n) = count n",
        "never : count 1000000000 ≡ 1",
        "never = refl",
        "",
      ].join("\n"),
    );
    const started = performance.now();
    const verdict = await target.session.checkFile(file);
    const elapsedMs = Math.round(performance.now() - started);
    assert(verdict.kind === "failure" && verdict.reason === "timeout" && verdict.detail?.terminated, `expected a timeout: ${JSON.stringify(verdict)}`);
    assert(handles.length === 1 && handles[0].pid && !alive(handles[0].pid), "the run's Agda is gone");
    const version = await target.session.version();
    assert(version.kind === "answer", "the lane goes on");
    return { elapsedMs, failure: verdict.message.replace(target.root, "<root>/") };
  } finally {
    await target.close();
  }
});

const lifecycleFailed = lifecycle.filter((entry) => !entry.ok).length;
const record = {
  date: new Date().toISOString(),
  engine: "native",
  agda: { executable: agda, version },
  machine: { platform: platform(), release: release(), cpus: cpus().length, cpu: cpus()[0]?.model, memory: totalmem() },
  node: process.version,
  ...report,
  lifecycle,
  totals: {
    shared: { passed: report.passed, failed: report.failed },
    lifecycle: { passed: lifecycle.length - lifecycleFailed, failed: lifecycleFailed },
  },
};
writeFileSync(join(out, "native.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(
  `native: ${report.passed} of ${report.scenarios.length} shared scenarios passed; ` +
    `${lifecycle.length - lifecycleFailed} of ${lifecycle.length} lifecycle checks; ${join(out, "native.json")}`,
);
process.exit(report.failed || lifecycleFailed ? 1 : 0);
