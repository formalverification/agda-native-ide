// File: scripts/pages/browser.mjs
//
// The website in headless Chromium (issue 96).  It serves the built Pages
// tree under the site's path (/agda-native-ide/, as GitHub Pages does) and
// does the following:
//
//   1.  opens the playground at play/, waits for its first check of the
//       default Main.agda (one open goal), and takes the home page's two
//       pictures of it, in its light and its dark theme, at 1440 by 900,
//       into the tree's assets/screenshots/, which the home page shows;
//   2.  opens every page of the website in both color schemes (the
//       reader's system preference, emulated, which the palette follows),
//       at a desktop width (1440) and a phone width (390), and asserts that
//       Material drew the scheme asked for, that nothing scrolls sideways,
//       that the page threw no error, that every text of the article has
//       WCAG 2.2 AA contrast against what it is drawn on (4.5:1, or 3:1 for
//       large text), with each ancestor's opacity folded in, and that every
//       request went to the site's own origin;
//   3.  searches for a word, which proves Material's search works without
//       the lunr/ directory the flake removes;
//   4.  clicks every link to the playground on every page, with Material's
//       instant navigation engaged, and asserts that each click is a full
//       load of play/ that starts the app, not a document fetched and
//       swapped in (which would leave the app's scripts unrun).  Instant
//       navigation intercepts a click only on a link the sitemap lists,
//       with the sitemap's host and the page's equal; the server answers
//       sitemap.xml with its addresses moved to its own origin, as they
//       are on the deployed site, and the step first proves that a click
//       on a page link is intercepted, or its finding would be vacuous.
//
// It writes pages-browser.json (every page's findings) and screenshots of
// the home page and the page on each project's own Agda, both schemes,
// desktop and phone, into --out, and exits 1 on the first page that fails.
//
//   CHROME=<chromium> node scripts/pages/browser.mjs <tree> [--out DIR] [--prefix /agda-native-ide/]
//   nix run .#pages-browser -- <tree> [--out DIR]

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { launch } from "../browser-check/cdp.mjs";
import { serve } from "../browser-check/serve.mjs";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "pages-check/browser" },
    prefix: { type: "string", default: "/agda-native-ide/" },
  },
});
if (positionals.length !== 1 || !process.env.CHROME) {
  console.error("usage: CHROME=<chromium> node scripts/pages/browser.mjs <tree> [--out DIR] [--prefix /agda-native-ide/]");
  process.exit(2);
}
const tree = resolve(positionals[0]);
const prefix = `/${options.prefix.replace(/^\/+|\/+$/g, "")}/`;
const out = resolve(options.out);
mkdirSync(out, { recursive: true });

const WIDTHS = { desktop: [1440, 900], phone: [390, 844] };
const SCHEMES = { light: "default", dark: "slate" };
// The pages whose screenshots the pull request shows.
const SHOWN = new Set(["", "each-projects-own-agda/"]);
const STEP_TIMEOUT_MS = 180_000;

/** Every page of the website (not the playground's), as a path from the
 * site's root: "" for the home page, "adr/0001-runtime/" and so on. */
