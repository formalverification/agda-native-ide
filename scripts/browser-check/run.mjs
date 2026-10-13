// File: scripts/browser-check/run.mjs
//
// The browser check (issue 5).  It serves a built site, opens it in
// headless Chromium (or Firefox) with a fresh profile, and uses it as a
// reader would, through the page alone, as follows:
//
//   1.  waits for "Agda ready", then for the automatic first check of the
//       default Main.agda (/play/Main.agda, in the playground's project
//       over the standard library and agda-algebras, under agda-algebras'
//       options line; issue 11), and asserts crossOriginIsolated as the
//       server made it (false by default: the page needs no isolation
//       since issue 59; true with --isolated, which sends the two
//       headers), that no service worker controls the page, one open goal
//       with its type and its context, and the version Agda reports in the
//       status bar, which the page's description must name too;
//   2.  checks the Explorer's tree (./explorer.mjs, issue 9): its roles,
//       the open file marked current, the arrow keys from the tab stop to
//       a module of agda-algebras, Space selecting it without opening it,
//       every module listed, in the list's order, once every row is
//       opened with the arrow keys, and the filter;
//   3.  runs Infer on length-hom from the command strip, and asserts the
//       modules that first check type-checked: the `Checking` lines of
//       Agda's running info, which the page shows only in the inspector's
//       compiler log, after an Infer or Normalize result;
//   4.  selects goal 0 in the goal list, gives the term that fills it from
//       the command strip, and asserts no goal is left and no error;
//   5.  appends a declaration with a type error, checks, and asserts the
//       error comes back with its position and message, which shows the
//       page elaborates against the shipped interfaces rather than
//       skipping work;
//   6.  replaces that declaration with a postulate, checks, and asserts
//       Agda refuses it as agda-algebras would, under --safe, with its
//       position and message;
//   7.  replaces the buffer with a Main that imports a module of
//       agda-algebras, checks, and asserts the page asks first (issue 14):
//       a question stating the bytes of the archives the import needs,
//       computed here from the site's own index, with no spinner, the
//       focus on its Fetch button, nothing sideways at 400 px, and no
//       archive requested while it waits; Esc cancels it, and a second
//       check asks again; Fetch fetches exactly those archives, and the
//       check type-checks Main alone;
//   8.  a library module, read-only (issue 10): types into Main, then opens
//       Overture.Signatures with Enter on its Explorer row, and asserts
//       that the page asks nothing and fetches nothing (Main's import
//       mounted its closure), that Agda type-checked nothing (it accepted
//       the module's own interface), that a line says it is the checked
//       library and links its page, that it is read-only and a keystroke,
//       a newline, a deletion or an undo changes nothing, that Infer
//       answers in its scope, that the drive's cache holds no copy of it
//       (nothing was written), and, in Chromium, that hover over a name
//       after two characters outside the Basic Multilingual Plane answers
//       that name's type; then Main again, from its tab, still holds what
//       was typed, and undo takes back that, and only that;
//   9.  a copy into the playground: from the library's line, a name Agda
//       finds already is refused; the module's copy, /play/Signatures,
//       opens editable, is listed in the Explorer, checks with only itself
//       type-checked, and a goal added to it answers its type, its context
//       and a give; the control: the library's name in its module line is
//       refused by Agda ([LibTooFarDown]), and undo puts its own back;
//  10.  a selection's copy, of two lines selected with the keyboard (the
//       module's code through them), checks with only itself type-checked;
//       the library's line adds `open import` of the module to Main, which
//       checks, and undo takes it back;
//  11.  closes the Explorer's section that holds the open file, and
//       reloads: the rows expanded before still are, and the open file is
//       revealed; then opens a PLFA chapter from the reader's Next, in a
//       part that is closed, far below the tree's top, and asserts the tree
//       opens the part and scrolls the chapter's row into view (issue 9);
//  12.  a second visit: once the browser keeps the archives, reloads in the
//       same profile, and asserts that the automatic check asks nothing,
//       requests no archive, mounts the 3 from the browser's store and
//       type-checks Main alone, and that a drive cache of another
//       namespace, made before the reload, is gone;
//  13.  imports Setoid.Varieties.HSP, the milestone's import: the question
//       states the bytes of the archives not yet mounted, Fetch fetches
//       exactly those, and Main alone is type-checked; while the mount and
//       the check run, it uses the Explorer, in one call inside the page: a
//       key and the filter work, and only the rows the page cannot open
//       then are aria-disabled (issue 9); a check after an edit that
//       imports nothing new asks nothing and fetches nothing;
//  14.  a changed archive: puts in the store what a browser that visited
//       an earlier deploy holds (one archive under another digest, its
//       current copy absent), reloads, and asserts that the stale copy is
//       evicted, that the automatic check asks for that archive alone,
//       without taking the focus, and, answered with the answer
//       remembered, fetches it once, at its current URL, and type-checks
//       Main alone;
//  15.  a remembered answer: with another archive gone from the store,
//       reloads, and asserts that the page asks nothing, states the bytes
//       in the status bar before the request (on the page's clock, as
//       measured), and fetches that archive alone;
//  16.  a declined fetch: with the remembered answer forgotten and one
//       more archive gone, the page asks for it alone; Check from source
//       requests nothing, says so in a note, mounts the archives the
//       browser keeps, and Agda type-checks the declined archive's
//       modules alone (with Main, or not), accepting the archived
//       interfaces above them;
//  17.  in Chromium, exercises the theme choices, persistence, system
//       changes, first-frame colors and narrow viewports (issue 17).
//
// The server sends `no-store` for agda-algebras' index and archives, so
// that every request for them reaches its log rather than the browser's
// HTTP cache (the host's `/*.zip` rule revalidates them too).
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as cdp from "./cdp.mjs";
import * as bidi from "./bidi.mjs";
import { serve } from "./serve.mjs";
import { checkThemes } from "./themes.mjs";
import { checkExplorer, checkExplorerAfterReload, useExplorerWhileBusy } from "./explorer.mjs";

/** The playground's Main.agda on the drive: a module of a project of its
 * own, beside /play/play.agda-lib (issue 11). */
const MAIN = "/play/Main.agda";

/** The modules a fresh profile's first check of the default Main.agda
 * type-checks, one `Checking` line each: Main alone, since every
 * interface the site ships is accepted.  A builtin here means the shipped
 * Agda rejected agda-data.zip's interfaces and checked them again (issue
 * 49), which is a defect. */
export const EXPECTED_CHECKING = ["Main"];

/** The default Main.agda's one goal, as the inspector shows it after the
 * first check: its type and its context, in Agda's normal form (which
 * unfolds IsHom), with the term the give step gives and the line it
 * leaves. */
const GOAL = {
  type: "g (f x * f y) ≡ (g (f x) ⋆ g (f y))",
  context: [
    ["A", "Set"],
    ["B", "Set"],
    ["C", "Set"],
    ["_·_", "A → A → A"],
    ["_*_", "B → B → B"],
    ["_⋆_", "C → C → C"],
    ["g", "B → C"],
    ["f", "A → B"],
    ["g-hom", "(x₁ y₁ : B) → g (x₁ * y₁) ≡ (g x₁ ⋆ g y₁)"],
    ["f-hom", "(x₁ y₁ : A) → f (x₁ · y₁) ≡ (f x₁ * f y₁)"],
    ["x", "A"],
    ["y", "A"],
  ],
  give: "g-hom (f x) (f y)",
  given: "∘-hom g f g-hom f-hom x y = trans (cong g (f-hom x y)) (g-hom (f x) (f y))",
};

/** What the Infer step infers, and its type. */
const INFER = {
  expression: "length-hom",
  type: "{A : Set} (x y : List A) → length (x ++ y) ≡ length x + length y",
};

