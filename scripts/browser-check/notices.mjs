// File: scripts/browser-check/notices.mjs
//
// The page's notices (issue 8): what a reader sees when the page cannot
// run in their browser, or when Agda cannot start.  For each case below it
// serves a built site, opens it in headless Chromium with a fresh profile,
// and asserts the page's banner, the inspector's heading and the status
// bar, which must say that Agda did not start and never "Agda ready":
//
//   no DecompressionStream  the browser lacks it (removed before the page
//                           loads): the page names what is missing and the
//                           browsers it is tested in, and fetches no
//                           compiler;
//   compiler not found      the compiler's request fails (the server
//                           answers 404);
//   compiler corrupt        the compiler's gzip is not a gzip (the server
//                           answers bytes that do not inflate), so its
//                           decompression fails in the worker;
//   standard library cut    the standard library's transfer breaks off
//     short                 after its headers (the server drops the
//                           connection halfway), so reading its body fails.
//
// It writes notices.json (each case's page state, requests and console)
// and a screenshot per case into --out, and exits 1 when a case fails.
// --browser firefox drives a Firefox through WebDriver BiDi (./bidi.mjs).
//
//   CHROME=<chromium> node scripts/browser-check/notices.mjs <site> [--out DIR]
//   FIREFOX=<firefox> node scripts/browser-check/notices.mjs <site> --browser firefox [--out DIR]
//   nix run .#browser-check-notices -- <site> [--out DIR]

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as cdp from "./cdp.mjs";
import * as bidi from "./bidi.mjs";
import { serve } from "./serve.mjs";

/** The compiler, as the page fetches it (scripts/asset-manifest.mjs). */
const COMPILER_GZ = /\/als-reactor-[^/]*\.wasm\.gz$/;

/** The standard library's archive. */
const STDLIB_ZIP = /\/agda-stdlib-[^/]*\.zip$/;

/** The browsers the page names as tested (src/lib/support.ts). */
const TESTED = "The page is tested in Chromium and Firefox; other browsers are not supported.";

const CASES = [
  {
    name: "no DecompressionStream",
    initScript: "delete globalThis.DecompressionStream;",
    banner: `This browser cannot run Agda here: it lacks DecompressionStream. ${TESTED}`,
    fetchesCompiler: false,
  },
  {
    name: "compiler not found",
    answer: (/** @type {string} */ path) =>
      COMPILER_GZ.test(path)
        ? { status: 404, body: Buffer.from("not found") }
        : undefined,
    banner:
      "Agda could not start: the compiler could not be downloaded (HTTP 404 Not Found).",
    fetchesCompiler: true,
  },
  {
    name: "compiler corrupt",
    answer: (/** @type {string} */ path) =>
      COMPILER_GZ.test(path)
        ? { status: 200, body: Buffer.alloc(4096, 0x5a) }
        : undefined,
    // The decompressor's own words vary by browser; the page names the
    // step that failed.
    banner: /^Agda could not start: the compiler could not be loaded \(.+\)\.$/,
    fetchesCompiler: true,
  },
  {
    name: "standard library cut short",
    answer: (/** @type {string} */ path) =>
      STDLIB_ZIP.test(path)
        ? { status: 200, body: Buffer.alloc(65_536, 0x5a), cut: true }
        : undefined,
    // The network error's words vary by browser; the page names the file.
    banner:
      /^Agda could not start: the standard library could not be downloaded \(.+\)\.$/,
    fetchesCompiler: true,
  },
];

const STEP_TIMEOUT_MS = 60_000;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "browser-check/notices" },
    browser: { type: "string", default: "chromium" },
  },
});
const driver = { chromium: { launch: cdp.launch, executable: process.env.CHROME },
  firefox: { launch: bidi.launch, executable: process.env.FIREFOX } }[
  options.browser
];
if (positionals.length !== 1 || !driver?.executable) {
  console.error(
    "usage: CHROME=<chromium> node notices.mjs <site> [--out DIR]\n" +
      "       FIREFOX=<firefox> node notices.mjs <site> --browser firefox [--out DIR]",
  );
  process.exit(2);
}
const site = resolve(positionals[0]);
if (!existsSync(join(site, "index.html"))) {
  console.error(
    `${site}/index.html does not exist: build the site first (make build, or nix build .#site)`,
  );
  process.exit(2);
}
const out = resolve(options.out);
mkdirSync(out, { recursive: true });

