// File: scripts/library-archives/gate/main.ts
//
// The gate's page (issue 13): agda-algebras' roots checked by the language
// server the site ships, its reactor, in this browser.  For each check the
// plan names (scripts/library-archives/gate.mjs writes it from the index),
// a fresh session of the browser engine, over a drive laid out from the
// site's builtins and standard library and agda-algebras' sources archive
// (a library in the engine's list); a play library beside Main, depending
// on both, as stage.sh writes it; the archives the index names for the
// root, mounted as the page mounts archives; and a load of a Main that
// imports the root under agda-algebras' options line, whose Checking lines
// are the count.  A root passes when Agda type-checked Main alone with no
// error; a control passes when it type-checked more, since a control
// breaks one thing a cold check needs.  It reports in window.__gate.
//
// With `sessions: "shared"`, each of the plan's jobs opens one session and
// checks its roots in turn on it, mounting each root's archives as it
// comes: what the decision between a session per root and a shared one
// measured (docs/notes/library-archives.md).

import JSZip from "jszip";

import { startBrowserSession, type BrowserConfig, type BrowserTransport } from "@agda-native-ide/engine/browser";
import type { AgdaSession } from "@agda-native-ide/engine";

interface Check {
  /** The root, or `control:NAME` for a control. */
  name: string;
  root: string;
  /** The archives to mount, by their paths under the plan's archives. */
  archives: string[];
  bytes: number;
  modules: number;
  /** A control: what it breaks. */
  control?: "drop_own_archive" | "change_a_source_byte";
  /** For change_a_source_byte: the root's source on the drive. */
  source?: string;
}

interface Plan {
  compiler: { url: string; bytes: number };
  glue: string;
  builtin: string;
  stdlib: string;
  /** The libraries on the drive, after the standard library. */
  libraries: { url: string; agdaLib: string; name: string }[];
  archivesBase: string;
  /** The play library: its directory on the drive (the transport's
   * root), its .agda-lib, and that file's text, as stage.sh writes it. */
  play: { root: string; agdaLib: string; text: string };
  mainOptions: string;
  jobs: number;
  sessions: "fresh" | "shared";
  loadDeadlineMs: number;
  checks: Check[];
}

interface Result {
  name: string;
  root: string;
  control?: string;
  ok: boolean;
  checking: string[];
  errors: string[];
  warnings: number;
  /** A failure to start, mount or load, in the engine's words. */
  failure?: string;
  modules: number;
  archives: number;
  bytes: number;
  /** Milliseconds: the engine's start, the archives' mount, Agda's load
   * (the session's own count), and the whole check. */
  startMs?: number;
  mountMs?: number;
  loadMs?: number;
  totalMs: number;
  /** The reactor's linear memory when the check ended: its peak. */
  memoryBytes: number | null;
  job: number;
  startedAt: number;
}

const state: {
  done: boolean;
  results: Result[];
  log: string[];
  fatal?: string;
  plan?: { checks: number; jobs: number; sessions: string };
  /** The version the server's Agda reports. */
  agdaVersion?: string;
} = { done: false, results: [], log: [] };
(window as unknown as { __gate: typeof state }).__gate = state;
const log = (line: string) => {
  state.log.push(line);
  document.querySelector("#log")!.textContent += `${line}\n`;
};

const memoryChannel = new BroadcastChannel("library-gate-memory");
/** The reactor's memory in the worker named `name`, or null. */
function memoryOf(name: string): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      memoryChannel.removeEventListener("message", listen);
      resolve(null);
    }, 5_000);
    const listen = (event: MessageEvent<{ name?: string; bytes?: number | null }>) => {
      if (event.data?.name !== name) return;
      clearTimeout(timer);
      memoryChannel.removeEventListener("message", listen);
      resolve(event.data.bytes ?? null);
    };
    memoryChannel.addEventListener("message", listen);
    memoryChannel.postMessage({ ask: name });
  });
}

/** The root's source with its first byte changed, as a zip at its path on
 * the drive (check.sh's change_a_source_byte): x, or y where it was x. */
async function changedSource(plan: Plan, source: string) {
  const sources = await fetch(plan.libraries[0].url).then((response) => response.arrayBuffer());
  const path = source.replace(/^\//, "");
  const entry = (await JSZip.loadAsync(sources)).file(path);
  if (!entry) throw new Error(`${path} is not in the sources archive`);
  const bytes = await entry.async("uint8array");
  bytes[0] = bytes[0] === 0x78 ? 0x79 : 0x78;
  const zip = new JSZip();
  zip.file(path, bytes);
  const blob = await zip.generateAsync({ type: "blob" });
  return URL.createObjectURL(blob);
}

let sessionCount = 0;

/** A fresh session, its drive laid out with the libraries and the play
 * library written. */
async function open(plan: Plan, name: string) {
  const worker = `Agda ${++sessionCount} ${name}`;
  const config: BrowserConfig = {
    createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: worker }),
    compiler: { url: plan.compiler.url, byteLength: plan.compiler.bytes },
    glueUrl: new URL(plan.glue, location.href).href,
    archives: { builtin: plan.builtin, stdlib: plan.stdlib, libraries: plan.libraries },
    // Its own, so that no session restores what another persisted (none
    // persists: the page never asks).
    cacheNamespace: `library-gate-${sessionCount}`,
    args: ["--raw", "+AGDA", "--interaction", "-AGDA"],
    root: plan.play.root,
  };
  const started = await startBrowserSession(config, { deadlines: { load: plan.loadDeadlineMs } });
  if (started.kind !== "session") throw new Error(`the engine did not start: ${started.message}`);
  const { session, transport } = started;
  state.agdaVersion ??= session.agdaVersion;
  await transport.writeSource(plan.play.agdaLib, plan.play.text);
  return { session, transport, worker };
}

