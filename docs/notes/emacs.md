<!-- File: docs/notes/emacs.md -->

# Emacs: each project's own Agda

This note explains `agda-for-project.el`, the Emacs package in `emacs/`
that makes agda2-mode check each buffer with its own project's Agda and
libraries ([#98]).  It is the Emacs side of `agda-for-project`, the
resolver that decides "which Agda, with which libraries, for this file"
for every host; [the resolver's note][project-agda] explains how it
decides, and [ADR 0004][adr-0004] records why.

## The problem

agda2-mode runs one Agda process for every buffer: the program
`agda2-program-name` names, read only when `agda2-restart` starts the
process.  The process then keeps the libraries of the project it was
started for, and a file of another project is checked against them.  Two
errors, both met on 2026-11-07, read as broken code rather than as the
wrong Agda:

+  A file of formal-ledger-specifications, opened while Emacs ran
   agda-algebras' Agda 2.9.0:

        error: [LibraryError] Library 'standard-library-classes' not found.

+  The same file, with a hand-built Agda 2.8.0 for formal-ledger-specifications
   whose libraries predate the checkout's lock:

        Extra.agda:127.25-26: error: [NotInScope] Not in scope: ∥

## What the package does

`agda-for-project-mode`, a global minor mode, puts advice around two
agda2-mode functions, as follows:

+  **Around `agda2-restart`** (every start of Agda, including the one
   agda2-mode makes when a file is opened), it asks the resolver which
   Agda the buffer's project pins, with `agda-for-project --explain --json
   --no-build FILE`, and binds `agda2-program-name`, `agda2-program-args`
   and `process-environment` to the program, the arguments and the
   environment of the answer.  It also binds `agda2-version` to the
   version that program reports, since agda2-mode refuses to start an
   Agda whose version differs from its own; so Agda 2.8.0 and 2.9.0 both
   start under one mode.  Everything is bound before anything runs the
   program, so agda2-mode's own version check, its dry run of the
   arguments and the process all run the same program the same way.
+  **Around `agda2-load`** (`C-c C-l`), it restarts Agda first when the
   buffer's project differs from the one the running process was started
   for, or when no process runs.

The buffer's project is its **root**: the directory of the nearest
`.agda-lib` at or above the file, or the file's own directory when there
is none.  That is the resolver's rule, and the rule Agda uses to find a
file's library; the package computes it itself, so that a load never
waits on Nix to learn whether to restart.  A file with no `.agda-lib` gets
a root of its own directory because Agda reads such a file in the project
of its working directory: a restart keyed only by repository would check
it in whatever project came before.

The package names no project.  Every file goes to the resolver, which
answers in one of four ways, as follows:

+  **An Agda, already built**: it starts.  A warm answer took 0.16 s on
   the machine measured.
+  **An Agda not built yet**: the echo area says that a build is starting
   and that Emacs waits for it; then the resolver builds it (once per
   change of the flake's inputs) and it starts.
+  **Nothing decided, and a choice would settle it** (a flake with several
   Agda environments and no default, a dev shell that is not trusted, a
   flake with no Agda at all): the package offers the resolver's
   candidates through `completing-read`, remembers the pick with the
   resolver's `--choose` (for every worktree of the project), and starts
   it.  A dev shell is offered with the words "entering it runs the
   project's shell hook", because choosing one is consent to run that
   project's code as you.
+  **A failure** (an evaluation or a build that failed, a flake with no
   lock): the package shows the resolver's one line and starts no Agda.
   It never runs some other Agda instead.

A file in no project with a flake, and with no choice remembered, gets
`agda-for-project-fallback`: by default `agda2-program-name` as you set
it, which is what agda2-mode would run without the package.

## Installing

The package needs the resolver on `exec-path`, or named by
`agda-for-project-program`.  With Nix:

    nix profile install github:formalverification/agda-native-ide#agda-for-project

or, to keep it as a gc root at a fixed path (which works whatever PATH
Emacs inherited):

    nix build github:formalverification/agda-native-ide#agda-for-project \
      -o ~/.cache/agda-for-project-bin

and then `(setq agda-for-project-program
(expand-file-name "~/.cache/agda-for-project-bin/bin/agda-for-project"))`.
Until [#101] is merged, the flake output exists only on its branch:
append `/97-m9-1-the-resolver` to the flake reference.

**Plain Emacs**, from a checkout of this repository:

```elisp
(use-package agda-for-project
  :load-path "~/git/formalverification/agda-native-ide/main/emacs"
  :config (agda-for-project-mode 1))
```

or, with Emacs 30's `:vc`, straight from GitHub:

```elisp
(use-package agda-for-project
  :vc (:url "https://github.com/formalverification/agda-native-ide"
       :lisp-dir "emacs" :rev :newest)
  :config (agda-for-project-mode 1))
```

**Doom Emacs**: in `packages.el`,

```elisp
(package! agda-for-project
  :recipe (:host github :repo "formalverification/agda-native-ide"
           :files ("emacs/agda-for-project.el")))
```

and in `config.el`,

```elisp
(agda-for-project-mode 1)
```

then `doom sync` and restart Emacs.  The mode command is autoloaded, so
the call loads the package.

Until [#98]'s pull request is merged, add `:branch "98-m9-2-emacs"` to the
recipe (or `:branch "98-m9-2-emacs"` to the `:vc` specification).  Both
installs were tested on 2026-11-08 from that branch, in scratch Emacs
directories under Emacs 29.3: the `:vc` specification through
`package-vc-install` (which Emacs 30's `use-package :vc` calls), and the
Doom recipe through Doom's own copy of straight.el, which `package!`
hands it to.  Enable the mode before the first Agda file is
opened, since agda2-mode starts Agda when it opens one.

A running Agda keeps the program it was started with; after installing,
restart Emacs, or Agda (`C-c C-x C-r`) in a buffer of the right project.

## Trusting dev shells

The resolver enters a flake's dev shell on its own only when the flake
lies under a directory listed in `~/.config/agda-for-project/trusted`,
one per line (see [the resolver's note][project-agda], "Trusting dev
shells").  agda-algebras' downstream projects (agda-lattices, for one)
give their Agda through the dev shell, so either list their parent
directory there, or answer the chooser once per project with
`devshell:default`.

## Commands

+  `agda-for-project-explain` shows how the resolver answers for the
   current buffer (the project, the flake, how the Agda was decided, the
   program, its version and libraries), and which root the running Agda
   was started for.  It only looks; with a prefix argument it builds
   first.
+  `agda-for-project-choose` offers the candidates for the buffer's
   project and remembers the pick, then restarts Agda if it runs for this
   project.  Use it to give a project another Agda than discovery finds:
   agda-algebras' dev shell, for one, instead of its package.
+  `agda-for-project-forget` forgets the project's choice.

The package binds no keys.  `C-c C-x C-t` is free in agda2-mode-map:

```elisp
(with-eval-after-load 'agda2-mode
  (define-key agda2-mode-map (kbd "C-c C-x C-t") #'agda-for-project-choose))
```

## Options

+  `agda-for-project-program`: the resolver, by name on `exec-path` (the
   default, `agda-for-project`) or as a path.
+  `agda-for-project-fallback`: the Agda for a file in no project with a
   flake, and with no choice: `nil` (the default) for
   `agda2-program-name` and `agda2-program-args`; a string for another
   program; or `ask`, to offer the candidates as for a project whose flake
   decides nothing, and remember the pick for that directory.

## A session

One Emacs, five files in turn, each loaded with `C-c C-l`, on
2026-11-08 (an Intel Core i9-12900H with 62 GiB, Linux, Nix 2.34.8, GNU
Emacs 29.3 with Doom's agda2-mode, which reports 2.9.0).  The resolver's
cache was already warm; "registry" is the libraries file the running Agda
was given, read from the process.

| File | Agda | Registry | Resolved | Load |
|---|---|---|---|---|
| fls `master`, `Axiom/Set/Map/Extra.agda` | 2.8.0 | `6qscaqml…-libraries` | 0.18 s | 9.0 s |
| fls worktree on the older lock, same file | 2.8.0 | `xza7nddh…-libraries` | 0.22 s | 9.4 s |
| agda-algebras, `Setoid/Operations.lagda.md` | 2.9.0 | `v81rfymb…-libraries` | 0.19 s | 1.0 s |
| agda-lattices, `Lattices/Bounded/Covers.lagda.md` | 2.9.0 | its dev shell's `.agda/libraries` | 0.07 s | 2.3 s |
| fls `master`, `Axiom/Set/Map/Extra.agda` again | 2.8.0 | `6qscaqml…-libraries` | 0.18 s | 9.8 s |

Every load ended `*All Done*`; the session took 42 s.  "Resolved" is the
resolver's answer for the start; "Load" runs from `C-c C-l` to Agda's
verdict and includes the restart (the first file's start came when it was
opened).  With an empty cache, the first resolution of each project took
2.4 to 4.7 s (linking a root, with every store path already present);
agda-lattices went through the chooser once, since its dev shell was not
trusted, and was remembered.  The same fls file under the configuration
this package replaced, which ran agda-algebras' Agda for every file of no
recognized checkout, fails at once: `Library 'standard-library-classes'
not found`.  A project whose Agda was not in the store at all (a scratch
flake on nixos-25.05, Agda 2.7.0.1) waited 327 s for the resolver's
download and build, then started and checked.

To reproduce, with the resolver built (`nix build .#agda-for-project`)
and the paths changed to files of your own projects:

    H=~/.claude/skills/testing-agda-mode-in-batch-emacs/agda-mode-harness.el
    AGDA_FOR_PROJECT=$PWD/result/bin/agda-for-project \
    CONFIG=emacs/test/batch-probe.el CONFIG_UNDER_TEST=emacs/test/batch-config.el \
      emacs --batch -Q -l $H FILE...

The harness belongs to the testing-agda-mode-in-batch-emacs skill; it
opens each file, loads it through agda2-mode and prints Agda's verdict, and
`batch-probe.el` adds what the running process is.  The logs and the
record of every run are in
[`docs/measurements/emacs-2026-11-08/`][runs] and [its record][record].

## Limits

+  **One Agda per Emacs.**  agda2-mode keeps one process, so moving to a
   buffer of another project and loading it restarts Agda, and the first
   buffer needs `C-c C-l` again when you come back to it.
+  **A first build blocks Emacs.**  The resolver's build runs while
   agda2-mode waits for the program to start, and nothing but the echo
   area's line shows it: 327 s for a project whose Agda had to be
   downloaded.  A build that fails is tried again at every start, and each
   try costs its full time before the failure (about 9 minutes, in the
   case met).  Build a new lock's Agda from a shell first:
   `agda-for-project --explain FILE`.
+  **`C-c C-=` fails on Agda 2.8.0 under a 2.9.0 agda2-mode.**  The mode
   of Agda 2.9.0 sends `Cmd_constraints` with a normalization argument,
   which Agda 2.8.0 does not read: `cannot read: IOTCM "…" NonInteractive
   Indirect ( Cmd_constraints Simplified )`.  It is the only command found
   whose form differs; the loads and highlighting of these runs worked
   under 2.7.0.1, 2.8.0 and 2.9.0 alike.
+  **Opening a file never asks.**  agda2-mode starts Agda when it opens a
   file, and a question or an error there would interrupt the open (a
   quit aborts `find-file`).  So a start made while a file opens only says
   what is missing, in the echo area, and starts nothing; the next
   `C-c C-l` asks, or fails with the resolver's line.
+  **`C-c C-x C-s`** (agda2-mode's "switch to another version of Agda")
   sets `agda2-program-name`, which the mode now uses only for files in no
   project with a flake.

[#98]: https://github.com/formalverification/agda-native-ide/issues/98
[#101]: https://github.com/formalverification/agda-native-ide/pull/101
[adr-0004]: ../adr/0004-each-projects-own-agda.md
[project-agda]: project-agda.md
[record]: ../measurements/emacs-2026-11-08.json
[runs]: ../measurements/emacs-2026-11-08/
