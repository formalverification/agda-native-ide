// File: scripts/browser-check/run.mjs
//
// The browser check (issue 5).  It serves a built site, opens it in
// headless Chromium (or Firefox) with a fresh profile, and uses it as a
// reader would, through the page alone, as follows:
//
//   1.  waits for "Agda ready", then for the automatic first check of the
//       default Main.agda, and asserts crossOriginIsolated as the server
//       made it (false by default: the page needs no isolation since issue
//       59; true with --isolated, which sends the two headers), that no
//       service worker controls the page, two open goals, and the version
//       Agda reports in the status bar, which the page's description must
//       name too;
//   2.  runs Infer on plus-zero from the command strip, and asserts the
//       modules that first check type-checked: the `Checking` lines of
//       Agda's running info, which the page shows only in the inspector's
//       compiler log, after an Infer or Normalize result;
//   3.  selects goal 1 and then goal 0 in the goal list, gives `x` at
//       goal 0 from the command strip, and asserts one open goal is left
//       and no error;
//   4.  appends a declaration with a type error, checks, and asserts the
//       error comes back with its position and message, which shows the
//       page elaborates against the shipped interfaces rather than
//       skipping work.
//   5.  in Chromium, exercises the theme choices, persistence, system
//       changes, first-frame colors and narrow viewports (issue 17).
//
// It writes browser-check.json (the timings, the requests, the console)
// and a screenshot into --out, and exits 1 on the first failed assertion,
// or when the browser fails; it is the language server's only test, since
// the server cannot be driven under wasmtime (issue 5).  CI runs it in
// Chromium, served with the headers and without; --browser firefox drives
// a Firefox through WebDriver BiDi (./bidi.mjs) instead.
//
//   CHROME=<chromium> node scripts/browser-check/run.mjs <site> [--out DIR] [--isolated]
//   FIREFOX=<firefox> node scripts/browser-check/run.mjs <site> --browser firefox [...]
//   nix run .#browser-check -- <site> [--out DIR] [--isolated]

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as cdp from "./cdp.mjs";
import * as bidi from "./bidi.mjs";
import { serve } from "./serve.mjs";
import { checkThemes } from "./themes.mjs";

/** The modules a fresh profile's first check of the default Main.agda
 * type-checks, one `Checking` line each: Main alone, since every
 * interface the site ships is accepted.  A builtin here means the shipped
 * Agda rejected agda-data.zip's interfaces and checked them again (issue
 * 49), which is a defect. */
export const EXPECTED_CHECKING = ["Main"];

/** The declaration step 4 appends, and the error Agda must report at
 * `refl`, after the position (Agda prints the naturals as numerals).
 * Agda 2.9.0 words it so; 2.8.0 wrote `0 != 1 of type Nat` in place of
 * the first five lines (issue 58). */
const TYPE_ERROR = {
  source: "\nwrong : zero ≡ suc zero\nwrong = refl\n",
  line: "wrong = refl",
  columns: "9-13",
  message:
    ": error: [UnequalTerms]\nThe terms\n  0\nand\n  1\nare not equal at type Nat\n" +
    "when checking that the expression refl has type zero ≡ 1",
};

/** The version Agda reports when the page asks for it (Cmd_show_version,
 * through the language server, which reports no version of its own since
 * the page runs its reactor build): the page shows it in the status bar,
 * after "Agda " (issues 58 and 59). */
export const AGDA_VERSION = "2.9.0";

