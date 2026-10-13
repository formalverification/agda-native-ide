// File: scripts/browser-check/explorer.mjs
//
// The Explorer's part of the browser check (issue 9), through the page
// alone, as a reader with the keyboard and a screen reader would use it:
//
//   +  the tree, after the first check: its roles and their attributes
//      (a labelled `tree`; each row a `treeitem` with its level and its
//      place among its siblings; one tab stop), the open file marked
//      current, agda-algebras' first rows, the arrow keys from the tab
//      stop to a module, Enter selecting it without opening it, Left,
//      Home and End; then every parent of agda-algebras opened with the
//      arrow keys, after which the rows must be the modules of the list
//      the site ships, in its order, each with its level, its place among
//      its siblings and its label; and the filter, whose rows must be the
//      modules whose names hold its words, with their ancestors;
//   +  the tree while a check runs: rows the page cannot open then are
//      `aria-disabled`, agda-algebras' never are, and a key and the filter
//      work, all in one call inside the page, so that it takes tens of
//      milliseconds of the check it runs beside;
//   +  the tree after a reload: the rows expanded before it still are, and
//      the open file, whose section was closed, is revealed; then a PLFA
//      chapter opened from the reader, in a part that is closed and far
//      below the tree's top, is revealed: its part opened, its row current
//      and scrolled into view.
//
// Each fills the record it is given as it goes, so a failure still leaves
// what was found in browser-check.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the page keeps which rows are expanded. */
export const EXPLORER_KEY = "agda-web-ide-beta:explorer:expanded";
const SECTION = "section:agda-algebras";
const PREFIX = "agda-algebras:";
const MAIN = "play:Main";

/** What the tree shows, as the accessibility tree has it, with the row
 * that has focus and what the page stored. */
export const treeState = () => {
  const tree = document.querySelector('.explorer [role="tree"]');
  const rows = tree ? [...tree.children] : [];
  let stored = null;
  try {
    stored = localStorage.getItem("agda-web-ide-beta:explorer:expanded");
  } catch {
    stored = "unavailable";
  }
  const box = tree?.getBoundingClientRect();
  return {
    label: tree?.getAttribute("aria-label") ?? null,
    rows: rows.map((row) => {
      const rect = row.getBoundingClientRect();
      const describedBy = row.getAttribute("aria-describedby");
      return {
        id: row.getAttribute("data-id"),
        role: row.getAttribute("role"),
        text: row.textContent?.trim() ?? "",
        level: Number(row.getAttribute("aria-level")),
        posinset: Number(row.getAttribute("aria-posinset")),
        setsize: Number(row.getAttribute("aria-setsize")),
        expanded: row.getAttribute("aria-expanded"),
        current: row.getAttribute("aria-current"),
        selected: row.getAttribute("aria-selected"),
        disabled: row.getAttribute("aria-disabled"),
        description: describedBy ? (document.getElementById(describedBy)?.textContent ?? "(missing)") : null,
        tabindex: row.getAttribute("tabindex"),
        inView: box ? rect.height > 0 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 : false,
      };
    }),
    scrollTop: tree?.scrollTop ?? 0,
    focused: document.activeElement?.closest?.('[role="treeitem"]')?.getAttribute("data-id") ?? null,
    filter: document.querySelector(".explorer input[type=search]")?.value ?? null,
    filterLabel: document.querySelector(".explorer input[type=search]")?.getAttribute("aria-label") ?? null,
    status: document.querySelector('.explorer [role="status"]')?.textContent?.trim() ?? null,
    stored,
    busy: document.querySelector(".spin") !== null,
    editor: document.querySelector(".cm-content")?.textContent ?? "",
  };
};

/** @param {boolean} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(`Explorer: ${message}`);
}

/** Poll the tree until `predicate` holds.
 * @param {any} page @param {(s: ReturnType<typeof treeState>) => boolean} predicate @param {string} what */
