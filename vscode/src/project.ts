// File: vscode/src/project.ts
//
// Each project's own Agda (issue 99): the companion's client of
// agda-for-project, the resolver of issue 97 (ADR 0004).  It asks the
// launcher for a file's Agda (`--explain --json`), for what a chooser can
// offer (`--candidates --json`), and remembers or forgets a choice
// (`--choose`, `--forget`), always naming the file, so the answer never
// depends on a working directory or on AGDA_FOR_PROJECT_DIR.  It also says
// which Agda versions the native lanes speak, finds the Agda that
// agda-mode-vscode is running, and writes a starter flake for a project
// with none.  It imports nothing of VS Code's, so its tests run under node.

import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';

/** The launcher's name, as a host names it in place of `agda`. */
export const launcherName = 'agda-for-project';

/** The Agda versions the native lanes speak: the engine was built against
 * 2.9.0, and its conformance suite passes against 2.8.0 too (13 of 13
 * scenarios and 12 of 12 lifecycle checks, 2026-11-08; the one difference,
 * the name Agda gives a type error, is Agda's).  Any other version is
 * refused with the reason. */
export const laneVersions: readonly string[] = ['2.9.0', '2.8.0'];

/** What `agda-for-project --explain --json FILE` answers (ADR 0004 § 10). */
export interface Explained {
  decided: boolean;
  /** The launcher's one line when nothing was decided. */
  error: string | null;
  project: { root: string; agdaLib: string | null };
  flake: string | null;
  decidedBy: 'attribute' | 'choice' | 'discovered' | null;
  method: 'package' | 'devshell' | 'path' | null;
  name: string | null;
  program: string | null;
  args: string[];
  env: Record<string, string>;
  version: string | null;
  /** Why nothing was decided: `failed` (a build or evaluation), `untrusted`
   * or `undecided`; null when decided. */
  reason?: 'failed' | 'untrusted' | 'undecided' | null;
  built: 'yes' | 'no' | 'missing';
  choice: string | null;
}

/** One entry of `--candidates --json`. */
export interface Candidate {
  id: string;
  kind: 'package' | 'devshell' | 'built' | 'PATH';
  version: string | null;
  label: string;
  chosen: boolean;
}

export interface Ran { code: number | null; stdout: string; stderr: string }

export type Runner = (launcher: string, args: string[]) => Promise<Ran>;

/** Run the launcher, without a shell, with AGDA_FOR_PROJECT_DIR removed
 * from its environment: the FILE argument says which project. */
export const runLauncher: Runner = (launcher, args) => new Promise(done => {
  const env = { ...process.env };
  delete env.AGDA_FOR_PROJECT_DIR;
  execFile(launcher, args, { env, encoding: 'utf8', maxBuffer: 1 << 22 }, (error, stdout, stderr) => {
    const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
    done({ code, stdout, stderr });
  });
});

/** The launcher's last line on stderr: its one line of refusal, after any
 * output of Nix's own. */
export function lastLine(text: string): string {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '').at(-1) ?? '';
}

/** A file's Agda, as the launcher decides it, building it first unless
 * `noBuild`.  A launcher that cannot be run, or that answers anything but
 * one JSON object, is an Error naming what it said. */
export async function explain(launcher: string, file: string, run: Runner = runLauncher, noBuild = false): Promise<Explained> {
  const ran = await run(launcher, ['--explain', '--json', ...(noBuild ? ['--no-build'] : []), file]);
  try {
    const answer = JSON.parse(ran.stdout) as Explained;
    if (typeof answer.decided !== 'boolean') throw new Error('no decided field');
    if (!answer.decided && !answer.error) answer.error = lastLine(ran.stderr) || `exit ${ran.code}`;
    return answer;
  } catch {
    throw new Error(`${launcher} --explain did not answer (exit ${ran.code ?? '?'}): ${lastLine(ran.stderr) || ran.stdout.trim() || 'no output'}`);
  }
}

export async function candidates(launcher: string, file: string, run: Runner = runLauncher): Promise<Candidate[]> {
  const ran = await run(launcher, ['--candidates', '--json', file]);
  try {
    const list = JSON.parse(ran.stdout) as Candidate[];
    if (!Array.isArray(list)) throw new Error('not a list');
    return list;
  } catch {
    throw new Error(`${launcher} --candidates did not answer (exit ${ran.code ?? '?'}): ${lastLine(ran.stderr) || 'no output'}`);
  }
}

