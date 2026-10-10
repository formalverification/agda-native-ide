// File: src/lib/theme-contrast.test.ts
// Check the shipped palettes, including every Agda highlight surface.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LS_THEME_KEY, prefersDarkTheme } from "./theme";
import {
  COLOR_SOURCES, contrast, palettes, report, resolveColor, summary,
} from "../../scripts/browser-check/contrast.mjs";

const read = (file: string): string => readFileSync(file, "utf8");
const css = read("static/theme.css");
const sources = COLOR_SOURCES.map(read);
const rows = report(css, sources);

describe("WCAG contrast calculations", () => {
  it("matches known ratios and handles short hex and alpha", () => {
    expect(contrast("#000", "#fff")).toBe(21);
    expect(contrast("#fff", "#000")).toBe(21);
    expect(contrast("#abc", "#aabbcc")).toBe(1);
    expect(contrast("#777", "#fff")).toBeCloseTo(4.478, 3);
    expect(contrast("#00000080", "#fff")).toBeCloseTo(4.004, 2);
    expect(contrast("#000", "#ffffff80", "#000"))
      .toBeCloseTo(5.317, 2);
  });
});

describe("the shipped light and dark palettes", () => {
  it("has complete palettes and every referenced token resolves", () => {
    const tables = palettes(css);
    expect(Object.keys(tables.light).length).toBeGreaterThan(100);
    expect(Object.keys(tables.dark).sort()).toEqual(Object.keys(tables.light).sort());
    const tokens = new Set([css, ...sources].flatMap((source) =>
      [...source.matchAll(/var\((--[a-z-]+)\)/g)].map((match) => match[1])));
    tokens.delete("--font-monospace");
    tokens.delete("--inspector-width");
    for (const palette of Object.values(tables)) {
      for (const token of tokens) expect(resolveColor(palette, token)).toMatch(/^#[\da-f]{3,8}$/i);
    }
  });

  it.each(rows)("$theme $foreground on $background meets $minimum:1", (row) => {
    expect(row.ratio).toBeGreaterThanOrEqual(row.minimum);
  });

  it("detects a later regression in a CSS text token", () => {
    const broken = css.replace(/--muted: #[\da-f]+;/i, "--muted: #eee;");
    expect(report(broken, sources).some((row) => row.ratio < row.minimum)).toBe(true);
  });

  it("uses the same storage key before paint and in the control", () => {
    const html = read("src/app.html");
    expect(html).toContain(`localStorage.getItem("${LS_THEME_KEY}")`);
    expect(html.indexOf(`localStorage.getItem("${LS_THEME_KEY}")`))
      .toBeLessThan(html.indexOf("%sveltekit.head%"));
    expect(html).toContain('href="%sveltekit.assets%/theme.css"');
  });

  it("reports minima for both themes and each category", () => {
    const minima = summary(rows);
    expect(minima).toHaveLength(6);
    console.table(minima);
  });
});

describe("the root theme choice", () => {
  it.each([
    ["light", true, false], ["light", false, false],
    ["dark", true, true], ["dark", false, true],
    [undefined, true, true], [undefined, false, false],
  ])("choice %s with system dark %s resolves to %s", (theme, systemDark, expected) => {
    const root = { dataset: { theme } } as unknown as HTMLElement;
    const win = { matchMedia: () => ({ matches: systemDark }) } as unknown as Window;
    expect(prefersDarkTheme(root, win)).toBe(expected);
  });
});