/** The import step's Main, which imports the agda-algebras module with the fewest
 * imports of the standard library (issue 11): its 3 archives (at the pin
 * of 2026-10-13; the steps compute them from the site's index), 206,933
 * bytes, hold the interfaces of it and the 10 standard-library modules it
 * imports, so the check type-checks Main alone (issue 14). */
const LIBRARY = {
  source:
    "{-# OPTIONS --without-K --exact-split --safe #-}\n\nmodule Main where\n\n" +
    "import Overture.Signatures\n",
  module: "Overture.Signatures",
  infer: "Overture.Signatures.Signature",
};

/** The HSP step's Main: the milestone's import. */
const HSP = {
  source:
    "{-# OPTIONS --without-K --exact-split --safe #-}\n\nmodule Main where\n\n" +
    "import Setoid.Varieties.HSP\n",
  module: "Setoid.Varieties.HSP",
  infer: "Setoid.Varieties.HSP.Birkhoff",
};

/** The library step's module (issue 10), which the import step's Main
 * imports, so its archives are mounted when it opens: its path on the
 * drive and on agda-algebras' site, an expression only its scope types
 * (Main imports it without opening it), with the type, and a line where
 * `Signature` follows two characters outside the Basic Multilingual
 * Plane, which hover must still find. */
const READ_ONLY = {
  module: "Overture.Signatures",
  path: "/agda-algebras/src/Overture/Signatures.lagda.md",
  tab: "Signatures.lagda.md",
  page: "https://agda-algebras.universalalgebra.org/Overture/Signatures/",
  infer: "Signature",
  type: "(𝓞 𝓥 : Level) → Type (lsuc 𝓞 ⊔ lsuc 𝓥)",
  hoverLine: "Level-of-Signature : {𝓞 𝓥 : Level} → Signature 𝓞 𝓥 → Level",
  hover: "(𝓞 𝓥 : Agda.Primitive.Level) →",
  /** An edit to Main before it opens, which undo there must take back: one
   * undo group in either browser (Firefox's typing sends a newline as
   * Enter, which starts a group, so it has none at its end). */
  mainEdit: "\n-- an edit made before the library's module opens",
};

/** The copy step's copies (issue 10): the module's, its goal and the term
 * that fills it (followed by prose, so that the give's highlighting stays
 * inside the text Agda loaded), and the selection's. */
const COPY = {
  refused: "Overture",
  name: "Signatures",
  path: "/play/Signatures.lagda.md",
  goal: "\n```agda\nsig-ops : Signature 𝓞 𝓥 → Type 𝓞\nsig-ops 𝑆 = {! !}\n```\n\nThe operation symbols of a signature.\n",
  goalType: "Type 𝓞",
  give: "proj₁ 𝑆",
  given: "sig-ops 𝑆 = proj₁ 𝑆",
  libTooFarDown:
    ": error: [LibTooFarDown]\nAn .agda-lib file for Overture.Signatures\nmust not be located in the directory /play",
  /** The start of the selection's first line. */
  selectionFrom: "Signature : (",
  selected: "Signature 𝓞 𝓥 = Σ[ F ∈ Type 𝓞 ] (F → Type 𝓥)",
  selectionName: "SignatureType",
  selectionPath: "/play/SignatureType.agda",
};

/** Where the page keeps the archives, and the drive's caches (the engine's
 * archive-store.ts and drive-caches.ts). */
const ARCHIVE_STORE = "agda-native-ide-archives";
const DRIVE_CACHE_PREFIX = "agda-playground-drive-";
const DRIVE_NAMESPACES_KEY = "agda-native-ide:drive-namespaces";
const ARCHIVES_PATH = "/agda-algebras/interfaces/";

/** The archives a set of imports needs, by path, sorted.
 * @param {string[]} roots */
function needs(roots) {
  const seen = new Set();
  const todo = [...roots];
  while (todo.length) {
    const name = /** @type {string} */ (todo.pop());
    if (seen.has(name)) continue;
    seen.add(name);
    todo.push(...INDEX.modules[name].deps);
  }
  const archives = new Set();
  for (const name of seen) if (INDEX.modules[name].archive !== null) archives.add(INDEX.modules[name].archive);
  return [...archives].sort();
}

/** A count and its noun. @param {number} n @param {string} noun */
const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What the page's question must say for these archives: their URLs as the
 * page names them, their bytes, and the interfaces they hold.
 * @param {string[]} archives */
function expected(archives) {
  const bytes = archives.reduce((sum, path) => sum + INDEX.archives[path].bytes, 0);
  const kb = bytes / 1024;
  const size =
    bytes < 1024 ? `${bytes} bytes` : Number(kb.toFixed(1)) < 1024 ? `${kb.toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MiB`;
  return {
    urls: archives.map((path) => `/agda-algebras/${path}?cache=${INDEX.archives[path].sha256.slice(0, 16)}`).sort(),
    bytes,
    stated: `${size} (${bytes.toLocaleString("en-US")} bytes)`,
    count: `${archives.length} ${archives.length === 1 ? "archive" : "archives"} holding ${plural(archives.reduce((sum, path) => sum + INDEX.archives[path].modules, 0), "module")}`,
    digests: archives.map((path) => INDEX.archives[path].sha256),
  };
}

/** The declaration the type error's step appends, and the error Agda must
 * report at `refl`, after the position (Agda prints the naturals as
 * numerals).
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

/** The postulate its step puts in place of the type error's declaration,
 * and the error Agda must report at its declaration: Main's own options
 * line has --safe, which refuses a postulate (issue 11). */
