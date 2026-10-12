// File: scripts/browser-check/themes.mjs
// Exercise the built page's theme control in pinned headless Chromium.
// CDP media emulation reaches both CSS media queries and matchMedia.
// Screenshots and the before-paint samples belong to the private CI artifact.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";
import { serve } from "./serve.mjs";
import { palettes, resolveColor, rgba } from "./contrast.mjs";

const THEME_KEY = "agda-web-ide-beta:theme";
// The playground's buffer, by its path (src/lib/controller.svelte.ts).
const DOC_KEY = "agda-web-ide-beta:doc:/play/Main.agda";
const rgb = (hex) => `rgb(${rgba(hex).slice(0, 3).map((c) => Math.round(c * 255)).join(", ")})`;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const FIRST_FRAMES = `(() => {
  window.__themeFrames = [];
  function sample() {
    const root = document.documentElement;
    if (root) {
      const style = getComputedStyle(root);
      if (style.getPropertyValue('--canvas').trim()) {
        window.__themeFrames.push({ t: performance.now(), theme: root.dataset.theme ?? 'system', background: style.backgroundColor });
      }
    }
    if (window.__themeFrames.length < 8) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();`;

const state = () => {
  const root = document.documentElement;
  if (!root) return { navigation: performance.timeOrigin, keyword: null, status: "", frames: [] };
  const editor = document.querySelector(".cm-editor");
  const select = document.querySelector('select[aria-label="Color theme"]');
  const style = (element, property) => element ? getComputedStyle(element)[property] : null;
  const leaf = (element) => {
    if (!element) return null;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (text.textContent.trim()) return text.parentElement;
    }
    return element;
  };
  let saved;
  try { saved = localStorage.getItem("agda-web-ide-beta:theme"); }
  catch { saved = "unavailable"; }
  return {
    navigation: performance.timeOrigin,
    theme: root.dataset.theme ?? "system", choice: select?.value,
    background: style(root, "backgroundColor"),
    editorBackground: style(editor, "backgroundColor"),
    editorText: style(editor, "color"),
    keyword: style(leaf(document.querySelector(".agda-keyword")), "color"),
    drawnAgda: [...document.querySelectorAll('.cm-content [class*="agda-"]')]
      .flatMap((element) => [...element.classList].filter((name) => name.startsWith("agda-"))
        .map((name) => ({ name, text: element.textContent, color: style(leaf(element), "color") }))),
    marker: style(document.querySelector(".agda-goal-marker"), "color"),
    classes: editor?.className.replace(/\s*cm-focused/g, ""),
    status: document.querySelector(".inspector-status")?.textContent ?? "",
    saved,
    frames: window.__themeFrames ?? [],
    width: root.clientWidth, scrollWidth: root.scrollWidth,
    controlVisible: select ? select.getBoundingClientRect().width > 0 : false,
  };
};