/** Remember `id` for the file's project, or forget its choice (id null). */
export async function choose(launcher: string, file: string, id: string | null, run: Runner = runLauncher): Promise<void> {
  const ran = await run(launcher, id === null ? ['--forget', file] : ['--choose', id, file]);
  if (ran.code !== 0) throw new Error(`${launcher} ${id === null ? '--forget' : `--choose ${id}`} failed (exit ${ran.code ?? '?'}): ${lastLine(ran.stderr)}`);
}

/** The directory the launcher starts from for a file, which names its
 * answer: the `.agda-lib`'s, as the launcher finds it, or else the file's
 * own (the launcher's project root then), not the workspace folder the
 * lanes fall back to, under which two subdirectories may hold two flakes. */
export function resolutionDir(file: string, project: { root: string; source: string }): string {
  return project.source === 'agda-lib' ? project.root : dirname(file);
}

/** Whether a change to this file can change the launcher's answer: its
 * build key hashes every tracked file of the checkout but Agda sources
 * (`*.agda`, `*.lagda`, `*.lagda.*`), so any other file may, except what
 * Agda and git write themselves (interfaces, `_build/`, `.git/`). */
export function affectsResolution(file: string): boolean {
  const path = file.replace(/\\/g, '/');
  if (/\/(\.git|_build)\//.test(path)) return false;
  const name = path.slice(path.lastIndexOf('/') + 1);
  return !/\.(agda|lagda|agdai)$/.test(name) && !/\.lagda\.[^/]*$/.test(name);
}

/** Whether an answer may change with no change to the files: a failed
 * build or evaluation (the network, the store), or trust given outside
 * the checkout; so it is not kept. */
export function transient(answer: Explained): boolean {
  return !answer.decided && (answer.reason === 'failed' || answer.reason === 'untrusted');
}

/** What a mode spawn of this resolution runs: two answers with one key
 * run the same Agda with the same libraries, so one process serves both
 * and the mode need not restart.  The version is part of it: a dev shell's
 * Agda may live in the checkout, at one path that a change of the flake
 * rebuilds as another Agda. */
export function runKey(answer: Explained): string {
  return JSON.stringify([answer.program, answer.args, Object.entries(answer.env).sort(), answer.version]);
}

/** Whether the native lanes speak this version's protocol, and if not,
 * why, in a sentence that names where the version came from. */
export function laneVersionRefusal(version: string, from: string): string | null {
  if (laneVersions.includes(version)) return null;
  return `the native lanes speak the protocol of Agda ${laneVersions.join(' and ')}; ${from} is Agda ${version}`;
}

/** How a resolution was decided, in a few words for the status bar. */
export function decidedHow(answer: Explained): string {
  switch (answer.decidedBy) {
    case 'attribute': return `the attribute ${answer.name}`;
    case 'choice': return `your choice, ${answer.method}:${answer.name}`;
    case 'discovered': return answer.method === 'devshell' ? `the dev shell ${answer.name}` : `the flake's ${answer.name}`;
    default: return 'nothing';
  }
}

/** Whether an entry of agdaMode.connection.paths names the launcher. */
export function namesLauncher(entry: unknown): entry is string {
  return typeof entry === 'string' && basename(entry.trim()) === launcherName;
}

/** The launcher the mode runs: the last entry of its paths, the one it
 * tries first, when that names the launcher. */
export function modeLauncher(paths: unknown): string | undefined {
  if (!Array.isArray(paths)) return undefined;
  const last = paths.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').at(-1);
  return namesLauncher(last) ? last.trim() : undefined;
}

/** One process, from `ps -A -o pid=,ppid=,args=`. */
export interface Process { pid: number; ppid: number; args: string }

export function parsePs(text: string): Process[] {
  return text.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3]! }] : [];
  });
}

/** agda-mode-vscode's Agda among the descendants of `root` (the extension
 * host): the one started with `--interaction` (the lanes start theirs with
 * `--interaction-json`).  The mode starts it through a shell, which may
 * stay as its parent, so every depth is searched. */
