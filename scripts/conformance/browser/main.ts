// File: scripts/conformance/browser/main.ts
//
// The conformance suite against the browser engine (issue 62): the shared
// scenarios (@agda-native-ide/engine/conformance), each in a fresh worker
// running the page's reactor over a drive laid out from the page's own
// builtins, and then the checks of what this page owns: a start that fails
// (and the worker it leaves), a deadline that aborts, a worker that stops
// answering, which the deadline ends, and a disposal that terminates the
// worker.  It runs in headless Chromium beside a built site, whose
// compiler and archives it fetches (scripts/conformance/browser.mjs), and
// leaves its report in window.__conformance.

import { startBrowserSession, type BrowserConfig } from "@agda-native-ide/engine/browser";
import { FIXTURES, runConformance, SLOW_TERM } from "@agda-native-ide/engine/conformance";

interface Lifecycle {
  name: string;
  ok: boolean;
  elapsedMs: number;
  detail?: unknown;
  error?: string;
}

const state: { done: boolean; report?: unknown; lifecycle: Lifecycle[]; log: string[]; fatal?: string } = {
  done: false,
  lifecycle: [],
  log: [],
};
(window as unknown as { __conformance: typeof state }).__conformance = state;
const log = (line: string) => {
  state.log.push(line);
  document.querySelector("#log")!.textContent += `${line}\n`;
};

const params = new URLSearchParams(location.search);
const asset = (name: string) => new URL(`/${name}?cache=${params.get("cache") ?? ""}`, location.href).href;

/** Workers this page made, and whether each was terminated. */
const workers: { worker: Worker; terminated: boolean }[] = [];
function createWorker() {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "Agda" });
  const entry = { worker, terminated: false };
  const terminate = worker.terminate.bind(worker);
  worker.terminate = () => {
    entry.terminated = true;
    terminate();
  };
  workers.push(entry);
  return worker;
}

const config = (overrides: Partial<BrowserConfig> = {}): BrowserConfig => ({
  createWorker,
  compiler: { url: asset("als-reactor-2.9.0.wasm.gz"), byteLength: Number(params.get("bytes")) || undefined },
  glueUrl: asset("als-reactor-2.9.0.js"),
  archives: { builtin: asset("agda-data.zip") },
  cacheNamespace: "conformance",
  // --raw: the server answers in Agda's own JSON.  The page starts it so.
  args: ["--raw", "+AGDA", "--interaction", "-AGDA"],
  root: "/conformance/",
  ...overrides,
});

async function open(sessionOptions = {}, overrides: Partial<BrowserConfig> = {}) {
  const started = await startBrowserSession(config(overrides), sessionOptions);
  if (started.kind !== "session") return started;
  const { session, transport } = started;
  await transport.writeSource(transport.resolvePath("conformance.agda-lib"), FIXTURES["conformance.agda-lib"]);
  return {
    session,
    transport,
    root: "/conformance/",
    path: (relative: string) => transport.resolvePath(relative),
    close: () => session.dispose(),
  };
}

async function check(name: string, run: () => Promise<unknown>) {
  const started = performance.now();
  try {
    const detail = await run();
    state.lifecycle.push({ name, ok: true, elapsedMs: Math.round(performance.now() - started), detail });
    log(`ok   ${name}`);
  } catch (error) {
    state.lifecycle.push({
      name,
      ok: false,
      elapsedMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    });
    log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

try {
  state.report = await runConformance({ engine: "browser", open: () => open() }, log);

  await check("a start whose compiler is missing fails, saying which file, and makes no worker", async () => {
    const before = workers.length;
    const failed = await open({}, { compiler: { url: asset("missing.wasm.gz") } });
    assert(failed.kind === "failure" && failed.reason === "startup", `expected a startup failure: ${JSON.stringify(failed)}`);
    assert(/^the compiler could not be downloaded \(HTTP 404/.test(failed.message), failed.message);
    assert(workers.length === before, "no worker was made");
    return { message: failed.message };
  });

  await check("a start whose compiler is not a compiler fails, and terminates its worker", async () => {
    const before = workers.length;
    const failed = await open({}, { compiler: { url: asset("agda-data.zip") } });
    assert(failed.kind === "failure" && failed.reason === "startup", `expected a startup failure: ${JSON.stringify(failed)}`);
    assert(/^the compiler could not be loaded/.test(failed.message), failed.message);
    assert(workers.length === before + 1 && workers.at(-1)!.terminated, "its worker was terminated");
    return { message: failed.message };
  });

  await check("a deadline aborts the command, and the session goes on", async () => {
    const target = await open({ deadlines: { normalize: 1000 } });
    assert(!("kind" in target), "opened");
    try {
      await target.session.load(target.path("Slow.agda"), FIXTURES["Slow.agda"]);
      const slow = await target.session.normalize(SLOW_TERM);
      assert(slow.kind === "failure" && slow.reason === "timeout", `expected a timeout: ${JSON.stringify(slow)}`);
      assert(slow.detail?.terminated === false, "Agda ended the command itself");
      assert(slow.responses?.some((response) => response.kind === "DoneAborting"), "with DoneAborting");
      assert(target.session.basis === undefined, "Agda forgot its file");
      const after = await target.session.version();
      assert(after.kind === "answer", "the session still answers");
      return { failure: slow.message };
    } finally {
      await target.close();
    }
  });

  await check("a worker that stops answering is ended by the deadline, and nothing waits", async () => {
    const target = await open({ deadlines: { normalize: 600 }, abortGraceMs: 600 });
    assert(!("kind" in target), "opened");
    const entry = workers.at(-1)!;
    try {
      await target.session.load(target.path("Slow.agda"), FIXTURES["Slow.agda"]);
      const slow = target.session.normalize(SLOW_TERM);
      const waiting = target.session.version();
      // The worker dies without a word, as a crashed worker does: no event
      // reaches the page.
      setTimeout(() => entry.worker.terminate(), 200);
      const [stuck, queued] = await Promise.all([slow, waiting]);
      assert(
        stuck.kind === "failure" && stuck.reason === "timeout" && stuck.detail?.terminated === true,
        `expected the deadline to end it: ${JSON.stringify(stuck)}`,
      );
      assert(queued.kind === "failure" && queued.reason === "session-ended", `the queued operation fails: ${JSON.stringify(queued)}`);
      const refused = await target.session.version();
      assert(refused.kind === "refusal" && refused.reason === "session-ended", "the session refuses");
      return { failure: stuck.message };
    } finally {
      await target.close();
    }
  });

  await check("disposal terminates the worker", async () => {
    const target = await open();
    assert(!("kind" in target), "opened");
    const entry = workers.at(-1)!;
    assert(!entry.terminated, "the worker runs");
    await target.close();
    assert(entry.terminated, "the worker was terminated");
    const refused = await target.session.version();
    assert(refused.kind === "refusal" && refused.reason === "session-ended", "the session refuses");
    return {};
  });

  // Every worker this page made is gone.
  state.lifecycle.push({
    name: "every worker made was terminated",
    ok: workers.every((entry) => entry.terminated),
    elapsedMs: 0,
    detail: { workers: workers.length },
  });
} catch (error) {
  state.fatal = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  log(`FATAL ${state.fatal}`);
} finally {
  state.done = true;
}