/** Run after the runtime check, or by itself on a built site. */
export async function checkThemes(page, origin, site, out) {
  const tables = palettes(readFileSync(join(site, "theme.css"), "utf8"));
  const record = { date: new Date().toISOString(), cases: [], failure: null };
  mkdirSync(out, { recursive: true });
  await page.addInitScript(FIRST_FRAMES);
  const media = (value) => page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value }],
  });
  async function checked(previousNavigation) {
    for (let i = 0; i < 300; i++) {
      const current = await page.eval(state);
      if (current.navigation !== previousNavigation && current.keyword && /^2 open goals.* · \d/.test(current.status) && current.frames.length >= 8) return;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error("theme check timed out waiting for the default Main.agda");
  }
  async function expectTheme(name, theme, choice, firstPaint = false) {
    // CSS reacts immediately; matchMedia change events and CodeMirror's
    // resulting transaction are delivered before the next frames.
    await page.eval(() => new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done))));
    let current;
    const palette = tables[theme];
    for (let i = 0; i < 50; i++) {
      current = await page.eval(state);
      if (current.editorBackground === rgb(resolveColor(palette, "--editor-surface")) &&
        current.keyword === rgb(resolveColor(palette, "--agda-keyword")) && current.choice === choice) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    for (const [property, token] of Object.entries({ background: "--canvas", editorBackground: "--editor-surface", editorText: "--editor-text", keyword: "--agda-keyword", marker: "--goal-marker-text" })) {
      assert(current[property] === rgb(resolveColor(palette, token)), `${name}: ${property} is ${current[property]}, expected ${theme} ${token}`);
    }
    for (const drawn of current.drawnAgda) {
      const token = `--${drawn.name}`;
      if (token in palette)
        assert(drawn.color === rgb(resolveColor(palette, token)), `${name}: drawn ${drawn.name} uses ${drawn.color}, expected ${token}`);
    }
    assert(current.choice === choice, `${name}: control says ${current.choice}, expected ${choice}`);
    assert(current.theme === choice, `${name}: root choice is ${current.theme}, expected ${choice}`);
    if (firstPaint) {
      assert(current.frames.length >= 8, `${name}: no first-frame evidence`);
      assert(current.frames.every((frame) => frame.background === rgb(resolveColor(palette, "--canvas"))), `${name}: a first frame used the other palette`);
    }
    record.cases.push({ name, effective: theme, ...current });
    console.log(`ok  theme: ${name}`);
    return current;
  }
  const choose = (value) => page.eval((value) => {
    const select = document.querySelector('select[aria-label="Color theme"]');
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  const reload = async () => {
    const previous = await page.eval(() => performance.timeOrigin);
    await page.navigate(origin);
    await checked(previous);
  };
  try {
    if (await page.eval(() => location.origin) !== new URL(origin).origin)
      await reload();
    await page.eval(([themeKey, docKey]) => {
      localStorage.removeItem(themeKey); localStorage.removeItem(docKey);
    }, [THEME_KEY, DOC_KEY]);
    await page.setViewport(1440, 900);
    await media("light");
    await reload();
    const light = await expectTheme("system light on first visit", "light", "system", true);
    await page.eval(() => document.fonts.ready.then(() => true));
    writeFileSync(join(out, "light.png"), await page.screenshot());

    await media("dark");
    const dark = await expectTheme("system change to dark", "dark", "system");
    assert(light.classes !== dark.classes, "CodeMirror did not change its dark facet");
    writeFileSync(join(out, "dark.png"), await page.screenshot());
    await reload();
    await expectTheme("system dark on first paint", "dark", "system", true);

    await choose("light");
    const explicitLight = await expectTheme("light overrides dark system", "light", "light");
    assert(explicitLight.saved === "light", "light choice was not persisted");
    assert(explicitLight.classes === light.classes, "CodeMirror did not return to its light facet");
    await reload();
    await expectTheme("saved light before paint on dark system", "light", "light", true);
    await media("light");
    await expectTheme("explicit light survives system change", "light", "light");

    await choose("dark");
    const explicitDark = await expectTheme("dark overrides light system", "dark", "dark");
    assert(explicitDark.saved === "dark", "dark choice was not persisted");
    assert(explicitDark.classes === dark.classes, "CodeMirror did not return to its dark facet");
    await reload();
    await expectTheme("saved dark before paint on light system", "dark", "dark", true);
    await media("dark");
    await expectTheme("explicit dark survives system change", "dark", "dark");

    await choose("system");
    const system = await expectTheme("return to system", "dark", "system");
    assert(system.saved === null, "system did not clear the saved override");
    await media("light");
    await expectTheme("system resumes following changes", "light", "system");

    for (const width of [400, 768, 1440]) {
      await page.setViewport(width, 900);
      const narrow = await expectTheme(`theme control at ${width}px`, "light", "system");
      assert(narrow.width === width && narrow.scrollWidth <= width, `${width}px: body scrolls sideways (${narrow.scrollWidth})`);
      assert(narrow.controlVisible, `${width}px: theme control is hidden`);
    }
    await page.setViewport(1440, 900);

    await page.eval((key) => localStorage.setItem(key, "invalid"), THEME_KEY);
    await reload();
    await expectTheme("invalid saved value follows system", "light", "system", true);

    await page.addInitScript(`(() => {
      for (const method of ['getItem', 'setItem', 'removeItem']) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function(key, ...args) {
          if (key === '${THEME_KEY}') throw new DOMException('storage refused', 'SecurityError');
          return original.call(this, key, ...args);
        };
      }
    })();`);
    await reload();
    await expectTheme("refused theme storage follows system", "light", "system", true);
    await choose("dark");
    const refused = await expectTheme("refused theme storage still switches", "dark", "dark");
    assert(refused.saved === "unavailable", "refused storage control did not take effect");
  } catch (error) {
    record.failure = error.message;
    throw error;
  } finally {
    writeFileSync(join(out, "themes.json"), JSON.stringify(record, null, 2) + "\n");
  }
  return record;

}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [site, out = "browser-check/themes"] = process.argv.slice(2);
  let server, browser;
  try {
    server = await serve({ root: site });
    browser = await launch(process.env.CHROME);
    await browser.page.onConsole((entry) => {
      if (entry.type === "exception" || entry.type === "error") console.error(entry);
    });
    await checkThemes(browser.page, server.origin, site, out);
    console.log(`Theme check passed in ${browser.product}`);
  } finally {
    await browser?.close();
    await server?.close();
  }
}