const STEP_TIMEOUT_MS = 180_000;

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "browser-check" },
    // Serve the site with the two headers that make it cross-origin
    // isolated, and assert that it is.
    isolated: { type: "boolean", default: false },
    browser: { type: "string", default: "chromium" },
  },
});
const driver = { chromium: { launch: cdp.launch, executable: process.env.CHROME },
  firefox: { launch: bidi.launch, executable: process.env.FIREFOX } }[
  options.browser
];
if (positionals.length !== 1 || !driver?.executable) {
  console.error(
    "usage: CHROME=<chromium> node run.mjs <site> [--out DIR] [--isolated]\n" +
      "       FIREFOX=<firefox> node run.mjs <site> --browser firefox [--out DIR] [--isolated]",
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

// Every change of the inspector's heading and the status bar, with its
// time since navigation, recorded in the page from its first moment: a
// state that lasts 50 ms ("Agda ready", before the first check starts)
// is easy to miss by polling.
const RECORDER = `(() => {
  const events = (window.__browserCheck = []);
  const last = {};
  const watched = { status: ".inspector-status", bar: ".statusbar > span" };
  new MutationObserver(() => {
    for (const [name, selector] of Object.entries(watched)) {
      const elements = [...document.querySelectorAll(selector)];
      const text = elements.length
        ? elements.map((e) => e.textContent.replace(/\\s+/g, " ").trim()).join(" | ")
        : null;
      if (text !== last[name]) {
        last[name] = text;
        events.push({ t: Math.round(performance.now()), name, text });
      }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
})();`;

/** What the page shows, read from its DOM. */
const state = () => ({
  isolated: self.crossOriginIsolated,
  // The page registers no service worker (coi-serviceworker.js, which
  // isolated a page its server did not, is gone since issue 59).
  controlled: Boolean(navigator.serviceWorker?.controller),
  status:
    document.querySelector(".inspector-status")?.textContent?.trim() ?? "",
  // The status bar's spans, which its text runs together.
  bar: [...document.querySelectorAll(".statusbar > span")]
    .map((span) => span.textContent?.replace(/\s+/g, " ").trim())
    .join(" | "),
  busy: document.querySelector(".spin") !== null,
  goals: [...document.querySelectorAll(".goal-card .goal-number")].map((goal) =>
    goal.textContent?.trim(),
  ),
  activeGoal:
    document
      .querySelector(".goal-card.active .goal-number")
      ?.textContent?.trim() ?? null,
  problems: [...document.querySelectorAll(".problem-card")].map((card) => ({
    error: card.classList.contains("error"),
    message: card.querySelector("pre")?.textContent ?? "",
  })),
  result: document.querySelector(".result-card pre")?.textContent ?? null,
  log: document.querySelector(".compiler-log pre")?.textContent ?? null,
  minibuffer: document.querySelector("#command-input") !== null,
  description:
    document.querySelector('meta[name="description"]')?.getAttribute("content") ??
    "",
  editor: [...document.querySelectorAll(".cm-content .cm-line")].map(
    (line) => line.textContent,
  ),
  banner: document.querySelector(".fatal-banner")?.textContent?.trim() ?? null,
  // An action the page could not run (a command that threw).
  failedAction:
    document.querySelector(".action-error span")?.textContent?.trim() ?? null,
  now: Math.round(performance.now()),
});

/** A heading that carries a duration is a finished check (`2 open goals ·
 * 1.58 s`); after an edit the previous verdict stays on screen until the
 * next one replaces it. */
const finished = (/** @type {string} */ status) => / · \d/.test(status);

/** A duration as the page writes it (`989 ms`, `1.10 s`), in ms.
 * @param {string} text */
function milliseconds(text) {
  const match = text.match(/([\d.]+) (ms|s)$/);
  if (!match) return NaN;
  return Math.round(Number(match[1]) * (match[2] === "s" ? 1000 : 1));
}

const results = {
  site,
  date: new Date().toISOString(),
  browser: "",
  served: options.isolated
    ? "with the isolation headers"
    : "without the isolation headers",
  expectedChecking: EXPECTED_CHECKING,
  timings: /** @type {Record<string, number>} */ ({}),
  steps: /** @type {string[]} */ ([]),
};
let failure = /** @type {string | null} */ (null);
const consoleLog = /** @type {object[]} */ ([]);
/** @type {Awaited<ReturnType<typeof serve>> | undefined} */
let server;
/** @type {{ product: string, page: any, close: () => Promise<void> } | undefined} */
let chrome;
/** @type {any} */
let page;
let runtimeCaptured = false;

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Poll the page until `predicate` holds.
 * @param {(s: ReturnType<typeof state>) => boolean} predicate
 * @param {string} what */
async function waitFor(predicate, what, timeoutMs = STEP_TIMEOUT_MS) {
  const start = performance.now();
  let last;
  while (performance.now() - start < timeoutMs) {
    last = await page.eval(state);
    if (last.banner) throw new Error(`the page says "${last.banner}"`);
    const thrown = consoleLog.find(
      (/** @type {any} */ entry) => entry.type === "exception",
    );
    if (thrown) throw new Error(`the page threw: ${thrown.text}`);
    if (last.failedAction)
      throw new Error(`the page could not act: "${last.failedAction}"`);
    if (predicate(last)) return last;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(
    `timed out after ${timeoutMs / 1000} s waiting for ${what}; the page shows ` +
      JSON.stringify({
        status: last?.status,
        bar: last?.bar,
        banner: last?.banner,
      }),
  );
}

/** Click the command strip's button whose title starts with `title`.
 * @param {string} title */
const click = (title) =>
  page.eval((title) => {
    const button = [...document.querySelectorAll(".command-strip button")].find(
      (b) => b.getAttribute("title")?.startsWith(title),
    );
    if (!button || button.disabled)
      throw new Error(`no enabled button "${title}"`);
    button.click();
  }, title);

/** Fill the minibuffer and submit it. @param {string} value */
const submit = (value) =>
  page.eval((value) => {
    const input = document.querySelector("#command-input");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form.requestSubmit();
  }, value);

/** Click goal `n`'s card in the goal list, and wait until it is the
 * active goal.  @param {string} n */
async function selectGoal(n) {
  await page.eval((n) => {
    const card = [...document.querySelectorAll(".goal-card")].find(
      (card) => card.querySelector(".goal-number")?.textContent?.trim() === n,
    );
    if (!card) throw new Error(`no card for goal ${n} in the goal list`);
    card.click();
  }, n);
  await waitFor((s) => !s.busy && s.activeGoal === n, `goal ${n} selected`);
}

/** @param {string} name @param {() => Promise<void>} body */
async function step(name, body) {
  const start = performance.now();
  await body();
  results.timings[name] = Math.round(performance.now() - start);
  results.steps.push(name);
  console.log(`ok  ${name} (${results.timings[name]} ms)`);
}

try {
  server = await serve({ root: site, isolated: options.isolated });
  chrome = await driver.launch(driver.executable);
  page = chrome.page;
  results.browser = chrome.product;
  await page.onConsole((/** @type {object} */ entry) => consoleLog.push(entry));
  await page.setViewport(1440, 900);
  await page.addInitScript(RECORDER);
  await page.navigate(`${server.origin}/`);

  let first = /** @type {ReturnType<typeof state>} */ ({});
  await step("first check", async () => {
    first = await waitFor(
      (s) => finished(s.status) && !s.busy,
      "the first check of Main.agda",
    );
    const events = await page.eval(() => window.__browserCheck);
    const ready = events.find(
      (e) => e.name === "bar" && /Agda ready/.test(e.text ?? ""),
    );
    const checked = events.find(
      (e) => e.name === "status" && finished(e.text ?? ""),
    );
    assert(ready !== undefined, `the status bar never said "Agda ready"`);
    results.timings["Agda ready, since navigation"] = ready.t;
    results.timings["first check done, since navigation"] = checked?.t ?? NaN;
    results.timings["first check, as the page reports it"] = milliseconds(
      first.status,
    );
    assert(
      first.isolated === options.isolated,
      `crossOriginIsolated is ${first.isolated}, served ${results.served}`,
    );
    assert(first.controlled === false, "a service worker controls the page");
    assert(
      first.problems.length === 0,
      `the first check reported ${JSON.stringify(first.problems)}`,
    );
    assert(
      first.status.startsWith("2 open goals"),
      `the first check says "${first.status}", not 2 open goals`,
    );
    assert(
      first.goals.join() === "0,1",
      `the goal list is [${first.goals}], not [0,1]`,
    );
    assert(
      first.bar.split(" | ").includes("2 goals"),
      `the status bar says "${first.bar}"`,
    );
    assert(
      first.bar.split(" | ").includes(`Agda ${AGDA_VERSION}`),
      `the status bar says "${first.bar}", not the version Agda reports`,
    );
    assert(
      first.description.includes(`Agda ${AGDA_VERSION}`),
      `the page's description, "${first.description}", does not name Agda ${AGDA_VERSION}`,
    );
  });

  await step("infer, and the first check's Checking lines", async () => {
    await click("Infer type");
    await waitFor((s) => s.minibuffer, "the Infer minibuffer");
    await submit("plus-zero");
    const inferred = await waitFor(
      (s) =>
        !s.busy &&
        !s.minibuffer &&
        ((s.status === "Inferred type" && s.log !== null) ||
          s.problems.length > 0),
      "the inferred type and the compiler log",
    );
    assert(
      inferred.problems.length === 0,
      `Infer reported ${JSON.stringify(inferred.problems)}`,
    );
    // Unanchored: Agda indents a nested module's line.
    const checking = [...inferred.log.matchAll(/Checking (\S+) \(/g)].map(
      (m) => m[1],
    );
    results.checking = checking;
    results.inferred = inferred.result;
    assert(
      /n \+ 0 ≡ n/.test(inferred.result ?? ""),
      `Infer gave "${inferred.result}"`,
    );
    assert(
      JSON.stringify([...checking].sort()) ===
        JSON.stringify([...EXPECTED_CHECKING].sort()),
      `the first check type-checked [${checking}], expected [${EXPECTED_CHECKING}]`,
    );
  });

  await step("give at goal 0", async () => {
    // After Infer the inspector shows the result; a goal query brings the
    // goal list back.  Selecting goal 1 first shows that selection works,
    // since goal 0 is the one active by default.
    await click("Goal type");
    await waitFor((s) => !s.busy && s.goals.length === 2, "the goal list");
    await selectGoal("1");
    await selectGoal("0");
    await click("Give hole contents");
    await waitFor((s) => s.minibuffer, "the Give minibuffer");
    await submit("x");
    const given = await waitFor(
      (s) =>
        !s.busy &&
        !s.minibuffer &&
        (s.goals.length !== 2 || s.problems.length > 0),
      "the give's answer",
    );
    results.goals = { before: first.goals.length, after: given.goals.length };
    assert(
      given.problems.length === 0,
      `the give reported ${JSON.stringify(given.problems)}`,
    );
    // After an edit the inspector shows goals, not problems; the status
    // bar counts errors whatever it shows.
    assert(!/\d+ error/.test(given.bar), `the status bar says "${given.bar}"`);
    assert(
      given.goals.join() === "1",
      `after the give the goals are [${given.goals}], not [1]`,
    );
    assert(
      given.editor.includes("identity x = x"),
      "the buffer does not read identity x = x",
    );
  });

  await step("check a type error", async () => {
    await page.eval(() => document.querySelector(".cm-content").focus());
    await page.press("End", "End", 35, 2);
    await page.type(TYPE_ERROR.source);
    const edited = await page.eval(state);
    const line = edited.editor.indexOf(TYPE_ERROR.line) + 1;
    assert(line > 0, "the appended declaration is not in the buffer");
    await page.press("Enter", "Enter", 13, 2);
    const failed = await waitFor(
      (s) => !s.busy && finished(s.status) && s.problems.some((p) => p.error),
      "the type error",
    );
    const error = failed.problems.find((p) => p.error)?.message.trim() ?? "";
    const expected = `/Main.agda:${line}.${TYPE_ERROR.columns}${TYPE_ERROR.message}`;
    results.typeError = error;
    assert(
      error === expected,
      `the error is ${JSON.stringify(error)}, expected ${JSON.stringify(expected)}`,
    );
  });
  if (options.browser === "chromium") {
    // Keep the runtime check's error screenshot and event record before
    // the theme check navigates to fresh copies of the default document.
    writeFileSync(join(out, "browser-check.png"), await page.screenshot());
    results.events = await page.eval(() => window.__browserCheck ?? []);
    runtimeCaptured = true;
    await step("themes", async () => {
      results.themes = await checkThemes(page, server.origin, site, join(out, "themes"));
    });
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(`FAILED: ${failure}`);
} finally {
  try {
    if (page) {
      if (!runtimeCaptured) {
        writeFileSync(join(out, "browser-check.png"), await page.screenshot());
        results.events = await page.eval(() => window.__browserCheck ?? []);
      }
    }
  } catch {
    // The page may be gone; the record below still says why.
  }
  results.failure = failure;
  results.requests = server?.log ?? [];
  results.requested = {
    count: results.requests.length,
    bytes: results.requests.reduce((sum, r) => sum + r.bytes, 0),
  };
  results.console = consoleLog;
  writeFileSync(
    join(out, "browser-check.json"),
    JSON.stringify(results, null, 1) + "\n",
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary());
  await chrome?.close();
  await server?.close();
}
console.log(summary());
process.exit(failure ? 1 : 0);

function summary() {
  const rows = Object.entries(results.timings).map(
    ([k, v]) => `| ${k} | ${v} |`,
  );
  return [
    `### Browser check: ${failure ? "failed" : "passed"}`,
    "",
    `${results.browser}, ${results.date}, served ${results.served}`,
    ...(failure ? ["", `**Failure**: ${failure}`] : []),
    "",
    "| Step | ms |",
    "|---|---:|",
    ...rows,
    "",
    `Checking: ${JSON.stringify(results.checking ?? null)}; goals: ${JSON.stringify(results.goals ?? null)}; ` +
      `${results.requested?.count} requests, ${results.requested?.bytes} bytes.`,
    "",
  ].join("\n");
}
