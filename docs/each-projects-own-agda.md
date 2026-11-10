<!-- File: docs/each-projects-own-agda.md -->

# Each project's own Agda

Open several Agda projects that depend on different Agdas and different
libraries, in VS Code or in Emacs, and check any file of any of them, with
no setting touched and no Agda switched by hand.  That is Milestone 9 of
[the plan](GITHUB_PROJECT.md), added on 2026-11-07, and this page says what
it builds, how, and what is done.

## The problem

An editor starts one Agda for every file it is given: agda2-mode in Emacs
runs the program `agda2-program-name` names, and agda-mode-vscode the last
entry of its `agdaMode.connection.paths`.  That works while every file you
open belongs to projects on the same Agda with the same libraries.  It
stops working the day you have two, and the errors read as broken code
rather than as the wrong Agda.  Both of the following were met on
2026-11-07 ([#97]):

+  A file of [formal-ledger-specifications] (Agda 2.8.0, five libraries),
   opened while the editor's Agda was [agda-algebras]' (Agda 2.9.0, the
   standard library alone):

        error: [LibraryError]
        Library 'standard-library-classes' not found.

+  A file of formal-ledger-specifications checked by an Agda built by hand
   from an earlier lock than the checkout's: `NotInScope` inside a
   dependency, because the checkout's lock had moved past the pin.

The usual fixes do not last.  A hand-built Agda matches one lock and goes
stale in silence when the lock moves; a table of projects in the editor's
configuration must be kept by hand for every checkout and every worktree;
and switching Agdas before each file is the chore this milestone ends.

## The idea

A project worth checking usually pins its Agda and its libraries already,
in a Nix flake whose `flake.lock` names every input by hash.  So the answer
to "which Agda for this file" is written down, and a program can read it.
The resolver, `agda-for-project`, is a program an editor runs where it
would run `agda`.  It finds the file's project and the project's flake,
decides which Agda the flake names, builds it the first time, and then
runs it with every argument the editor passed, so the editor cannot tell
it from `agda`.

<figure class="diagram">
<svg class="diagram" viewBox="0 0 720 650" role="img" aria-labelledby="resolver-title resolver-desc">
<title id="resolver-title">How agda-for-project decides which Agda runs a file</title>
<desc id="resolver-desc">From the file, the resolver finds its project and its flake, then tries four answers in order: an attribute the host names, a choice you remembered, the flake's one Agda environment, and a trusted dev shell with its own agda.  The first that answers is built once per key, given the checkout's sibling libraries if needed, and run with every argument.  If none answers, it exits 69 without running any Agda.</desc>
<defs>
<marker id="resolver-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head" d="M0,0 L10,5 L0,10 z"/></marker>
</defs>
<rect class="box" x="30" y="16" width="310" height="44" rx="6"/>
<text x="185" y="44" text-anchor="middle">A file the editor opens</text>
<rect class="box" x="30" y="92" width="310" height="52" rx="6"/>
<text x="185" y="114" text-anchor="middle">Its project:</text>
<text x="185" y="134" text-anchor="middle" class="small">the nearest .agda-lib at or above it</text>
<rect class="box" x="30" y="176" width="310" height="52" rx="6"/>
<text x="185" y="198" text-anchor="middle">Its flake:</text>
<text x="185" y="218" text-anchor="middle" class="small">the nearest flake.nix, in the same repository</text>
<rect class="box key" x="30" y="262" width="310" height="52" rx="6"/>
<text x="185" y="284" text-anchor="middle">1. An attribute the host names?</text>
<text x="185" y="304" text-anchor="middle" class="small">AGDA_FLAKE_ATTR, or --flake-attr</text>
<rect class="box key" x="30" y="346" width="310" height="52" rx="6"/>
<text x="185" y="368" text-anchor="middle">2. A choice you remembered?</text>
<text x="185" y="388" text-anchor="middle" class="small">--choose, kept outside the checkout</text>
<rect class="box key" x="30" y="430" width="310" height="52" rx="6"/>
<text x="185" y="452" text-anchor="middle">3. One Agda environment?</text>
<text x="185" y="472" text-anchor="middle" class="small">an agda.withPackages among the packages</text>
<rect class="box key" x="30" y="514" width="310" height="52" rx="6"/>
<text x="185" y="536" text-anchor="middle">4. A trusted dev shell?</text>
<text x="185" y="556" text-anchor="middle" class="small">one that puts its own agda on PATH</text>
<rect class="box stop" x="30" y="596" width="310" height="44" rx="6"/>
<text x="185" y="623" text-anchor="middle">Nothing decided: exit 69, no Agda</text>
<path class="edge" d="M185,60 V90" marker-end="url(#resolver-arrow)"/>
<path class="edge" d="M185,144 V174" marker-end="url(#resolver-arrow)"/>
<path class="edge" d="M185,228 V260" marker-end="url(#resolver-arrow)"/>
<path class="edge" d="M185,314 V344" marker-end="url(#resolver-arrow)"/>
<path class="edge" d="M185,398 V428" marker-end="url(#resolver-arrow)"/>
<path class="edge" d="M185,482 V512" marker-end="url(#resolver-arrow)"/>
<path class="edge" d="M185,566 V594" marker-end="url(#resolver-arrow)"/>
<text x="195" y="335" class="small">no</text>
<text x="195" y="419" class="small">no</text>
<text x="195" y="503" class="small">no</text>
<text x="195" y="586" class="small">no</text>
<path class="edge" d="M340,288 H385"/>
<path class="edge" d="M340,372 H385"/>
<path class="edge" d="M340,456 H385"/>
<path class="edge" d="M340,540 H385"/>
<path class="edge" d="M385,288 V540"/>
<path class="edge" d="M385,330 H418" marker-end="url(#resolver-arrow)"/>
<text x="350" y="281" class="small">yes</text>
<rect class="box" x="420" y="300" width="270" height="60" rx="6"/>
<text x="555" y="324" text-anchor="middle">Build it once per key</text>
<text x="555" y="344" text-anchor="middle" class="small">a hash of the files Nix reads</text>
<rect class="box" x="420" y="392" width="270" height="60" rx="6"/>
<text x="555" y="416" text-anchor="middle">Add sibling libraries</text>
<text x="555" y="436" text-anchor="middle" class="small">the checkout's own, if it needs them</text>
<rect class="box key" x="420" y="484" width="270" height="60" rx="6"/>
<text x="555" y="508" text-anchor="middle">Run that Agda</text>
<text x="555" y="528" text-anchor="middle" class="small">with every argument, unchanged</text>
<path class="edge" d="M555,360 V390" marker-end="url(#resolver-arrow)"/>
<path class="edge" d="M555,452 V482" marker-end="url(#resolver-arrow)"/>
</svg>
<figcaption>The resolver's discovery order: the first answer wins, and when
none answers it runs no Agda at all.  Drawn from the resolver's note in
<a href="https://github.com/formalverification/agda-native-ide/pull/101">#101</a>.</figcaption>
</figure>

## How it decides

+  **The project** is the directory of the nearest `.agda-lib` at or above
   the file, as Agda itself finds a file's library.  **The flake** is the
   nearest `flake.nix` at or above the project, without leaving its
   repository.
+  **An attribute the host names** wins: `AGDA_FLAKE_ATTR` in the
   environment, or `--flake-attr` first on the command line.  It is the
   interface of agda-native-air's launcher for `agda-mcp`, so a
   registration written for that launcher works here.
+  **A choice you made** for the project comes next.  `agda-for-project
   --candidates` lists what can run it (the flake's environments and dev
   shells, the Agdas already built on this machine, `agda` on PATH), and
   `--choose ID` remembers one, in your state directory and never in the
   checkout, for every worktree of the repository.
+  **The flake's one Agda environment**: a package named `default`, or with
   `agda` in its name, that is an `agda.withPackages`.  The resolver
   evaluates the candidates rather than trusting their names:
   formal-ledger-specifications has four packages with `agda` in the name,
   and one environment among them.
+  **The flake's default dev shell**, when entering it puts an `agda` of its
   own on PATH, as agda-algebras' downstream projects (such as
   [agda-lattices]) do, and you trust the flake.  Entering a dev shell runs
   the project's shell hook as you, so the resolver does it on its own only
   for a flake under a directory you list in
   `~/.config/agda-for-project/trusted`, or after you choose the dev shell
   for that project.
+  **Otherwise nothing is decided**: the resolver says so on one line and
   exits 69 without running any Agda.  It never runs some other Agda
   instead.

The environment is tried before the dev shell because evaluating a package
runs nothing and builds only Agda and its libraries, while entering a dev
shell runs the project's hook and builds every tool its developers use.

## Building once, and only when it matters

The first time a project's Agda is needed, the resolver builds it with
`nix build` (usually a download from a cache) and keeps the result under
`~/.cache/agda-for-project/`.  Later starts reuse it until the key
changes: a hash of every file of the checkout that Nix reads, which is
every tracked file except Agda sources.  So a moved lock or an edited
`flake.nix` gets its own build, and editing proofs never triggers one;
worktrees on the same lock share a build, and a worktree on another lock
gets its own.

An Agda environment cannot contain the project's own library, and a
project may depend on another library in the same checkout
(formal-ledger-specifications' test library depends on its main library).
When the project needs a library the environment does not provide, the
resolver writes a libraries file of the environment's entries and the
checkout's `.agda-lib` files that provide the missing names, and passes it
to Agda.

## In the editors

+  **Emacs** ([#98]): a package makes agda2-mode start each buffer's
   project's Agda through the resolver, restart it when you move to a
   buffer of another project, and accept the version the resolved Agda
   reports, so that Agda 2.8.0 and 2.9.0 both load under one agda2-mode.
   agda2-mode keeps one Agda process, so a switch of project restarts it,
   and the other buffer needs a load again.
+  **VS Code** ([#99], in [#102]): agda-mode-vscode and the companion's
   lanes run each project's Agda through the resolver.  agda-mode-vscode
   runs one Agda for the whole window, so the companion names the resolver
   as the mode's one path, tells it which project is active, and restarts
   the mode when the active file moves to a project on another Agda.  A
   status-bar item names the active project's Agda and how it was decided,
   and a quick pick offers the candidates when nothing decides.
+  **agda-mcp**, agda-native-air's tool server for agents, can name the
   resolver as its Agda, so an agent checks a file with the same Agda the
   editor does.

## What is done, and what is not

+  **The resolver** is written and tested, with its design record (ADR
   0004) and its note, in [#101], which is under review; the account above
   is drawn from that note and changes with it.  Its interface (the program
   in place of `agda`, exit 69, `--explain`, `--candidates` and `--choose`)
   is what the editors build on.
+  **VS Code's run is done, in [#102]**, which is under review: on
   2026-11-08, one VS Code window (1.141.0, with agda-mode-vscode 0.10.4)
   held agda-algebras and formal-ledger-specifications, with the resolver
   as the mode's one path and no setting changed.  A file of agda-algebras
   loaded under its flake's Agda 2.9.0; a file of
   formal-ledger-specifications under its Agda 2.8.0, after the mode
   restarted on the switch (8.6 s, a fresh Agda reading the project's
   interfaces); and agda-algebras again under 2.9.0.  The figures are the
   run's record, [`vscode-project-agda-2026-11-08.json`][vscode-run], on
   [#102]'s branch.  Its three screenshots are not on this page yet: the
   repository commits no binaries, and they wait for a home that is pinned
   by hash, as every file the site serves is.
+  **Emacs's run is not done yet**: one `emacs --batch` session loading
   files of formal-ledger-specifications (Agda 2.8.0), agda-algebras (Agda
   2.9.0) and agda-lattices (its dev shell's Agda) in turn, each under its
   own Agda, is [#98]'s acceptance run.  This section will show its
   transcript when it lands.

[#97]: https://github.com/formalverification/agda-native-ide/issues/97
[#98]: https://github.com/formalverification/agda-native-ide/issues/98
[#99]: https://github.com/formalverification/agda-native-ide/issues/99
[#101]: https://github.com/formalverification/agda-native-ide/pull/101
[#102]: https://github.com/formalverification/agda-native-ide/pull/102
[vscode-run]: https://github.com/formalverification/agda-native-ide/blob/99-m9-3-vs-code/docs/measurements/vscode-project-agda-2026-11-08.json
[formal-ledger-specifications]: https://github.com/IntersectMBO/formal-ledger-specifications
[agda-algebras]: https://github.com/ualib/agda-algebras
[agda-lattices]: https://github.com/ualib/agda-lattices
