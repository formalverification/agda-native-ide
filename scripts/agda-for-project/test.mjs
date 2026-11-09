// File: scripts/agda-for-project/test.mjs
//
// Tests for agda-for-project.sh, the launcher that runs a file's project's
// own Agda (issue 97).  They run the real script, in real git checkouts
// under a temporary directory, with stub-nix.sh first on PATH as `nix`, so
// they need git, bash, jq and flock, and no network or Nix store; the whole
// file takes a few seconds.
//
// The stub's builds make a stub Agda that prints which build or dev shell it
// came from, its arguments, its AGDA_DIR, and its stdin; so a test reads from
// the launcher's stdout alone which Agda ran and how, and from the stub's
// log how many builds and dev-shell entries there were.
//
// Usage: node --test scripts/agda-for-project/test.mjs  (make agda-for-project-test);
// with AGDA_FOR_PROJECT=<path>, against that copy of the launcher (CI runs the
// flake's package this way).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = process.env.AGDA_FOR_PROJECT || join(here, "agda-for-project.sh");
const STUB_NIX = join(here, "stub-nix.sh");
const UNAVAILABLE = 69;
const USAGE = 64;

const ENV_FILES = {
  "flake.nix": "{ outputs = _: { }; }\n",
  "flake.lock": '{"nodes": {"root": {}}, "version": 7}\n',
  "project.agda-lib": "name: project\ndepend: standard-library\ninclude: src\n",
  "src/Main.agda": "module Main where\n",
  "README.md": "prose\n",
};
const ONE_ENV = [{ name: "project-agdaWithPackages", version: "2.8.0" }];

/** One test's world: a stub nix and its log and store, a cache, a state
 * directory, and a PATH with no real agda or nix on it; every flake in it
 * trusted, as a user lists ~/git, unless TRUSTED is false. */
