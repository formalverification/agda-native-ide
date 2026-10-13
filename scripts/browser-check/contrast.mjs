// File: scripts/browser-check/contrast.mjs
// WCAG 2.2 contrast, measured from the shipped CSS and its consumers.
// https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
// https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const COLOR_SOURCES = [
  "src/app.css", "src/routes/+page.svelte", "src/lib/agda/color-scheme.js",
  "src/lib/codemirror/theme.ts", "src/lib/codemirror/symbol-input.js",
  // The inspector's components, with their styles, are the views
  // package's since issue 62, and the Explorer's tree since issue 9.
  "packages/views/src/GoalList.svelte", "packages/views/src/ResultView.svelte",
  "packages/views/src/ProblemList.svelte", "packages/views/src/ExplorerTree.svelte",
];

export function palettes(css) {
  const declarations = (selector) => {
    const block = css.match(selector)?.[1];
    if (!block) throw new Error(`no palette matching ${selector}`);
    const pairs = [...block.matchAll(/(--[a-z-]+):\s*([^;]+);/g)]
      .map(([, name, value]) => [name, value.trim()]);
    if (new Set(pairs.map(([name]) => name)).size !== pairs.length)
      throw new Error("duplicate token in palette");
    return Object.fromEntries(pairs);
  };
  const light = declarations(/:root\s*\{([^}]+)\}/);
  const systemDark = declarations(/:root:not\(\[data-theme="light"\]\)\s*\{([^}]+)\}/);
  const explicitDark = declarations(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/);
  if (JSON.stringify(systemDark) !== JSON.stringify(explicitDark))
    throw new Error("system and explicit dark palettes disagree");
  return { light, dark: { ...light, ...systemDark } };
}

export function resolveColor(palette, token, seen = []) {
  if (seen.includes(token)) throw new Error(`cyclic token ${token}`);
  const value = palette[token];
  if (!value) throw new Error(`undefined token ${token}`);
  const alias = value.match(/^var\((--[a-z-]+)\)$/);
  return alias ? resolveColor(palette, alias[1], [...seen, token]) : value;
}

export function rgba(hex) {
  if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex))
    throw new Error(`not a hex color: ${hex}`);
  const full = hex.length <= 5
    ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  const bytes = full.match(/../g).map((n) => parseInt(n, 16) / 255);
  return [...bytes.slice(0, 3), bytes[3] ?? 1];
}

export function composite(foreground, background) {
  return foreground.slice(0, 3).map((c, i) =>
    c * foreground[3] + background[i] * (1 - foreground[3]));
}

function luminance(rgb) {
  return rgb.map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}

export function contrast(foreground, background, canvas = "#fff") {
  const bg = composite(rgba(background), rgba(canvas));
  const fg = composite(rgba(foreground), [...bg, 1]);
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Text on a filled control or candidate has its own foreground role.
const INVERSE = {
  "--goal-marker-text": ["--editor-cursor"],
  "--input-badge-text": ["--accent-fill", "--accent-fill-hover", "--error-fill"],
  "--symbol-selected-text": ["--symbol-selected-surface"],
  "--symbol-match-text": ["--symbol-match-surface"],
  "--symbol-no-match-text": ["--symbol-no-match-surface"],
};

export function report(css, sources) {
  // Derive foreground roles from the real consumers, so adding a text
  // color adds coverage.  Include inherited text in static/theme.css.
  const foregrounds = new Set(["--text", ...sources.flatMap((source) =>
    [...source.matchAll(/(?<![-\w])color:\s*["']?var\((--[a-z-]+)\)/g)]
      .map(([, token]) => token))]);
  const tables = palettes(css);
  const surfaces = Object.keys(tables.light).filter((token) =>
    (token.endsWith("-surface") || ["--canvas", "--surface", "--surface-soft", "--accent-soft", "--error-soft", "--warning-soft", "--editor-active-line"].includes(token)) &&
    !["--symbol-selected-surface", "--resize-hover-surface"].includes(token));
  const rows = [];
  for (const [theme, palette] of Object.entries(tables)) {
    const add = (category, foreground, background, minimum) => rows.push({
      theme, category, foreground, background, minimum,
      ratio: contrast(resolveColor(palette, foreground), resolveColor(palette, background), resolveColor(palette, "--canvas")),
    });
    for (const foreground of foregrounds) {
      const category = foreground.startsWith("--agda-") ? "Agda text" : "Page text";
      for (const background of INVERSE[foreground] ?? surfaces)
        add(category, foreground, background, 4.5);
    }
    for (const background of surfaces) {
      for (const foreground of ["--line", "--line-strong", "--focus-ring", "--goal-line", "--editor-cursor"])
        add("UI", foreground, background, 3);
    }
  }
  return rows;
}

export function summary(rows) {
  return ["light", "dark"].flatMap((theme) => ["Page text", "Agda text", "UI"].map((category) => {
    const group = rows.filter((row) => row.theme === theme && row.category === category);
    const worst = group.reduce((a, b) => a.ratio < b.ratio ? a : b);
    return { theme, category, pairs: group.length, minimum: worst.ratio, foreground: worst.foreground, background: worst.background };
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const rows = report(readFileSync("static/theme.css", "utf8"), COLOR_SOURCES.map((file) => readFileSync(file, "utf8")));
  console.log(JSON.stringify({ summary: summary(rows), failures: rows.filter((row) => row.ratio < row.minimum) }, null, 2));
  process.exitCode = rows.some((row) => row.ratio < row.minimum) ? 1 : 0;
}