function websitePages(dir = tree) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    const rel = relative(tree, path).split(sep).join("/");
    if (entry.isDirectory()) return rel === "play" ? [] : websitePages(path);
    if (entry.name === "index.html") return [rel.slice(0, -"index.html".length)];
    if (entry.name === "404.html") return [rel];
    return [];
  }).sort();
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(page, fn, what, timeout = STEP_TIMEOUT_MS, arg = null) {
  const start = performance.now();
  let last;
  while (performance.now() - start < timeout) {
    last = await page.eval(fn, arg).catch(() => undefined);
    if (last?.ok) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

/** Runs in the page: what Material drew, the widths, and every text of the
 * article whose contrast is under AA, with each ancestor's opacity. */
const AUDIT = () => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return [0, 0, 0, 0];
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (top, bottom) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
  };
  /** The color an element is drawn on: its ancestors' backgrounds, over
   * the page's. */
  const background = (element) => {
    const layers = [];
    for (let e = element; e; e = e.parentElement) {
      const bg = parse(getComputedStyle(e).backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
    }
    let color = [255, 255, 255, 1];
    for (const layer of layers.reverse()) color = over(layer, color);
    return color;
  };
  const opacity = (element) => {
    let o = 1;
    for (let e = element; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const failures = [];
  const seen = new Set();
  const article = document.querySelector("article") ?? document.body;
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const element = node.parentElement;
    if (!element || element.closest("svg, .md-clipboard, [hidden]")) continue;
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden") continue;
    // Text drawn fully transparent (a heading's permalink before hover)
    // is not shown, so it has no contrast to judge.
    const alpha = opacity(element);
    if (alpha === 0) continue;
    const bg = background(element);
    const fg = parse(style.color);
    const drawn = over([fg[0], fg[1], fg[2], fg[3] * alpha], bg);
    const [a, b] = [lum(drawn), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      const key = `${element.tagName}.${element.className}|${style.color}|${bg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push({ text: node.textContent.trim().slice(0, 60), tag: element.tagName, class: String(element.className), color: style.color, background: `rgb(${bg.slice(0, 3).map(Math.round).join(", ")})`, ratio: Math.round(ratio * 100) / 100, need });
    }
  }
  return {
    scheme: document.body.getAttribute("data-md-color-scheme"),
    prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
    stored: Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`.slice(0, 200)),
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    title: document.title,
    contrast: failures,
  };
};

// The server serves a directory holding one link, named after the site's
// path, to the tree, so that a URL under the path finds the tree's file.
const holder = mkdtempSync(join(tmpdir(), "pages-browser-"));
symlinkSync(tree, join(holder, prefix.replace(/\//g, "")));
// The sitemap names the deployed host; Material compares a link with it
// by protocol and hostname, never the port, so on this server it would
// match nothing, and instant navigation would intercept no click at all.
// It is answered with its addresses on this server's origin instead.
let origin = "";
const server = await serve({
  root: holder,
  prefix,
  answer: (path) =>
    path === "/sitemap.xml"
      ? { status: 200, body: Buffer.from(readFileSync(join(tree, "sitemap.xml"), "utf8").replace(/<loc>https?:\/\/[^/<]+/g, () => `<loc>${origin}`)) }
      : undefined,
});
origin = server.origin;
const chrome = await launch(process.env.CHROME);
const page = chrome.page;
const site = `${server.origin}${prefix}`;
const record = { tree, site: prefix, date: new Date().toISOString(), browser: chrome.product, screenshots: [], pages: [], search: null, playgroundLinks: null, failure: null };
const errors = [];
const offOrigin = [];
await page.onConsole((entry) => {
  if (entry.type === "exception" || entry.type === "error") errors.push(entry);
});
await page.send("Network.enable");
page.on("Network.requestWillBeSent", (event) => {
  const url = event.request.url;
  if (!url.startsWith(server.origin) && !/^(data|blob|about|chrome-extension):/.test(url)) offOrigin.push(url);
});
const media = (scheme) =>
  page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
const viewport = ([width, height], mobile) =>
  page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
/** Navigate, and wait for the new document to finish loading. */
async function open(url) {
  // Material remembers the scheme it drew; a reader's first visit has
  // nothing remembered, which is what the emulated preference decides.
  // The storage is cleared from a blank page, since a page of the site
  // still open can write it again after a clear.
  await page.navigate("about:blank");
  await until(page, () => ({ ok: location.href === "about:blank" }), "a blank page", 10_000);
  await page.send("Storage.clearDataForOrigin", { origin: server.origin, storageTypes: "local_storage" });
  const before = await page.eval(() => performance.timeOrigin).catch(() => 0);
  await page.navigate(url);
  await until(
    page,
    (b) => ({ ok: performance.timeOrigin !== b && document.readyState === "complete" }),
    `the load of ${url}`,
    30_000,
    before,
  );
}

let code = 0;
try {
  // 1.  The playground's pictures.
  await viewport(WIDTHS.desktop, false);
  await media("light");
  const shots = join(tree, "assets", "screenshots");
  mkdirSync(shots, { recursive: true });
  await open(`${site}play/`);
  const checked = await until(
    page,
    () => {
      const status = document.querySelector(".inspector-status")?.textContent?.trim() ?? "";
      const busy = document.querySelector(".spin") !== null;
      const context = document.querySelectorAll(".context-row").length;
      return { ok: status.startsWith("1 open goal") && !busy && context > 0, status };
    },
    "the playground's first check",
  );
  for (const theme of ["light", "dark"]) {
    await page.eval((value) => {
      const select = document.querySelector('select[aria-label="Color theme"]');
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, theme);
    await until(page, (value) => ({ ok: document.documentElement.dataset.theme === value }), `the ${theme} theme`, 10_000, theme);
    await sleep(400);
    const file = join(shots, `playground-${theme}.png`);
    writeFileSync(file, await page.screenshot());
    record.screenshots.push(relative(tree, file));
  }
  record.playground = { status: checked.status };
  // Leave the playground's theme as the reader's system again.
  await page.eval(() => localStorage.clear());
  console.log(`ok  the playground's pictures (${checked.status})`);

  // 2.  Every page, both schemes, two widths.
  for (const path of websitePages()) {
    for (const [schemeName, scheme] of Object.entries(SCHEMES)) {
      for (const [widthName, size] of Object.entries(WIDTHS)) {
        const errorsBefore = errors.length;
        const offBefore = offOrigin.length;
        // The viewport first: a change of its `mobile` flag can reset the
        // emulated media, which then must be set after it.
        await viewport(size, widthName === "phone");
        await media(schemeName);
        await open(`${site}${path}`);
        // Material picks the scheme in its bundle, after the load; give it
        // a moment, and let the audit report what it drew.
        await until(page, (want) => ({ ok: document.body.getAttribute("data-md-color-scheme") === want }), "the scheme", 5_000, scheme)
          .catch(() => undefined);
        await sleep(150);
        const found = await page.eval(AUDIT);
        // `asked` and `viewport` are what was asked for; `scheme` and
        // `width` (from the audit) are what the page drew.
        const finding = { path, asked: schemeName, viewport: widthName, ...found, errors: errors.slice(errorsBefore), offOrigin: offOrigin.slice(offBefore) };
        record.pages.push(finding);
        const problems = [
          found.scheme !== scheme && `Material drew ${found.scheme}, not ${scheme} (dark preferred: ${found.prefersDark}; stored: ${found.stored.join(" ")})`,
          found.scrollWidth > found.width && `it scrolls sideways (${found.scrollWidth} > ${found.width})`,
          finding.errors.length && `it threw ${JSON.stringify(finding.errors)}`,
          finding.offOrigin.length && `it requested ${finding.offOrigin.join(", ")}`,
          found.contrast.length && `${found.contrast.length} texts under AA: ${JSON.stringify(found.contrast.slice(0, 3))}`,
        ].filter(Boolean);
        if (SHOWN.has(path)) {
          const name = `${path.replace(/\/$/, "") || "home"}-${schemeName}-${widthName}.png`;
          writeFileSync(join(out, name), await page.screenshot());
        }
        if (problems.length) throw new Error(`/${path} (${schemeName}, ${widthName}): ${problems.join("; ")}`);
      }
    }
    console.log(`ok  /${path}`);
  }

  // 3.  Search.
  await viewport(WIDTHS.desktop, false);
  // Material reads a query from ?q=, opens the search, and runs it once
  // its worker has the index: the reader's path through the search box,
  // without synthetic keys (it listens for keyup, which insertText is not).
  await open(`${site}?q=reactor`);
  const search = await until(
    page,
    () => {
      const items = document.querySelectorAll(".md-search-result__item");
      return { ok: items.length > 0, results: items.length, meta: document.querySelector(".md-search-result__meta")?.textContent };
    },
    "search results for reactor",
    20_000,
  );
  record.search = { query: "reactor", results: search.results, meta: search.meta };
  console.log(`ok  search: ${search.meta}`);

  // 4.  The links to the playground.
  const playground = `${prefix}play/`;
  /** Open `path` and wait until Material has the sitemap, before which it
   * intercepts no click (its click stream waits on the sitemap). */
  const ready = async (path) => {
    await open(`${site}${path}`);
    await until(
      page,
      () => ({ ok: performance.getEntriesByType("resource").some((e) => e.name.endsWith("/sitemap.xml") && e.responseEnd > 0) }),
      `the sitemap, on /${path}`,
      20_000,
    );
    await sleep(300);
    await page.eval(() => {
      window.__beforeClick = true;
    });
  };
  // The precondition: a click on a link to the next page is intercepted,
  // so the page, and the marker set on it, survive the navigation.
  await ready("");
  const next = await page.eval(() => {
    const link = document.querySelector("a.md-footer__link--next");
    link?.click();
    return link ? new URL(link.href).pathname : null;
  });
  if (!next) throw new Error("the home page has no link to the next page");
  const kept = await until(page, (want) => ({ ok: location.pathname === want, marker: window.__beforeClick === true }), `the next page, ${next}`, 20_000, next);
  if (!kept.marker) throw new Error(`instant navigation did not intercept a click on ${next}, so a full load of play/ would prove nothing`);
  const links = [];
  for (const path of websitePages()) {
    await ready(path);
    const count = await page.eval((want) => [...document.querySelectorAll("a[href]")].filter((a) => new URL(a.href).pathname === want).length, playground);
    for (let index = 0; index < count; index++) {
      if (index > 0) await ready(path);
      const text = await page.eval(([want, i]) => {
        const link = [...document.querySelectorAll("a[href]")].filter((a) => new URL(a.href).pathname === want)[i];
        link.click();
        return link.textContent.trim().replace(/\s+/g, " ");
      }, [playground, index]);
      await until(page, (want) => ({ ok: location.pathname === want && document.readyState === "complete" }), `play/, from /${path}`, 30_000, playground);
      await sleep(500);
      const swapped = await page.eval(() => window.__beforeClick === true);
      if (swapped) throw new Error(`/${path}: the link "${text}" to play/ was swapped in by instant navigation, so the app's scripts never ran`);
      await until(page, () => ({ ok: document.querySelector(".inspector-status") !== null }), `the app, from /${path}`, 30_000);
      links.push({ from: path, text });
    }
  }
  if (links.length === 0) throw new Error("no page links to play/");
  record.playgroundLinks = { instantNavigation: next, links };
  console.log(`ok  ${links.length} links to play/, on ${new Set(links.map((l) => l.from)).size} pages: each a full load that starts the app (a click on ${next} was intercepted)`);
} catch (error) {
  record.failure = error instanceof Error ? error.message : String(error);
  console.error(`FAILED: ${record.failure}`);
  writeFileSync(join(out, "failure.png"), await page.screenshot().catch(() => Buffer.from("")));
  code = 1;
} finally {
  record.requests = server.log;
  writeFileSync(join(out, "pages-browser.json"), JSON.stringify(record, null, 1) + "\n");
  await chrome.close();
  await server.close();
  rmSync(holder, { recursive: true, force: true });
}
console.log(`pages-browser: ${record.pages.length} page views, ${record.failure ? "failed" : "passed"}`);
process.exit(code);
