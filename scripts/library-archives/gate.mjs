// File: scripts/library-archives/gate.mjs
//
// The gate (issue 13): prove that the language server the site ships, its
// reactor, accepts agda-algebras' archives in a browser.  It serves a
// built site without the isolation headers, the gate's page (built by
// `make library-gate` from scripts/library-archives/gate/) under
// /__gate__/, and the archives (`nix build .#agda-algebras-archives`) under
// /__archives__/; writes the page's plan from the index (index.mjs's
// `needs`, as check.sh stages each root); opens the page in headless
// Chromium with a fresh profile; and polls its report, since a check can
// outlast a DevTools command's minute.  Each root must type-check Main
// alone, with no error, and then two controls on CONTROL_ROOT must
// type-check more: the root's own archive left out, and the first byte of
// its source changed under its interface.  It writes report.json and
// report.txt into --out, and exits 1 if a check failed, 2 on bad input.
//
// The site's builtins and standard library must be the ones the archives
// were built against (the index's digests), or the check would measure
// other inputs, and it stops.
//
//   CHROME=<chromium> node scripts/library-archives/gate.mjs <site>
//     --harness DIR --archives DIR [--out DIR] [--root ROOT]... [--jobs N]
//     [--no-controls] [--shared]
//   nix run .#library-gate -- <site> --harness DIR --archives DIR ...
//
//   --root    a root to check, repeatable (default: every root of the index)
//   --jobs    checks at once, each a worker of its own (default 4)
//   --shared  one session per job, its roots checked in turn on it, where
//             each check otherwise has a fresh one: what the choice between
//             them measured (docs/notes/library-archives.md), and a quick
//             run while iterating, which does not prove the criterion
//   env: CONTROL_ROOT, the controls' root (default Overture.Basic)

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, release, totalmem } from "node:os";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import * as cdp from "../browser-check/cdp.mjs";
import { serve } from "../browser-check/serve.mjs";
import { listed, needs, readIndex } from "./index.mjs";

const GATE = "/__gate__/";
const ARCHIVES = "/__archives__/";
/** agda-algebras' options line, which every module of it carries. */
const MAIN_OPTIONS = "{-# OPTIONS --without-K --exact-split --safe #-}";
const CONTROL_ROOT = process.env.CONTROL_ROOT ?? "Overture.Basic";
/** The longest a check may go without a result before the gate gives up;
 * every load has its own deadline (LOAD_DEADLINE_MS) well under it. */
const STALL_MS = 20 * 60_000;
const LOAD_DEADLINE_MS = 10 * 60_000;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    harness: { type: "string" },
    archives: { type: "string" },
    out: { type: "string", default: "library-gate" },
    root: { type: "string", multiple: true },
    jobs: { type: "string", default: "4" },
    "no-controls": { type: "boolean", default: false },
    shared: { type: "boolean", default: false },
  },
});
const usage =
  "usage: CHROME=<chromium> node gate.mjs <site> --harness DIR --archives DIR [--out DIR] [--root ROOT]... [--jobs N] [--no-controls] [--shared]";
const jobs = Number(options.jobs);
if (positionals.length !== 1 || !options.harness || !options.archives || !process.env.CHROME || !Number.isInteger(jobs) || jobs < 1) {
  console.error(usage);
  process.exit(2);
}
const site = resolve(positionals[0]);
const harness = resolve(options.harness);
const archives = resolve(options.archives);
const out = resolve(options.out);
const indexPath = join(archives, "index.json");
for (const required of [join(site, "index.html"), join(harness, "index.html"), indexPath])
  if (!existsSync(required)) {
    console.error(`${required} does not exist: build the site, the gate's page and the archives first`);
    process.exit(2);
  }

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const index = readIndex(indexPath);
const builtins = index.libraries.builtins.sources;
const stdlib = index.libraries["standard-library"].sources;
const algebras = index.libraries["agda-algebras"];
for (const { path, sha256: expected } of [builtins, stdlib]) {
  const shipped = join(site, path);
  const actual = existsSync(shipped) ? sha256(shipped) : "missing";
  if (actual !== expected) {
    console.error(
      `the site's ${path} is ${actual}, but the archives were built against ${expected}: rebuild them, or check another site`,
    );
    process.exit(2);
  }
}