/** Mount the check's archives, and load a Main importing its root. */
async function check(
  plan: Plan,
  target: { session: AgdaSession; transport: BrowserTransport; worker: string },
  item: Check,
  job: number,
  started: number,
  startMs: number | undefined,
): Promise<Result> {
  const base = {
    name: item.name,
    root: item.root,
    ...(item.control ? { control: item.control } : {}),
    modules: item.modules,
    archives: item.archives.length,
    bytes: item.bytes,
    job,
    startedAt: Math.round(started),
    ...(startMs === undefined ? {} : { startMs }),
  };
  const mountStarted = performance.now();
  const urls = item.archives.map((path) => `${plan.archivesBase}${path}`);
  // Mounted last, so that the changed source replaces the one laid out.
  const changed = item.control === "change_a_source_byte" ? await changedSource(plan, item.source!) : undefined;
  try {
    await target.transport.mountArchives(changed ? [...urls, changed] : urls);
  } finally {
    if (changed) URL.revokeObjectURL(changed);
  }
  const mountMs = Math.round(performance.now() - mountStarted);
  const text = `${plan.mainOptions}\nmodule Main where\nimport ${item.root}\n`;
  const loaded = await target.session.load(`${plan.play.root}Main.agda`, text);
  const memoryBytes = await memoryOf(target.worker);
  const totalMs = Math.round(performance.now() - started);
  if (loaded.kind !== "answer")
    return {
      ...base,
      ok: false,
      checking: [],
      errors: [],
      warnings: 0,
      failure: `${loaded.kind}: ${loaded.message}`,
      mountMs,
      totalMs,
      memoryBytes,
    };
  const { checking, errors, warnings } = loaded.value;
  const ok = item.control
    ? checking.length > 1
    : errors.length === 0 && checking.length === 1 && checking[0] === "Main";
  return {
    ...base,
    ok,
    checking,
    errors: errors.slice(0, 3).map((error) => error.slice(0, 2_000)),
    warnings: warnings.length,
    mountMs,
    loadMs: Math.round(loaded.elapsedMs),
    totalMs,
    memoryBytes,
  };
}

function report(result: Result) {
  state.results.push(result);
  const seconds = (ms: number | undefined) => (ms === undefined ? "-" : (ms / 1000).toFixed(1));
  const mib = result.memoryBytes === null ? "-" : `${Math.round(result.memoryBytes / 2 ** 20)} MiB`;
  log(
    `${result.ok ? "ok  " : "FAIL"} ${result.name} checking=${result.checking.length} ` +
      `[${result.checking.slice(0, 4).join(" ")}${result.checking.length > 4 ? " ..." : ""}] ` +
      `start ${seconds(result.startMs)} s, mount ${seconds(result.mountMs)} s, load ${seconds(result.loadMs)} s, ` +
      `${mib}${result.failure ? `; ${result.failure}` : ""}${result.errors.length ? `; ${result.errors[0].slice(0, 300)}` : ""}`,
  );
}

/** A check that could not run to its load. */
function failed(item: Check, job: number, started: number, error: unknown): Result {
  return {
    name: item.name,
    root: item.root,
    ...(item.control ? { control: item.control } : {}),
    ok: false,
    checking: [],
    errors: [],
    warnings: 0,
    failure: error instanceof Error ? error.message : String(error),
    modules: item.modules,
    archives: item.archives.length,
    bytes: item.bytes,
    totalMs: Math.round(performance.now() - started),
    memoryBytes: null,
    job,
    startedAt: Math.round(started),
  };
}

/** Each check in a session of its own. */
async function fresh(plan: Plan, item: Check, job: number) {
  const started = performance.now();
  let target: Awaited<ReturnType<typeof open>> | undefined;
  try {
    target = await open(plan, item.name);
    const startMs = Math.round(performance.now() - started);
    report(await check(plan, target, item, job, started, startMs));
  } catch (error) {
    report(failed(item, job, started, error));
  } finally {
    await target?.session.dispose();
  }
}

async function run(plan: Plan) {
  const roots = plan.checks.filter((item) => !item.control);
  const controls = plan.checks.filter((item) => item.control);
  state.plan = { checks: plan.checks.length, jobs: plan.jobs, sessions: plan.sessions };
  log(`${roots.length} roots and ${controls.length} controls, ${plan.jobs} at once, sessions ${plan.sessions}`);

  let next = 0;
  const jobs = Array.from({ length: Math.min(plan.jobs, roots.length) }, async (_, job) => {
    if (plan.sessions === "fresh") {
      for (let item = roots[next++]; item; item = roots[next++]) await fresh(plan, item, job);
      return;
    }
    const started = performance.now();
    const target = await open(plan, `job ${job}`);
    // The session's start is the first check's.
    let startMs: number | undefined = Math.round(performance.now() - started);
    try {
      for (let item = roots[next++]; item; item = roots[next++], startMs = undefined) {
        const checkStarted = performance.now();
        try {
          report(await check(plan, target, item, job, checkStarted, startMs));
        } catch (error) {
          report(failed(item, job, checkStarted, error));
        }
      }
    } finally {
      await target.session.dispose();
    }
  });
  await Promise.all(jobs);
  // The controls last, each in a session of its own, as check.sh runs them.
  for (const item of controls) await fresh(plan, item, 0);
}

try {
  const plan: Plan = await fetch(new URL("./plan.json", location.href)).then((response) => response.json());
  await run(plan);
} catch (error) {
  state.fatal = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  log(`FATAL ${state.fatal}`);
} finally {
  state.done = true;
}