const POSTULATE = {
  source: "postulate cheat : zero ≡ suc zero\n",
  line: "postulate cheat : zero ≡ suc zero",
  columns: "11-34",
  message:
    ": error: [SafeFlagPostulate]\nCannot postulate cheat with safe flag\n" +
    "when scope checking the declaration\n  cheat : zero ≡ suc zero",
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

/** The site's own index: what an import needs is computed here from it, as
 * scripts/library-archives/index.mjs computes it, and not from the page. */
if (!existsSync(join(site, "agda-algebras", "index.json"))) {
  console.error(
    `${site}/agda-algebras/index.json does not exist: the site carries agda-algebras' archives since issue 14 (make assets, then make build)`,
  );
  process.exit(2);
}
const INDEX = JSON.parse(readFileSync(join(site, "agda-algebras", "index.json"), "utf8"));

// Every change of the inspector's heading and the status bar, with its
// time since navigation, recorded in the page from its first moment: a
// state that lasts 50 ms ("Agda ready", before the first check starts)
// is easy to miss by polling.
const RECORDER = `(() => {
  const events = (window.__browserCheck = []);
  const last = {};
  // The question before a fetch, with the bytes it states (issue 14).
  const watched = { status: ".inspector-status", bar: ".statusbar > span", consent: ".consent-size" };
  new MutationObserver(() => {
    for (const [name, selector] of Object.entries(watched)) {
      const elements = [...document.querySelectorAll(selector)];
      const text = elements.length
        ? elements.map((e) => e.textContent.replace(/\\s+/g, " ").trim()).join(" | ")
        : null;
      if (text !== last[name]) {
        last[name] = text;
        // t, rounded, for the record; at, as measured, to compare.
        const at = performance.now();
        events.push({ t: Math.round(at), at, name, text });
      }
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
  // When each of agda-algebras' archives was requested, on the page's own
  // clock, which the events above share.
  const resources = (window.__browserCheckResources = []);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (entry.name.includes(${JSON.stringify("/agda-algebras/interfaces/")}))
        resources.push({ t: Math.round(entry.startTime), at: entry.startTime, name: new URL(entry.name).pathname + new URL(entry.name).search });
  }).observe({ type: "resource", buffered: true });
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
  goalTypes: [...document.querySelectorAll(".goal-card .goal-content")].map(
    (type) => type.textContent?.trim(),
  ),
  // The selected goal's context, as name and type.
  context: [...document.querySelectorAll(".context-row")].map((row) =>
    [...row.querySelectorAll("code")].map((code) => code.textContent?.trim()),
  ),
  problems: [...document.querySelectorAll(".problem-card")].map((card) => ({
    error: card.classList.contains("error"),
    message: card.querySelector("pre")?.textContent ?? "",
  })),
  result: document.querySelector(".result-card pre")?.textContent ?? null,
  log: document.querySelector(".compiler-log pre")?.textContent ?? null,
  minibuffer: document.querySelector("#command-input") !== null,
  // The question before a fetch: what it says, the bytes it states, and
  // whether its Fetch button has the focus (issue 14).
  consent: document.querySelector(".consent")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
  consentBytes: document.querySelector(".consent-size")?.dataset.bytes ?? null,
  consentFocused: document.activeElement?.classList.contains("consent-fetch") ?? false,
  note: document.querySelector(".plan-note")?.textContent?.trim() ?? null,
  width: document.documentElement?.clientWidth ?? 0,
  scrollWidth: document.documentElement?.scrollWidth ?? 0,
  description:
    document.querySelector('meta[name="description"]')?.getAttribute("content") ??
    "",
  editor: [...document.querySelectorAll(".cm-content .cm-line")].map(
    (line) => line.textContent,
  ),
  banner: document.querySelector(".fatal-banner")?.textContent?.trim() ?? null,
  // The open files, by path, and the one on screen; whether it is
  // read-only, and the line that says so (issue 10).
  tabs: [...document.querySelectorAll(".editor-tab")].map((tab) => tab.getAttribute("title")),
  tab: document.querySelector(".editor-tab.active")?.getAttribute("title") ?? null,
  readOnly: document.querySelector(".cm-content")?.getAttribute("aria-readonly") === "true",
  editable: document.querySelector(".cm-content")?.getAttribute("contenteditable") === "true",
  library: document.querySelector(".library-bar")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
  libraryPage: document.querySelector(".library-page")?.getAttribute("href") ?? null,
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
  /** What the Explorer's steps found, filled as they go (./explorer.mjs). */
  explorer: /** @type {Record<string, any>} */ ({}),
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
async function waitFor(predicate, what, timeoutMs = STEP_TIMEOUT_MS, also = async () => true) {
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
    if (predicate(last) && (await also())) return last;
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

/** In a step where the page must not ask, a question fails it at once,
 * rather than holding the check until the step's time runs out. */
function noQuestion(/** @type {ReturnType<typeof state>} */ s, /** @type {string} */ what) {
  if (s.consent !== null) throw new Error(`${what} asked: ${JSON.stringify(s.consent)}`);
  return true;
}

/** The requests for agda-algebras' archives the server logged since the
 * `from`th, by URL, sorted. */
const archiveRequests = (from = 0) =>
  (server?.log ?? [])
    .slice(from)
    .filter((request) => request.url.startsWith(ARCHIVES_PATH))
    .map((request) => request.url)
    .sort();

/** The digests the page's archive store holds; the store is never created
 * here, only read. */
const storeKeys = () =>
  page.eval(
    (name) =>
      new Promise((resolve) => {
        const open = indexedDB.open(name);
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const database = open.result;
          const keys = database.transaction("archives").objectStore("archives").getAllKeys();
          keys.onsuccess = () => (database.close(), resolve(keys.result.map(String)));
          keys.onerror = () => (database.close(), resolve([]));
        };
      }),
    ARCHIVE_STORE,
  );

/** The paths the drive's cache holds (every drive cache of the page's,
 * which is one outside the second visit's step). */
const driveCachePaths = () =>
  page.eval(
    (prefix) =>
      indexedDB.databases().then((all) =>
        Promise.all(
          all
            .map((database) => database.name)
            .filter((name) => name?.startsWith(prefix))
            .map(
              (name) =>
                new Promise((resolve) => {
                  const open = indexedDB.open(name);
                  open.onupgradeneeded = () => open.transaction?.abort();
                  open.onerror = () => resolve([]);
                  open.onsuccess = () => {
                    const database = open.result;
                    const keys = database.transaction("files").objectStore("files").getAllKeys();
                    keys.onsuccess = () => (database.close(), resolve(keys.result.map(String)));
                    keys.onerror = () => (database.close(), resolve([]));
                  };
                }),
            ),
        ).then((lists) => lists.flat()),
      ),
    DRIVE_CACHE_PREFIX,
  );

/** Delete an archive from the page's store, and put another record in its
 * place when one is given (the state an earlier deploy leaves). */
const replaceKept = (/** @type {string} */ digest, /** @type {{ sha256: string, path: string } | undefined} */ instead) =>
  page.eval(
    ({ name, digest, instead }) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => {
          const transaction = open.result.transaction("archives", "readwrite");
          const store = transaction.objectStore("archives");
          store.delete(digest);
          if (instead)
            store.put({ ...instead, library: "agda-algebras", bytes: 1, data: new ArrayBuffer(1), stored: 0 });
          transaction.oncomplete = () => (open.result.close(), resolve(true));
          transaction.onerror = () => reject(transaction.error);
        };
        open.onerror = () => reject(open.error);
      }),
    { name: ARCHIVE_STORE, digest, instead: instead ?? null },
  );

/** Wait until the store holds `digests` (and `also` holds of its keys). */
async function waitForStore(digests, what, also = () => true) {
  const start = performance.now();
  let keys = [];
  while (performance.now() - start < 30_000) {
    keys = await storeKeys();
    if (digests.every((digest) => keys.includes(digest)) && also(keys)) return keys;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`timed out waiting for ${what}: the store holds ${keys.length} archives`);
}

/** Navigate to the page again in the same profile, and wait for the new
 * document. */
async function reload() {
  const before = await page.eval(() => performance.timeOrigin);
  await page.navigate(`${server.origin}/`);
  const start = performance.now();
  while (performance.now() - start < STEP_TIMEOUT_MS) {
    try {
      const now = await page.eval(() => (document.readyState === "complete" ? performance.timeOrigin : null));
      if (now !== null && now !== before) return;
    } catch {
      // The old document is going.
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("the page did not load again");
}

/** Wait for a check that started after `since` (the page's clock) to end:
 * a heading that said it was checking since then, and a verdict now. */
async function waitForCheck(since, what) {
  return waitFor(
    (s) =>
      !s.busy &&
      s.consent === null &&
      finished(s.status) &&
      (s.status.startsWith("Module checked") || s.problems.some((p) => p.error)),
    what,
    STEP_TIMEOUT_MS,
    async () =>
      (await page.eval(() => window.__browserCheck)).some(
        (e) => e.t >= since && e.name === "status" && /^Checking source/.test(e.text ?? ""),
      ),
  );
}

/** The modules the last check type-checked, from the compiler log an
 * Infer shows. */
async function inferChecking(expression) {
  await click("Infer type");
  await waitFor((s) => s.minibuffer, "the Infer minibuffer");
  await submit(expression);
  const inferred = await waitFor(
    (s) => !s.busy && !s.minibuffer && (s.status === "Inferred type" || s.problems.length > 0),
    `the type of ${expression}`,
  );
  assert(inferred.problems.length === 0, `Infer reported ${JSON.stringify(inferred.problems)}`);
  // A check that type-checked nothing (Main's interface restored, and up
  // to date) leaves no compiler log under the result.
  const { log } = await page.eval(state);
  // Unanchored: Agda indents a nested module's line.
  return [...(log ?? "").matchAll(/Checking (\S+) \(/g)].map((m) => m[1]);
}

/** Open a module of agda-algebras as a reader would with the keyboard:
 * the Explorer's filter finds its row, and Enter on the row opens it
 * (issue 10).  @param {string} name */
async function openModule(name) {
  await page.eval(() => document.querySelector('.explorer input[type="search"]').focus());
  await page.press("a", "KeyA", 65, 2);
  await page.type(name);
  const id = `agda-algebras:${name}`;
  await waitFor(() => true, `the row of ${name}`, 5_000, () =>
    page.eval((id) => document.querySelector(`.explorer [data-id="${id}"]`) !== null, id),
  );
  await page.eval((id) => document.querySelector(`.explorer [data-id="${id}"]`).focus(), id);
  await page.press("Enter", "Enter", 13);
}

/** Clear the Explorer's filter, with Escape in it. */
async function clearFilter() {
  await page.eval(() => document.querySelector('.explorer input[type="search"]').focus());
  await page.press("Escape", "Escape", 27);
}

/** Show the open file at `path`, from its tab. @param {string} path */
const openTab = (path) =>
  page.eval((path) => {
    const tab = [...document.querySelectorAll(".editor-tab")].find((tab) => tab.getAttribute("title") === path);
    if (!tab) throw new Error(`no tab for ${path}`);
    tab.querySelector(".editor-tab-open").click();
  }, path);

/** Click the library line's button whose class is `name`. @param {string} name */
const libraryAction = (name) =>
  page.eval((name) => {
    const button = document.querySelector(`.library-actions .${name}`);
    if (!button || button.disabled) throw new Error(`no enabled ${name} in the library's line`);
    button.click();
  }, name);