/** What the page shows, read from its DOM. */
const state = () => ({
  banner: document.querySelector(".fatal-banner")?.textContent?.trim() ?? null,
  status:
    document.querySelector(".inspector-status")?.textContent?.trim() ?? "",
  bar: [...document.querySelectorAll(".statusbar > span")]
    .map((span) => span.textContent?.replace(/\s+/g, " ").trim())
    .join(" | "),
  now: Math.round(performance.now()),
});

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Run one case in a fresh profile; return its record. */
async function check(/** @type {(typeof CASES)[number]} */ test) {
  const record = /** @type {Record<string, any>} */ ({ name: test.name });
  const consoleLog = /** @type {object[]} */ ([]);
  /** @type {Awaited<ReturnType<typeof serve>> | undefined} */
  let server;
  /** @type {{ product: string, page: any, close: () => Promise<void> } | undefined} */
  let chrome;
  try {
    server = await serve({ root: site, answer: test.answer });
    chrome = await driver.launch(/** @type {string} */ (driver.executable));
    const { page } = chrome;
    record.browser = chrome.product;
    await page.onConsole((/** @type {object} */ entry) => consoleLog.push(entry));
    if (test.initScript) await page.addInitScript(test.initScript);
    await page.navigate(`${server.origin}/`);

    const start = performance.now();
    let shown = await page.eval(state);
    while (!shown.banner && performance.now() - start < STEP_TIMEOUT_MS) {
      await new Promise((done) => setTimeout(done, 100));
      shown = await page.eval(state);
    }
    record.shown = shown;
    record.requests = server.log;
    writeFileSync(
      join(out, `${test.name.replace(/\W+/g, "-")}.png`),
      await page.screenshot(),
    );
    assert(
      shown.banner !== null,
      `no notice after ${STEP_TIMEOUT_MS / 1000} s; the page shows ${JSON.stringify(shown)}`,
    );
    assert(
      typeof test.banner === "string"
        ? shown.banner === test.banner
        : test.banner.test(shown.banner),
      `the notice is ${JSON.stringify(shown.banner)}, expected ${test.banner}`,
    );
    assert(
      shown.status === "Agda did not start",
      `the inspector says ${JSON.stringify(shown.status)}`,
    );
    assert(
      shown.bar.split(" | ").includes("Agda did not start") &&
        !/Agda ready/.test(shown.bar),
      `the status bar says ${JSON.stringify(shown.bar)}`,
    );
    const fetched = server.log.some((r) => COMPILER_GZ.test(r.url.split("?")[0]));
    assert(
      fetched === test.fetchesCompiler,
      test.fetchesCompiler
        ? "the page never asked for the compiler"
        : "the page asked for the compiler, which this browser cannot run",
    );
  } catch (error) {
    record.failure = error instanceof Error ? error.message : String(error);
  } finally {
    record.console = consoleLog;
    await chrome?.close();
    await server?.close();
  }
  return record;
}

const results = [];
for (const test of CASES) {
  const record = await check(test);
  results.push(record);
  console.log(
    record.failure
      ? `FAILED  ${test.name}: ${record.failure}`
      : `ok  ${test.name}: ${record.shown.banner}`,
  );
}
writeFileSync(
  join(out, "notices.json"),
  JSON.stringify(
    { site, date: new Date().toISOString(), cases: results },
    null,
    1,
  ) + "\n",
);
const failed = results.filter((r) => r.failure);
const summary = [
  `### The page's notices: ${failed.length ? "failed" : "passed"}`,
  "",
  `${results[0]?.browser ?? ""}, ${new Date().toISOString()}`,
  "",
  "| Case | Notice |",
  "|---|---|",
  ...results.map(
    (r) =>
      `| ${r.name} | ${r.failure ? `**failed**: ${r.failure}` : r.shown.banner} |`,
  ),
  "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
process.exit(failed.length ? 1 : 0);