const roots = options.root ?? index.roots;
const unlisted = roots.filter((root) => !listed(index, root));
if (unlisted.length || !listed(index, CONTROL_ROOT)) {
  console.error(`not in the index: ${[...unlisted, ...(listed(index, CONTROL_ROOT) ? [] : [CONTROL_ROOT])].join(" ")}`);
  process.exit(2);
}
const checkOf = (root) => {
  const need = needs(index, [root]);
  return { name: root, root, archives: need.archives, bytes: need.bytes, modules: need.modules };
};
const checks = roots.map(checkOf);
if (!options["no-controls"]) {
  const control = checkOf(CONTROL_ROOT);
  const own = index.modules[CONTROL_ROOT].archive;
  const left = control.archives.filter((archive) => archive !== own);
  checks.push(
    {
      ...control,
      name: "control:drop_own_archive",
      control: "drop_own_archive",
      archives: left,
      bytes: left.reduce((sum, path) => sum + index.archives[path].bytes, 0),
    },
    {
      ...control,
      name: "control:change_a_source_byte",
      control: "change_a_source_byte",
      source: index.modules[CONTROL_ROOT].source,
    },
  );
}

// The play library, as stage.sh's write_play_library writes it.
const play = {
  root: "/play/",
  agdaLib: "/play/play.agda-lib",
  text: `name: play\ndepend: ${index.libraries["standard-library"].name} ${algebras.name}\ninclude: .\n`,
};
const compressed = join(site, "als-reactor-2.9.0.wasm.gz");
const plan = {
  compiler: { url: "/als-reactor-2.9.0.wasm.gz", bytes: gunzipSync(readFileSync(compressed)).length },
  glue: "/als-reactor-2.9.0.js",
  builtin: `/${builtins.path}`,
  stdlib: `/${stdlib.path}`,
  libraries: [{ url: `${ARCHIVES}${algebras.sources.path}`, agdaLib: algebras.agdaLib, name: algebras.name }],
  archivesBase: ARCHIVES,
  play,
  mainOptions: MAIN_OPTIONS,
  jobs,
  sessions: options.shared ? "shared" : "fresh",
  loadDeadlineMs: LOAD_DEADLINE_MS,
  checks,
};
const planBody = Buffer.from(JSON.stringify(plan));

mkdirSync(out, { recursive: true });
// A run that does not finish leaves no report to be mistaken for its.
rmSync(join(out, "report.json"), { force: true });
rmSync(join(out, "report.txt"), { force: true });

/** A file under `dir` at `path`, or null. */
const fileUnder = (dir, path) => {
  const file = resolve(dir, `.${path}`);
  return file.startsWith(dir + sep) && existsSync(file) && statSync(file).isFile() ? file : null;
};
const server = await serve({
  root: site,
  answer: (path) => {
    if (path === `${GATE}plan.json`) return { status: 200, body: planBody };
    for (const [prefix, dir] of [
      [GATE, harness],
      [ARCHIVES, archives],
    ]) {
      if (!path.startsWith(prefix)) continue;
      const file = fileUnder(dir, path.slice(prefix.length - 1));
      return file ? { status: 200, body: readFileSync(file) } : { status: 404, body: Buffer.from("not found") };
    }
    return undefined;
  },
});