/** Select `text` in the editor with its search panel (Mod-f), as a reader
 * would, and close the panel, which leaves the match selected.
 * @param {string} text */
async function findInEditor(text) {
  await page.eval(() => document.querySelector(".cm-content").focus());
  await page.press("f", "KeyF", 70, 2);
  await waitFor(() => true, "the search panel", 5_000, () =>
    page.eval(() => document.activeElement?.matches(".cm-search input[name=search]") ?? false),
  );
  await page.press("a", "KeyA", 65, 2);
  await page.type(text);
  // The panel takes its query on a key's release, which typing through
  // CDP's insertText has none of.
  await page.press("End", "End", 35);
  await page.press("Enter", "Enter", 13);
  await page.press("Escape", "Escape", 27);
}

/** Move the cursor down from the top of the editor, with the arrow key, to
 * the first line that starts with `start`: the keyboard a reader has in a
 * read-only module, where Firefox's search panel does not move the
 * selection.  @param {string} start */
async function cursorToLine(start) {
  await page.eval(() => document.querySelector(".cm-content").focus());
  await page.press("Home", "Home", 36, 2);
  for (let presses = 0; presses < 400; presses++) {
    const line = await page.eval(() => document.querySelector(".cm-activeLine")?.textContent ?? null);
    if (line?.startsWith(start)) return;
    await page.press("ArrowDown", "ArrowDown", 40);
  }
  throw new Error(`no line of the editor starts with ${JSON.stringify(start)}`);
}

/** Hover over the last character of the occurrence of `word` after the
 * colon in the drawn line `line`, with the mouse, and return the language
 * server's answer, and how long it took (Chromium: the driver moves the
 * mouse through CDP).  The last character, so that a position counted in
 * the wrong unit, which lands as many characters to the right as there are
 * characters outside the Basic Multilingual Plane before it, is in the
 * next token.  @param {string} line @param {string} word */