function sandbox(t, { trusted = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agda-for-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(STUB_NIX, join(bin, "nix"));
  mkdirSync(join(root, "store"));
  mkdirSync(join(root, "elsewhere"));
  const hostPath = (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)
    .filter(d => d && !existsSync(join(d, "agda")) && !existsSync(join(d, "nix")));
  const env = {
    PATH: [bin, ...hostPath].join(delimiter),
    HOME: join(root, "home"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    AGDA_DIR: "/the/caller/agda-dir",
    AGDA_FOR_PROJECT_SYSTEM: "x86_64-linux",
    STUB_NIX_LOG: join(root, "nix.log"),
    STUB_STORE: join(root, "store"),
    NIX_STORE_DIR: join(root, "store"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    LANG: "C",
  };
  const sb = { root, bin, env, hostPath };
  if (trusted) trustAll(sb);
  return sb;
}

/** Trust every flake under the sandbox, as a user lists ~/git. */
const trustFile = sb => join(sb.env.XDG_CONFIG_HOME, "agda-for-project", "trusted");
function trustAll(sb) {
  mkdirSync(join(sb.env.XDG_CONFIG_HOME, "agda-for-project"), { recursive: true });
  writeFileSync(join(sb.env.XDG_CONFIG_HOME, "agda-for-project", "trusted"), `# my checkouts\n  ${sb.root}  \n`);
}

function git(cwd, ...args) {
  const done = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
    "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  assert.equal(done.status, 0, done.stderr);
  return done.stdout;
}

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

/** A committed checkout of FILES, with CONTROL files for the stub in .stub/
 * (excluded from git, so outside the key, as a dev shell's .agda/ is).  Each
 * checkout also tracks a file naming it: two checkouts of identical tracked
 * files are one flake to the launcher, which shares their discovery. */
function checkout(sb, name, files, control = {}) {
  const dir = join(sb.root, name);
  mkdirSync(dir, { recursive: true });
  write(dir, { ...files, "checkout.txt": `${name}\n` });
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".git", "info", "exclude"), ".stub/\n.agda/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  control_(dir, control);
  return dir;
}

function control_(dir, control) {
  for (const [file, value] of Object.entries(control)) {
    mkdirSync(join(dir, ".stub"), { recursive: true });
    const path = join(dir, ".stub", file);
    if (value === null) rmSync(path, { force: true });
    else writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  }
}

function run(sb, args, { cwd, input = "", env = {} } = {}) {
  const done = spawnSync(LAUNCHER, args, {
    cwd: cwd ?? sb.root, input, encoding: "utf8", env: { ...sb.env, ...env },
  });
  return { status: done.status, stdout: done.stdout, stderr: done.stderr };
}

function runAsync(sb, args, { cwd } = {}) {
  return new Promise(resolve => {
    const child = spawn(LAUNCHER, args, { cwd, env: sb.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.stdin.end();
    child.on("close", status => resolve({ status, stdout, stderr }));
  });
}

const log = sb => existsSync(sb.env.STUB_NIX_LOG) ? readFileSync(sb.env.STUB_NIX_LOG, "utf8") : "";
const count = (sb, sub) => log(sb).split("\n").filter(l => l.startsWith(`nix ${sub}`)).length;
const lastLine = text => text.trimEnd().split("\n").at(-1) ?? "";

/** A refusal: exit 69, one line of ours last on stderr, no Agda run. */
function refused(result, pattern) {
  assert.equal(result.status, UNAVAILABLE, result.stderr);
  assert.match(lastLine(result.stderr), /^agda-for-project: /);
  assert.match(lastLine(result.stderr), pattern);
  assert.doesNotMatch(result.stdout, /^agda /m);
}

const explain = (sb, args, opts) => {
  const r = run(sb, ["--explain", "--json", ...args], opts);
  return { ...r, json: JSON.parse(r.stdout) };
};

// ---- One environment: the build, the key, the streams ----------------------

test("one environment: a miss builds, a hit does not; arguments, stdin and exit status pass through", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": ONE_ENV, devshells: null });
  const first = run(sb, ["--interaction-json", "src/Main.agda"], { cwd: join(dir, "src"), input: "hello\n" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^agda build-1 of project-agdaWithPackages$/m);
  assert.match(first.stdout, /^arg --interaction-json$/m);
  assert.match(first.stdout, /^arg src\/Main\.agda$/m);
  assert.match(first.stdout, /^hello$/m);
  assert.doesNotMatch(first.stdout, /stub nix/);
  assert.match(first.stderr, /building project-agdaWithPackages/);
  assert.match(first.stderr.split("\n")[0], /^agda-for-project: evaluating .* to find its Agda \(key [0-9a-f]{32}\); once per key$/,
    "a first evaluation is announced before it starts");
  const second = run(sb, ["--version"], { cwd: dir, env: { STUB_AGDA_EXIT: "42" } });
  assert.equal(second.status, 42);
  assert.match(second.stdout, /^agda build-1 of/m);
  assert.equal(second.stderr, "");
  assert.equal(count(sb, "build"), 1);
});

test("the key moves with the lock and with an uncommitted edit of a Nix file, and holds for Agda sources", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": ONE_ENV });
  assert.equal(run(sb, ["x"], { cwd: dir }).status, 0);
  write(dir, { "src/Main.agda": "module Main where\n-- edited\n", "src/New.lagda.md": "# new\n" });
  git(dir, "add", "-A");
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /build-1 of/);
  write(dir, { "flake.nix": "{ outputs = _: { x = 1; }; }\n" });
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /build-2 of/);
  git(dir, "checkout", "--", "flake.nix");
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /build-1 of/, "back to the first tree, back to its build");
  write(dir, { "flake.lock": '{"nodes": {"root": {"x": 1}}, "version": 7}\n' });
  git(dir, "commit", "-qam", "lock");
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /build-3 of/);
  assert.equal(count(sb, "build"), 3);
});

test("sibling worktrees share a build on one lock and get their own on another", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": ONE_ENV });
  const wt = join(sb.root, "worktree");
  git(dir, "worktree", "add", "-q", wt);
  control_(wt, { "packages.json": ONE_ENV });
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /build-1 of/);
  assert.match(run(sb, ["x"], { cwd: wt }).stdout, /build-1 of/);
  write(wt, { "flake.lock": '{"nodes": {"root": {"y": 2}}, "version": 7}\n' });
  assert.match(run(sb, ["x"], { cwd: wt }).stdout, /build-2 of/);
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /build-1 of/);
});

test("two first calls at once build once", async t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": ONE_ENV, "build-sleep": "1" });
  const [a, b] = await Promise.all([runAsync(sb, ["x"], { cwd: dir }), runAsync(sb, ["x"], { cwd: dir })]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.match(a.stdout, /build-1 of/);
  assert.match(b.stdout, /build-1 of/);
  assert.equal(count(sb, "build"), 1);
  assert.match(a.stderr + b.stderr, /waiting for another build/);
});

test("outside git, where every call evaluates, a warm start still says nothing", t => {
  const sb = sandbox(t);
  const dir = join(sb.root, "plain");
  write(dir, ENV_FILES);
  control_(dir, { "packages.json": ONE_ENV });
  const first = run(sb, ["x"], { cwd: dir });
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stderr, /evaluating/);
  const second = run(sb, ["x"], { cwd: dir });
  assert.match(second.stdout, /^agda build-1 of/m);
  assert.equal(second.stderr, "");
  assert.equal(count(sb, "eval --system x86_64-linux --json"), 4, "discovered afresh on each call");
});