async function until(page, predicate, what, timeoutMs = 30_000) {
  const start = performance.now();
  let last;
  while (performance.now() - start < timeoutMs) {
    last = await page.eval(treeState);
    if (predicate(last)) return last;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Explorer: timed out waiting for ${what}; focused ${last?.focused}, ${last?.rows.length} rows`);
}

const KEY_CODES = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Enter: 13, Escape: 27 };
/** Press a key where the focus is. @param {any} page @param {keyof typeof KEY_CODES} key */
const press = (page, key) => page.press(key, key, KEY_CODES[key]);

/** Focus a row, as Tab or assistive technology would. @param {any} page @param {string} id */
const focusRow = (page, id) =>
  page.eval((id) => {
    const row = [...document.querySelectorAll('.explorer [role="treeitem"]')].find(
      (element) => element.getAttribute("data-id") === id,
    );
    if (!row) throw new Error(`no row ${id}`);
    row.focus();
  }, id);

/** Click what `selector` names without scrolling to it first, as a click
 * on what is on screen does. @param {any} page @param {string} selector */
const click = (page, selector) =>
  page.eval((selector) => {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`nothing matches ${selector}`);
    target.click();
  }, selector);

/** The rows of a library with every parent opened, from a list's modules
 * in its order: each module, after any folder of its name's that is no
 * module, the folder first; each with its level under its section, its
 * place among its siblings, and its label.
 * @param {{ name: string }[]} modules */
export function libraryRows(modules) {
  const names = new Set(modules.map((entry) => entry.name));
  const seen = new Set();
  /** @type {{ name: string, level: number, parent: string }[]} */
  const rows = [];
  for (const { name } of modules) {
    const parts = name.split(".");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join(".");
      if (names.has(folder) || seen.has(folder)) continue;
      seen.add(folder);
      rows.push({ name: folder, level: i + 1, parent: parts.slice(0, i - 1).join(".") });
    }
    rows.push({ name, level: parts.length + 1, parent: parts.slice(0, -1).join(".") });
  }
  const siblings = Map.groupBy(rows, (row) => row.parent);
  return rows.map((row) => {
    const group = siblings.get(row.parent) ?? [];
    return {
      name: row.name,
      level: row.level,
      posinset: group.indexOf(row) + 1,
      setsize: group.length,
      label: row.name.split(".").at(-1),
    };
  });
}

/** The rows of the library shown. @param {ReturnType<typeof treeState>} tree */
const library = (tree) => tree.rows.filter((row) => row.id?.startsWith(PREFIX));
/** @param {ReturnType<typeof treeState>} tree @param {string} id */
const row = (tree, id) => tree.rows.find((candidate) => candidate.id === id);

/** The tree after the first check, the keys, every module, the filter.
 * @param {any} page @param {string} site @param {Record<string, any>} record */
export async function checkExplorer(page, site, record) {
  const list = JSON.parse(readFileSync(join(site, "agda-algebras-modules.json"), "utf8"));
  /** @type {{ name: string }[]} */
  const modules = list.modules;
  record.modules = modules.length;

  let tree = await until(page, (s) => library(s).length > 0, "agda-algebras' rows");
  record.firstVisitRows = tree.rows.length;
  assert(tree.label === "Files", `the tree's label is ${JSON.stringify(tree.label)}`);
  assert(tree.filterLabel === "Filter files by name", `the filter's label is ${JSON.stringify(tree.filterLabel)}`);
  for (const shown of tree.rows) {
    assert(shown.role === "treeitem", `row ${shown.id} has role ${shown.role}`);
    assert(
      shown.level >= 1 && shown.posinset >= 1 && shown.posinset <= shown.setsize,
      `row ${shown.id} has level ${shown.level} and place ${shown.posinset} of ${shown.setsize}`,
    );
  }
  const stops = tree.rows.filter((shown) => shown.tabindex === "0").map((shown) => shown.id);
  assert(stops.length === 1 && stops[0] === MAIN, `the tab stops are [${stops}], not the open file's row alone`);
  const current = tree.rows.filter((shown) => shown.current === "true").map((shown) => shown.id);
  assert(current.join() === MAIN, `the rows marked current are [${current}], not Main.agda's`);
  assert(row(tree, MAIN)?.expanded === null, "Main.agda's row says it has rows of its own");
  const tops = [...new Set(modules.map((entry) => entry.name.split(".")[0]))];
  const firstRows = library(tree).map((shown) => shown.id.slice(PREFIX.length));
  record.firstVisitLibraryRows = firstRows.length;
  assert(
    JSON.stringify(firstRows) === JSON.stringify(tops),
    `agda-algebras' first rows are [${firstRows}], not the list's [${tops}]`,
  );

  // The arrow keys from the tab stop to Overture.Signatures, the module
  // the import step checks, and Enter on it.
  const target = "Overture.Signatures";
  const parent = "Overture";
  const editor = tree.editor;
  await focusRow(page, MAIN);
  /** @param {keyof typeof KEY_CODES} key @param {(s: ReturnType<typeof treeState>) => boolean} expect @param {string} what */
  const step = async (key, expect, what) => {
    await press(page, key);
    tree = await until(page, expect, `${key}: ${what}`, 5_000);
  };
  await step("ArrowDown", (s) => s.focused === SECTION, "the agda-algebras section focused");
  await step("ArrowRight", (s) => s.focused === `${PREFIX}${tops[0]}`, "its first row focused");
  for (let i = 1; i <= tops.indexOf(parent); i++)
    await step("ArrowDown", (s) => s.focused === `${PREFIX}${tops[i]}`, `${tops[i]} focused`);
  await step("ArrowRight", (s) => row(s, `${PREFIX}${parent}`)?.expanded === "true" && s.focused === `${PREFIX}${parent}`, `${parent} expanded`);
  const children = libraryRows(modules).filter((entry) => entry.level === 3 && entry.name.startsWith(`${parent}.`)).map((entry) => entry.name);
  await step("ArrowRight", (s) => s.focused === `${PREFIX}${children[0]}`, `${children[0]} focused`);
  for (let i = 1; i <= children.indexOf(target); i++)
    await step("ArrowDown", (s) => s.focused === `${PREFIX}${children[i]}`, `${children[i]} focused`);
  await step("Enter", (s) => row(s, `${PREFIX}${target}`)?.selected === "true", `${target} selected`);
  record.keysToModule = { module: target, presses: 5 + tops.indexOf(parent) + children.indexOf(target) };
  const reached = row(tree, `${PREFIX}${target}`);
  assert(reached?.level === 3 && reached.tabindex === "0", `${target}'s row is ${JSON.stringify(reached)}`);
  assert(row(tree, MAIN)?.current === "true", "Enter on a library module moved the open file");
  assert(tree.editor === editor, "Enter on a library module changed the editor's text");
  const described = row(tree, `${PREFIX}${parent}`)?.description;
  assert(described === "module and folder", `${parent}'s row is described as ${JSON.stringify(described)}`);
  await step("ArrowLeft", (s) => s.focused === `${PREFIX}${parent}`, "the parent focused");
  await step("ArrowLeft", (s) => row(s, `${PREFIX}${parent}`)?.expanded === "false", `${parent} collapsed`);
  await step("Home", (s) => s.focused === "section:play", "the first row focused");
  await step("End", (s) => s.focused === s.rows.at(-1)?.id, "the last row focused");

  // Every parent of agda-algebras opened, each with Right: the rows must
  // be the list's modules, in its order, each at its level and place,
  // with its label.
  let opened = 0;
  for (;;) {
    const closed = library(tree).find((shown) => shown.expanded === "false");
    if (!closed) break;
    await focusRow(page, closed.id);
    await step("ArrowRight", (s) => row(s, closed.id)?.expanded === "true", `${closed.id} expanded`);
    opened += 1;
  }
  const expected = libraryRows(modules);
  const shown = library(tree).map((entry) => ({
    name: entry.id.slice(PREFIX.length),
    level: entry.level,
    posinset: entry.posinset,
    setsize: entry.setsize,
    label: entry.text,
  }));
  const moduleNames = new Set(modules.map((entry) => entry.name));
  record.allExpanded = {
    libraryRows: shown.length,
    moduleRows: shown.filter((entry) => moduleNames.has(entry.name)).length,
    foldersAlone: shown.filter((entry) => !moduleNames.has(entry.name)).map((entry) => entry.name),
    parentsOpened: opened,
    deepestLevel: Math.max(...library(tree).map((entry) => entry.level)),
    treeRows: tree.rows.length,
  };
  const differs = expected.findIndex((entry, i) => JSON.stringify(entry) !== JSON.stringify(shown[i]));
  assert(
    differs < 0 && shown.length === expected.length,
    "agda-algebras' rows, all expanded, are not the list's modules in its order: " +
      (differs < 0
        ? `${shown.length} rows, expected ${expected.length}`
        : `row ${differs} is ${JSON.stringify(shown[differs])}, expected ${JSON.stringify(expected[differs])}`),
  );
  const stored = JSON.parse(tree.stored ?? "[]");
  assert(
    library(tree).filter((entry) => entry.expanded === "true").every((entry) => stored.includes(entry.id)),
    "the page did not store every expanded row",
  );

  // The filter: the modules whose names hold every word, with their
  // ancestors; Escape clears it.
  const query = "hsp";
  await page.eval(() => document.querySelector(".explorer input[type=search]").focus());
  await page.type(query);
  const found = modules.filter((entry) => entry.name.toLowerCase().includes(query)).map((entry) => entry.name);
  const keep = new Set(found.flatMap((name) => name.split(".").map((_, i, parts) => parts.slice(0, i + 1).join("."))));
  const filtered = expected.filter((entry) => keep.has(entry.name)).map((entry) => entry.name);
  record.filter = { query, matches: found.length };
  tree = await until(page, (s) => s.filter === query && s.status === `${found.length} matches`, `the filter's ${found.length} matches`, 5_000);
  const filteredShown = library(tree).map((entry) => entry.id.slice(PREFIX.length));
  record.filter.libraryRows = filteredShown.length;
  assert(
    JSON.stringify(filteredShown) === JSON.stringify(filtered),
    `the filter "${query}" shows [${filteredShown}], not [${filtered}]`,
  );
  assert(!row(tree, MAIN), "the filter shows Main.agda, which does not match");
  await press(page, "Escape");
  tree = await until(page, (s) => s.filter === "" && library(s).length === expected.length, "the filter cleared", 5_000);
}

/** The tree while a check runs, in one call inside the page: called as
 * the check starts.  @param {any} page @param {Record<string, any>} record */
export async function useExplorerWhileBusy(page, record) {
  await until(page, (s) => s.busy, "the check to start", 10_000);
  const found = await page.eval(async () => {
    const busy = () => document.querySelector(".spin") !== null;
    const frame = () => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));
    const started = performance.now();
    const rows = () => [...document.querySelectorAll('.explorer [role="treeitem"]')];
    const out = {
      busyBefore: busy(),
      disabled: rows()
        .filter((row) => row.getAttribute("aria-disabled") === "true")
        .map((row) => row.getAttribute("data-id")),
    };
    const library = rows().filter((row) => row.getAttribute("data-id").startsWith("agda-algebras:"));
    out.libraryDisabled = library.filter((row) => row.hasAttribute("aria-disabled")).length;
    library[0].focus();
    library[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    out.focusedAfterDown = document.activeElement?.getAttribute("data-id") ?? null;
    out.expectedAfterDown = library[1].getAttribute("data-id");
    const input = document.querySelector('.explorer input[type="search"]');
    input.value = "basic";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await frame();
    out.status = document.querySelector('.explorer [role="status"]').textContent.trim();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await frame();
    out.busyAfter = busy();
    out.ms = Math.round(performance.now() - started);
    return out;
  });
  Object.assign(record, found);
  assert(
    found.busyBefore && found.busyAfter,
    `the check ended while the Explorer was used (${found.ms} ms): this step needs a check that outlasts it`,
  );
  assert(found.disabled.includes(MAIN), "Main.agda's row is not aria-disabled while Agda is busy");
  assert(found.libraryDisabled === 0, `${found.libraryDisabled} rows of agda-algebras are disabled while Agda is busy`);
  assert(
    found.focusedAfterDown === found.expectedAfterDown,
    `Down while Agda is busy focused ${found.focusedAfterDown}, not ${found.expectedAfterDown}`,
  );
  assert(/^\d+ match/.test(found.status), `the filter while Agda is busy says ${JSON.stringify(found.status)}`);
}

