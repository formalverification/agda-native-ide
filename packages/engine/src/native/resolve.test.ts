// File: packages/engine/src/native/resolve.test.ts
//
// Which Agda a project uses, and its root, against stand-ins for `agda`:
// node scripts that answer `--numeric-version` as told, and count how
// often they are asked.

import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findProjectRoot, locateExecutable, resolveAgda } from "./resolve.js";

let dir: string;
let bin: string;
let probes: string;

function standIn(name: string, version: string): string {
  const file = join(bin, name);
  writeFileSync(
    file,
    `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(probes)}, "${name}\\n");
if (process.argv.includes("--bad")) { process.stdout.write("Error: Unrecognized option:\\n--bad\\n"); process.exit(71); }
process.stdout.write("${version}\\n");`,
  );
  chmodSync(file, 0o755);
  return file;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "resolve-agda-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  probes = join(dir, "probes");
  appendFileSync(probes, "");
  standIn("agda", "2.9.0");
  standIn("agda-2.8", "2.8.0");
  writeFileSync(join(bin, "not-executable"), "");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const env = () => ({ ...process.env, PATH: `${bin}:/nonexistent` });

describe("which Agda a project uses", () => {
  it("finds a name on PATH, and a path as it is, and nothing that cannot run", async () => {
    expect(await locateExecutable("agda", env())).toBe(join(bin, "agda"));
    expect(await locateExecutable(join(bin, "agda-2.8"), env())).toBe(join(bin, "agda-2.8"));
    expect(await locateExecutable("not-executable", env())).toBeUndefined();
    expect(await locateExecutable("no-such-agda", env())).toBeUndefined();
  });

  it("finds what a spawn in the project's root would: relative paths and PATH entries, and an empty entry", async () => {
    const root = join(dir, "project");
    mkdirSync(join(root, "tools", "bin"), { recursive: true });
    const inTools = join(root, "tools", "bin", "agda-tools");
    const inRoot = join(root, "agda-here");
    for (const file of [inTools, inRoot]) {
      writeFileSync(file, `#!${process.execPath}\nprocess.stdout.write("2.9.0\\n");`);
      chmodSync(file, 0o755);
    }
    const env = { ...process.env, PATH: `tools/bin::${bin}` };
    expect(await locateExecutable("agda-tools", env, root)).toBe(inTools);
    expect(await locateExecutable("agda-here", env, root)).toBe(inRoot);
    expect(await locateExecutable("./tools/bin/agda-tools", env, root)).toBe(inTools);
    expect(await locateExecutable("agda-tools", env, dir)).toBeUndefined();
    expect(await locateExecutable("agda", { PATH: undefined }, root)).toBeUndefined();
    expect(await resolveAgda([{ source: "PATH", executable: "agda-tools" }], { expectedVersion: "2.9.0", env, cwd: root })).toMatchObject({
      executable: inTools,
      version: "2.9.0",
    });
  });

  it("takes the first candidate that names an executable, with its arguments", async () => {
    const resolved = await resolveAgda(
      [
        { source: "agdaWorkbench.agda.path", executable: "" },
        { source: "agdaMode.connection.paths", executable: "no-such-agda" },
        { source: "PATH", executable: "agda", args: ["--no-libraries"] },
      ],
      { expectedVersion: "2.9.0", env: env() },
    );
    expect(resolved).toEqual({ executable: join(bin, "agda"), args: ["--no-libraries"], source: "PATH", version: "2.9.0" });
  });

  it("refuses the first one found when it is another version, naming where it came from", async () => {
    const refused = await resolveAgda(
      [
        { source: "agdaWorkbench.agda.path", executable: join(bin, "agda-2.8") },
        { source: "PATH", executable: "agda" },
      ],
      { expectedVersion: "2.9.0", versionSource: "agdaWorkbench.agda.version", env: env() },
    );
    expect(refused).toMatchObject({ kind: "refusal", reason: "configuration" });
    const message = (refused as { message: string }).message;
    expect(message).toMatch(/agdaWorkbench\.agda\.path names .*agda-2\.8, which is Agda 2\.8\.0/);
    expect(message).toMatch(/expects Agda 2\.9\.0 \(agdaWorkbench\.agda\.version\)/);
  });

  it("refuses options the Agda found refuses, with its words", async () => {
    const refused = await resolveAgda([{ source: "agdaMode.connection.commandLineOptions", executable: "agda", args: ["--bad"] }], {
      expectedVersion: "2.9.0",
      env: env(),
    });
    expect(refused).toMatchObject({ kind: "refusal", reason: "configuration" });
    expect((refused as { message: string }).message).toMatch(/exit 71: Error: Unrecognized option: --bad/);
  });

  it("says what it passed over when nothing is found", async () => {
    const refused = await resolveAgda([{ source: "agdaMode.connection.paths", executable: "no-such-agda" }], {
      expectedVersion: "2.9.0",
      env: env(),
    });
    expect((refused as { message: string }).message).toBe(
      "no Agda was found: agdaMode.connection.paths names no-such-agda, which is not an executable on PATH",
    );
  });

  it("asks an executable its version once, while it is unchanged", async () => {
    const cache = new Map<string, string>();
    const asked = () => readFileSync(probes, "utf8").split("\n").filter((name) => name === "agda").length;
    const before = asked();
    for (let i = 0; i < 3; i++)
      expect(await resolveAgda([{ source: "PATH", executable: "agda" }], { expectedVersion: "2.9.0", env: env(), cache })).toMatchObject({
        version: "2.9.0",
      });
    expect(asked() - before).toBe(1);
  });
});

describe("a file's project root", () => {
  it("is the nearest .agda-lib's directory, else the fallback around the file, else the file's own", async () => {
    const library = join(dir, "library");
    mkdirSync(join(library, "src", "Deep"), { recursive: true });
    writeFileSync(join(library, "library.agda-lib"), "name: library\ninclude: src\n");
    expect(await findProjectRoot(join(library, "src", "Deep", "M.agda"))).toEqual({
      root: library,
      source: "agda-lib",
      library: join(library, "library.agda-lib"),
    });
    // tmpdir has no .agda-lib above it on the machines this runs on.
    const loose = join(dir, "loose", "Sub");
    mkdirSync(loose, { recursive: true });
    expect(await findProjectRoot(join(loose, "M.agda"), join(dir, "loose"))).toEqual({ root: join(dir, "loose"), source: "fallback" });
    expect(await findProjectRoot(join(loose, "M.agda"), join(dir, "elsewhere"))).toEqual({ root: loose, source: "directory" });
  });
});