// ---- Discovery -------------------------------------------------------------

test("the system is Nix's own unless AGDA_FOR_PROJECT_SYSTEM names one; the key and every nix call name it", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "packages.x86_64-linux.json": ONE_ENV, "packages.aarch64-linux.json": [] });
  const own = { AGDA_FOR_PROJECT_SYSTEM: "", STUB_NIX_SYSTEM: "x86_64-linux" };
  const r = explain(sb, [], { cwd: dir, env: own });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.system, "x86_64-linux");
  assert.equal(r.json.name, "project-agdaWithPackages");
  assert.match(log(sb), /^nix build --system x86_64-linux /m);
  // Another system, by the variable or as Nix's own: a discovery of its own.
  refused(run(sb, ["x"], { cwd: dir, env: { AGDA_FOR_PROJECT_SYSTEM: "aarch64-linux" } }),
    /exports no Agda environment and no default dev shell/);
  refused(run(sb, ["x"], { cwd: dir, env: { ...own, STUB_NIX_SYSTEM: "aarch64-linux" } }),
    /exports no Agda environment and no default dev shell/);
  assert.match(log(sb), /^nix eval --system aarch64-linux --json .*#packages\.aarch64-linux /m);
  assert.match(run(sb, ["x"], { cwd: dir, env: own }).stdout, /^agda build-1 of/m, "back to the first system, back to its build");
});

test("several environments: default wins; without default nothing is decided", t => {
  const sb = sandbox(t);
  const two = [{ name: "other-agda", version: "2.8.0" }, { name: "default", version: "2.9.0" }];
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": two });
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /of default$/m);
  const dir2 = checkout(sb, "project2", ENV_FILES, { "packages.json": [two[0], { name: "agda", version: "2.9.0" }] });
  refused(run(sb, ["x"], { cwd: dir2 }), /exports 2 Agda environments \(other-agda, agda\) and no default/);
});

test("no environment: the dev shell's agda, with the AGDA_DIR it set, entered once per key", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "devshells.json": ["default"] });
  const first = run(sb, ["--interaction-json"], { cwd: join(dir, "src") });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`^agda devshell of ${dir}$`, "m"));
  assert.match(first.stdout, new RegExp(`^AGDA_DIR=${dir}/\\.agda$`, "m"));
  assert.doesNotMatch(first.stdout, /banner|stub nix/);
  // The gc root is made where it stays: Nix registers a profile by its path.
  const profile = log(sb).match(/^nix develop .* --profile (\S+) /m)[1];
  assert.match(profile, /\/devshell\/default\/[0-9a-f]{32}-[0-9a-f]{12}\.profile$/);
  assert.ok(existsSync(profile), `${profile} is still there`);
  assert.equal(run(sb, ["x"], { cwd: dir }).status, 0);
  assert.equal(count(sb, "develop"), 1);
  rmSync(join(dir, ".agda"), { recursive: true });
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /devshell of/);
  assert.equal(count(sb, "develop"), 2, "its agda gone, the shell is entered again");
});

test("a dev shell that leaves AGDA_DIR alone passes none of its own", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "devshells.json": ["default"], "keep-agda-dir": "" });
  const r = explain(sb, [], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.env, {});
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /^AGDA_DIR=\/the\/caller\/agda-dir$/m);
});

