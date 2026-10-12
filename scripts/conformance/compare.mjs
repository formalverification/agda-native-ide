// File: scripts/conformance/compare.mjs
//
// Compare the browser's and the native engine's conformance runs (issue
// 62), scenario by scenario and field by field: each runner's transcript
// holds the values its scenario asserted on, with the engine's root path
// and the session's name already replaced by placeholders by the suite,
// and nothing else removed.  It prints every difference and writes
// comparison.json beside the two runs; it exits 1 when a scenario of the
// suite is missing from either run, failed in either, or answered
// differently, or when a run holds a scenario the suite does not.  A
// failed scenario's transcript is empty, so two runs that failed alike
// would otherwise agree, and the names come from the suite, so two empty
// runs cannot.
//
// A scenario that depends on a capability (the suite's
// scenarioRequirements: the batch lane) records it in its transcript as
// `capability`.  Where the two engines declare it differently, the
// scenario's transcripts differ by that declaration: each run must have
// passed its own branch, and the difference is reported as declared, not
// compared.  Every other scenario must answer identically.
//
//   node scripts/conformance/compare.mjs <browser.json> <native.json> [--out DIR]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { scenarioNames, scenarioRequirements } from "@agda-native-ide/engine/conformance";

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

const ran = [...browser.scenarios, ...native.scenarios].map((scenario) => scenario.name);
const names = [...new Set([...scenarioNames, ...ran])];
const scenarios = names.map((name) => {
  const left = browser.scenarios.find((scenario) => scenario.name === name);
  const right = native.scenarios.find((scenario) => scenario.name === name);
  if (!scenarioNames.includes(name)) return { name, unknown: true, differences: [] };
  if (!left || !right) return { name, missing: !left && !right ? "either" : !left ? "browser" : "native", differences: [] };
  const passed = { browser: left.ok, native: right.ok };
  const capability = scenarioRequirements[name];
  if (capability && left.ok && right.ok) {
    const declared = {
      browser: left.transcript?.capability?.[capability],
      native: right.transcript?.capability?.[capability],
    };
    if (typeof declared.browser !== "boolean" || typeof declared.native !== "boolean")
      return { name, passed, differences: [{ path: `/capability/${capability}`, ...declared }] };
    if (declared.browser !== declared.native) return { name, passed, declared: { capability, ...declared }, differences: [] };
  }
  return { name, passed, differences: differences(left.transcript, right.transcript) };
});
const fixturesAgree = JSON.stringify(browser.fixtures) === JSON.stringify(native.fixtures);
const failed = (scenario) => scenario.passed && !(scenario.passed.browser && scenario.passed.native);
const differing = scenarios.filter(
  (scenario) => scenario.missing || scenario.unknown || failed(scenario) || scenario.differences.length,
);
const declared = scenarios.filter((scenario) => scenario.declared);
const comparison = {
  date: new Date().toISOString(),
  runs: { browser: browser.date, native: native.date },
  agda: { browser: browser.agdaVersion, native: native.agdaVersion },
  fixturesAgree,
  scenarios,
  // Every scenario passed in both runs, and answered identically except
  // where a capability is declared differently.
  identical: differing.length === 0 && fixturesAgree,
  declared: declared.map((scenario) => ({ name: scenario.name, ...scenario.declared })),
};
for (const scenario of scenarios) {
  if (scenario.missing)
    console.log(`MISSING ${scenario.name}: not in ${scenario.missing === "either" ? "either run" : `the ${scenario.missing} run`}`);
  else if (scenario.unknown) console.log(`UNKNOWN ${scenario.name}: not a scenario of the suite`);
  else if (failed(scenario))
    console.log(`FAILED  ${scenario.name}: in ${["browser", "native"].filter((run) => !scenario.passed[run]).join(" and ")}`);
  else if (scenario.declared) {
    const { capability, browser: inBrowser, native: inNative } = scenario.declared;
    const has = (engine, value) => `the ${engine} engine ${value ? "has" : "lacks"} it`;
    console.log(`declared ${scenario.name}: ${capability}: ${has("browser", inBrowser)}, ${has("native", inNative)}`);
  } else if (!scenario.differences.length) console.log(`same    ${scenario.name}`);
  else {
    console.log(`DIFFER  ${scenario.name}`);
    for (const difference of scenario.differences)
      console.log(`        ${difference.path}: browser ${JSON.stringify(difference.browser)}, native ${JSON.stringify(difference.native)}`);
  }
}
const out = options.out ? resolve(options.out) : dirname(resolve(positionals[0]));
writeFileSync(join(out, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
const same = scenarios.length - differing.length - declared.length;
console.log(
  `${same} of ${scenarios.length} scenarios passed in both runs and answered identically` +
    `${declared.length ? `, and ${declared.length} ${declared.length === 1 ? "differs" : "differ"} only by a declared capability` : ""}` +
    `${fixturesAgree ? "" : "; the fixtures differ"}; ${join(out, "comparison.json")}`,
);
process.exit(comparison.identical ? 0 : 1);