/** The tree after a reload: what was expanded still is, and the open
 * file, whose section was closed, is revealed; then a chapter opened from
 * the reader is revealed, its part opened and its row scrolled into view.
 * @param {any} page @param {string} origin @param {string} site
 * @param {() => Promise<unknown>} checked @param {Record<string, any>} record */
export async function checkExplorerAfterReload(page, origin, site, checked, record) {
  await focusRow(page, "section:play");
  await press(page, "ArrowLeft");
  let tree = await until(page, (s) => !row(s, MAIN) && row(s, "section:play")?.expanded === "false", "the playground closed", 5_000);
  const before = JSON.parse(tree.stored ?? "[]");
  assert(!before.includes("section:play"), "the page stored the closed playground as expanded");
  const expandedBefore = tree.rows.filter((entry) => entry.expanded === "true").map((entry) => entry.id);
  record.expandedBefore = expandedBefore.length;
  const navigation = await page.eval(() => performance.timeOrigin);
  await page.navigate(origin);
  for (let i = 0; i < 200; i++) {
    const now = await page.eval(() => performance.timeOrigin).catch(() => navigation);
    if (now !== navigation) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  await checked();
  tree = await until(page, (s) => library(s).length > 0 && Boolean(row(s, MAIN)), "agda-algebras' rows and Main.agda's, after the reload");
  const main = row(tree, MAIN);
  assert(main?.current === "true" && main.tabindex === "0", `after the reload Main.agda's row is ${JSON.stringify(main)}`);
  const lost = expandedBefore.filter((id) => row(tree, id)?.expanded !== "true");
  assert(lost.length === 0, `after the reload [${lost}] are no longer expanded`);
  assert(JSON.parse(tree.stored ?? "[]").includes("section:play"), "the page did not store the revealed playground");
  record.revealedAfterReload = MAIN;

  // A chapter opened from the tree, its part then closed and the tree
  // scrolled to its top; the reader's Next opens the next part's first
  // chapter, which the tree must reveal, far below its top.
  const corpus = JSON.parse(readFileSync(join(site, "plfa/manifest.json"), "utf8"));
  const [first, second] = corpus.groups;
  const last = `plfa:${first.chapters.at(-1).id}`;
  const next = `plfa:${second.chapters[0].id}`;
  /** @param {ReturnType<typeof treeState>} s */
  const idle = (s) => !s.busy;
  await until(page, (s) => idle(s) && Boolean(row(s, last)), `${last}'s row`);
  await click(page, `.explorer [data-id="${last}"]`);
  tree = await until(page, (s) => idle(s) && row(s, last)?.current === "true", `${last} opened`, 60_000);
  await click(page, `.explorer [data-id="plfa:${first.id}"]`);
  tree = await until(page, (s) => row(s, `plfa:${first.id}`)?.expanded === "false" && !row(s, last), `${first.id} closed`, 5_000);
  assert(row(tree, `plfa:${second.id}`)?.expanded === "false", `${second.id} is open before the reader's Next`);
  await page.eval(() => {
    document.querySelector('.explorer [role="tree"]').scrollTop = 0;
  });
  await click(page, 'button[aria-label="Next PLFA chapter"]');
  tree = await until(
    page,
    (s) => idle(s) && row(s, next)?.current === "true" && Boolean(row(s, next)?.inView),
    `${next} revealed`,
    60_000,
  );
  record.chapterRevealed = { chapter: next, scrolledTo: tree.scrollTop };
  assert(row(tree, `plfa:${second.id}`)?.expanded === "true", `${second.id} was not opened for its chapter`);
  assert(row(tree, `plfa:${first.id}`)?.expanded === "false", `${first.id}, closed by the reader, was opened again`);
  assert(tree.scrollTop > 0, "the tree did not scroll to the chapter");
}