test("a dev shell with no agda of its own is refused", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "devshells.json": ["default"], "devshell-agda": "none" });
  refused(run(sb, ["x"], { cwd: dir }), /puts no agda on PATH/);
  // An agda in the store, on the caller's PATH: the shell only inherits it.
  const outer = join(sb.root, "store", "outer", "bin");
  mkdirSync(outer, { recursive: true });
  writeFileSync(join(outer, "agda"), "#!/bin/sh\necho outer agda\n");
  chmodSync(join(outer, "agda"), 0o755);
  refused(run(sb, ["x"], { cwd: dir, env: { PATH: `${outer}${delimiter}${sb.env.PATH}` } }),
    /adds no agda of its own \(it finds .*\/store\/outer\/bin\/agda, from the caller's PATH\)/);
  // The same agda reached through a profile's link, as ~/.nix-profile/bin is.
  symlinkSync(join(sb.root, "store", "outer"), join(sb.root, "profile"));
  refused(run(sb, ["x"], { cwd: dir, env: { PATH: `${join(sb.root, "profile", "bin")}${delimiter}${sb.env.PATH}` } }),
    /adds no agda of its own \(it finds .*\/store\/outer\/bin\/agda, from the caller's PATH\)/);
  const dir2 = checkout(sb, "project2", ENV_FILES, { "devshells.json": ["default"], "devshell-agda": "elsewhere" });
  refused(run(sb, ["x"], { cwd: dir2 }), /elsewhere-bin\/agda, which is neither in the store nor in the checkout/);
});

test("a dev shell's relative PATH entry and AGDA_DIR are read from its directory and recorded absolute", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "devshells.json": ["default"], "devshell-agda": "relative" });
  for (const cwd of [join(dir, "src"), join(dir, "src"), dir]) {
    const r = run(sb, ["x"], { cwd });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^agda devshell of ${dir}$`, "m"));
    assert.match(r.stdout, new RegExp(`^AGDA_DIR=${dir}/\\.agda$`, "m"));
  }
  assert.equal(count(sb, "develop"), 1);
  assert.equal(explain(sb, [], { cwd: dir }).json.program, join(dir, ".agda", "bin", "agda"));
});

test("a dev shell entered for another key since is entered again, since its hook rewrote the checkout", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "devshells.json": ["default"], version: "2.8.0" });
  const version = () => explain(sb, [], { cwd: dir }).json.version;
  assert.equal(version(), "2.8.0");
  write(dir, { "README.md": "another state\n" });
  control_(dir, { version: "2.9.0" });
  assert.equal(version(), "2.9.0", "another key, another entry; its hook rewrites .agda/bin/agda");
  git(dir, "checkout", "--", "README.md");
  control_(dir, { version: "2.8.0" });
  assert.equal(version(), "2.8.0", "back to the first key: its record names a wrapper the second entry rewrote");
  assert.equal(count(sb, "develop"), 3);
  assert.equal(version(), "2.8.0");
  assert.equal(count(sb, "develop"), 3, "and then it is current again");
});

test("a dev shell is entered only by a choice, or under a trusted directory", t => {
  const sb = sandbox(t, { trusted: false });
  const dir = checkout(sb, "project", ENV_FILES, { "devshells.json": ["default"] });
  refused(run(sb, ["x"], { cwd: dir }), new RegExp(`is not trusted, and entering its dev shell default runs the project's shell hook as you: allow it with --choose trust:${dir} \\(every flake at or below it\\) or --choose devshell:default \\(this project\\), or list a directory at or above it in .*/config/agda-for-project/trusted$`));
  assert.equal(count(sb, "develop"), 0);
  mkdirSync(join(sb.env.XDG_CONFIG_HOME, "agda-for-project"), { recursive: true });
  const trust = join(sb.env.XDG_CONFIG_HOME, "agda-for-project", "trusted");
  mkdirSync(join(sb.root, "proj"));
  writeFileSync(trust, `${join(sb.root, "proj")}\n${join(dir, "src")}\n`);
  refused(run(sb, ["x"], { cwd: dir }), /shell hook as you/, "a sibling prefix and a subdirectory do not cover it");
  assert.equal(run(sb, ["--choose", "devshell:default"], { cwd: dir }).status, 0);
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /devshell of/, "a choice is consent");
  assert.equal(run(sb, ["--forget"], { cwd: dir }).status, 0);
  mkdirSync(sb.env.HOME, { recursive: true });
  symlinkSync(sb.root, join(sb.env.HOME, "checkouts"));
  writeFileSync(trust, "# a comment\n~/checkouts # and another\n");
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /devshell of/, "~/ and a symlinked directory");
});

