// File: scripts/conformance/compare.mjs
//
// Compare the browser's and the native engine's conformance runs (issue
// 62), scenario by scenario and field by field: each runner's transcript
// is what Agda answered, with the engine's root path and the session's
// name already replaced by placeholders by the suite, and nothing else
// removed.  It prints every difference and writes comparison.json beside
// the two runs; it exits 1 when a scenario is missing from either run, or
// when any field differs.
//
//   node scripts/conformance/compare.mjs <browser.json> <native.json> [--out DIR]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" } },
});
if (positionals.length !== 2) {
  console.error("usage: node compare.mjs <browser.json> <native.json> [--out DIR]");
  process.exit(2);
}
const [browser, native] = positionals.map((file) => JSON.parse(readFileSync(resolve(file), "utf8")));

/** Every path at which `a` and `b` differ. */
function differences(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((key) => differences(a[key], b[key], `${path}/${key}`));
  }
  return [{ path: path || "/", browser: a, native: b }];
}

const names = [...new Set([...browser.scenarios, ...native.scenarios].map((scenario) => scenario.name))];
const scenarios = names.map((name) => {
  const left = browser.scenarios.find((scenario) => scenario.name === name);
  const right = native.scenarios.find((scenario) => scenario.name === name);
  if (!left || !right) return { name, missing: !left ? "browser" : "native", differences: [] };
  return {
    name,
    passed: { browser: left.ok, native: right.ok },
    differences: differences(left.transcript, right.transcript),
  };
});
const fixturesAgree = JSON.stringify(browser.fixtures) === JSON.stringify(native.fixtures);
const differing = scenarios.filter((scenario) => scenario.missing || scenario.differences.length);
const comparison = {
  date: new Date().toISOString(),
  runs: { browser: browser.date, native: native.date },
  agda: { browser: browser.agdaVersion, native: native.agdaVersion },
  fixturesAgree,
  scenarios,
  identical: differing.length === 0 && fixturesAgree,
};
for (const scenario of scenarios) {
  if (scenario.missing) console.log(`MISSING ${scenario.name}: not in the ${scenario.missing} run`);
  else if (!scenario.differences.length) console.log(`same    ${scenario.name}`);
  else {
    console.log(`DIFFER  ${scenario.name}`);
    for (const difference of scenario.differences)
      console.log(`        ${difference.path}: browser ${JSON.stringify(difference.browser)}, native ${JSON.stringify(difference.native)}`);
  }
}
const out = options.out ? resolve(options.out) : dirname(resolve(positionals[0]));
writeFileSync(join(out, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
console.log(
  `${scenarios.length - differing.length} of ${scenarios.length} scenarios answered identically` +
    `${fixturesAgree ? "" : "; the fixtures differ"}; ${join(out, "comparison.json")}`,
);
process.exit(comparison.identical ? 0 : 1);
