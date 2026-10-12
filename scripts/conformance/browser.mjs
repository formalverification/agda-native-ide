// File: scripts/conformance/browser.mjs
//
// The engine's conformance suite in headless Chromium (issue 62): it
// serves a built site (build/, or `nix build .#site`'s result) without the
// isolation headers, with the conformance harness (built by `make
// conformance-browser` from scripts/conformance/browser/) under
// /__conformance__/, opens the harness with a fresh profile, waits for its
// report, and writes browser.json (what ran, the compiler and the sources
// it checked, every scenario's transcript, the console) into --out.  It
// exits 1 if a scenario or a check failed, or the page threw.
//
//   CHROME=<chromium> node scripts/conformance/browser.mjs <site> --harness DIR [--out DIR]
//   nix run .#conformance-browser -- <site> --harness DIR [--out DIR]

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as cdp from "../browser-check/cdp.mjs";
import { serve } from "../browser-check/serve.mjs";

const TIMEOUT_MS = 300_000;
const PREFIX = "/__conformance__/";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "conformance/browser" },
    harness: { type: "string" },
  },
});
if (positionals.length !== 1 || !options.harness || !process.env.CHROME) {
  console.error("usage: CHROME=<chromium> node browser.mjs <site> --harness DIR [--out DIR]");
  process.exit(2);
}
const site = resolve(positionals[0]);
const harness = resolve(options.harness);
const out = resolve(options.out);
for (const required of [join(site, "index.html"), join(harness, "index.html")])
  if (!existsSync(required)) {
    console.error(`${required} does not exist: build the site and the harness first`);
    process.exit(2);
  }
mkdirSync(out, { recursive: true });
// A run that does not finish leaves no record for the comparison to read.
rmSync(join(out, "browser.json"), { force: true });

const digest = (file) => `sha256:${createHash("sha256").update(readFileSync(join(site, file))).digest("hex")}`;
const compiler = {
  "als-reactor-2.9.0.wasm.gz": digest("als-reactor-2.9.0.wasm.gz"),
  "als-reactor-2.9.0.js": digest("als-reactor-2.9.0.js"),
  "agda-data.zip": digest("agda-data.zip"),
};

const server = await serve({
  root: site,
  answer: (path) => {
    if (!path.startsWith(PREFIX)) return undefined;
    const file = resolve(harness, `.${path.slice(PREFIX.length - 1)}`);
    if (!file.startsWith(harness) || !existsSync(file)) return { status: 404, body: Buffer.from("not found") };
    return { status: 200, body: readFileSync(file.endsWith("/") ? join(file, "index.html") : file) };
  },
});
const consoleLog = [];
let chrome;
let state;
let failure = null;
try {
  chrome = await cdp.launch(process.env.CHROME);
  const page = chrome.page;
  await page.onConsole((entry) => consoleLog.push(entry));
  await page.navigate(`${server.origin}${PREFIX}index.html`);
  const started = performance.now();
  let printed = 0;
  for (;;) {
    state = await page.eval(() => window.__conformance ?? null).catch(() => null);
    for (const line of state?.log?.slice(printed) ?? []) console.log(line);
    printed = state?.log?.length ?? printed;
    if (state?.done) break;
    const thrown = consoleLog.find((entry) => entry.type === "exception");
    if (thrown) throw new Error(`the harness threw: ${thrown.text}`);
    if (performance.now() - started > TIMEOUT_MS) throw new Error(`no report after ${TIMEOUT_MS / 1000} s`);
    await new Promise((done) => setTimeout(done, 250));
  }
  if (state.fatal) throw new Error(`the harness failed: ${state.fatal}`);
} catch (error) {
  failure = String(error?.message ?? error);
  console.error(failure);
} finally {
  await chrome?.close();
  await server.close();
}

const report = state?.report ?? { scenarios: [], passed: 0, failed: 0 };
const lifecycle = state?.lifecycle ?? [];
const lifecycleFailed = lifecycle.filter((entry) => !entry.ok).length;
const record = {
  date: new Date().toISOString(),
  engine: "browser",
  browser: chrome?.product ?? null,
  served: "without the isolation headers",
  site,
  compiler,
  machine: { platform: platform(), release: release(), cpus: cpus().length, cpu: cpus()[0]?.model, memory: totalmem() },
  ...report,
  lifecycle,
  totals: {
    shared: { passed: report.passed, failed: report.failed },
    lifecycle: { passed: lifecycle.length - lifecycleFailed, failed: lifecycleFailed },
  },
  failure,
  console: consoleLog,
};
writeFileSync(join(out, "browser.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(
  `browser: ${report.passed} of ${report.scenarios.length} shared scenarios passed; ` +
    `${lifecycle.length - lifecycleFailed} of ${lifecycle.length} lifecycle checks; ${join(out, "browser.json")}`,
);
process.exit(failure || report.failed || lifecycleFailed || !report.scenarios.length ? 1 : 0);