test("an untrusted flake's environment is not run; trust, or a choice for the project, allows it", t => {
  const sb = sandbox(t, { trusted: false });
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": ONE_ENV });
  const other = checkout(sb, "other", ENV_FILES, { "packages.json": ONE_ENV });
  refused(run(sb, ["x"], { cwd: dir }), new RegExp(`^agda-for-project: ${dir} is not trusted, and running its Agda environment project-agdaWithPackages runs the flake's code as you: allow it with --choose trust:${dir} \\(every flake at or below it\\) or --choose package:project-agdaWithPackages \\(this project\\), or list`));
  const r = explain(sb, [], { cwd: dir });
  assert.equal(r.status, UNAVAILABLE);
  assert.deepEqual([r.json.decided, r.json.reason, r.json.decidedBy, r.json.method, r.json.name, r.json.program, r.json.version],
    [false, "untrusted", "discovered", "package", "project-agdaWithPackages", null, null]);
  assert.equal(count(sb, "build"), 0, "nothing built, nothing run");
  // What a chooser offers: trusting the flake first, then the environment.
  const offered = JSON.parse(run(sb, ["--candidates", "--json"], { cwd: dir }).stdout);
  assert.deepEqual(offered.slice(0, 2).map(c => [c.id, c.kind, c.version]),
    [[`trust:${dir}`, "trust", "2.8.0"], ["package:project-agdaWithPackages", "package", "2.8.0"]]);
  assert.match(offered[0].label, /runs what it finds there as you \(package:project-agdaWithPackages here\)/);
  // A choice is consent for its project alone.
  assert.equal(run(sb, ["--choose", "package:project-agdaWithPackages"], { cwd: dir }).status, 0);
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /^agda build-1 of project-agdaWithPackages$/m);
  refused(run(sb, ["x"], { cwd: other }), /is not trusted/);
  // Trust, granted by the chooser's ID, keeps what the file held and
  // replaces the project's choice, so that discovery decides.
  mkdirSync(dirname(trustFile(sb)), { recursive: true });
  writeFileSync(trustFile(sb), "# mine, with no newline at the end");
  const granted = run(sb, ["--choose", `trust:${sb.root}`, join(dir, "src/Main.agda")], { cwd: join(sb.root, "elsewhere") });
  assert.equal(granted.status, 0, granted.stderr);
  assert.match(granted.stderr, new RegExp(`trusted ${sb.root} and every flake below it`));
  assert.match(granted.stderr, /forgot the choice for repository/);
  assert.deepEqual(readFileSync(trustFile(sb), "utf8").split("\n").filter(l => !l.startsWith("# --choose")),
    ["# mine, with no newline at the end", sb.root, ""]);
  assert.equal(explain(sb, [], { cwd: dir }).json.decidedBy, "discovered");
  assert.match(run(sb, ["x"], { cwd: other }).stdout, /^agda build-2 of/m, "every flake below it (its own key, its own build)");
  assert.match(run(sb, ["--choose", `trust:${dir}`], { cwd: dir }).stderr, /is already trusted/);
  assert.equal(readFileSync(trustFile(sb), "utf8").split("\n").filter(l => l === sb.root || l === dir).length, 1);
  // Trust is offered only where it would decide something, and not once given.
  assert.ok(!JSON.parse(run(sb, ["--candidates", "--json"], { cwd: dir }).stdout).some(c => c.kind === "trust"));
  rmSync(trustFile(sb));
  const empty = checkout(sb, "empty", ENV_FILES);
  assert.ok(!JSON.parse(run(sb, ["--candidates", "--json"], { cwd: empty }).stdout).some(c => c.kind === "trust"));
});

test("a flake with neither an environment nor a dev shell decides nothing", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES);
  refused(run(sb, ["x"], { cwd: dir }), /exports no Agda environment and no default dev shell/);
});

// ---- Choices and the host's attribute --------------------------------------

test("no flake: nothing is decided until a choice, which every worktree shares, until it is forgotten", t => {
  const files = { "project.agda-lib": "name: project\ninclude: src\n", "src/Main.agda": "module Main where\n" };
  const sb = sandbox(t);
  const dir = checkout(sb, "project", files);
  refused(run(sb, ["x"], { cwd: dir }), /no flake\.nix at or above/);
  const exe = join(sb.root, "my-agda");
  writeFileSync(exe, "#!/bin/sh\necho my agda \"$@\"\n");
  chmodSync(exe, 0o755);
  const chose = run(sb, ["--choose", `path:${exe}`, join(dir, "src/Main.agda")]);
  assert.equal(chose.status, 0, chose.stderr);
  assert.equal(run(sb, ["--version"], { cwd: dir }).stdout, "my agda --version\n");
  const wt = join(sb.root, "worktree");
  git(dir, "worktree", "add", "-q", wt);
  assert.equal(run(sb, ["y"], { cwd: join(wt, "src") }).stdout, "my agda y\n");
  assert.equal(run(sb, ["--forget"], { cwd: wt }).status, 0);
  refused(run(sb, ["x"], { cwd: dir }), /no flake\.nix/);
});