const consoleLog = [];
const results = [];
const load = { start: loadavg().map((x) => Number(x.toFixed(2))) };
const started = new Date();
let chrome;
let state;
let failure = null;
try {
  chrome = await cdp.launch(process.env.CHROME);
  const page = chrome.page;
  await page.onConsole((entry) => consoleLog.push(entry));
  await page.navigate(`${server.origin}${GATE}index.html`);
  console.log(
    `gate: ${started.toISOString()}, load ${load.start.join(" ")}, ${chrome.product}, ` +
      `${checks.length} checks, ${jobs} at once, sessions ${plan.sessions}`,
  );
  let printed = 0;
  let lastProgress = performance.now();
  for (;;) {
    state = await page
      .eval(
        ([from, logged]) => {
          const gate = window.__gate;
          return gate
            ? {
                done: gate.done,
                fatal: gate.fatal,
                agdaVersion: gate.agdaVersion,
                results: gate.results.slice(from),
                log: gate.log.slice(logged),
              }
            : null;
        },
        [results.length, printed],
      )
      .catch(() => null);
    for (const line of state?.log ?? []) console.log(line);
    printed += state?.log?.length ?? 0;
    if (state?.results?.length) {
      results.push(...state.results);
      lastProgress = performance.now();
    }
    if (state?.done) break;
    const thrown = consoleLog.find((entry) => entry.type === "exception");
    if (thrown) throw new Error(`the page threw: ${thrown.text}`);
    if (performance.now() - lastProgress > STALL_MS)
      throw new Error(`no check finished in ${STALL_MS / 60_000} minutes`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
  if (state.fatal) throw new Error(`the page failed: ${state.fatal}`);
} catch (error) {
  failure = String(error?.message ?? error);
  console.error(failure);
} finally {
  await chrome?.close();
  await server.close();
}
const finished = new Date();
load.end = loadavg().map((x) => Number(x.toFixed(2)));

const rootResults = results.filter((result) => !result.control);
const controlResults = results.filter((result) => result.control);
const passed = rootResults.filter((result) => result.ok).length;
const missing = checks.filter((item) => !results.some((result) => result.name === item.name)).map((item) => item.name);
const byLoad = [...rootResults].filter((r) => r.loadMs !== undefined).sort((a, b) => b.loadMs - a.loadMs);
const byMemory = [...rootResults].filter((r) => r.memoryBytes !== null).sort((a, b) => b.memoryBytes - a.memoryBytes);
const sum = (key) => rootResults.reduce((total, result) => total + (result[key] ?? 0), 0);
const served = server.log.filter((entry) => entry.status === 200);

const record = {
  date: started.toISOString(),
  finished: finished.toISOString(),
  wallSeconds: Math.round((finished - started) / 1000),
  browser: chrome?.product ?? null,
  agdaVersion: state?.agdaVersion ?? null,
  served: "without the isolation headers",
  site,
  compiler: Object.fromEntries(
    ["als-reactor-2.9.0.wasm.gz", "als-reactor-2.9.0.js", builtins.path, stdlib.path].map((file) => [
      file,
      `sha256:${sha256(join(site, file))}`,
    ]),
  ),
  archives: {
    path: archives,
    index: `sha256:${sha256(indexPath)}`,
    agda: index.agda,
    agdaAlgebras: algebras.commit,
  },
  machine: { platform: platform(), release: release(), cpus: cpus().length, cpu: cpus()[0]?.model, memory: totalmem() },
  load,
  jobs,
  sessions: plan.sessions,
  mainOptions: MAIN_OPTIONS,
  play: play.text,
  totals: {
    roots: checks.filter((item) => !item.control).length,
    passed,
    failed: rootResults.length - passed,
    missing,
    controls: controlResults.map((result) => ({ name: result.name, ok: result.ok, checking: result.checking.length })),
    seconds: { start: sum("startMs") / 1000, mount: sum("mountMs") / 1000, load: sum("loadMs") / 1000, total: sum("totalMs") / 1000 },
    slowest: byLoad.slice(0, 5).map((result) => ({ root: result.root, loadSeconds: result.loadMs / 1000 })),
    largestMemory: byMemory.slice(0, 5).map((result) => ({ root: result.root, memoryBytes: result.memoryBytes })),
    requests: served.length,
    bytesServed: served.reduce((total, entry) => total + entry.bytes, 0),
  },
  failure,
  results,
  console: consoleLog.filter((entry) => entry.type !== "log").slice(0, 200),
};
writeFileSync(join(out, "report.json"), `${JSON.stringify(record, null, 2)}\n`);
const seconds = (ms) => (ms === undefined ? "-" : (ms / 1000).toFixed(2));
writeFileSync(
  join(out, "report.txt"),
  [
    "check ok checking modules archives bytes start mount load total memory",
    ...[...rootResults, ...controlResults].map((result) =>
      [
        result.name,
        result.ok ? 1 : 0,
        result.checking.length,
        result.modules,
        result.archives,
        result.bytes,
        seconds(result.startMs),
        seconds(result.mountMs),
        seconds(result.loadMs),
        seconds(result.totalMs),
        result.memoryBytes ?? "-",
      ].join(" "),
    ),
  ].join("\n") + "\n",
);

const controlsOk = options["no-controls"] || (controlResults.length === 2 && controlResults.every((result) => result.ok));
console.log(
  `gate: ${passed} of ${record.totals.roots} roots type-checked Main alone` +
    (options["no-controls"] ? "" : `; the controls: ${controlResults.map((r) => `${r.name} ${r.checking.length}`).join(", ")}`) +
    `; ${record.wallSeconds} s; ${join(out, "report.json")}`,
);
process.exit(failure || missing.length || passed !== record.totals.roots || !controlsOk ? 1 : 0);
