<!-- File: docs/adr/0004-each-projects-own-agda.md -->

# ADR 0004: each project's own Agda

File: `agda-native-ide/docs/adr/0004-each-projects-own-agda.md`

+  **Status**: Proposed with [#97].  The decisions are this record's, taken
   while building the resolver on 2026-11-07; each is built and tested
   here, and measured on three real projects.  The two editors' use of it
   is [#98]'s and [#99]'s, and each section's status says what they owe.
+  **Date**: 2026-11-07.
+  **Tracking**: [#97] (this record, and the launcher); [#98] (Emacs);
   [#99] (VS Code, the mode and the companion's lanes); [#96] (the website's
   page on this feature, drawn from the [companion note][note]).
+  **Ancestry**: agda-native-air's launcher `scripts/agda-for-flake.sh`
   ([agda-native-air#344], read at `0359b4be`), whose key (with the system
   added here), build under a lock and stream rules this one keeps; an
   investigation of 2026-11-07 of
   an Emacs configuration that picked an Agda per checkout from a hand-kept
   table, whose failures and tests are the evidence of § 1; and
   [ADR 0003][adr-0003] § 13, where the companion resolves one Agda from its
   settings and refuses any version but the one a setting names.

## Executive summary

A host (agda2-mode in Emacs, agda-mode-vscode, this repository's VS Code
companion, agda-native-air's agda-mcp) starts one Agda for every file it
is given.  A file of a project pinned to another Agda, or to other
libraries, then fails with errors that read as broken code.  This record
decides how every host gets each project's own Agda instead: one program,
`agda-for-project`, that a host names where it would name `agda`.

+  **What it does**: from its working directory it finds the project (the
   nearest `.agda-lib`) and the project's flake, decides which Agda that
   flake names, builds it once per change of the files that decide it, and
   execs it with every argument unchanged.
+  **How it decides**: an attribute the host names; else a choice the user
   made for the project; else the flake's one Agda environment, or else its
   dev shell's own `agda`, either only if the user trusts the flake, since
   running either runs the flake's code; else nothing, and it says so, exit
   69, and lists the candidates a chooser can offer, trusting the flake
   among them.
+  **Why it is shaped so**: most projects worth checking already pin their
   Agda and libraries in a flake, so the answer is written down; and a
   program, not a library, is the one thing every host can run.
+  **Where it stands**: built, packaged in the flake, tested (26 cases
   against a stub `nix`; 25 checks each made to fail by a mutation, and
   each case added after a review failing against the launcher before it
   or under a mutation), and measured on formal-ledger-specifications
   (Agda 2.8.0, two locks), agda-algebras (Agda 2.9.0) and agda-lattices
   (a dev shell's wrapper): each file checks through it, where one Agda for
   all of them fails two ways.
+  **Where it goes**: Emacs ([#98]) and VS Code ([#99]) name it and build
   their choosers on its answers; agda-native-air's registrations can name
   it in place of `agda-for-flake.sh`, whose interface it keeps.

### Terms

+  **A host**: a program that starts Agda for a user: an editor mode, the
   companion's native lanes, or agda-mcp.
+  **A project**: the directory of the nearest `.agda-lib` file at or above
   a file, which is how Agda itself finds a file's library.
+  **A flake**: a directory with a `flake.nix`, Nix's unit of pinned
   inputs; its `flake.lock` pins every input by hash.  `nix build DIR#NAME`
   builds the output NAME of the flake in DIR.
+  **An Agda environment**: what nixpkgs' `agda.withPackages` makes, an
   `agda` wrapped with a libraries file (Agda's registry of library
   locations) that names the chosen libraries; its derivation's `pname` is
   `agdaWithPackages`, and recent nixpkgs gives it a `libraryFile`
   attribute.
+  **A dev shell**: the environment `nix develop` enters, from a flake's
   `devShells`; its hook (`shellHook`) runs on entry and may write files.
+  **The key**: a hash of what decides a build (§ 5).
+  **A trusted flake**: one at or below a directory the user lists in
   `~/.config/agda-for-project/trusted` (§ 7).
+  **A root**: a symlink into the Nix store that keeps a build from being
   collected (a gc root).
+  **The launcher**: `scripts/agda-for-project/agda-for-project.sh`, run as
   `agda-for-project`.
+  **Exit 69**: `EX_UNAVAILABLE` of sysexits.h, the launcher's status when
   it runs no Agda; Agda itself exits 1, 42, 71 or 154.

## 1.  One program that every host names

(See also [#97], [the note][note].)

**Decision**.  The resolver is a program a host runs in place of `agda`,
which decides and then execs the project's Agda, so that no host keeps a
rule of its own.

+  A bash script, packaged by the flake as `agda-for-project` with its
   tools (git, jq, flock, coreutils) from nixpkgs and the caller's own
   `nix`; `nix run github:formalverification/agda-native-ide#agda-for-project`
   runs it with nothing installed but Nix.
+  Not a TypeScript library in the shared core: agda2-mode and agda-mcp
   start a program, and the companion can start the same one, so a program
   is the only form all four can share.  The companion's own resolution
   ([ADR 0003][adr-0003] § 13) becomes a call to it in [#99].
+  Every argument goes to Agda unchanged, and nothing but Agda writes to
   standard output, so a host that speaks Agda's interaction protocol over
   the program's streams cannot tell it from `agda`.
+  **One line on stderr before a first evaluation or a build**, once per
   key, so that a host which passes over a silent program waits for this
   one: agda-mode-vscode probes each candidate with `--version` and moves
   on after 3 s without output ([#97]'s report of 2026-11-09).  A warm
   start writes nothing, nor does any call outside git, where every call
   evaluates: a host may read stderr during a session as an error of
   Agda's.

**Evidence**.

+  The two failures one Agda for every file gives, reproduced on
   2026-11-07 ([the record][record], `checks`): agda-algebras' Agda 2.9.0
   on a formal-ledger-specifications file exits 42 with `Library
   'standard-library-classes' not found`; the master checkout's
   environment on a worktree pinned to an older lock exits 42 with
   `Multiple definitions of _≢ᵐ_`.  Through the launcher both exit 0, with
   no module type-checked again.
+  The investigation of the same day found the Emacs configuration's
   hand-kept table picking a hand-built pin of one lock (built
   2025-12-09) for every worktree, 14 of which pin a newer library and 31
   an older one; no single pin can serve both.
+  Costs: a warm start costs 0.20 s more than starting the environment's
   `agda` directly (median of five), paid once per Agda process.
+  The second review of [#101] (2026-11-09) found discovery silent: with
   two evaluations of 2 s each under the stub `nix`, the first byte on
   stderr came at 4.2 s; with the line, at 0.0 s ([the record of
   2026-11-09][record-11-09], `silence`).  Tests: the line opens
   a first call; a warm start, and a second call outside git, write
   nothing; a mutation that speaks outside git is caught.

**Status**.  Adopted (2026-11-07, [#97]); the line before a first
evaluation added on 2026-11-09.  [#98] and [#99] name it.

---

## 2.  The project and its flake

(See also [#97].)

**Decision**.  The project is the nearest `.agda-lib` at or above the
starting directory, and its flake the nearest `flake.nix` at or above the
project, within its repository.

+  **The starting directory** is the working directory (agda2-mode starts
   Agda in the buffer's directory); or `AGDA_FOR_PROJECT_DIR`, for a host
   that cannot choose where it starts Agda; or, for the answers of § 10, a
   `FILE` argument.
+  **No `.agda-lib`**: the starting directory is the project.
+  **The search for the `.agda-lib` does not stop at a repository's
   boundary**, since Agda's does not: a file of a checkout nested in
   another library's directory, with no `.agda-lib` of its own above it, is
   that library's to Agda, and only that library's Agda can check it.
+  **The search for the flake stops at a repository's boundary** (a
   directory holding `.git`), as agda-for-flake.sh's does, so a checkout
   nested in another never borrows the outer flake.

**Evidence**.  A test runs each answer from an unrelated directory with a
`FILE`, and the exec path with `AGDA_FOR_PROJECT_DIR`; the
formal-ledger-test library, a subdirectory of formal-ledger-specifications
with its own `.agda-lib`, resolves to the checkout's flake ([the
record][record], `explain`).  The second review of [#101] (2026-11-09)
asked that the `.agda-lib` search stop at a nested repository's `.git`.
Agda 2.8.0, checking `outer/nested/X.agda` with `outer/nested/.git` and
`outer/outer.agda-lib` (which depends on `no-such-library`), fails with
`Library 'no-such-library' not found`; with the outer file removed, `X`
checks ([the record of 2026-11-09][record-11-09], `nestedLibrary`).  So
the nested flake's Agda would read the outer `.agda-lib` too.

**Status**.  Adopted (2026-11-07, [#97]); the stop at `.git` for the
library search declined on 2026-11-09.  [#99] decides whether the VS Code
mode needs `AGDA_FOR_PROJECT_DIR`.

---

## 3.  The order of discovery

(See also [#97], [#98], [#99].)

**Decision**.  The first of the following that applies decides the Agda:
an attribute the host names, a remembered choice, the flake's one Agda
environment, its default dev shell's own `agda`; otherwise nothing is
decided.  What discovery finds (3 and 4) is run only for a trusted flake
(§ 7).

1.  **An attribute named by the host**: `AGDA_FLAKE_ATTR`, or a leading
    `--flake-attr NAME`, agda-for-flake.sh's interface, so an agda-mcp
    registration written for that script works unchanged.  An empty
    `NAME` is refused as a usage error (exit 64; agda-for-flake.sh refuses
    it too), and `--explain` may follow the flag.
2.  **A remembered choice** (§ 9).
3.  **The flake's one Agda environment** (§ 4), when the flake is trusted.
4.  **The flake's default dev shell**, when it puts an `agda` of its own on
    PATH (§ 6) and the flake is trusted.
5.  **Nothing**: exit 69, with one line saying what is missing, and
    `--candidates` lists what a chooser can offer (§ 10).

The environment comes before the dev shell: both are cheap once built,
but a package runs none of the project's code before its Agda starts, and
builds only Agda and its libraries, while entering a dev shell runs the
project's hook, which may write into the checkout, and builds every tool
the project's developers use.  A project whose dev shell does more than
its environment (below) is given its dev shell by a choice.

**Evidence**.  Probes of 2026-11-07, warm evaluation caches ([the
record][record], `discoveryProbes`):

| Project | Environment found by evaluation | Dev shell's `agda` |
|---|---|---|
| formal-ledger-specifications | `fls-agdaWithPackages` (2.8.0), 0.35 s | the environment's store path, 0.30 s |
| agda-algebras | `default` (2.9.0), 1.04 s | `.agda/bin/agda` in the checkout, 1.96 s, 300 bytes of banner on stdout |
| agda-lattices | no `packages` output, 0.06 s | `.agda/bin/agda` in the checkout, 2.51 s, 428 bytes of banner |

+  For formal-ledger-specifications and agda-algebras the two answers run
   the same Agda; agda-algebras' dev-shell wrapper also passes `--library`
   flags, so a scratch file outside every library still sees them, which
   the environment alone does not give; `--choose devshell:default` gives
   it.
+  The first-call times of the acceptance run (linking a root and
   evaluating; every store path already present): 2.2 s, 2.2 s, 4.2 s and
   2.7 s; warm, 0.10 s to 0.21 s, each including a `--numeric-version`.

**Status**.  Adopted (2026-11-07, [#97]).

---

## 4.  Recognizing an Agda environment

(See also [#97].)

**Decision**.  An Agda environment is a package of the system (Nix's own,
unless `AGDA_FOR_PROJECT_SYSTEM` names another; § 5), named `default` or
with `agda` in its name, that evaluates to a derivation
whose `pname` is `agdaWithPackages`; with one, it decides, and with
several, `default` decides if it is one, and nothing does otherwise.

+  **By evaluation, not by name**: formal-ledger-specifications' packages
   hold four names with `agda` in them (`default`, `fls-agda`,
   `fls-agdaWithPackages`, `fls-shake-agdaWithPackages`), of which one is
   an environment: `fls-agda` is an Agda without libraries, and
   `fls-shake-agdaWithPackages` a build tool.
+  **Only the names that could be one are evaluated**, each under
   `tryEval`, so a package that fails to evaluate is passed over and a
   large package set is never forced.
+  **`legacyPackages` is not searched**: it may hold all of nixpkgs.
+  **One evaluation per key** (§ 5): the answer is cached under the key,
   since identical tracked files are an identical flake.

**Evidence**.  The probes of § 3; the cases "several environments: default
wins; without default nothing is decided" and the mutation that prefers the
first environment, which a test catches.

**Status**.  Adopted (2026-11-07, [#97]).

---

## 5.  The key and the cache

(See also [#97], agda-native-air [#344][agda-native-air#344].)

**Decision**.  A build is keyed as agda-for-flake.sh keys it, by every
tracked file of the checkout except Agda sources, and kept as a root under
`${XDG_CACHE_HOME:-~/.cache}/agda-for-project/`.

+  **The key**: the index's entry for each tracked file that is not an Agda
   source, or the working tree's type, mode and contents where it changes
   the file, with the system, the attribute and the flake's directory
   within the repository.  Nix reads exactly the tracked files of a git
   flake, so the key moves when anything Nix reads moves (a lock, a Nix
   file, a build tool's sources), and holds while a session edits proofs,
   since an environment for checking a project cannot depend on them.
+  **One system throughout**: the system is Nix's own (`nix eval --impure
   --expr builtins.currentSystem`, about 0.01 s), or the one
   `AGDA_FOR_PROJECT_SYSTEM` names, and every `nix` call is passed it as
   `--system`.  `nix build DIR#NAME` resolves `NAME` for Nix's own system,
   so a system read from `uname` alone could make discovery and the build
   disagree; agda-for-flake.sh builds for Nix's own system only, and so
   needs none in its key.
+  **A locked flake only**: a `flake.lock` that git tracks, checked before
   any evaluation.  In a git checkout Nix reads only tracked files, so it
   ignores an untracked lock and resolves every input afresh, under a key
   that would not move when those inputs did.
+  **The build under a lock**: the first call builds under an exclusive
   `flock`, publishes the root only if the key is unchanged afterward, and
   a second call waits for it.
+  **Shared where Nix would build the same thing**: a package's root and
   the discovery are keyed by content alone, so sibling worktrees on one
   lock share them; a dev shell's record is kept per checkout, since its
   `agda` may live in the checkout, and is used only while its key is the
   one last entered there (§ 6).
+  **Outside git**: a package is keyed by its output path, from `nix eval`
   on every call; discovery and dev shells are found afresh.
+  **Nothing is removed**: the roots accumulate until the user deletes them
   and runs `nix store gc`.

**Evidence**.  On 2026-11-07 the master checkout and the older-lock
worktree of formal-ledger-specifications got two environments
(`0vx59n9g…` and `ws6a1ika…`, libraries files `6qscaqml…` and
`xza7nddh…`, the pair the investigation of § 1 had found by hand), and the
formal-ledger-test library shared the master checkout's root.  Tests: a
miss builds and a hit does not; the key moves with the lock and an
uncommitted edit of a Nix file and returns with the tree; it holds for
Agda sources; worktrees share; two first calls build once.  Copilot's
review of [#101] (2026-11-08) found the key without the system: a
discovery made for `x86_64-linux` was reused when the variable named
`aarch64-linux`, with no evaluation.  It also found the lock checked only
after discovery had evaluated the flake; with Nix 2.34.8, an untracked
`flake.lock` in a git flake was ignored, and the input it pinned resolved
afresh.  Tests now cover each system's own discovery and build, an
untracked lock refused, and no evaluation of an unlocked flake.

**Status**.  Adopted (2026-11-07, [#97]); the system and the tracked lock
added on 2026-11-08, after the review of [#101].

---

## 6.  A dev shell's own agda

(See also [#97].)

**Decision**.  A dev shell is entered once per key and checkout, and the
`agda` its hook leaves on PATH is run thereafter directly, with the
`AGDA_DIR` the hook set if it changed the caller's.

+  **Entered with its profile kept**: `nix develop --profile` keeps the dev
   environment, and so the store paths the shell's `agda` names, as a
   root.  The profile is made where it stays, beside the record
   (`<key>-<checkout>.profile`), since Nix registers a profile's root by
   the path it was made at.  Its banner goes to `/dev/null`; its errors are
   shown only when it fails.
+  **Its own, not inherited**: the `agda` must be in the store or in the
   checkout (agda-algebras' downstream shells write `.agda/bin/agda`), and
   not the one the caller's PATH already gives; otherwise the shell is
   refused, since `nix develop` keeps the caller's PATH after its own.  The
   two are compared with their directories' links resolved, since a
   profile's `bin` (`~/.nix-profile/bin`, NixOS's
   `/run/current-system/sw/bin`) resolves into the store.
+  **Recorded absolute**: the `agda` is recorded as that resolved path, and
   a relative PATH entry or `AGDA_DIR` of the hook's is read from the
   shell's working directory, so a later call from any directory runs the
   same `agda` with the same `AGDA_DIR`.
+  **`AGDA_DIR` only when the hook changed it**: the caller's own
   (`~/.config/agda` on the machine measured) passes through the shell
   unchanged, and recording it would pin it.
+  **Entered again** when the key changes, when the recorded `agda` is gone
   (a `git clean` of `.agda/`), or when another key's shell has been
   entered in the checkout since: a hook writes into the checkout what its
   own key asks (agda-lattices' writes `.agda/bin/agda`, `.agda/libraries`
   and a copy of agda-algebras), so each checkout records the shell and key
   last entered, under one lock per checkout.  A shell entered by hand
   (`nix develop`, direnv) is not seen until the next entry.

**Evidence**.  The probes of § 3 (formal-ledger-specifications' shell left
`AGDA_DIR` as the caller had it); tests for each clause, three of them
made to fail by mutations (an `AGDA_DIR` recorded when unchanged, any
`agda` accepted, the inherited one not compared).  The review of [#101]
found the caller's `agda`, reached through a profile's link, accepted as
the shell's own (the shell's path was resolved and the caller's was not;
`~/.nix-profile/bin` resolves into `/nix/store` on the machine measured),
and a relative PATH entry recorded as given, so that a call from a
subdirectory entered the shell again and was refused.  A test covers each.
The second review (2026-11-09) found two more, as follows:

+  **A wrapper shared by two keys**: under the stub `nix`, a shell whose
   hook writes an Agda 2.8.0 wrapper at one key and a 2.9.0 wrapper at
   another gave 2.9.0 on returning to the first key, with no entry; now it
   enters again (three entries, 2.8.0), and a mutation that skips the
   comparison is caught.
+  **A root at a path that no longer exists**: with Nix 2.34.8, a profile
   made in the temporary directory was registered under
   `/nix/var/nix/gcroots/auto` by that directory's path, and after the
   directory was moved into place `nix-store -q --roots` listed no root of
   the dev environment.  Made at its final path, the root is the record's
   own `.profile-1-link`, for a real dev shell entered through the
   launcher; three entries at one path make one generation.  A test checks
   that the profile named to `nix develop` is still there afterward
   ([the record of 2026-11-09][record-11-09], `devShellRoot`).

**Status**.  Adopted (2026-11-07, [#97]); the comparison through links and
the absolute record added on 2026-11-08, the last entered key and the
profile's place on 2026-11-09, after the reviews of [#101].

---

## 7.  Trust

(See also [#97], [#98], [#99].)

**Decision**.  What discovery finds, a package's `agda` or a dev shell, is
run only for a trusted flake: one at or below a directory the user lists,
or a working tree git lists for a repository the user lists.  `--choose
trust:DIR` and `--choose trust-repository:[GITDIR]` list one, a choice or
the host's attribute is consent for its project, and evaluating or
building a flake needs none.

+  **Why**: both run the flake's code as the user, outside any sandbox: a
   package's `bin/agda` can be any program the flake builds, and a dev
   shell's hook runs on entry.  Discovery that ran either would run a
   just-cloned repository's code when an editor merely opened one of its
   files.  direnv asks for `direnv allow` before it loads a directory's
   environment, for the same reason.
+  **The trust file**: `${XDG_CONFIG_HOME:-~/.config}/agda-for-project/trusted`,
   `~/` for the home directory, `#` for a comment, with two kinds of line.
   A directory trusts every flake whose directory, with symlinks resolved,
   is at or below it; a user who keeps their own checkouts under `~/git`
   lists that line once.  `repository GITDIR` trusts every working tree
   that `git worktree list` gives for the repository whose common git
   directory is `GITDIR` (§ 9), now and later, and never a directory whose
   `.git` file merely names that git directory, nor one inside it.
+  **Granting it**: `--choose trust:DIR`, or `--choose
   trust-repository:GITDIR` (with no `GITDIR`, the project's own
   repository; a worktree's git directory names its repository too),
   appends the line to the trust file after a dated comment and forgets
   the project's choice, so that discovery decides.  `--candidates` offers
   one of them first, of kind `trust`, whenever trusting the flake would
   decide something: in a checkout git lists, its repository, so that one
   pick covers every worktree; elsewhere, the flake's directory.  A chooser
   that lists the candidates and passes the picked ID to `--choose` (both
   [#98]'s and [#99]'s do) offers it with no change of its own.
+  **Untrusted**: the launcher evaluates the flake (to say what trusting it
   would run) and stops, exit 69, with a line naming the three ways to
   allow it: the trust the chooser offers first, `--choose trust:DIR` for
   a whole directory, or `--choose package:NAME` (or `devshell:NAME`) for
   the project alone.
   `--explain --json` says `"reason": "untrusted"`, with `method` and
   `name` naming what would run.
+  **Evaluating and building need no consent**: the evaluation is pure,
   and the build runs as Nix's build users, in Nix's sandbox where the
   platform has one (Linux by default), exactly as a `nix build` by hand
   would.

**Evidence**.  On 2026-11-07 agda-lattices, untrusted, stops with that
line; with `~/git/ualib` in the trust file it resolves to its dev shell's
Agda 2.9.0 (2.4 s on the first call) and a module checks, exit 0.  The
second review of [#101] (2026-11-09) found a package's `agda` run with no
consent: under the stub `nix`, with no trust file, a flake's one
environment was built and run, on a plain start and by `--explain`'s
version probe, while the same flake's dev shell was refused.  On
formal-ledger-specifications master the same day, untrusted, the launcher
refused in 0.77 s (evaluated, nothing built) with `reason`
`untrusted` and `trust:<checkout>` as the first candidate; after `--choose
trust:$HOME/git`, it built (3.3 s, every store path present) and ran Agda
2.8.0, and five warm starts took 0.18 s to 0.23 s ([the record of
2026-11-09][record-11-09], `trust`).  Tests: untrusted, no
shell is entered and no package built or run; a sibling directory whose
name is a prefix (`proj` beside `project`) and a subdirectory do not cover
a flake; a choice covers its project alone; `--choose trust:` covers every
flake below its directory, keeps a last line with no newline intact, and
forgets the project's choice; trust is offered only where it decides
something and not once given; `~/` and a symlinked directory resolve.
Seven mutations are caught: the shell entered without trust, trust by
string prefix, discovery run without trust, trust offered to a trusted
flake, trust offered where it decides nothing, `--choose trust:` keeping
the choice, and the missing newline.

Trust of a directory was the only kind at first, and the chooser offered
the flake's own, so a user of worktrees would have been asked once per
worktree (formal-ledger-specifications' repository lists 46).  On
2026-11-09, on its master checkout, `--candidates` offered
`trust-repository:<master>/.git` first; after `--choose trust-repository:`
there, a worktree never opened before was decided by discovery with no
question ([the record of 2026-11-09][record-11-09], `repositoryTrust`).
Tests: a repository trusted from a subdirectory covers a worktree made
afterward, and not another repository, a planted `.git` file naming it, or
a flake inside its git directory; named by a worktree's git directory, it
is already trusted.  Five more mutations are caught: repository trust
without git's list, repository lines ignored, repository lines read as
directories, the chooser offering the directory in a listed checkout, and
a `GITDIR` not taken to its common directory.

**Status**.  Adopted for dev shells (2026-11-07, [#97]), and for every
answer of discovery on 2026-11-09, after the second review of [#101]; the
repository's line the same day.  It changes Milestone 9's exit criterion:
"no setting touched" becomes one line in the trust file (`--choose
trust:$HOME/git`, for every project under it at once), or one pick of the
chooser's first entry per repository; William decides which the criterion
should say.  The choosers of [#98] and [#99] offer the choice,
and now trust; each may give the `trust` kind a label of its own.

---

## 8.  The project's own libraries

(See also [#97].)

**Decision**.  When the project's `.agda-lib` depends on a library its
environment does not register, the launcher passes a second libraries file:
the environment's entries and the checkout's tracked `.agda-lib` files that
provide the missing names, followed transitively.

+  **Why**: an environment cannot hold the project's own library (Agda
   would find it twice), and formal-ledger-test depends on formal-ledger,
   a sibling library of the same checkout.
+  **Names without their version**, as Agda matches a dependency
   `standard-library` to a library named `standard-library-2.3`.
+  **A name found nowhere** is left for Agda to report, and `--explain`
   lists it under `libraries.missing`.
+  **Passed after the environment's own** `--library-file`, which the later
   one overrides; the file is named by its contents, so it is written once.
+  **A dev shell's `agda` keeps the registry its hook wrote**.

**Evidence**.  On 2026-11-07 a formal-ledger-test module exits 42 with
`Library 'formal-ledger' not found` under the environment alone, and 0
through the launcher (10.6 s, no module type-checked again); the test of
two sibling libraries, one depending on the other, and a missing one.

**Status**.  Adopted (2026-11-07, [#97]).

---

## 9.  Choices

(See also [#97], [#98], [#99].)

**Decision**.  A choice is remembered per project, keyed by its repository
and its directory within it, in the user's state directory, never in the
checkout.

+  **The repository** is its common git directory, which every worktree
   shares, so one choice serves every worktree of a project; outside git,
   the project's path.
+  **Only for a working tree git lists** (`git worktree list`, the main
   one and the linked ones): a `.git` file can name any git directory, so
   a directory unpacked with one naming a repository of the user's would
   report that repository as its own and inherit its choices, which are
   consent to run code (§ 7).  Any other checkout is keyed by its own
   path; a submodule's is among them, since git lists its git directory,
   not its checkout, and loses nothing, its git directory being its
   superproject checkout's alone.
+  **The IDs**: `package:NAME` (a flake attribute, built from each
   checkout's own lock), `devshell:NAME`, and `path:FILE` (an executable,
   for a project with no flake, kept as an absolute path, since a host may
   start from any directory of the project); `--forget` removes it.
+  **Below the host's attribute and above discovery** (§ 3): a choice is
   the user's, and a registration's attribute is the host's configuration.

**Evidence**.  Tests: a choice made in one worktree is seen from another,
and forgotten from either; the mutation that keys choices by worktree is
caught.  On agda-algebras, a choice of `devshell:default` made in master
was seen from a sibling worktree.  On 2026-11-09, while answering the
second review of [#101], a directory with its own flake and a `.git` file
of `gitdir: <my checkout>/.git` (under the stub `nix`, no trust file)
inherited my checkout's `devshell:default` and had its own dev shell
entered.  Now it is refused as untrusted, with no choice; a test covers
that file and one naming a worktree's git directory, and fails against
the launcher before and under the mutation that drops the check.  The
check costs about 0.01 s a start on formal-ledger-specifications master,
whose repository lists 46 working trees ([the record of
2026-11-09][record-11-09], `choicesListed`).

**Status**.  Adopted (2026-11-07, [#97]); shared only among the trees git
lists since 2026-11-09.  The choosers are [#98]'s and [#99]'s.

---

## 10.  Answers without running Agda

(See also [#98], [#99].)

**Decision**.  The launcher answers a host's questions with options that
run no Agda, in JSON a host can read; these are the interface [#98] and
[#99] build on.

+  `--explain [--json] [--no-build] [FILE]`: the project, the flake, how
   the Agda was decided (`decidedBy`: `attribute`, `choice` or
   `discovered`), `method` and `name`, the `program` with its `args` and
   `env`, its `version`, whether this call `built` it (`yes`, `no`, or
   `missing` under `--no-build`), the `libraries` (`environment`, `file`,
   `local`, `missing`), and the `choice`.  It builds first unless
   `--no-build`.  With `--json` it prints one object also when nothing is
   decided (`"decided": false`, with the line in `error`), and exits 69.
+  **`reason`**, in that object: `untrusted` (trusting the flake would let
   discovery's answer, in `method` and `name`, run), `undecided` (a choice
   would settle it: several environments and no `default`, no Agda found,
   no flake, a chosen Agda that is gone), or `failed` (an evaluation or a
   build, no lock, no `nix`); `null` when an Agda is decided.  A host then
   offers the chooser for the first two and starts nothing for the third,
   without reading the line.
+  `--candidates [--json] [FILE]`: an array of `{id, kind, version, label,
   chosen}`, where `kind` is `trust` (§ 7), `package`, `devshell`, `built`
   (an Agda this program built for any project) or `PATH`; versions are
   given where they are known without building.
+  `--choose ID [FILE]`, where `ID` is `package:NAME`, `devshell:NAME`,
   `path:FILE`, `trust:DIR` or `trust-repository:[GITDIR]`, and `--forget
   [FILE]`.
+  **Exit status**: 0, or Agda's own in the exec path; 69 when no Agda can
   be run (nothing decided, an untrusted flake, a failed evaluation or
   build, no lock, no `bin/agda`, no `nix`, or an attribute named with no
   `nix` to build it), after one line on stderr; 64 for a malformed
   command line.

**Evidence**.  Tests of each field and each refusal; the acceptance run
used `--explain --json` throughout ([the record][record], `explain`).
`reason` answers [#97]'s report of 2026-11-09 from the Emacs package,
which had matched `--choose` in the line.  The second review of [#101]
found an attribute named by the host passed over when `nix` was missing,
and a remembered `path:` choice run in its place (exit 0); now it is
refused, and a test and a mutation cover it.

**Status**.  Adopted (2026-11-07, [#97]); `reason`, the `trust` kind,
`trust:DIR` and `trust-repository:[GITDIR]` added on 2026-11-09.  A change
to these fields is announced on [#98] and [#99].

---

## 11.  Decision log

| # | Decision | Status | Evidence |
|---|---|---|---|
| 1 | One program, `agda-for-project`, named by every host in place of `agda`; bash, packaged by the flake; nothing but Agda on stdout; one line on stderr before a first evaluation or build | Adopted ([#97], 2026-11-07; the line 2026-11-09, [#101]) | Two controls fail, the launcher passes; 0.20 s per warm start; first byte at 0.0 s, not 4.2 s (§ 1) |
| 2 | The project is the nearest `.agda-lib`, past a nested repository's `.git` as Agda's search goes; the flake the nearest `flake.nix` within the repository; the start is the working directory, `AGDA_FOR_PROJECT_DIR`, or a `FILE` | Adopted ([#97]) | Tests; formal-ledger-test resolves to its checkout's flake; Agda 2.8.0 reads the outer `.agda-lib` (§ 2) |
| 3 | Order: the host's attribute, a choice, the one environment, the default dev shell's own `agda` (these two for a trusted flake), else nothing (exit 69) | Adopted ([#97]) | Probes on three projects (§ 3) |
| 4 | An environment is a `default` or `agda`-named package whose `pname` is `agdaWithPackages`; several decide only by `default` | Adopted ([#97]) | formal-ledger-specifications' four `agda` names; a mutation caught (§ 4) |
| 5 | agda-for-flake.sh's key with the system added, one system for every `nix` call, and the build under a lock; only a tracked `flake.lock`, checked before any evaluation; discovery cached under the key; dev shells per checkout | Adopted ([#97]; system and lock 2026-11-08, [#101]) | Two locks, two environments; tests (§ 5) |
| 6 | A dev shell entered once per key and checkout, and again when another key's was entered there since; its profile made where it stays; its own `agda`, in the store or the checkout, not the caller's even through links; recorded absolute; `AGDA_DIR` only if changed | Adopted ([#97]; links and absolute paths 2026-11-08, the last key and the profile 2026-11-09, [#101]) | Probes; four mutations caught; the root listed by `nix-store -q --roots`; tests (§ 6) |
| 7 | A second libraries file for sibling libraries, transitively, names without versions | Adopted ([#97]) | formal-ledger-test: 42 under the environment, 0 through the launcher (§ 8) |
| 8 | Choices per repository and project, in the state directory, shared only among the working trees git lists; a `path:` choice absolute | Adopted ([#97]; the listed trees 2026-11-09, [#101]) | Worktrees share; a planted `.git` file does not; two mutations caught (§ 9) |
| 9 | `--explain` (with `reason` when nothing is decided), `--candidates`, `--choose` (with `trust:DIR`), `--forget`; exit 69 and 64 | Adopted ([#97]; `reason` and `trust:` 2026-11-09, [#101]) | Tests; the acceptance run (§ 10) |
| 10 | What discovery finds, a package's `agda` or a dev shell, runs only under a trusted directory, in a listed worktree of a trusted repository, or by a choice; `--choose trust:DIR` and `trust-repository:[GITDIR]` grant trust, and `--candidates` offers it, the repository first | Adopted ([#97]; packages and repositories 2026-11-09, [#101]) | agda-lattices refused, then trusted and checked; formal-ledger-specifications refused, then trusted and run, a worktree with it; twelve mutations caught (§ 7) |

## References

+  Issues: [#96], [#97], [#98], [#99]; pull request [#101]; agda-native-air
   [#344][agda-native-air#344].
+  Documents: [the companion note][note]; [ADR 0003][adr-0003] § 13; [the
   record][record] of 2026-11-07 and [that of 2026-11-09][record-11-09].
+  Code: [`scripts/agda-for-project/agda-for-project.sh`][launcher], its
   [tests][tests] and their [stub `nix`][stub]; `packages.agda-for-project`
   in [`flake.nix`][flake]; `make agda-for-project-test`; the
   [workflow][workflow].

[#96]: https://github.com/formalverification/agda-native-ide/issues/96
[#97]: https://github.com/formalverification/agda-native-ide/issues/97
[#98]: https://github.com/formalverification/agda-native-ide/issues/98
[#99]: https://github.com/formalverification/agda-native-ide/issues/99
[#101]: https://github.com/formalverification/agda-native-ide/pull/101
[agda-native-air#344]: https://github.com/formalverification/agda-native-air/pull/344
[note]: ../notes/project-agda.md
[adr-0003]: 0003-the-shared-core.md
[record]: ../measurements/agda-for-project-2026-11-07.json
[record-11-09]: ../measurements/agda-for-project-2026-11-09.json
[launcher]: ../../scripts/agda-for-project/agda-for-project.sh
[tests]: ../../scripts/agda-for-project/test.mjs
[stub]: ../../scripts/agda-for-project/stub-nix.sh
[flake]: ../../flake.nix
[workflow]: ../../.github/workflows/agda-for-project.yml