test("a directory whose .git file names a repository's git directory does not share its choices", t => {
  const sb = sandbox(t, { trusted: false });
  const mine = checkout(sb, "mine", ENV_FILES, { "devshells.json": ["default"] });
  assert.equal(run(sb, ["--choose", "devshell:default"], { cwd: mine }).status, 0);
  const wt = join(sb.root, "worktree");
  git(mine, "worktree", "add", "-q", wt);
  control_(wt, { "devshells.json": ["default"] });
  assert.equal(explain(sb, ["--no-build"], { cwd: wt }).json.choice, "devshell:default", "a worktree git lists shares it");
  // Unpacked archives with their own flake, and a .git file naming my
  // repository's git directory, or my worktree's.
  for (const [name, gitdir] of [["archive", join(mine, ".git")], ["archive2", join(mine, ".git", "worktrees", "worktree")]]) {
    const planted = join(sb.root, "Downloads", name);
    write(planted, { ...ENV_FILES, "checkout.txt": "mine\n", ".git": `gitdir: ${gitdir}\n` });
    control_(planted, { "devshells.json": ["default"] });
    assert.equal(git(planted, "rev-parse", "--show-toplevel").trim(), planted, "git takes it for a checkout of mine");
    const r = explain(sb, ["--no-build"], { cwd: planted });
    assert.deepEqual([r.json.decided, r.json.reason, r.json.choice], [false, "untrusted", null]);
    refused(run(sb, ["x"], { cwd: planted }), /is not trusted, and entering its dev shell default/);
  }
  assert.equal(count(sb, "develop"), 0, "no shell entered on my choice's authority");
});

test("a chosen attribute overrides discovery, and AGDA_FLAKE_ATTR or --flake-attr overrides the choice", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": ONE_ENV });
  assert.equal(run(sb, ["--choose", "package:chosen"], { cwd: dir }).status, 0);
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /of chosen$/m);
  assert.match(run(sb, ["x"], { cwd: dir, env: { AGDA_FLAKE_ATTR: "named" } }).stdout, /of named$/m);
  assert.match(run(sb, ["--flake-attr", "flagged", "x"], { cwd: dir }).stdout, /of flagged$/m);
  assert.match(run(sb, ["--flake-attr=flagged", "y"], { cwd: dir }).stdout, /^arg y$/m);
  const r = run(sb, ["--flake-attr", "flagged", "--explain", "--json", "--no-build"], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).decidedBy, "attribute");
  assert.equal(JSON.parse(r.stdout).name, "flagged");
});

test("a path chosen relative to the working directory is kept absolute", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": ONE_ENV });
  for (const [where, text] of [["tools", "the chosen agda"], ["src/tools", "another agda"]]) {
    mkdirSync(join(dir, where), { recursive: true });
    writeFileSync(join(dir, where, "agda"), `#!/bin/sh\necho ${text}\n`);
    chmodSync(join(dir, where, "agda"), 0o755);
  }
  assert.equal(run(sb, ["--choose", "path:tools/agda"], { cwd: dir }).status, 0);
  assert.equal(explain(sb, ["--no-build"], { cwd: dir }).json.choice, `path:${join(dir, "tools", "agda")}`);
  assert.equal(run(sb, ["x"], { cwd: join(dir, "src") }).stdout, "the chosen agda\n");
  mkdirSync(join(sb.env.XDG_STATE_HOME, "agda-for-project", "choices"), { recursive: true });
  const file = explain(sb, ["--no-build"], { cwd: dir }).json.choiceFile;
  writeFileSync(file, "path:tools/agda\n");
  refused(run(sb, ["x"], { cwd: join(dir, "src") }), /tools\/agda, is not an absolute path; run --forget/);
});

// ---- The project's own libraries -------------------------------------------

test("sibling libraries join the environment's in a libraries file, transitively; a missing one is reported", t => {
  const sb = sandbox(t);
  const stdlib = join(sb.root, "store", "standard-library-2.3", "standard-library.agda-lib");
  write(dirname(stdlib), { "standard-library.agda-lib": "name: standard-library-2.3\ninclude: src\n" });
  const dir = checkout(sb, "project", {
    ...ENV_FILES,
    "sibling-a/sibling-a.agda-lib": "name: sibling-a\ndepend:\n  sibling-b, standard-library\ninclude: src\n",
    "sibling-b/sibling-b.agda-lib": "name: sibling-b -- a comment\ninclude: src\n",
    "tests/tests.agda-lib": "name: tests\ndepend:\n  standard-library\n  sibling-a\n  nowhere\ninclude: src\n",
    "tests/src/T.agda": "module T where\n",
  }, { "packages.json": ONE_ENV, libraries: `${stdlib}\n` });
  const r = explain(sb, [join(dir, "tests/src/T.agda")]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.libraries.local, [join(dir, "sibling-a/sibling-a.agda-lib"), join(dir, "sibling-b/sibling-b.agda-lib")]);
  assert.deepEqual(r.json.libraries.missing, ["nowhere"]);
  assert.equal(r.json.args.length, 1);
  assert.equal(r.json.args[0], `--library-file=${r.json.libraries.file}`);
  assert.deepEqual(readFileSync(r.json.libraries.file, "utf8").trim().split("\n"),
    [stdlib, join(dir, "sibling-a/sibling-a.agda-lib"), join(dir, "sibling-b/sibling-b.agda-lib")]);
  assert.match(run(sb, ["x"], { cwd: join(dir, "tests/src") }).stdout, /^arg --library-file=.*\.libraries$/m);
  const top = explain(sb, [], { cwd: dir });
  assert.deepEqual(top.json.args, [], "the environment provides every dependency of the root project");
  assert.match(run(sb, ["x"], { cwd: dir }).stdout, /^arg x$/m);
});

