// File: scripts/conformance/native.mjs
//
// The engine's conformance suite against native Agda (issue 62): the
// shared scenarios (@agda-native-ide/engine/conformance), each in a fresh
// `agda --interaction-json` under a temporary project root, and then the
// checks of the resources this runner owns: a start that fails, a deadline
// that aborts, a child that cannot answer and is killed, a child that
// crashes, and a disposal that leaves no process.  It writes native.json
// (what ran, the Agda and the sources it checked, every scenario's
// transcript) into --out, and exits 1 if anything failed.
//
//   AGDA=<agda> node scripts/conformance/native.mjs [--out DIR]
//   nix develop .#vscode --command make conformance-native

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runConformance, FIXTURES, SLOW_TERM } from "@agda-native-ide/engine/conformance";
import { startNativeSession } from "@agda-native-ide/engine/native";

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

/** A fresh project root, with its own empty Agda directory so that no
 * library of this machine's reaches the check. */
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "engine-conformance-"));
  mkdirSync(join(root, ".agda"));
  return root;
}

async function open(sessionOptions = {}, config = {}) {
  const root = freshRoot();
  const started = await startNativeSession(
    {
      executable: agda,
      projectRoot: root,
      env: { ...process.env, AGDA_DIR: join(root, ".agda") },
      ...config,
    },
    sessionOptions,
  );
  if (started.kind !== "session") {
    rmSync(root, { recursive: true, force: true });
    return started;
  }
  const { session, transport } = started;
  await transport.writeSource(transport.resolvePath("conformance.agda-lib"), FIXTURES["conformance.agda-lib"]);
  return {
    session,
    transport,
    root: `${transport.root}/`,
    path: (relative) => transport.resolvePath(relative),
    close: async () => {
      await session.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
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
  const failed = await open({}, { executable: "/nonexistent/agda" });
  assert(failed.kind === "failure" && failed.reason === "startup", `expected a startup failure: ${JSON.stringify(failed)}`);
  return { message: failed.message };
});

await check("a start whose Agda exits at once fails, with Agda's words", async () => {
  const failed = await open({}, { args: ["--no-such-option"] });
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
