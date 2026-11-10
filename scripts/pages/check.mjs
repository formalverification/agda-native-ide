// File: scripts/pages/check.mjs
//
// The built Pages tree's static check (issue 96): every HTML page and
// stylesheet of the website and of the playground under play/, read as
// files, with no browser, as follows:
//
//   +  every link and every fetch inside the site resolves to a file in the
//      tree, and every fragment of a link to a page names an `id` (or a
//      `name`) on that page;
//   +  nothing is fetched from another origin: no stylesheet, script,
//      image, font, icon or frame, in an attribute, a <style> element, a
//      style attribute or a stylesheet's url() and @import;
//   +  no target leaves the tree, and a root-absolute one starts with the
//      site's path (/agda-native-ide/ by default, the site_url's), since
//      GitHub Pages serves the site there.
//
// Links to other sites are not followed here; they are listed, by page,
// in --out's outbound.json, for the sweep that checks them by hand.
// <link rel="canonical"> and its kin (prev, next, alternate), which
// Material writes with the absolute site_url, are links, not fetches.
//
//   node scripts/pages/check.mjs <tree> [--prefix /agda-native-ide/] [--out DIR]
//
// It exits 1 with every problem listed, and writes check.json (what it
// read and found) into --out.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prefix: { type: "string", default: "/agda-native-ide/" },
    out: { type: "string", default: "pages-check" },
  },
});
if (positionals.length !== 1) {
  console.error("usage: node scripts/pages/check.mjs <tree> [--prefix /agda-native-ide/] [--out DIR]");
  process.exit(2);
}
const root = resolve(positionals[0]);
const prefix = `/${options.prefix.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");

/** Every file under `dir`, as a path relative to the tree, with `/`. */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [relative(root, path).split(sep).join("/")];
  });
}

const files = walk(root);
const fileSet = new Set(files);
const pages = files.filter((f) => f.endsWith(".html"));
const sheets = files.filter((f) => f.endsWith(".css"));

/** The tree's file a site path names (`a/b/` is `a/b/index.html`), or
 * null. */
function fileOf(path) {
  const clean = path.replace(/^\/+/, "");
  if (clean === "" || clean.endsWith("/")) return fileSet.has(`${clean}index.html`) ? `${clean}index.html` : null;
  if (fileSet.has(clean)) return clean;
  if (fileSet.has(`${clean}/index.html`)) return `${clean}/index.html`;
  return null;
}

/** The ids and names on each page, read once. */
const anchorCache = new Map();
function anchorsOf(file) {
  if (!anchorCache.has(file)) {
    const html = readFileSync(join(root, file), "utf8");
    const ids = new Set([...html.matchAll(/\s(?:id|name)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
    anchorCache.set(file, ids);
  }
  return anchorCache.get(file);
}

const problems = [];
const outbound = new Map();
let checked = 0;

/** Judge one URL written in `from` (a file of the tree): `fetch` when the
 * browser loads it by itself (a stylesheet, a script, an image). */
function judge(from, url, { fetch, where }) {
  const raw = url.trim().replace(/&amp;/g, "&");
  if (raw === "" || raw.startsWith("data:") || raw.startsWith("blob:") || raw.startsWith("mailto:") || raw.startsWith("javascript:")) return;
  checked++;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
    if (fetch) problems.push(`${from}: ${where} fetches ${raw} from another origin`);
    else {
      const list = outbound.get(raw) ?? [];
      if (!list.includes(from)) list.push(from);
      outbound.set(raw, list);
    }
    return;
  }
  const [beforeHash, fragment = ""] = raw.split("#", 2);
  const path = beforeHash.split("?", 1)[0];
  if (path === "") {
    if (fragment && from.endsWith(".html") && !anchorsOf(from).has(decodeURIComponent(fragment)))
      problems.push(`${from}: ${where} #${fragment} names no id on the page`);
    return;
  }
  let target;
  if (path.startsWith("/")) {
    if (!path.startsWith(prefix)) {
      problems.push(`${from}: ${where} ${raw} is root-absolute outside ${prefix}`);
      return;
    }
    target = posix.normalize(path.slice(prefix.length));
  } else {
    target = posix.normalize(posix.join(posix.dirname(from), decodeURIComponent(path)));
    if (path.endsWith("/") && !target.endsWith("/")) target += "/";
  }
  if (target === ".." || target.startsWith("../")) {
    problems.push(`${from}: ${where} ${raw} leaves the tree`);
    return;
  }
  const file = fileOf(target === "." ? "" : target);
  if (!file) {
    problems.push(`${from}: ${where} ${raw} resolves to ${target}, which the tree does not have`);
    return;
  }
  if (fragment && file.endsWith(".html") && !anchorsOf(file).has(decodeURIComponent(fragment)))
    problems.push(`${from}: ${where} ${raw}: ${file} has no id ${decodeURIComponent(fragment)}`);
}