// ---- Answers ---------------------------------------------------------------

test("--explain --json: the resolution, and decided false with the reason", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": ONE_ENV, version: "2.8.0" });
  const none = explain(sb, ["--no-build"], { cwd: dir });
  assert.equal(none.json.built, "missing");
  assert.equal(none.json.program, null);
  const r = explain(sb, [join(dir, "src/Main.agda")]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.decided, true);
  assert.equal(r.json.reason, null);
  assert.equal(r.json.decidedBy, "discovered");
  assert.equal(r.json.method, "package");
  assert.equal(r.json.name, "project-agdaWithPackages");
  assert.equal(r.json.version, "2.8.0");
  assert.equal(r.json.built, "yes");
  assert.equal(r.json.project.root, dir);
  assert.equal(r.json.project.agdaLib, join(dir, "project.agda-lib"));
  assert.equal(r.json.flake, dir);
  assert.match(r.json.program, /\/package\/project-agdaWithPackages\/[0-9a-f]{32}\/bin\/agda$/);
  assert.equal(explain(sb, [], { cwd: dir }).json.built, "no");
  const lonely = checkout(sb, "lonely", { "Main.agda": "module Main where\n" });
  const undecided = explain(sb, [], { cwd: lonely });
  assert.equal(undecided.status, UNAVAILABLE);
  assert.equal(undecided.json.decided, false);
  assert.equal(undecided.json.reason, "undecided", "a choice would settle it");
  assert.match(undecided.json.error, /no flake\.nix/);
  const two = checkout(sb, "two", ENV_FILES, { "packages.json": [{ name: "a-agda" }, { name: "b-agda" }] });
  assert.equal(explain(sb, [], { cwd: two }).json.reason, "undecided");
  const broken = explain(sb, [], { cwd: checkout(sb, "broken", ENV_FILES, { "eval-fails": "" }) });
  assert.deepEqual([broken.status, broken.json.decided, broken.json.reason], [UNAVAILABLE, false, "failed"]);
});

test("--candidates: environments, dev shells, builds and agda on PATH, the chosen one marked", t => {
  const sb = sandbox(t);
  const two = [{ name: "default", version: "2.9.0" }, { name: "old-agda", version: "2.8.0" }];
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": two, "devshells.json": ["default", "ci"] });
  assert.equal(run(sb, ["x"], { cwd: dir }).status, 0);
  const outer = join(sb.root, "outer-bin");
  mkdirSync(outer);
  writeFileSync(join(outer, "agda"), "#!/bin/sh\necho 2.6.4\n");
  chmodSync(join(outer, "agda"), 0o755);
  const env = { PATH: `${outer}${delimiter}${sb.env.PATH}` };
  assert.equal(run(sb, ["--choose", "package:old-agda"], { cwd: dir, env }).status, 0);
  const r = run(sb, ["--candidates", "--json", join(dir, "src/Main.agda")], { env });
  assert.equal(r.status, 0, r.stderr);
  const list = JSON.parse(r.stdout);
  const ids = list.map(c => c.id);
  assert.deepEqual(ids.slice(0, 4), ["package:default", "package:old-agda", "devshell:default", "devshell:ci"]);
  assert.ok(!list.some(c => c.kind === "trust"), "a trusted flake is not offered trust");
  assert.ok(list.some(c => c.kind === "built" && c.id.endsWith("/bin/agda") && c.version === "2.9.0"));
  assert.ok(list.some(c => c.kind === "PATH" && c.id === `path:${join(outer, "agda")}` && c.version === "2.6.4"));
  assert.deepEqual(list.filter(c => c.chosen).map(c => c.id), ["package:old-agda"]);
  const text = run(sb, ["--candidates"], { cwd: dir, env });
  assert.match(text.stdout, /^package:old-agda\t.*\(chosen\)$/m);
});