export function modeAgda(processes: readonly Process[], root: number): Process | undefined {
  const children = new Map<number, Process[]>();
  for (const each of processes) children.set(each.ppid, [...(children.get(each.ppid) ?? []), each]);
  const found: Process[] = [];
  const visit = (pid: number) => {
    for (const child of children.get(pid) ?? []) {
      if (/(^|\s)--interaction(\s|$)/.test(child.args) && !/(^|\s)-c\s/.test(child.args)) found.push(child);
      visit(child.pid);
    }
  };
  visit(root);
  return found.at(-1);
}

export function listProcesses(): Promise<Process[]> {
  return new Promise(done => execFile('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 1 << 24 },
    (error, stdout) => done(error ? [] : parsePs(stdout))));
}

/** The libraries a `.agda-lib` depends on (its `depend:` field, which
 * may span lines), in order. */
export function libraryDepends(text: string): string[] {
  const names: string[] = [];
  let inDepend = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/--.*$/, '');
    const field = /^([A-Za-z-]+):(.*)$/.exec(line);
    if (field) {
      inDepend = field[1] === 'depend';
      if (inDepend) names.push(...field[2]!.split(/[\s,]+/).filter(Boolean));
    } else if (inDepend && /^\s/.test(line)) names.push(...line.split(/[\s,]+/).filter(Boolean));
  }
  return names;
}

/** nixpkgs' agdaPackages at nixos-25.11, by the library name a
 * `.agda-lib` depends on (their `libraryName`, without a version suffix,
 * as Agda matches them), read with `nix eval` on 2026-11-08. */
const nixpkgsLibraries: Record<string, string> = {
  '1lab': '_1lab',
  'agda-categories': 'agda-categories',
  'agda-prelude': 'agda-prelude',
  'agda2hs-base': 'agda2hs-base',
  'agdarsec': 'agdarsec',
  'cubical': 'cubical',
  'cubical-mini': 'cubical-mini',
  'functional-linear-algebra': 'functional-linear-algebra',
  'generics': 'generics',
  'IAL': 'iowa-stdlib',
  'standard-library': 'standard-library',
};

/** The nixpkgs release a starter flake pins: its Agda is 2.8.0, and its
 * standard library the one built for it. */
export const starterNixpkgs = 'github:NixOS/nixpkgs/nixos-25.11';

/** `text` as a Nix string literal: a backslash, a double quote, the `${`
 * that would start an interpolation, and the control characters escaped,
 * so that the literal reads back as `text` and evaluates nothing. */
export function nixString(text: string): string {
  const escaped = text
    .replace(/[\\"]/g, character => `\\${character}`)
    .replace(/\$\{/g, '\\${')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** A starter flake.nix for a project with none: one Agda environment, as
 * `packages.<system>.default`, which agda-for-project discovers, holding
 * the nixpkgs libraries its `.agda-lib` depends on.  Libraries nixpkgs
 * does not have are named in a comment, for the author to add. */
export function starterFlake(projectName: string, depends: readonly string[]): { text: string; included: string[]; missing: string[] } {
  const included: string[] = [];
  const missing: string[] = [];
  for (const name of depends) {
    const attribute = nixpkgsLibraries[name.replace(/-[0-9][0-9.]*$/, '')];
    if (attribute) { if (!included.includes(attribute)) included.push(attribute); }
    else missing.push(name);
  }
  const libraries = included.map(attribute => `p.${attribute}`).join(' ');
  // The name is a directory's, so it may hold anything: in the comment, no
  // line break may end it; in the description, it is a string literal.
  const commented = projectName.replace(/[\u0000-\u001f\u007f]/g, ' ');
  const text = `# flake.nix: a starter written by Agda Workbench (agda-native-ide) for
# ${commented}, so that agda-for-project finds its Agda: one Agda
# environment, Agda 2.8.0 from ${starterNixpkgs} with the libraries
# its .agda-lib depends on.  Change the input to pin another release.
${missing.length ? `#\n# Not in nixpkgs, so not included: ${missing.join(', ')}.\n` : ''}{
  description = ${nixString(`The Agda environment of ${projectName}`)};
  inputs.nixpkgs.url = "${starterNixpkgs}";
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.\${system});
    in {
      packages = forAll (pkgs: {
        default = pkgs.agda.withPackages (p: [ ${libraries} ]);
      });
    };
}
`;
  return { text, included, missing };
}