/** The URLs a piece of CSS loads. */
function cssUrls(css) {
  const urls = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]);
  const imports = [...css.matchAll(/@import\s+(['"])([^'"]+)\1/g)].map((m) => m[2]);
  return [...urls, ...imports];
}

const FETCHING_RELS = /\b(stylesheet|icon|preload|modulepreload|prefetch|manifest|apple-touch-icon|mask-icon)\b/i;
const LINK_RELS = /\b(canonical|prev|next|alternate|search|license)\b/i;

for (const page of pages) {
  const html = readFileSync(join(root, page), "utf8");
  // Code is not markup: a URL inside <pre> or <code> is text.
  const markup = html.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  for (const tag of markup.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const name = tag[1].toLowerCase();
    const attrs = Object.fromEntries(
      [...tag[2].matchAll(/([a-z][a-z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3]]),
    );
    if (attrs.href !== undefined) {
      if (name === "link") {
        const rel = attrs.rel ?? "";
        const fetch = FETCHING_RELS.test(rel) || !LINK_RELS.test(rel);
        if (LINK_RELS.test(rel) && /^https?:/.test(attrs.href)) continue;
        judge(page, attrs.href, { fetch, where: `<link rel="${rel}">` });
      } else judge(page, attrs.href, { fetch: false, where: `<${name} href>` });
    }
    if (attrs.src !== undefined) judge(page, attrs.src, { fetch: true, where: `<${name} src>` });
    if (attrs.srcset !== undefined)
      for (const candidate of attrs.srcset.split(","))
        judge(page, candidate.trim().split(/\s+/)[0], { fetch: true, where: `<${name} srcset>` });
    if (attrs.poster !== undefined) judge(page, attrs.poster, { fetch: true, where: `<${name} poster>` });
    if (attrs.data !== undefined && name === "object") judge(page, attrs.data, { fetch: true, where: "<object data>" });
    if (attrs.style !== undefined)
      for (const url of cssUrls(attrs.style)) judge(page, url, { fetch: true, where: "a style attribute" });
  }
  for (const style of markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    for (const url of cssUrls(style[1])) judge(page, url, { fetch: true, where: "<style>" });
}

for (const sheet of sheets) {
  const css = readFileSync(join(root, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const url of cssUrls(css)) judge(sheet, url, { fetch: true, where: "url()" });
}

const out = resolve(options.out);
mkdirSync(out, { recursive: true });
const record = {
  tree: root,
  prefix,
  date: new Date().toISOString(),
  pages: pages.length,
  stylesheets: sheets.length,
  urls: checked,
  outbound: outbound.size,
  problems,
};
writeFileSync(join(out, "check.json"), JSON.stringify(record, null, 1) + "\n");
writeFileSync(
  join(out, "outbound.json"),
  JSON.stringify(Object.fromEntries([...outbound].sort(([a], [b]) => a.localeCompare(b))), null, 1) + "\n",
);
console.log(
  `pages-check: ${pages.length} pages, ${sheets.length} stylesheets, ${checked} URLs, ` +
    `${outbound.size} outbound links listed in ${relative(process.cwd(), join(out, "outbound.json"))}`,
);
if (problems.length) {
  for (const problem of problems) console.error(`pages-check: ${problem}`);
  console.error(`pages-check: ${problems.length} problems`);
  process.exit(1);
}
console.log("pages-check: every link and fetch resolves, and nothing is fetched from another origin");