// ---- Refusals and the command line -----------------------------------------

test("refusals: no lock, a failed build, an output without agda, an evaluation that fails, no nix", t => {
  const sb = sandbox(t);
  const { "flake.lock": _, ...unlocked } = ENV_FILES;
  refused(run(sb, ["x"], { cwd: checkout(sb, "unlocked", unlocked, { "packages.json": ONE_ENV }) }), /no flake\.lock in /);
  const untracked = checkout(sb, "untracked", unlocked, { "packages.json": ONE_ENV });
  write(untracked, { "flake.lock": ENV_FILES["flake.lock"] });
  refused(run(sb, ["x"], { cwd: untracked }), /flake\.lock in .* is not tracked by git, so Nix ignores it/);
  const listed = run(sb, ["--candidates", "--json"], { cwd: untracked });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stderr, /Agdas are not listed: the flake\.lock in .* is not tracked by git/);
  assert.deepEqual(JSON.parse(listed.stdout).filter(c => c.kind === "package"), []);
  assert.equal(count(sb, "eval"), 0, "an unlocked flake is never evaluated");
  refused(run(sb, ["x"], { cwd: checkout(sb, "broken", ENV_FILES, { "packages.json": ONE_ENV, "build-fails": "" }) }),
    /nix build .*#project-agdaWithPackages failed/);
  refused(run(sb, ["x"], { cwd: checkout(sb, "noagda", ENV_FILES, { "packages.json": ONE_ENV, "no-agda": "" }) }),
    /which has no executable bin\/agda/);
  refused(run(sb, ["x"], { cwd: checkout(sb, "noeval", ENV_FILES, { "eval-fails": "" }) }), /Nix could not evaluate/);
  refused(run(sb, ["x"], { cwd: checkout(sb, "nodev", ENV_FILES, { "devshells.json": ["default"], "develop-fails": "" }) }),
    /nix develop .* failed/);
  const dir = checkout(sb, "nonix", ENV_FILES, { "packages.json": ONE_ENV });
  const noNix = { PATH: sb.hostPath.join(delimiter) };
  refused(run(sb, ["x"], { cwd: dir, env: noNix }), /nix is not on PATH/);
  const exe = join(sb.root, "my-agda");
  writeFileSync(exe, "#!/bin/sh\necho mine\n");
  chmodSync(exe, 0o755);
  assert.equal(run(sb, ["--choose", `path:${exe}`], { cwd: dir }).status, 0);
  assert.equal(run(sb, ["x"], { cwd: dir, env: noNix }).stdout, "mine\n", "a chosen executable needs no nix");
  refused(run(sb, ["x"], { cwd: dir, env: { ...noNix, AGDA_FLAKE_ATTR: "named" } }),
    /the host names the flake attribute named, and nix is not on PATH/);
  refused(run(sb, ["--flake-attr", "flagged", "x"], { cwd: dir, env: noNix }), /flake attribute flagged, and nix is not on PATH/);
});

test("a FILE, or AGDA_FOR_PROJECT_DIR, starts the search somewhere other than the working directory", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": ONE_ENV });
  const elsewhere = join(sb.root, "elsewhere");
  assert.equal(explain(sb, [join(dir, "src/Main.agda")], { cwd: elsewhere }).json.project.root, dir);
  assert.equal(explain(sb, [join(dir, "src")], { cwd: elsewhere }).json.project.root, dir);
  const r = run(sb, ["x"], { cwd: elsewhere, env: { AGDA_FOR_PROJECT_DIR: join(dir, "src") } });
  assert.match(r.stdout, /build-1 of project-agdaWithPackages/);
});

test("a malformed command line exits 64", t => {
  const sb = sandbox(t);
  const dir = checkout(sb, "project", ENV_FILES, { "packages.json": ONE_ENV });
  for (const args of [["--choose"], ["--choose", "nonsense"], ["--choose", "path:/no/such/agda"],
    ["--explain", "a", "b"], ["--choose", "package:x", "--json"], ["--forget", "--no-build"],
    ["--explain", "/no/such/file"], ["--candidates", "--bogus"], ["--flake-attr"], ["--flake-attr", ""],
    ["--flake-attr="], ["--flake-attr", "x", "--choose", "package:y"], ["--flake-attr=x", "--candidates"],
    ["--choose", "trust:/no/such/dir"], ["--choose", "trust:"]]) {
    const r = run(sb, args, { cwd: dir });
    assert.equal(r.status, USAGE, `${args.join(" ")}: ${r.stderr}`);
  }
  assert.equal(count(sb, "build"), 0);
});