async function hoverOver(line, word) {
  const point = await page.eval(
    async ({ line, word }) => {
      const scroller = document.querySelector(".cm-scroller");
      scroller.scrollTop = 0;
      for (let tries = 0; tries < 100; tries++) {
        const element = [...document.querySelectorAll(".cm-content .cm-line")].find((l) => l.textContent === line);
        if (element) {
          element.scrollIntoView({ block: "center" });
          await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50)));
          const offset = element.textContent.indexOf(word, element.textContent.indexOf(":")) + word.length - 2;
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let seen = 0, node; (node = walker.nextNode()); seen += node.length)
            if (seen + node.length > offset + 1) {
              const range = document.createRange();
              range.setStart(node, offset + 1 - seen);
              range.setEnd(node, offset + 2 - seen);
              const box = range.getBoundingClientRect();
              return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
            }
        }
        scroller.scrollTop += 300;
        await new Promise((done) => setTimeout(done, 50));
      }
      return null;
    },
    { line, word },
  );
  assert(point !== null, `the line ${JSON.stringify(line)} is not in the editor`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x - 40, y: point.y - 40 });
  await new Promise((done) => setTimeout(done, 100));
  const start = performance.now();
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  let answer = null;
  await waitFor(() => true, `the language server's hover over ${word}`, 60_000, async () => {
    answer = await page.eval(
      () => document.querySelector(".cm-lsp-hover-tooltip:not(.cm-lsp-hover-tooltip--loading)")?.textContent ?? null,
    );
    return answer !== null;
  });
  const ms = Math.round(performance.now() - start);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
  return { answer, ms };
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
  // agda-algebras' index and archives are never answered from the HTTP
  // cache, so the log sees every request for them (issue 14).
  server = await serve({ root: site, isolated: options.isolated, noStore: ["/agda-algebras/"] });
  chrome = await driver.launch(driver.executable);
  page = chrome.page;
  results.browser = chrome.product;
  await page.onConsole((/** @type {object} */ entry) => consoleLog.push(entry));
  await page.setViewport(1440, 900);
  await page.addInitScript(RECORDER);
  await page.navigate(`${server.origin}/`);

  let first = /** @type {ReturnType<typeof state>} */ ({});
  await step("first check", async () => {
    // The context arrives after the check, from a question of its own; a
    // check that failed has none, and the assertions below say why.
    first = await waitFor(
      (s) => finished(s.status) && !s.busy && (s.context.length > 0 || s.problems.length > 0),
      "the first check of Main.agda, and its goal's context",
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
      first.status.startsWith("1 open goal ·"),
      `the first check says "${first.status}", not 1 open goal`,
    );
    assert(
      first.goals.join() === "0",
      `the goal list is [${first.goals}], not [0]`,
    );
    assert(
      first.goalTypes.join() === GOAL.type,
      `goal 0's type is "${first.goalTypes}", not "${GOAL.type}"`,
    );
    results.context = first.context;
    assert(
      JSON.stringify(first.context) === JSON.stringify(GOAL.context),
      `goal 0's context is ${JSON.stringify(first.context)}`,
    );
    assert(
      first.bar.split(" | ").includes("1 goal"),
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

  await step("the Explorer", async () => {
    await checkExplorer(page, site, results.explorer);
  });

  await step("infer, and the first check's Checking lines", async () => {
    await click("Infer type");
    await waitFor((s) => s.minibuffer, "the Infer minibuffer");
    await submit(INFER.expression);
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
      inferred.result === INFER.type,
      `Infer gave "${inferred.result}", not "${INFER.type}"`,
    );
    assert(
      JSON.stringify([...checking].sort()) ===
        JSON.stringify([...EXPECTED_CHECKING].sort()),
      `the first check type-checked [${checking}], expected [${EXPECTED_CHECKING}]`,
    );
  });

  await step("give at goal 0", async () => {
    // After Infer the inspector shows the result; a goal query brings the
    // goal list back.
    await click("Goal type");
    await waitFor((s) => !s.busy && s.goals.length === 1, "the goal list");
    await selectGoal("0");
    await click("Give hole contents");
    await waitFor((s) => s.minibuffer, "the Give minibuffer");
    await submit(GOAL.give);
    const given = await waitFor(
      (s) =>
        !s.busy &&
        !s.minibuffer &&
        (s.goals.length !== 1 || s.problems.length > 0),
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
      given.goals.length === 0,
      `after the give the goals are [${given.goals}], not none`,
    );
    assert(
      given.editor.includes(GOAL.given),
      `the buffer does not read ${GOAL.given}`,
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
    const expected = `${MAIN}:${line}.${TYPE_ERROR.columns}${TYPE_ERROR.message}`;
    results.typeError = error;
    assert(
      error === expected,
      `the error is ${JSON.stringify(error)}, expected ${JSON.stringify(expected)}`,
    );
  });

  await step("refuse a postulate", async () => {
    // Select the type error's two lines, from the end of the buffer, and
    // type the postulate over them.
    await page.eval(() => document.querySelector(".cm-content").focus());
    await page.press("End", "End", 35, 2);
    await page.press("ArrowUp", "ArrowUp", 38, 8);
    await page.press("ArrowUp", "ArrowUp", 38, 8);
    await page.type(POSTULATE.source);
    const edited = await page.eval(state);
    const line = edited.editor.indexOf(POSTULATE.line) + 1;
    assert(line > 0, "the postulate is not in the buffer");
    assert(
      !edited.editor.includes(TYPE_ERROR.line),
      "the type error's declaration is still in the buffer",
    );
    await page.press("Enter", "Enter", 13, 2);
    // The type error stays on screen until this check's verdict replaces
    // it, whatever that is.
    const refused = await waitFor(
      (s) =>
        !s.busy &&
        finished(s.status) &&
        !s.problems.some((p) => p.message.includes("[UnequalTerms]")),
      "the postulate's check",
    );
    const error = refused.problems.find((p) => p.error)?.message.trim() ?? "";
    const expected = `${MAIN}:${line}.${POSTULATE.columns}${POSTULATE.message}`;
    results.postulate = error;
    assert(
      error === expected,
      `the error is ${JSON.stringify(error)}, expected ${JSON.stringify(expected)}`,
    );
  });

  await step("import a module of agda-algebras, asked first", async () => {
    const want = expected(needs([LIBRARY.module]));
    results.libraryImport = { archives: want.urls.length, bytes: want.bytes, stated: want.stated };
    await page.eval(() => document.querySelector(".cm-content").focus());
    await page.press("a", "KeyA", 65, 2);
    await page.type(LIBRARY.source);
    const from = server.log.length;
    await page.press("Enter", "Enter", 13, 2);
    // A question, not work under way: no spinner while it waits.
    const asked = await waitFor((s) => s.consent !== null && !s.busy, "the question before the fetch");
    results.libraryQuestion = asked.consent;
    assert(asked.consentBytes === String(want.bytes), `the question states ${asked.consentBytes} bytes, not ${want.bytes}`);
    assert(
      asked.consent.includes(`needs ${want.stated} of agda-algebras' interfaces: ${want.count}, from this site.`),
      `the question says ${JSON.stringify(asked.consent)}, not ${want.stated} and ${want.count}`,
    );
    assert(asked.consentFocused, "the question the reader asked for does not have the focus on its Fetch button");
    await new Promise((done) => setTimeout(done, 1000));
    assert(archiveRequests(from).length === 0, `archives were requested before the answer: ${archiveRequests(from)}`);
    // At 400 px the question wraps, and nothing scrolls sideways.
    await page.setViewport(400, 900);
    await new Promise((done) => setTimeout(done, 300));
    const narrow = await page.eval(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      buttons: [...document.querySelectorAll(".consent button")].map((b) => {
        const box = b.getBoundingClientRect();
        return box.width > 0 && box.right <= document.documentElement.clientWidth + 0.5;
      }),
    }));
    await page.setViewport(1440, 900);
    assert(narrow.scrollWidth <= narrow.width, `at 400 px the page scrolls sideways (${narrow.scrollWidth} > ${narrow.width})`);
    assert(narrow.buttons.length === 3 && narrow.buttons.every(Boolean), `at 400 px the question's buttons are not all in view: ${narrow.buttons}`);
    // Esc cancels: nothing is fetched, nothing checked; a second check asks again.
    await page.press("Escape", "Escape", 27);
    await waitFor((s) => s.consent === null && !s.busy, "the question cancelled");
    assert(archiveRequests(from).length === 0, `archives were requested after a cancel: ${archiveRequests(from)}`);
    await page.eval(() => document.querySelector(".cm-content").focus());
    const since = await page.eval(() => performance.now());
    await page.press("Enter", "Enter", 13, 2);
    await waitFor((s) => s.consent !== null && !s.busy, "the question asked again");
    await page.eval(() => document.querySelector(".consent-fetch").click());
    const checked = await waitForCheck(since, "the library import's check");
    results.timings["library import, as the page reports it"] = milliseconds(checked.status);
    assert(checked.problems.length === 0, `the import reported ${JSON.stringify(checked.problems)}`);
    const requested = archiveRequests(from);
    results.libraryRequests = requested;
    assert(
      JSON.stringify(requested) === JSON.stringify(want.urls),
      `the page requested ${JSON.stringify(requested)}, not ${JSON.stringify(want.urls)}`,
    );
    const events = await page.eval(() => window.__browserCheck);
    const asks = events.filter((e) => e.name === "consent" && e.text);
    assert(asks.length === 2, `the page asked ${asks.length} times, not twice (once, cancelled, and once more)`);
    const progress = `Fetching agda-algebras' interfaces: ${want.stated.replace(/ \(.*$/, "").replace(/^([\d.]+) (\S+)$/, "$1 of $1 $2")}`;
    assert(
      events.some((e) => e.name === "status" && e.text === progress),
      `the inspector never said "${progress}"`,
    );
    const checking = await inferChecking(LIBRARY.infer);
    results.libraryChecking = checking;
    assert(
      JSON.stringify(checking) === JSON.stringify(["Main"]),
      `the import type-checked [${checking}], not Main alone: an archive's interface was not accepted`,
    );
  });
  await step("a library module, read-only, and undo in its own file", async () => {
    // An edit to Main, not checked.
    await page.eval(() => document.querySelector(".cm-content").focus());
    await page.press("End", "End", 35, 2);
    await page.type(READ_ONLY.mainEdit);
    const main = (await page.eval(state)).editor;
    assert(main.includes(READ_ONLY.mainEdit.trim()), "the edit to Main is not in the buffer");
    // Enter on its row in the Explorer: Main's import mounted its
    // archives, so the page asks nothing and fetches nothing.
    const from = server.log.length;
    const since = await page.eval(() => performance.now());
    await openModule(READ_ONLY.module);
    const loaded = await waitFor(
      (s) => noQuestion(s, "the library module's load") && !s.busy && s.tab === READ_ONLY.path && finished(s.status),
      "the library module's load",
    );
    await clearFilter();
    results.timings["library module's load, as the page reports it"] = milliseconds(loaded.status);
    const events = (await page.eval(() => window.__browserCheck)).filter((e) => e.t >= since);
    assert(
      events.some((e) => e.name === "status" && e.text === `Loading ${READ_ONLY.module}…`),
      `the inspector never said "Loading ${READ_ONLY.module}…"`,
    );
    assert(loaded.status.startsWith("Module checked ·") && loaded.problems.length === 0, `the load says "${loaded.status}"`);
    assert(archiveRequests(from).length === 0, `opening the module requested ${archiveRequests(from)}`);
    // It says what it is, and it is read-only.
    results.library = { bar: loaded.library, tabs: loaded.tabs, page: loaded.libraryPage };
    assert(
      loaded.library?.startsWith(`Read-only: ${READ_ONLY.module} is agda-algebras`) && loaded.library.includes("the checked library"),
      `the library's line says ${JSON.stringify(loaded.library)}`,
    );
    assert(loaded.libraryPage === READ_ONLY.page, `its page is ${loaded.libraryPage}, not ${READ_ONLY.page}`);
    assert(loaded.readOnly && !loaded.editable, `the module is ${loaded.readOnly ? "" : "not "}read-only and ${loaded.editable ? "" : "not "}editable`);
    assert(
      JSON.stringify(loaded.tabs) === JSON.stringify([MAIN, READ_ONLY.path]),
      `the tabs are ${JSON.stringify(loaded.tabs)}`,
    );
    const current = await page.eval(() => document.querySelector('.explorer [aria-current="true"]')?.getAttribute("data-id"));
    assert(current === `agda-algebras:${READ_ONLY.module}`, `the Explorer marks ${current} current`);
    // Agda accepted the module's own interface: it type-checked nothing,
    // and answers in the module's scope (Main does not open it).
    const checking = await inferChecking(READ_ONLY.infer);
    results.libraryLoadChecking = checking;
    assert(checking.length === 0, `the library module's load type-checked [${checking}]`);
    const inferred = await page.eval(state);
    assert(inferred.result === READ_ONLY.type, `Infer of ${READ_ONLY.infer} gave ${JSON.stringify(inferred.result)}`);
    // Nothing was written: the drive's cache, which keeps every source
    // the page writes (persisted after the load), has no copy of it.
    await new Promise((done) => setTimeout(done, 1000));
    const cached = await driveCachePaths();
    results.libraryDriveCache = { paths: cached.length, module: cached.includes(READ_ONLY.path) };
    assert(cached.includes(MAIN), `the drive's cache holds no Main, so it cannot show what was written: ${cached.length} paths`);
    assert(!cached.includes(READ_ONLY.path), `opening ${READ_ONLY.module} wrote it: the drive's cache holds ${READ_ONLY.path}`);
    // A keystroke, a deletion, a newline, an undo: nothing changes.
    await page.eval(() => document.querySelector(".cm-content").focus());
    await page.press("Home", "Home", 36, 2);
    const before = (await page.eval(state)).editor;
    await page.type("xyz");
    await page.press("Enter", "Enter", 13);
    await page.press("Delete", "Delete", 46);
    await page.press("z", "KeyZ", 90, 2);
    await new Promise((done) => setTimeout(done, 300));
    const after = await page.eval(state);
    assert(JSON.stringify(after.editor) === JSON.stringify(before), "a keystroke changed the library module");
    assert(after.editor.join("\n").includes(READ_ONLY.module), "the library module's text is not on screen");
    // Hover over a name after two characters outside the BMP.
    if (options.browser === "chromium") {
      const hover = await hoverOver(READ_ONLY.hoverLine, "Signature");
      results.libraryHover = hover;
      results.timings["hover in the library module"] = hover.ms;
      assert(hover.answer?.startsWith(READ_ONLY.hover), `hover over Signature answered ${JSON.stringify(hover.answer)}`);
    }
    // Main again: its edit is there, and undo takes it back, and only it.
    await openTab(MAIN);
    const back = await waitFor((s) => !s.busy && s.tab === MAIN && finished(s.status), "Main again, checked");
    assert(!back.readOnly && back.editable, "Main is read-only");
    assert(JSON.stringify(back.editor) === JSON.stringify(main), `Main reads ${JSON.stringify(back.editor)}, not what was typed`);
    await page.eval(() => document.querySelector(".cm-content").focus());
    await page.press("z", "KeyZ", 90, 2);
    const undone = await waitFor((s) => !s.editor.join("\n").includes(READ_ONLY.mainEdit.trim()), "the edit to Main undone", 5_000);
    assert(
      undone.editor.join("\n") === LIBRARY.source,
      `after undo Main reads ${JSON.stringify(undone.editor)}`,
    );
  });

  await step("a copy into the playground, checked, with a goal answered", async () => {
    await openTab(READ_ONLY.path);
    await waitFor((s) => !s.busy && s.tab === READ_ONLY.path && finished(s.status), "the library module again");
    await libraryAction("library-copy");
    const asked = await waitFor((s) => s.minibuffer, "the copy's minibuffer");
    const offered = await page.eval(() => ({
      label: document.querySelector(".minibuffer strong")?.textContent?.trim(),
      value: document.querySelector("#command-input")?.value,
    }));
    assert(asked.readOnly, "the copy's minibuffer left the module");
    assert(
      offered.label === `Copy ${READ_ONLY.module} to /play/` && offered.value === COPY.name,
      `the copy's minibuffer offers ${JSON.stringify(offered)}`,
    );
    // A name Agda finds already is refused, and nothing is written.
    await submit(COPY.refused);
    let refusal = null;
    for (let tries = 0; tries < 100 && !refusal; tries++) {
      refusal = await page.eval(() => document.querySelector(".action-error span")?.textContent?.trim() ?? null);
      if (!refusal) await new Promise((done) => setTimeout(done, 100));
    }
    results.copyRefused = refusal;
    assert(
      refusal?.startsWith(`Agda finds ${COPY.refused} at /agda-algebras/src/${COPY.refused}.lagda.md already`),
      `copying as ${COPY.refused} said ${JSON.stringify(refusal)}`,
    );
    await page.eval(() => document.querySelector(".action-error button").click());
    assert((await page.eval(state)).tabs.length === 2, "a refused copy opened a file");
    // The module's copy: a file of the playground, editable, checked, with
    // its module line renamed, and only itself type-checked.
    await submit(COPY.name);
    const copied = await waitFor((s) => !s.busy && s.tab === COPY.path && finished(s.status), "the copy's check");
    assert(copied.editable && !copied.readOnly && copied.library === null, "the copy is not an editable playground file");
    assert(
      copied.status.startsWith("Module checked") && copied.problems.length === 0,
      `the copy's check says "${copied.status}": ${JSON.stringify(copied.problems)}`,
    );
    const listed = await page.eval(() =>
      [...document.querySelectorAll('.explorer [role="treeitem"]')]
        .filter((row) => row.getAttribute("data-id").startsWith("play:"))
        .map((row) => row.textContent.trim()),
    );
    results.playgroundRows = listed;
    assert(listed.some((label) => label.startsWith(COPY.path.slice("/play/".length))), `the Explorer's playground lists ${JSON.stringify(listed)}`);
    const checking = await inferChecking(READ_ONLY.infer);
    results.copyChecking = checking;
    assert(JSON.stringify(checking) === JSON.stringify([COPY.name]), `the copy's check type-checked [${checking}]`);
    // A goal in the copy: its type, its context, and a give.
    await page.eval(() => document.querySelector(".cm-content").focus());
    await page.press("End", "End", 35, 2);
    await page.type(COPY.goal);
    await page.press("Enter", "Enter", 13, 2);
    const goal = await waitFor((s) => !s.busy && s.status.startsWith("1 open goal ·") && s.goals.length === 1, "the copy's goal");
    assert(goal.goalTypes.join() === COPY.goalType, `the copy's goal has type ${JSON.stringify(goal.goalTypes)}`);
    await selectGoal("0");
    const context = await waitFor((s) => s.context.length > 0, "the goal's context", 30_000);
    results.copyContext = context.context;
    assert(context.context.some(([name]) => name === "𝑆"), `the goal's context is ${JSON.stringify(context.context)}`);
    await click("Give hole contents");
    await waitFor((s) => s.minibuffer, "the Give minibuffer");
    await submit(COPY.give);
    const given = await waitFor((s) => !s.busy && !s.minibuffer && (s.goals.length === 0 || s.problems.length > 0), "the give's answer");
    assert(given.problems.length === 0, `the give reported ${JSON.stringify(given.problems)}`);
    assert(given.editor.includes(COPY.given), `the copy does not read ${COPY.given}`);
    // The control: the library's name in the copy's module line, which
    // Agda refuses.
    await findInEditor(`module ${COPY.name} where`);
    await page.type(`module ${READ_ONLY.module} where`);
    const sinceControl = await page.eval(() => performance.now());
    await page.press("Enter", "Enter", 13, 2);
    const refused = await waitForCheck(sinceControl, "the check of the copy under the library's name");
    const error = refused.problems.find((problem) => problem.error)?.message.trim() ?? "";
    results.copyControl = error;
    assert(error === `${COPY.path}:1.1${COPY.libTooFarDown}`, `under the library's name the copy's check said ${JSON.stringify(error)}`);
    await page.eval(() => document.querySelector(".cm-content").focus());
    await page.press("z", "KeyZ", 90, 2);
    const sinceBack = await page.eval(() => performance.now());
    await page.press("Enter", "Enter", 13, 2);
    const restored = await waitForCheck(sinceBack, "the copy's check under its own name again");
    assert(restored.status.startsWith("Module checked") && restored.problems.length === 0, `the copy checks as "${restored.status}"`);
  });

  await step("a selection's copy, and an import in Main", async () => {
    await openTab(READ_ONLY.path);
    await waitFor((s) => !s.busy && s.tab === READ_ONLY.path && finished(s.status), "the library module again");
    // Two lines, selected with the keyboard.
    await cursorToLine(COPY.selectionFrom);
    await page.press("Home", "Home", 36);
    await page.press("ArrowDown", "ArrowDown", 40, 8);
    await page.press("ArrowDown", "ArrowDown", 40, 8);
    await libraryAction("library-copy");
    await waitFor((s) => s.minibuffer, "the selection copy's minibuffer");
    const label = await page.eval(() => document.querySelector(".minibuffer strong")?.textContent?.trim());
    assert(label === "Copy the selection (2 lines), with the code above it, to /play/", `the minibuffer says ${JSON.stringify(label)}`);
    await submit(COPY.selectionName);
    const copied = await waitFor((s) => !s.busy && s.tab === COPY.selectionPath && finished(s.status), "the selection copy's check");
    assert(
      copied.status.startsWith("Module checked") && copied.problems.length === 0,
      `the selection copy's check says "${copied.status}": ${JSON.stringify(copied.problems)}`,
    );
    assert(copied.editor.includes(COPY.selected), `the selection copy reads ${JSON.stringify(copied.editor)}`);
    const checking = await inferChecking(READ_ONLY.infer);
    results.selectionChecking = checking;
    assert(JSON.stringify(checking) === JSON.stringify([COPY.selectionName]), `the selection copy type-checked [${checking}]`);
    // Import in Main: Main shown, the line added, and checked.
    await openTab(READ_ONLY.path);
    await waitFor((s) => !s.busy && s.tab === READ_ONLY.path && finished(s.status), "the library module once more");
    const sinceImport = await page.eval(() => performance.now());
    await libraryAction("library-import");
    const imported = await waitForCheck(sinceImport, "Main's check with the import added");
    assert(imported.tab === MAIN, `the import showed ${imported.tab}, not Main`);
    assert(imported.problems.length === 0, `Main with the import reported ${JSON.stringify(imported.problems)}`);
    assert(imported.editor.includes(`open import ${READ_ONLY.module}`), `Main reads ${JSON.stringify(imported.editor)}`);
    // Undo takes the line back, and Main is the import step's again.
    await page.eval(() => document.querySelector(".cm-content").focus());
    await page.press("z", "KeyZ", 90, 2);
    const undone = await waitFor((s) => !s.editor.includes(`open import ${READ_ONLY.module}`), "the import undone", 5_000);
    assert(undone.editor.join("\n") === LIBRARY.source, `after undo Main reads ${JSON.stringify(undone.editor)}`);
    const sinceCheck = await page.eval(() => performance.now());
    await page.press("Enter", "Enter", 13, 2);
    await waitForCheck(sinceCheck, "Main's check after the undo");
    // Saved before the steps that reload (the save waits 250 ms).
    await new Promise((done) => setTimeout(done, 500));
  });
  // Keep the runtime check's screenshot and event record before the steps
  // that navigate: the Explorer's reload, and the theme check's fresh
  // copies of the default document.
  writeFileSync(join(out, "browser-check.png"), await page.screenshot());
  results.events = await page.eval(() => window.__browserCheck ?? []);
  runtimeCaptured = true;
  await step("the Explorer after a reload", async () => {
    try {
      await checkExplorerAfterReload(
        page,
        server.origin,
        site,
        () => waitFor((s) => finished(s.status) && !s.busy, "the check after the reload"),
        (results.explorer.afterReload = {}),
      );
    } catch (error) {
      // The runtime's screenshot is kept already; this one is the reload's.
      writeFileSync(join(out, "explorer-reload.png"), await page.screenshot());
      throw error;
    }
  });

  await step("a second visit, from the browser's store", async () => {
    const want = expected(needs([LIBRARY.module]));
    await waitForStore(want.digests, "the archives kept before the page is left");
    // A drive cache of another namespace, as an earlier deploy leaves it.
    const stale = `${DRIVE_CACHE_PREFIX}0000000000000000`;
    await page.eval(
      ({ name, key }) =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open(name, 1);
          open.onupgradeneeded = () => open.result.createObjectStore("files", { keyPath: "path" });
          open.onsuccess = () => {
            open.result.close();
            localStorage.setItem(key, JSON.stringify([...JSON.parse(localStorage.getItem(key) ?? "[]"), "0000000000000000"]));
            resolve(true);
          };
          open.onerror = () => reject(open.error);
        }),
      { name: stale, key: DRIVE_NAMESPACES_KEY },
    );
    const from = server.log.length;
    await reload();
    const checked = await waitFor(
      (s) => noQuestion(s, "the second visit") && !s.busy && s.status.startsWith("Module checked"),
      "the second visit's automatic check",
    );
    results.timings["second visit's check, as the page reports it"] = milliseconds(checked.status);
    const events = await page.eval(() => window.__browserCheck);
    assert(!events.some((e) => e.name === "consent" && e.text), "the second visit asked before its check");
    assert(archiveRequests(from).length === 0, `the second visit requested ${archiveRequests(from)}`);
    const count = `${want.urls.length} ${want.urls.length === 1 ? "archive" : "archives"}`;
    const mounted = `Mounting ${count} of agda-algebras' interfaces, kept in this browser…`;
    assert(events.some((e) => e.name === "bar" && e.text?.includes(mounted)), `the status bar never said "${mounted}"`);
    const databases = await page.eval(() => indexedDB.databases().then((all) => all.map((d) => d.name)));
    results.databases = databases;
    assert(!databases.includes(stale), `the drive cache of another namespace, ${stale}, is still there`);
    assert(
      databases.some((name) => name.startsWith(DRIVE_CACHE_PREFIX)) && databases.includes(ARCHIVE_STORE),
      `the drive's own cache or the archive store is gone: ${databases}`,
    );
    const checking = await inferChecking(LIBRARY.infer);
    results.secondVisitChecking = checking;
    assert(checking.every((name) => name === "Main"), `the second visit type-checked [${checking}], not Main alone`);
  });

  await step("import Setoid.Varieties.HSP, asked once", async () => {
    const mounted = needs([LIBRARY.module]);
    const want = expected(needs([HSP.module]).filter((path) => !mounted.includes(path)));
    results.hspImport = { archives: want.urls.length, bytes: want.bytes, stated: want.stated };
    await page.eval(() => document.querySelector(".cm-content").focus());
    await page.press("a", "KeyA", 65, 2);
    await page.type(HSP.source);
    const from = server.log.length;
    const since = await page.eval(() => performance.now());
    await page.press("Enter", "Enter", 13, 2);
    const asked = await waitFor((s) => s.consent !== null && !s.busy, "the question before HSP's fetch");
    results.hspQuestion = asked.consent;
    assert(asked.consentBytes === String(want.bytes), `the question states ${asked.consentBytes} bytes, not ${want.bytes}`);
    assert(
      asked.consent.includes(`needs ${want.stated} of agda-algebras' interfaces: ${want.count}, from this site.`),
      `the question says ${JSON.stringify(asked.consent)}`,
    );
    assert(archiveRequests(from).length === 0, "archives were requested before the answer");
    // Fetch, without remembering the answer: the check after the edit
    // below must ask again if the plan wanted anything.
    await page.eval(() => document.querySelector(".consent-fetch").click());
    // The Explorer, while the mount and the check run, which take seconds
    // (issue 9).
    await useExplorerWhileBusy(page, (results.explorer.whileBusy = {}));
    const started = performance.now();
    const checked = await waitForCheck(since, "HSP's check");
    results.timings["HSP: from the answer to the check's end"] = Math.round(performance.now() - started);
    results.timings["HSP import, as the page reports it"] = milliseconds(checked.status);
    assert(checked.problems.length === 0, `HSP's import reported ${JSON.stringify(checked.problems)}`);
    const requested = archiveRequests(from);
    assert(
      JSON.stringify(requested) === JSON.stringify(want.urls),
      `the page requested ${requested.length} archives, not the ${want.urls.length} expected`,
    );
    const checking = await inferChecking(HSP.infer);
    results.hspChecking = checking;
    assert(JSON.stringify(checking) === JSON.stringify(["Main"]), `HSP's import type-checked [${checking}], not Main alone`);
    // An edit that imports nothing new: no question, no request.
    await page.eval(() => document.querySelector(".cm-content").focus());
    await page.press("End", "End", 35, 2);
    await page.type("\n-- an edit that imports nothing new\n");
    const again = server.log.length;
    const sinceEdit = await page.eval(() => performance.now());
    await page.press("Enter", "Enter", 13, 2);
    await waitForCheck(sinceEdit, "the check after an edit");
    const after = (await page.eval(() => window.__browserCheck)).filter((e) => e.t >= sinceEdit);
    assert(!after.some((e) => e.name === "consent" && e.text), "a check that imports nothing new asked again");
    assert(archiveRequests(again).length === 0, `a check that imports nothing new requested ${archiveRequests(again)}`);
  });

  await step("a changed archive, fetched again", async () => {
    const all = expected(needs([HSP.module]));
    await waitForStore(all.digests, "HSP's archives kept");
    // A browser that visited an earlier deploy: this archive under another
    // digest, and its current copy absent.
    const changed = `interfaces/${LIBRARY.module}.zip`;
    const current = INDEX.archives[changed].sha256;
    const old = "f".repeat(64);
    await replaceKept(current, { sha256: old, path: changed });
    const want = expected([changed]);
    const from = server.log.length;
    await reload();
    // The automatic check asks for that archive alone, and its bytes.
    const asked = await waitFor((s) => s.consent !== null && !s.busy, "the question for the changed archive");
    assert(asked.consentBytes === String(want.bytes), `the question states ${asked.consentBytes} bytes, not ${want.bytes}`);
    assert(
      asked.consent.includes(`needs ${want.stated} of agda-algebras' interfaces: ${want.count}, from this site.`),
      `the question says ${JSON.stringify(asked.consent)}`,
    );
    assert(!asked.consentFocused, "the automatic check's question took the focus");
    assert(archiveRequests(from).length === 0, "the changed archive was requested before the answer");
    // The old copy is evicted when the page reads the index.
    await waitForStore([], `the stale copy ${old.slice(0, 16)} evicted`, (keys) => !keys.includes(old));
    // Remember the answer for the tab, and fetch.
    await page.eval(() => {
      document.querySelector(".consent-remember input").click();
      document.querySelector(".consent-fetch").click();
    });
    await waitFor((s) => !s.busy && s.consent === null && s.status.startsWith("Module checked"), "the check after the fetch");
    const requested = archiveRequests(from);
    results.changedRequests = requested;
    assert(
      JSON.stringify(requested) === JSON.stringify(want.urls),
      `after the change the page requested ${JSON.stringify(requested)}, not ${JSON.stringify(want.urls)}`,
    );
    await waitForStore([current], "the changed archive kept");
    const checking = await inferChecking(HSP.infer);
    results.changedChecking = checking;
    assert(checking.every((name) => name === "Main"), `after the change the check type-checked [${checking}], not Main alone`);
  });

  await step("a remembered answer: the bytes stated, then fetched", async () => {
    // Another archive gone from the store; the answer is remembered.
    const gone = needs([LIBRARY.module]).find((path) => path !== `interfaces/${LIBRARY.module}.zip`);
    const want = expected([gone]);
    await replaceKept(INDEX.archives[gone].sha256);
    const from = server.log.length;
    await reload();
    const checked = await waitFor(
      (s) => noQuestion(s, "the check with the answer remembered") && !s.busy && s.status.startsWith("Module checked"),
      "the automatic check with the answer remembered",
    );
    assert(checked.problems.length === 0, `the check reported ${JSON.stringify(checked.problems)}`);
    const requested = archiveRequests(from);
    assert(
      JSON.stringify(requested) === JSON.stringify(want.urls),
      `with the answer remembered the page requested ${JSON.stringify(requested)}, not ${JSON.stringify(want.urls)}`,
    );
    // The bytes are stated before the request is made, on the page's clock,
    // as measured, not rounded.
    const events = await page.eval(() => window.__browserCheck);
    const stated = `Fetching 1 archive of agda-algebras' interfaces, ${want.stated}…`;
    const statedAt = events.find((e) => e.name === "bar" && e.text?.includes(stated))?.at;
    const requestedAt = (await page.eval(() => window.__browserCheckResources))[0]?.at;
    results.rememberedStated = { statedAt, requestedAt };
    assert(statedAt !== undefined, `the status bar never said "${stated}"`);
    assert(requestedAt !== undefined && statedAt < requestedAt, `the bytes were stated at ${statedAt} ms, not before the request at ${requestedAt} ms`);
  });

  await step("a declined fetch: what the browser keeps still mounts", async () => {
    // Forget the remembered answer, and lose one more archive from the
    // store: the next check asks for it alone.
    await page.eval(() => sessionStorage.removeItem("agda-native-ide:fetch-choice:agda-algebras"));
    const declined = needs([LIBRARY.module]).find((path) => path !== `interfaces/${LIBRARY.module}.zip` && path !== needs([LIBRARY.module]).find((p) => p !== `interfaces/${LIBRARY.module}.zip`));
    const want = expected([declined]);
    await replaceKept(INDEX.archives[declined].sha256);
    const from = server.log.length;
    await reload();
    const asked = await waitFor((s) => s.consent !== null && !s.busy, "the question for one archive");
    assert(asked.consentBytes === String(want.bytes), `the question states ${asked.consentBytes} bytes, not ${want.bytes}`);
    await page.eval(() => document.querySelector(".consent-source").click());
    const checked = await waitFor(
      (s) => noQuestion(s, "the check after a decline") && !s.busy && s.status.startsWith("Module checked"),
      "the check after the decline",
    );
    assert(checked.problems.length === 0, `the check reported ${JSON.stringify(checked.problems)}`);
    assert(archiveRequests(from).length === 0, `a declined fetch requested ${archiveRequests(from)}`);
    assert(/were not fetched/.test(checked.note ?? ""), `the note says ${JSON.stringify(checked.note)}`);
    // The archives the browser kept were mounted; Agda checked the declined
    // archive's modules from source, and accepted the archived interfaces
    // above them, which name those modules by their sources' hashes, and
    // Main's own restored interface, for the same reason (Main is not
    // always among the Checking lines).
    const fromSource = Object.entries(INDEX.modules)
      .filter(([, module]) => module.archive === declined)
      .map(([name]) => name);
    const checking = await inferChecking(HSP.infer);
    results.declinedChecking = { declined, fromSource, checking };
    assert(
      JSON.stringify(checking.filter((name) => name !== "Main").sort()) === JSON.stringify([...fromSource].sort()),
      `after the decline the check type-checked [${checking}], not the declined archive's [${fromSource}] alone (and Main)`,
    );
  });

  if (options.browser === "chromium") {
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
    `Explorer: ${results.explorer?.modules ?? "no"} modules; all expanded, ` +
      `${JSON.stringify(results.explorer?.allExpanded ?? null)}; filter ${JSON.stringify(results.explorer?.filter ?? null)}.`,
    "",
  ].join("\n");
}
