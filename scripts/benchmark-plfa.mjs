// File: scripts/benchmark-plfa.mjs
//
// Changed from upstream: this is SeungheonOh/plfa-playground's
// scripts/benchmark-plfa.mjs at ae0aa84c24363a8d6dadc292b6eb8f88f7f38705
// (docs/provenance.md).  The Explorer is one tree since issue 9, so the
// benchmark opens PLFA's parts and finds its chapters by the tree's rows
// (`[role="treeitem"]`, `data-id` "plfa:part1" and "plfa:part1/Naturals"),
// where it clicked the fork's `.tree-part` and `.chapter-row` buttons.

import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const baseUrl = process.env.PLAYGROUND_URL ?? "http://127.0.0.1:5173/";
const selectedChapters = new Set(
  (process.env.CHAPTERS ?? "")
    .split(",")
    .map((chapter) => chapter.trim())
    .filter(Boolean),
);

function findChrome() {
  if (process.env.CHROME_EXECUTABLE) return process.env.CHROME_EXECUTABLE;
  for (const command of ["google-chrome", "chromium", "chromium-browser"]) {
    try {
      return execFileSync("which", [command], { encoding: "utf8" }).trim();
    } catch {
      // Try the next common executable name.
    }
  }
}

const executablePath = findChrome();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const browserErrors = [];

page.on("pageerror", (error) =>
  browserErrors.push(`pageerror: ${error.message}`),
);
page.on("console", (message) => {
  if (message.type() === "error")
    browserErrors.push(`console: ${message.text()}`);
});

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(
    '.command-strip button[title^="Normalize"]:not([disabled])',
    { timeout: 180_000 },
  );
  await page.waitForSelector('[role="treeitem"][data-id^="plfa:part"]', {
    timeout: 10_000,
  });

  for (const group of ["part1", "part2", "part3"]) {
    const part = page.locator(`[role="treeitem"][data-id="plfa:${group}"]`);
    if (
      (await part.count()) &&
      (await part.getAttribute("aria-expanded")) === "false"
    ) {
      await part.click();
    }
  }

  async function checkCurrentChapter() {
    const startedAt = performance.now();
    await page.locator(".cm-content").click();
    await page.keyboard.press("Meta+Enter");
    await page.waitForTimeout(100);
    if (await page.locator(".abort-action").count()) {
      await page.waitForSelector(".abort-action", {
        state: "detached",
        timeout: 300_000,
      });
    } else {
      await page.waitForFunction(
        () =>
          document
            .querySelector(".statusbar")
            ?.textContent?.includes("Checked"),
        undefined,
        { timeout: 300_000 },
      );
    }
    return {
      milliseconds: Math.round(performance.now() - startedAt),
      status: await page.locator(".inspector-status").innerText(),
      problems: await page.locator(".problem-card.error").allInnerTexts(),
    };
  }

  const chapterRows = '[role="treeitem"][data-id^="plfa:part"][data-id*="/"]';
  const chapterNames = (await page.locator(chapterRows).allInnerTexts())
    .map((text) => text.match(/([^\s]+)\.lagda\.md/)?.[1])
    .filter(Boolean)
    .filter(
      (chapter) => selectedChapters.size === 0 || selectedChapters.has(chapter),
    );
  const results = [];

  for (const chapter of chapterNames) {
    const row = page
      .locator(chapterRows)
      .filter({ hasText: `${chapter}.lagda.md` });
    await row.click();
    await page.waitForFunction(
      (name) =>
        document
          .querySelector(".editor-tab")
          ?.textContent?.includes(`${name}.lagda.md`),
      chapter,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(300);

    const initial = await checkCurrentChapter();
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText(
      "\n\n```agda\nprivate\n  browserBenchmarkIdentity : ∀ {A : Set} → A → A\n  browserBenchmarkIdentity x = x\n```\n",
    );
    const edited = await checkCurrentChapter();
    const result = { chapter, initial, edited };
    results.push(result);
    process.stderr.write(`${JSON.stringify(result)}\n`);
  }

  const failed =
    browserErrors.length > 0 ||
    results.length === 0 ||
    results.some(
      (result) =>
        result.initial.problems.length > 0 || result.edited.problems.length > 0,
    );
  console.log(JSON.stringify({ baseUrl, results, browserErrors }, null, 2));
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
