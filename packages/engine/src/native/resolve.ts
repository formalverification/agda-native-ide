// File: packages/engine/src/native/resolve.ts
//
// Which Agda a project uses, and where its root is: what a host resolves
// before it asks for a lane (issue 64).
//
//   +  The root is the directory of the nearest `.agda-lib` above the file,
//      which is where Agda itself finds the project's library and anchors
//      its `_build/` interfaces; with none above it, the host's fallback (a
//      workspace folder) when the file is inside it, else the file's own
//      directory.
//   +  The Agda is the first of the host's candidates, in its order, that
//      names an executable that exists: an explicit path, or a name looked
//      up on PATH.  A candidate that names nothing is passed over; the first
//      that names something decides, and is refused, naming where it came
//      from, when it does not answer `--numeric-version` with the version
//      the project expects.  A different version is never used: the
//      engine's answers are validated against Agda's encoding at one commit,
//      and interfaces written by another Agda are not accepted.
//
// Each candidate carries its own arguments (a wrapper carries them inside
// itself; agda-mode-vscode's `commandLineOptions` are the mode's), which
// the version probe passes too, so an option Agda refuses is refused here,
// before any lane starts.

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { refusal, type Refusal } from "../core/index.js";

/** One place a host may find an Agda. */
export interface AgdaCandidate {
  /** Where it came from, as a user would look for it: a setting's name,
   * or `PATH`. */
  source: string;
  /** An absolute path, or a name to look up on PATH. */
  executable: string;
  /** Arguments every run of it takes (before `--interaction-json`, before
   * the file in a batch run). */
  args?: readonly string[];
}

/** The Agda a project uses. */
export interface ResolvedAgda {
  /** The executable, as an absolute path. */
  executable: string;
  args: string[];
  /** The candidate's `source`. */
  source: string;
  /** What it answered to `--numeric-version`. */
  version: string;
}

export interface ResolveOptions {
  /** The version the project expects (`2.9.0`). */
  expectedVersion: string;
  /** Where the expected version comes from, for the refusal's message. */
  versionSource?: string;
  /** The environment the probe and the lanes run in (default: this
   * process's); its PATH is searched. */
  env?: Record<string, string | undefined>;
  /** How long the version probe may take, in ms (default 30 s). */
  timeoutMs?: number;
  /** Probes already made, by executable, arguments and modification time;
   * a host keeps one across requests. */
  cache?: Map<string, string>;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The executable a candidate names, as an absolute path, or undefined. */
export async function locateExecutable(
  executable: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (!executable) return undefined;
  if (executable.includes("/") || executable.includes(sep)) {
    const path = resolve(executable);
    return (await isExecutableFile(path)) ? path : undefined;
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const path = join(directory, executable);
    if (await isExecutableFile(path)) return path;
  }
  return undefined;
}

function probe(
  executable: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ ok: true; version: string } | { ok: false; why: string }> {
  return new Promise((done) => {
    execFile(
      executable,
      [...args, "--numeric-version"],
      { env, timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 16 },
      (error, stdout, stderr) => {
        const said = `${stdout}${stderr}`.trim();
        if (error)
          done({
            ok: false,
            why: `${error.killed ? `no answer within ${timeoutMs} ms` : `exit ${error.code ?? error.signal ?? "?"}`}${said ? `: ${said.split("\n").slice(0, 3).join(" ")}` : ""}`,
          });
        else done({ ok: true, version: stdout.trim() });
      },
    );
  });
}

/** The Agda a project uses: the first candidate that names an executable,
 * if it is the version the project expects; else a refusal that names the
 * setting to change. */
export async function resolveAgda(
  candidates: readonly AgdaCandidate[],
  options: ResolveOptions,
): Promise<ResolvedAgda | Refusal> {
  const env = options.env ?? process.env;
  const passed: string[] = [];
  for (const candidate of candidates) {
    const executable = await locateExecutable(candidate.executable, env);
    if (!executable) {
      passed.push(`${candidate.source} names ${candidate.executable || "nothing"}, which is not an executable${candidate.executable.includes("/") ? "" : " on PATH"}`);
      continue;
    }
    const args = [...(candidate.args ?? [])];
    let key: string | undefined;
    try {
      key = JSON.stringify([executable, args, (await stat(executable)).mtimeMs]);
    } catch {
      key = undefined;
    }
    let version = key === undefined ? undefined : options.cache?.get(key);
    if (version === undefined) {
      const answered = await probe(executable, args, env, options.timeoutMs ?? 30_000);
      if (!answered.ok)
        return refusal(
          "configuration",
          `${candidate.source} names ${executable}, which did not answer \`${[executable, ...args, "--numeric-version"].join(" ")}\` (${answered.why}); set ${candidate.source} to an Agda ${options.expectedVersion}, or fix its options`,
        );
      version = answered.version;
      if (key !== undefined) options.cache?.set(key, version);
    }
    if (version !== options.expectedVersion)
      return refusal(
        "configuration",
        `${candidate.source} names ${executable}, which is Agda ${version}; the project expects Agda ${options.expectedVersion}${options.versionSource ? ` (${options.versionSource})` : ""}.  Set ${candidate.source} to an Agda ${options.expectedVersion}`,
      );
    return { executable, args, source: candidate.source, version };
  }
  return refusal(
    "configuration",
    passed.length
      ? `no Agda was found: ${passed.join("; ")}`
      : "no Agda was found: the configuration names none",
  );
}

/** Where a file's project is rooted. */
export interface ProjectRoot {
  root: string;
  /** `agda-lib`: the directory of the nearest `.agda-lib` above the file;
   * `fallback`: the host's (a workspace folder); `directory`: the file's
   * own. */
  source: "agda-lib" | "fallback" | "directory";
  /** The `.agda-lib` file, when one was found. */
  library?: string;
}

const inside = (directory: string, path: string) => {
  const within = relative(directory, path);
  return within !== "" && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within);
};

/** The root of the project a file belongs to, as Agda finds it. */
export async function findProjectRoot(file: string, fallback?: string): Promise<ProjectRoot> {
  const absolute = resolve(file);
  let directory = dirname(absolute);
  for (;;) {
    let names: string[] = [];
    try {
      names = await readdir(directory);
    } catch {
      names = [];
    }
    const library = names.filter((name) => name.endsWith(".agda-lib")).sort()[0];
    if (library && (await stat(join(directory, library)).then((entry) => entry.isFile(), () => false)))
      return { root: directory, source: "agda-lib", library: join(directory, library) };
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (fallback && inside(resolve(fallback), absolute)) return { root: resolve(fallback), source: "fallback" };
  return { root: dirname(absolute), source: "directory" };
}
