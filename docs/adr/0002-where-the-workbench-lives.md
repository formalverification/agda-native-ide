<!-- File: docs/adr/0002-where-the-workbench-lives.md -->

# ADR 0002: where the workbench lives

File: `agda-native-ide/docs/adr/0002-where-the-workbench-lives.md`

+  **Status**: Accepted when the pull request that adds it merges.  The
   decisions are William's of 2026-10-05, adopted in the plan by merging PR
   [#75] (2026-10-06); none is built yet.  Isolation (§ 6) was proposed
   pending [#59], and adopted on 2026-10-08 ([ADR 0001][adr-0001] § 8);
   § 7 records what is deliberately left open.
+  **Date**: 2026-10-06 (the decision 2026-10-05).
+  **Tracking**: [#60] (this record); [#58] (Agda 2.9.0), [#59] (the reactor
   and the drive), [#61] (the library under 2.9.0), [#62] (the shared core);
   Milestone 7, the VS Code companion ([#63] to [#70]); Milestone 8, Emacs
   ([#71] to [#74]).
+  **Ancestry**: the [proposal] this project follows (agda-native-air's browser
   IDE proposal, carried here by [#56]); [ADR 0001][adr-0001], the runtime; the
   platform brief of 2026-10-05, "Where the Agda Workbench Lives", carried here
   as the companion note [`docs/notes/platform-brief-2026-10-05.md`][note]; the
   plan revision, PR [#75], and its corrections, PR [#76].

## Executive summary

The workbench is a place where a person and an AI model work on the same Agda
development: Agda checks, the model proposes, and two views draw the
development as diagrams.  This record decides where it lives: on three
platforms, each with its own job, sharing one core.  (The terms in bold below
are defined in the list that follows this summary.)

+  **In a browser tab** it is the reader's playground: the page a documentation
   site's "Playground" link opens, with nothing to install, and the first home
   of the two views (a development drawn as a graph of definitions, and one
   proof drawn as a natural-deduction derivation).
+  **In VS Code** it is the author's workbench: a companion extension beside
   agda-mode-vscode (the existing Agda mode for VS Code), running native Agda
   on the author's own checkout, with the views in a webview (a web page inside
   the editor) and the **agents** the author already runs.
+  **In Emacs** it is the agent half (the tools through which an agent works in
   Agda) and a picker over the **corpus**, beside agda2-mode (Agda's own Emacs
   mode), and nothing more: Emacs cannot draw the views and cannot reach a
   reader.
+  **The core** the three share is four TypeScript packages: the **engine
   client**, the **tool surface**, the views and the **plugin manifest**.  They
   are written against one interface to Agda with two implementations: Agda
   compiled to **WebAssembly** and run in the page, and native Agda processes
   beside the editor.
+  **The Agda** of the page becomes 2.9.0, built by this project from Agda's
   own sources, and the libraries the page ships are carried to it.  In the
   editors, the native engine runs whatever Agda the author's project pins.

Why it is shaped this way: the reader and the author are different people with
different machines.  Only a browser reaches a reader who has installed nothing.
For an author with a checkout, native Agda checks a large agda-algebras
**import closure** in 5.1 s where the page takes 11 to 22 s even after its
planned fix, and needs no **interfaces** downloaded (54 MB gzipped per reader
in the page, against 15.6 MB for the whole of the fork's first visit today).
And the agents that prove things through Agda already reach it natively: every
one of them starts or connects to a local process, and a web page can neither
be started by an agent nor listen for one.  The three things the [proposal]
adds (the tool surface, the views, the plugin model) are platform-neutral if
they are written as packages, so a second and a third host should cost less
than a second and a third IDE, an argument [#62] will test.  And Agda 2.9.0 is
the first release whose WebAssembly build needs no patch, so the page's
compiler can be built from Agda's own maintained sources instead of a
one-person patched fork; that buys provenance and upkeep, and, as measured
since, a smaller download (the HSP closure's interfaces are 41.7 MB under
2.9.0, against 54.3 MB gzipped under 2.8.0); § 4 weighs it against its risks.

Where it stands: the plan carries all of it (PR [#75]), and none of it is
built.  The page still runs **the fork**'s patched Agda 2.8.0, and so still
needs **cross-origin isolation**.  The riskiest decision is the Agda version
(§ 4): on 2026-10-06, 2.9.0 is unreleased, the language server has no 2.9
target, Agda's own WebAssembly workflow last passed in full on 2026-09-06, and
no released standard library checks under 2.9.0, though agda-algebras does with
standard-library 2.3 patched by three upstream commits ([#61]'s findings of
2026-10-06).

Where it goes: the compiler ([#58]), the library ([#61]), the **reactor** and
**the drive** ([#59]), the shared core ([#62]), then Milestones 7 and 8; and
three questions this record leaves open on purpose (§ 7).

### Terms

The record assumes a reader who knows Agda and agda-mode and not this codebase.

+  **The fork**: [plfa-playground], the browser Agda IDE this repository forks
   ([ADR 0001][adr-0001]).  It runs the Agda Language Server (below) in the
   page.
+  **agda-native-air**: this project's sibling research repository, which built
   `agda-mcp`, the corpora and a benchmark of 55 proofs that the plan reuses.
+  **Agent**: an AI model that acts through tools rather than only answering:
   it reads a goal, proposes a term, asks Agda, and tries again.  Claude Code,
   Copilot's agent mode and Cline are agents that run beside an editor.
+  **MCP**, the Model Context Protocol: how an agent discovers and calls a tool
   server, over the server's standard input and output (the agent starts the
   server as a subprocess) or over HTTP (the server listens on a port).
   **`agda-mcp`** is agda-native-air's MCP server over Agda.
+  **Tool surface, tool contract, verdict**: the tool surface is the set of
   operations an agent may call on Agda (check a file, show a goal, try a term
   in a hole, search the library).  The tool contract is the rule every answer
   follows, from `agda-mcp` ([agda-native-air ADR 0002][air-adr-0002]): a
   verdict, the judgment that a file checks, is Agda's exit code and never a
   reading of its messages; every answer names the project (the directory tree
   and library) it checked; and an answer from the interaction lane (below)
   carries no verdict.  A model's suggestion is a candidate until Agda says
   otherwise.
+  **Lane**: one of the two ways `agda-mcp` runs Agda.  The **interaction
   lane** is a long-lived interactive Agda that answers questions about a
   loaded file in milliseconds and tolerates open holes; the **batch lane** is
   a fresh `agda` per check whose exit code (0, or 42 for a type error or an
   open hole) is the verdict.
+  **Corpus**: an exported dataset of a library, one row per definition with
   its type, its dependencies and its text, from which the views are drawn and
   the search tools answer.
+  **Plugin manifest**: the file that says what a plugin (a library, a corpus,
   a model, a tool) is, what it is pinned to, what it unpacks into the page,
   and what it costs in bytes.
+  **Engine client**: the package that speaks Agda's interaction protocol for
   the other three.
+  **Interaction protocol**: Agda's editor command language, one `IOTCM`
   command per line on standard input (`Cmd_load`, `Cmd_give`, `Cmd_refine`,
   `Cmd_make_case`, and so on), the one agda-mode in Emacs sends.
+  **Interface**: a `.agdai` file, the checked result of one module.  Agda
   accepts it on a later load only if the same Agda built it from the same
   source under the same options against imports with the same hashes;
   otherwise it silently checks the module again.  So the interfaces a browser
   reader downloads must be built by the Agda the page ships.
+  **Import closure**: every module a module transitively imports, and so every
   interface a check of it must read.  "The HSP closure" below is that of a
   `Main` importing agda-algebras' `Setoid.Varieties.HSP` (its module for
   Birkhoff's HSP theorem): 314 modules.
+  **Archive, root**: the page downloads a library's sources and interfaces as
   zip archives and unpacks ("mounts") them into the drive; a root is a module
   a reader opens, such as a `Main.agda` that imports `Setoid.Varieties.HSP`.
   The builtins are Agda's own `Agda.Builtin` modules, shipped the same way.
+  **WebAssembly** (wasm): a portable binary format that browsers execute;
   **WASI**, the WebAssembly System Interface, is the POSIX-like set of imports
   (files, standard streams, clocks) through which a WebAssembly program
   reaches the outside world.  GHC compiles Haskell, and so Agda, to
   `wasm32-wasi`.
+  **Worker, the drive**: a worker is a background thread of a web page.  The
   drive is the fork's in-memory filesystem, which holds what Agda reads and
   writes, in a worker of its own.
+  **Cross-origin isolation**: a page served with two response headers,
   `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp`.  Browsers give
   `SharedArrayBuffer` (memory shared between threads, on which a blocked
   thread can wait) only to such a page.  The fork needs it because GHC's
   runtime blocks while it waits for input and for files, and a page's main
   thread cannot block: so Agda runs in a worker that waits on memory it shares
   with the page and with the drive.
+  **Service worker, CORS**: a service worker is a script a page installs that
   can intercept its requests; the fork uses one to add the two headers on a
   host that cannot send them.  CORS is the set of headers by which a server
   lets another site's page fetch from it; under `require-corp`, every fetch
   from another site needs them.
+  **Reactor**: a WebAssembly module built to be called rather than run: it
   initializes once and exports functions the host calls (for the language
   server, create a server, send it a message, receive one), instead of running
   a `main` that blocks reading standard input.
+  **LSP**, the Language Server Protocol: the JSON protocol by which an editor
   asks a separate process for hovers and diagnostics.  The **Agda Language
   Server** (ALS) is Agda with an LSP front end; Agda's own commands ride
   inside one custom LSP request named `agda`.
+  **LM tools**: VS Code's own API for tools that an agent calls from inside
   the editor; only Copilot's agent mode calls them.

---

## 1.  Context: the question, and the brief that answered it

The [proposal] that started this project (2026-09-23) described an Agda
workbench in a browser tab: Agda loaded by default and everything else a
plugin, a tool surface on which a model works under `agda-mcp`'s contract, and
two views generated from the checked source.  The plan assumed the browser and
forked [plfa-playground] for it ([ADR 0001][adr-0001]).

On 2026-10-05, before Milestone 1 started, a platform brief asked whether that
IDE would be better built as a VS Code extension, or in Emacs, or both, and
answered from the infrastructure up: what each platform gives for free, what it
makes expensive, and whom it serves, with two native measurements made for it.
It recommended "both, with different jobs, sharing one core": the browser as
the playground a documentation site links to, VS Code for the author with a
checkout, the new things as platform-neutral packages, and nothing built for
Emacs.  William decided the same day to go further: all three platforms,
sharing one core, on Agda 2.9.0, with a small Emacs milestone.  PR [#75]
revised the plan to match, and PR [#76] corrected it, both merged on
2026-10-06.

The brief is carried into this repository as
[`docs/notes/platform-brief-2026-10-05.md`][note], with its matrix, its numbers
and its sources, and with what changed or was found wrong after it corrected in
place, each correction dated.  The note explains; this record decides.

---

## 2.  The three platforms and their jobs

(See also [#60], Milestones 7 and 8, and [the note][note]'s "Side by side".)

**Decision**.  The workbench targets three platforms with different jobs: the
browser for the reader, VS Code for the author, and Emacs for the agent half
and a corpus picker.

+  **The browser** (Milestones 0 to 6) is the reader's playground and the
   views' first host.  The agda-algebras site's "Playground" link opens it in a
   new tab (Milestone 1, the agda-algebras IDE); plugins, the in-page tool
   surface and the views follow.  The views are drawn in the page first because
   the page is where the data already loads.
+  **VS Code** (Milestone 7, [#63] to [#70]) is the author's workbench: a
   companion extension beside agda-mode-vscode, in the shape Paperproof (a VS
   Code extension that draws Lean proof trees in a webview) takes beside Lean's
   extension, with the views in a webview, the tool surface over native Agda
   ([#64]), the tool contract registered for the agents already there ([#65]),
   and corpus and full-text search.  It drives agda-mode-vscode through its
   commands ([#63]) until upstream exports a client ([#69]).
+  **Emacs** (Milestone 8, [#71] to [#74]) gets the agent half and a picker:
   agda2-mode's commands registered as agent tools through claude-code-ide.el,
   a package that runs an MCP server inside Emacs for Claude Code ([#71]);
   `agda-mcp` reached from inside Emacs through gptel or ellama, Emacs's
   clients for language models, which can call MCP tools ([#72]); and the
   corpus as a `completing-read` picker ([#73]).  The views are only an
   experiment there ([#74]).
+  **The Emacs milestone is William's decision beyond the brief**.  The brief
   recommended building nothing for Emacs: "Emacs needs nothing built: agda-mcp
   and the claude-code-ide.el pattern serve it, and it cannot draw the diagrams
   anyway"; for the people already in Emacs, "the agent half is a weekend's
   work on top of agda-mcp, and nothing in this project needs to be built for
   it".  That argument is the evidence this decision overrides, and it is
   recorded here so that it can be weighed again.  The decision was written
   down without a reason of its own; the brief names whom an Emacs front end
   would serve, "the people who already live in Emacs, William among them".
   The milestone is scoped to exactly what the brief found Emacs good at
   (agents, a picker) and measures what it found Emacs cannot do (the views);
   the plan's description says it "builds only what Emacs is good for and
   measures the rest".

**Evidence**.

+  **The reader**.  Only the browser reaches a reader with nothing installed.
   In the brief's matrix, that row is rated good for the browser page, fair for
   VS Code for the Web (a vscode.dev link, then two extension prompts), and
   poor for VS Code desktop and Emacs; every other rated row of the VS Code
   desktop column is good ([the note][note], "Side by side").
+  **Speed for an author**.  Native Agda 2.8.0 checked a `Main` importing
   `Setoid.Varieties.HSP` (314 modules, every interface accepted) in 5.10 to
   5.23 s at a peak resident memory of about 750 MiB, and one importing
   `Overture.Basic` in 0.67 to 0.69 s, three runs each on 2026-10-05 ([#60]'s
   findings).  The fork took 79 to 104 s and 13.6 to 18.5 s for the same
   imports, and 11 to 22 s and 1.8 to 3.7 s with a prototype index on its
   in-memory filesystem's lookups, in headless Chromium 153 on 2026-10-04
   ([#50]).  With the index, the page takes 2.1 to 4.3 times as long as native
   Agda on the HSP closure and 2.6 to 5.5 times on `Overture.Basic`.  Under
   Agda 2.9.0 the same native check took 2.09 to 2.11 s, against 5.90 to 6.22 s
   for the 2.8.0 binary in the same sitting ([#61]'s findings, 2026-10-06; the
   two binaries differ in build flags, so that ratio is the binaries', not the
   versions'); the page has not been measured under 2.9.0.  (The plan's summary
   says native Agda takes "a fifth of the time the page takes"; measured, it
   takes a quarter to a half.  Flagged on [#60].)
+  **Bytes**.  The HSP closure's interfaces are 63,719,275 bytes, 54,294,820
   gzipped, under 2.8.0 ([#60]), and 41,759,612 bytes under 2.9.0, which gzip
   shrinks by 0.1 % since they come compressed ([#61]): a download for every
   reader in the page, and already on disk for the author.
+  **Memory does not decide it**.  750 MiB is well under the 4 GiB a 32-bit
   WebAssembly memory can address, so memory does not rule the browser out for
   this library.
+  **What VS Code already has**.  agda-mode-vscode 0.10.4 (2026-10-05) is still
   the latest on 2026-10-06, with 19,552 installs and 77 commands, all three
   checked that day; by the brief's survey (2026-10-05), it downloads a
   prebuilt language server, has a web build, and exports no public API.
   agda-web's [PLFA fork][agda-web-plfa] type-checks PLFA (the textbook
   *Programming Language Foundations in Agda*) in VS Code for the Web with
   agda-mode-vscode and the ALS WASM Loader extension ([v0.8.5][als-loader]).
+  **What Emacs can and cannot do**.  It already has agent clients that speak
   MCP (gptel, ellama, through mcp.el) and a way to expose Elisp functions to
   Claude Code (claude-code-ide.el); it displays an SVG only as one image with
   clickable hot-spots, and its embedded WebKit widget depends on how Emacs was
   built ([the note][note], "Emacs: the reference implementation, and its
   ceiling"; the brief's survey, 2026-10-05).

**Status**.  Adopted in the plan (PR [#75], merged 2026-10-06): Milestones 7
and 8 exist with their issues, and the README describes all three platforms.
Nothing is built.  Open: everything in Milestones 7 and 8; the VS Code web
build and the Emacs view are § 7's.

---

## 3.  The shared core

(See also [#62], [#64], [#66], and [the note][note]'s "Could we do both?".)

**Decision**.  The engine client, the tool surface, the views and the plugin
manifest are TypeScript packages that every host imports, written against one
engine interface with two implementations: WebAssembly in the page's workers,
and native child processes in the editor.

+  **The engine client** speaks Agda's interaction protocol (the `IOTCM`
   commands; the schemas of Agda's responses, which the fork already checks
   with zod, a TypeScript schema library; and the give rule, which checks an
   edit inside one goal with `Cmd_give` instead of a full reload) behind one
   interface ([#62]).
+  **Its two implementations**, each with both lanes.  In the page: the
   language server in a worker as the interaction lane, reached over the fork's
   transport (rings of shared memory today, the reactor's functions after
   [#59]), and the plain `agda` compiled to WebAssembly, one process per check,
   as the batch lane ([#30]; until it lands, the page has no verdict of record,
   only the language server's answers, [ADR 0001][adr-0001] § 5).  In the
   editor: a native `agda --interaction-json` (or the native language server)
   per project root as the interaction lane, and a fresh native `agda` per
   verdict as the batch lane, both child processes of VS Code's extension host,
   the Node.js process in which extensions run ([#64]).
+  **The tool surface** (`agda-mcp`'s contract as functions with JSON schemas)
   and **the manifest** (what a plugin is, what it is pinned to, what it
   mounts, what it registers, what it costs) import only that interface; **the
   views** are components that import nothing from the page, so the VS Code
   webview hosts them unchanged, through a message protocol designed once for
   both hosts ([#66]).
+  **One test suite** runs against both implementations: the WebAssembly one in
   headless Chromium, the native one under node ([#62]).

**Evidence**.

+  **The fork already has half the seam**.  The part of its code that sends
   Agda's commands and routes Agda's answers (to the handlers for highlighting,
   goals, gives and case splits) is already behind an interface that knows
   nothing of WebAssembly: `ALSMessageRouter` in `src/lib/agda/transport.js`,
   an implementation of the LSP transport interface of CodeMirror, the fork's
   editor component.  The part that starts Agda is not: the page's controller
   (`src/lib/controller.svelte.ts`) downloads the compiler, starts both workers
   and owns the shared-memory rings.  (The brief said the controller "never
   touches the wasm"; read on 2026-10-06, it does, and the note records the
   correction.)  So a native implementation replaces the startup and the rings
   and keeps the command path; that refactoring is [#62].
+  **agda-mode-vscode made the same split from the other side**: its connection
   to the language server is "via pipe", "via TCP" or "via WASM", behind one
   interface (`src/Connection/`; the brief's survey, 2026-10-05).
+  **Views written once already run in several hosts**: Lean's ProofWidgets4
   renders the same widget in VS Code's infoview and in lean4web, and
   Paperproof draws its proof tree in a VS Code webview ([the note][note],
   "Diagrams: the precedents").
+  **Not measured**: the brief's claim that "both" costs "less than twice" one
   host is an argument, not a measurement.  [#62]'s acceptance (a workspace of
   packages; one suite passing against both implementations) is where it is
   first tested.

**Status**.  Adopted in the plan (PR [#75]); not built.  Open: [#62] (Milestone
3), then [#64] and [#66] (Milestone 7).  [#62] records the interface and what
each shell owns in an ADR of its own.

---

## 4.  Agda 2.9.0 as the compiler

(See also [#58], [#61], [#13], [#49], [#12], and [ADR 0001][adr-0001] § 3.)

**Decision**.  The page's compiler becomes Agda 2.9.0: this project's own build
of Agda and its language server for `wasm32-wasi`, from Agda's own Nix flake
with no patch from agda-web (the group whose patched Agda and language server
the fork runs), pinned to a commit of Agda's `nightly` prerelease (a build of
master that the tag `nightly` follows) and moved to the release when it lands
([#58]).

+  **The library comes with it**: agda-algebras and the standard library it
   depends on must check under the pinned 2.9.0 ([#61]), and the builtins and
   the library archives are rebuilt by it ([#49], [#12]), since an interface is
   accepted only from the Agda that built it.  That is why the version is one
   across the page and everything it downloads.
+  **The editors run the author's Agda**.  The companion's native engine
   resolves the Agda the author's project pins (a dev shell's wrapper, an
   `agda` on the path, or the language server agda-mode-vscode downloaded;
   [#64]).  agda-algebras pins 2.8.0 today, so its authors run 2.9.0 in the
   editor only once the library moves (agda-algebras issue [588][aa-588]);
   agda-mode-vscode's downloaded servers are built for 2.8.0 and older, and the
   companion's engine may use one but needs none.
+  **The 2.8.0 compiler stays buildable** until the 2.9.0 one passes [#13]'s
   gate: for every root, with only the archives it needs unpacked, the page's
   Agda must accept every imported interface and type-check the root alone, or
   the build fails ([#58]'s risk).
+  **Risks are recorded as findings**, below, because this is the decision most
   likely to move.

**Evidence: why 2.9.0**.

+  **2.9.0 is the first release that builds for WebAssembly unpatched**.
   agda/agda PR [8205][agda-8205] (Andy Pan, merged 2025-12-07) added a Nix
   flake with GHC's WebAssembly toolchain and a weekly CI workflow that builds
   Agda for `wasm32-wasi` and runs its test suites under wasmtime, a standalone
   WebAssembly runtime.  The 2.8.0 line does not carry it: v2.8.0.2
   (2026-09-13), the latest release, does not contain PR 8205's merge commit
   (checked 2026-10-06).
+  **Today's compiler has one source and a patch**.  The fork's language server
   embeds agda-web/agda `e2f8c694`, one commit ahead of `v2.8.0` (nonblocking
   standard input on wasm32, a lock file, packaging; [#13]'s findings), built
   by a recipe that is not hermetic, and the binary exists only in upstream's
   git tree ([ADR 0001][adr-0001] § 3).

**The trade-off**.  What 2.9.0 buys is the compiler's provenance and upkeep (a
build from Agda's own maintained sources and CI, pinned here, in place of a
one-person patched fork whose binary has a single source) and, measured on
2026-10-06, smaller interfaces: the HSP closure is 41,725,378 bytes gzipped
under 2.9.0 against 54,290,430 under 2.8.0 at the same commit, 23 % less for
every reader ([#61]'s findings).  What it costs today is a patched standard
library: no released one checks under 2.9.0, so the page would ship
standard-library 2.3 with three upstream commits applied, one of them ported by
hand, until Agda 2.9.0 and standard-library 3.0 are released and agda-algebras
has moved to them.  The 2.8.0 compiler stays buildable meanwhile.

**Evidence: the risks, on 2026-10-06**.

+  **2.9.0 is unreleased**.  The latest release is v2.8.0.2 (2026-09-13);
   master's `Agda.cabal` declares 2.9.0; the `nightly` prerelease is commit
   `835beac` (committed 2026-10-05, published 2026-10-06), where on 2026-10-05
   it was `da66a8c` ([#58]'s findings), so the tag moves and a pin must name a
   commit ([Agda's releases][agda-releases]).
+  **The language server has no 2.9 target**.  Its
   [`package.yaml`][als-package-yaml] has exact-version flags for Agda 2.6.4.3,
   2.7.0.1 and 2.8.0, and a `reactor` flag; release [v8][als-v8] (2026-09-22)
   is the latest; no branch, issue or pull request mentions 2.9 (checked
   2026-10-06).  Its source branches on Agda's version in 59 conditionals
   across 12 files ([#58]'s findings, 2026-10-05), so a 2.9.0 build will need
   patches, each to be recorded.
+  **Agda's WebAssembly workflow last passed in full on 2026-09-06** ([that
   run][agda-run-0906], at `28cbf0e6`).  Its WebAssembly `agda` built in the
   runs of 2026-09-13, 09-20 and 09-27 (the last at `49cafe99`, [run of
   2026-09-27][agda-run-0927]), and each run then failed at the native build
   its test suites need, agda/agda issue [8756][agda-8756], still open.  The
   [run of 2026-10-04][agda-run-1004] failed at setup, because the flake did
   not evaluate, which agda/agda PR [8809][agda-8809] fixed on 2026-10-05.  No
   run has executed since: the workflow runs weekly, on a manual dispatch, or
   for a commit or pull request tagged `[wasm]`, and the next scheduled run is
   2026-10-11.  So the WebAssembly build last succeeded in the run of
   2026-09-27, and Agda's test suites last ran under WebAssembly on 2026-09-06;
   no run has tested a later commit, the nightly's included.
+  **No released standard library checks under 2.9.0; a patched one does**
   ([#61]'s findings, 2026-10-06, at the nightly `da66a8c`).  Standard-library
   2.3 and 2.4 both fail at the construct one of `agda-master`'s fixes removes,
   an irrelevant field projected in `irrelevant-recompute`
   (`Relation.Nullary.Recomputable:35` in 2.3, `Data.Irrelevant:48` in 2.4).
   With agda-stdlib's three `agda-master` commits applied to 2.3 (two cleanly,
   one ported by hand), Agda 2.9.0 checks all 344 agda-algebras modules and the
   251 standard-library modules they need, the set the 2.8.0 control checks,
   and agda-algebras changes only two fixity declarations (agda-algebras PR
   [587][aa-587]).  Standard-library 3.0 ([`1b7f26af`][stdlib-1b7f26af] on
   `agda-master`) checks under 2.9.0 in Agda's own CI, but agda-algebras'
   `--cubical-compatible` modules cannot import it (Agda reports
   `CoInfectiveImport`), under 2.8.0 as well.  The latest release is
   agda-stdlib [v2.4][stdlib-v24] (2026-06-17; checked 2026-10-06).

**Status**.  Adopted as the plan's target (PR [#75]); not built.  Open: [#58]
(the build, the pin, the move to the release), [#61] (its second criterion, the
archives built under 2.9.0), [#49] and [#12] (rebuilt by 2.9.0), [#13] (the
acceptance gate).  Milestone 0's exit criterion already asks for the pinned
2.9.0 compiler, so these risks bear on the first milestone, not only on later
ones.  [#61]'s first criterion is met: the library checks under the pinned
2.9.0 with the patched 2.3, so Milestone 1's exit criterion (the HSP `Main`
checks under 2.9.0) is within reach without moving agda-algebras' pin.
William's plan of 2026-10-06 moves agda-algebras from `--cubical-compatible`
back to `--without-K`, which makes 3.0 importable; once Agda 2.9.0 and
standard-library 3.0 are released and the library has moved (agda-algebras
issue [588][aa-588]), the page can ship an unpatched standard library.

**Built, 2026-10-07** ([#58]): the page runs this project's own build of
Agda 2.9.0 and its language server, with standard-library 2.3 patched as
above; [ADR 0001][adr-0001] § 7 records the build and its evidence.  One
finding there bears on this section: Agda 2.9.0 writes an interface's
integers at the word size of the machine that writes it, so every
interface the page ships is built by a 32-bit (wasm32) Agda, and the
closure sizes above, measured with the native nightly, are not the page's.

---

## 5.  Agents attach where they already are

(See also [#38], [#35], [#36], [#65], [#71], [#72], and [the note][note]'s
"Agents: where the field has settled".)

**Decision**.  Agents reach the tool contract through processes they already
talk to: in VS Code and Emacs through `agda-mcp` and the companion's
registrations, and in the browser through a local bridge first, with the
in-page model last, as a demonstration (Milestone 4's order).

+  **VS Code**: the companion contributes `agda-mcp` as an MCP server
   definition, for Claude Code, Cline and Copilot, and registers the same
   contract as LM tools (VS Code's own tool API, which only Copilot calls)
   ([#65]).
+  **Emacs**: agda2-mode's commands as tools through claude-code-ide.el, an MCP
   server that runs inside Emacs ([#71]); and `agda-mcp` from gptel or ellama
   ([#72]).
+  **The browser**: first a local bridge ([#38]), a small process the agent
   launches or dials on localhost, which relays to the page over a WebSocket,
   since a page cannot listen; then the key isolation ([#35]) and a frontier
   model on the reader's own key ([#36]), last.
+  **The contract does not change by platform**: agda-native-air ADR 0002's,
   word for word where it matters.  The model's claims are never the verdict;
   Agda's are.

**Evidence**.  The brief's survey of 2025 and 2026 (2026-10-05), re-checked at
the sources on 2026-10-06.

+  **Every integration through which an external agent drives a proof assistant
   is a local MCP server beside the editor**.  The survey found the following:
   +  Lean: [lean-lsp-mcp][lean-lsp-mcp] (v0.31.0, 2026-09-30; over stdio,
      streamable HTTP or server-sent events), and [lean-beam][lean-beam], "new
      Lean LSP extensions with a thin local broker" exposed through a CLI and a
      stdio MCP server, which the Lean FRO's [roadmap][fro-roadmap] for
      September 2026 to February 2027 calls "how AI agents interact with Lean";
   +  Rocq: [rocq-mcp][rocq-mcp], thirteen tools over coq-lsp's `pet`, over
      stdio;
   +  Isabelle: [isabelle-pide-mcp][pide-mcp], "a customisable Model Context
      Protocol server managing a headless PIDE session" ([its
      preprint][pide-preprint], 2026-09-12), over stdio;
   +  Agda: six small servers besides `agda-mcp`, all local processes:
      [DreamLinuxer's][mcp-dreamlinuxer], [InvariantHoldings'][mcp-invariant]
      (and [cliu238's][mcp-cliu238], a copy of it) and
      [peterthiemann's][mcp-thiemann] spawn `agda --interaction-json` and speak
      MCP over stdio; [faezs's][mcp-faezs] and [broughjt's][mcp-broughjt] link
      Agda as a Haskell library, faezs's served over HTTP on localhost.
+  **The exceptions do not drive the prover from outside**: LeanCopilot and
   LLMLean run a model as a tactic inside Lean, and CoqPilot calls a model from
   a VS Code extension.  None is a page.  (The brief's "Every proof-assistant
   agent integration shipped in 2025 and 2026, for Lean, Rocq, Isabelle and
   Agda, is a local MCP process beside the editor" is contradicted by these
   three, from its own survey; the note records the correction.)
+  **A page cannot be an MCP server**.  The MCP specification ([revision
   2026-07-28][mcp-spec], the current one on 2026-10-06) defines two
   transports: standard input and output of a subprocess the client launches,
   and Streamable HTTP to an endpoint.  A page can be launched by no one and
   can listen on nothing.  WebMCP, Chrome's early preview of tools a page
   registers, exposes them to the browser's own agent, not to a process outside
   it (the brief, 2026-10-05).
+  **VS Code for the Web has no agents**: Copilot Chat, Claude Code and Cline
   are desktop-only extensions, and a September 2026 issue records the LM API
   as unsupported in vscode.dev (the brief, 2026-10-05).
+  **The contract is measured natively**: a batch verdict on a standard-library
   fixture costs about 2.6 s and a lane question 1 to 3 ms ([agda-native-air
   ADR 0002][air-adr-0002], its executive summary and § 2); nine real proving
   sessions by agents, in agda-algebras and in formal-ledger-specifications,
   record warm rounds of `check_file` (`agda-mcp`'s whole-file check, a batch
   verdict) of 2 to 35 s, against 20 s to 10 min for the same check from a
   shell (its § 12); and `Cmd_give` on the interaction lane agreed with the
   batch verdict on all 80 distinct pairs of an obligation and a candidate term
   that archived agent sessions had tried ([issue 163][air-163], 2026-09-21).

**Status**.  Adopted in the plan (PR [#75]): [#38] is first among the browser's
agent items and [#35] and [#36] last; [#65], [#71] and [#72] exist.  Nothing is
built.  Open: all six.

---

## 6.  Isolation: the reactor build, and the drive in its worker

(See also [#59], [#6], [#50], [ADR 0001][adr-0001] § 5 and § 8, and
[`docs/notes/runtime.md`][runtime], "No shared memory, and no isolation".)

**Decision** (proposed 2026-10-05, adopted 2026-10-08).  The page stops
needing cross-origin isolation once the language server is built as a
reactor and the in-memory filesystem (the drive) moves into the server's
worker, so that the page allocates no `SharedArrayBuffer` ([#59]); until
then the host sends the two headers ([#6]).

**Evidence**.

+  **The fork shares memory in two places**: the server's standard input and
   output, two 4 KiB rings that the server blocks on with `Atomics.wait`, and
   every WASI file call the server makes, which
   `src/lib/worker/proxy-wasi-drive.ts` proxies to the drive worker through two
   1 MiB rings under a 4-byte lock ([`runtime.md`][runtime]).
+  **The reactor removes the first and not the second**.
   agda/agda-language-server PR [48][als-48] (merged 2026-09-13) adds the
   `reactor` flag, because the blocking design "relies on `SharedArrayBuffer`",
   so that "the web page has to be cross-origin isloated" (sic), which "is
   proven to be a very unusual requirement and has prevented wider adoption".
   [`app/Reactor.hs`][als-reactor] exports `run_setup`, `new_language_server`,
   `run_language_server`, `free_language_server`, `send_message` and
   `recv_message` (checked 2026-10-06), which replace the input and output
   rings.  A reactor still makes its file calls synchronously through WASI, so
   a drive in another worker still needs shared memory; in the server's worker,
   a file call is a plain function call.
+  **The plan first got this wrong**.  The revision of 2026-10-05 said the
   reactor alone removes the isolation requirement; [#59]'s correction of the
   same day, mirrored by PR [#76], added the drive and the criterion that the
   page allocates no `SharedArrayBuffer`.
+  **The batch lane already runs without isolation**: agda-algebras PR
   [585][pr-585] drove the plain checker in a page with `crossOriginIsolated`
   false, one process per command, and a probe with JSPI (JavaScript Promise
   Integration, which lets WebAssembly wait on a JavaScript promise without
   shared memory) kept one process alive across commands (12.9 s for the first
   load, 1.45 s per reload, 45 to 55 ms per goal query on a 244-module image,
   measured once, 2026-10-04; [ADR-011][adr-011], [ADR 0001][adr-0001] § 5).
+  **Why it matters for hosting**: GitHub Pages cannot send the two headers;
   the fork's fallback for such a host, a service worker that adds them, costs
   a reload on a first visit and had a race that left some first visits
   unisolated, which two guards fix; and while this repository is private, the
   organization's free plan serves no GitHub Pages site from it at all ([#6]'s
   findings, 2026-10-04).  A page that needs no isolation can be served by any
   static host.  That is why isolation belongs in this record: it is the
   browser's one hosting constraint in the brief's matrix, and the reason
   Milestone 0 weighs hosts by their headers.
+  **Not measured** when this record was written: no reactor had been built
   or run here.  A reactor cannot run under a standalone WebAssembly runtime,
   so the browser check is its only test.  [#58] built it, and [#59] measured
   it on 2026-10-08 ([ADR 0001][adr-0001] § 8): the page checks `Main.agda`
   served without the headers, with `crossOriginIsolated` false, in Chromium
   149 and Firefox 157, "Agda ready" came 257 ms sooner than the stdio
   build's (medians 650 and 907 ms), and warm reloads were 9 to 22% faster.

**Status**.  Adopted 2026-10-08 in [#59]'s pull request, which meets its
acceptance: `Main.agda` checks with `crossOriginIsolated` false in a fresh
profile, on a host that sends no isolation headers; the page allocates no
`SharedArrayBuffer`; the comparison with the stdio build is recorded
([ADR 0001][adr-0001] § 8).  Milestone 0's exit criterion required
`crossOriginIsolated` true until then; the browser check now asserts it
false served without the headers, and true served with them.

---

## 7.  What is deliberately left open

(See also [#68], [#74], [#58], and [#4].)

**Decision**.  Three questions stay open on purpose, each with the issue that
will answer it.

+  **The VS Code web build** is verified, not promised ([#68]): the companion
   as a web extension in vscode.dev, with the WebAssembly engine and without
   agents, measured for what works.  Its result decides whether a vscode.dev
   link belongs beside the playground link on the agda-algebras site.
+  **The Emacs view** is [#74]'s experiment: one benchmark proof drawn as a
   static SVG with a hot-spot per leaf, measured for render time, legibility
   and interaction, and kept only if it is useful.
+  **Where the 2.9.0 binaries are served from** is open on [#58] and [#4].
   [#58] proposes a release of this organization, pinned by hash in the flake;
   this repository is private for now, so its releases are not a public URL for
   the page or for a clean `nix build`; and [#4] asks for a mirror the
   organization controls, since today's compiler has one source, a personal
   repository.

**Evidence**.

+  **For the web build**: no chat extension runs in vscode.dev; vscode.dev
   sends the isolation headers itself (checked with `curl -sI` on 2026-10-06),
   so the language server's shared memory works there and every cross-origin
   fetch needs CORS; and Microsoft's WASI support for extensions
   (`@vscode/wasm-wasi-lsp`) is still a pre-release (the brief, 2026-10-05;
   [the note][note], "What the web variant rests on").
+  **For the Emacs view**: an SVG in Emacs is one image, re-rasterized on every
   change, with no DOM and no text selection, and the embedded WebKit widget
   was disabled in nixpkgs until April 2026 and is absent on Windows (the
   brief, 2026-10-05; [the note][note], "Emacs: the reference implementation,
   and its ceiling").
+  **For the binaries**: [ADR 0001][adr-0001] § 3's status (the compiler's only
   source is upstream's git tree) and [#58]'s acceptance
   (`nix build .#compiler` from the pinned commits, the hashes recorded).

**Status**.  Open by design: [#68], [#74], [#58] and [#4].

---

## 8.  Decision log

| # | Decision | Status | Evidence |
|---|---|---|---|
| 1 | Three platforms with different jobs: the browser for the reader and the views' first host, VS Code for the author, Emacs for the agent half and a picker | Adopted (William, 2026-10-05; PR [#75]) | Only the browser reaches a reader with nothing installed; native HSP check 5.10 to 5.23 s against 11 to 22 s in the page with its drive indexed; 54,294,820 bytes gzipped per reader ([#60], [#50]) |
| 2 | An Emacs milestone, beyond the brief's recommendation to build nothing for Emacs, scoped to agents and a picker | Adopted (William, 2026-10-05) | Overrides the brief's "Emacs needs nothing built"; the views only as an experiment ([#74]) |
| 3 | The engine client, tool surface, views and manifest as TypeScript packages over one engine interface, with a WebAssembly and a native implementation and one suite run against both | Adopted; to build ([#62]) | The fork's command path is already behind CodeMirror's `Transport`; its startup and rings are not; agda-mode-vscode's three connections; no cost measured |
| 4 | The page's Agda is 2.9.0, built here from Agda's own flake with no agda-web patch, pinned to a nightly commit and moved to the release; the libraries it ships are carried to 2.9.0; the editors run the Agda the author's project pins | Adopted; to build ([#58], [#61], [#64]) | PR 8205 is not in 2.8.0.x; risks on 2026-10-06: unreleased, no language-server target, the WebAssembly workflow's last full pass 2026-09-06, no released standard library checks (a patched 2.3 does, [#61]); the HSP closure's interfaces 23 % smaller gzipped |
| 5 | Keep the 2.8.0 compiler buildable until the 2.9.0 one passes [#13]'s gate | Adopted ([#58]) | The risks of row 4 |
| 6 | Agents attach through local processes: `agda-mcp` and the companion's registrations in VS Code and Emacs; in the browser a bridge first and the in-page model last | Adopted (PR [#75]; [#38], [#35], [#36], [#65], [#71], [#72]) | Every agent-facing prover integration found is a local MCP server; MCP's transports are a subprocess's stdio and Streamable HTTP; no agents in vscode.dev |
| 7 | The tool contract is agda-native-air ADR 0002's on every platform | Adopted | Lane and batch agreed on all 80 committed candidate pairs (agda-native-air issue 163) |
| 8 | No isolation: the reactor build, with the drive in the server's worker | Proposed ([#59]); adopted 2026-10-08 | Two shared-memory channels; the reactor replaces one (ALS PR 48); built and measured in [#59] ([ADR 0001][adr-0001] § 8) |
| 9 | The VS Code web build is verified, not promised | Open ([#68]) | No agents on the web; CORS on every fetch under `require-corp` |
| 10 | The Emacs view is an experiment, kept only if useful | Open ([#74]) | One image per SVG; the WebKit widget uneven |
| 11 | Where the 2.9.0 binaries are served from | Open ([#58], [#4]) | A private repository's releases are not public; today's compiler has one source |

---

## References

+  **Issues**: [#4] (the pins and the mirror), [#6] (hosting), [#12] (the
   library archives), [#13] (interface acceptance), [#30] (the batch lane in
   the page), [#35] (key isolation), [#36] (the in-page model), [#38] (the
   bridge), [#49] (the builtins), [#50] (the drive), [#56] (the proposal
   carried here), [#58] (Agda 2.9.0), [#59] (the reactor and the drive), [#60]
   (this record, with the native baselines in its findings), [#61] (the library
   under 2.9.0), [#62] (the shared core); Milestone 7, [#63] to [#70];
   Milestone 8, [#71] to [#74].
+  **Pull requests**: [#75] (the plan revision), [#76] (its corrections).
+  **Documents**: [`docs/notes/platform-brief-2026-10-05.md`][note] (the brief,
   with its matrix, numbers, sources and corrections);
   [`docs/notes/browser-ide-proposal.md`][proposal]; [ADR 0001][adr-0001] and
   [`docs/notes/runtime.md`][runtime]; [the plan][plan].
+  **Elsewhere**: agda-native-air's [ADR 0002][air-adr-0002] (`agda-mcp` and
   its contract) and [issue 163][air-163] (the lane's parity); agda-algebras PR
   [585][pr-585] and its [ADR-011][adr-011], its issues [586][aa-586] (the
   library under 2.9.0) and [588][aa-588] (the upgrade), and PR [587][aa-587];
   [plfa-playground] at `ae0aa84c`; agda/agda PRs [8205][agda-8205] and
   [8809][agda-8809] and issue [8756][agda-8756], its [releases][agda-releases]
   and its WebAssembly runs ([2026-09-06][agda-run-0906],
   [2026-09-27][agda-run-0927], [2026-10-04][agda-run-1004]);
   agda/agda-language-server [v8][als-v8], PR [48][als-48],
   [`package.yaml`][als-package-yaml] and [`app/Reactor.hs`][als-reactor];
   agda-stdlib [v2.4][stdlib-v24] and [`1b7f26af`][stdlib-1b7f26af]; agda-web's
   [PLFA fork][agda-web-plfa] and the [ALS WASM Loader][als-loader]; the MCP
   servers and precedents of § 5; the [MCP specification][mcp-spec].

Every external fact above was read at its source on 2026-10-06 unless it is
attributed to the brief (2026-10-05).

[#4]: https://github.com/formalverification/agda-native-ide/issues/4
[#6]: https://github.com/formalverification/agda-native-ide/issues/6
[#12]: https://github.com/formalverification/agda-native-ide/issues/12
[#13]: https://github.com/formalverification/agda-native-ide/issues/13
[#30]: https://github.com/formalverification/agda-native-ide/issues/30
[#35]: https://github.com/formalverification/agda-native-ide/issues/35
[#36]: https://github.com/formalverification/agda-native-ide/issues/36
[#38]: https://github.com/formalverification/agda-native-ide/issues/38
[#49]: https://github.com/formalverification/agda-native-ide/issues/49
[#50]: https://github.com/formalverification/agda-native-ide/issues/50
[#56]: https://github.com/formalverification/agda-native-ide/issues/56
[#58]: https://github.com/formalverification/agda-native-ide/issues/58
[#59]: https://github.com/formalverification/agda-native-ide/issues/59
[#60]: https://github.com/formalverification/agda-native-ide/issues/60
[#61]: https://github.com/formalverification/agda-native-ide/issues/61
[#62]: https://github.com/formalverification/agda-native-ide/issues/62
[#63]: https://github.com/formalverification/agda-native-ide/issues/63
[#64]: https://github.com/formalverification/agda-native-ide/issues/64
[#65]: https://github.com/formalverification/agda-native-ide/issues/65
[#66]: https://github.com/formalverification/agda-native-ide/issues/66
[#68]: https://github.com/formalverification/agda-native-ide/issues/68
[#69]: https://github.com/formalverification/agda-native-ide/issues/69
[#70]: https://github.com/formalverification/agda-native-ide/issues/70
[#71]: https://github.com/formalverification/agda-native-ide/issues/71
[#72]: https://github.com/formalverification/agda-native-ide/issues/72
[#73]: https://github.com/formalverification/agda-native-ide/issues/73
[#74]: https://github.com/formalverification/agda-native-ide/issues/74
[#75]: https://github.com/formalverification/agda-native-ide/pull/75
[#76]: https://github.com/formalverification/agda-native-ide/pull/76
[note]: ../notes/platform-brief-2026-10-05.md
[proposal]: ../notes/browser-ide-proposal.md
[runtime]: ../notes/runtime.md
[adr-0001]: 0001-runtime.md
[plan]: ../GITHUB_PROJECT.md
[plfa-playground]: https://github.com/SeungheonOh/plfa-playground
[air-adr-0002]: https://github.com/formalverification/agda-native-air/blob/7a05012794b604bcd8ad3995930ab7993e7f9588/docs/adr/0002-agda-mcp.md
[air-163]: https://github.com/formalverification/agda-native-air/issues/163
[pr-585]: https://github.com/ualib/agda-algebras/pull/585
[adr-011]: https://github.com/ualib/agda-algebras/blob/577-an-interactive-agda-proof-environment/docs/adr/011-interactive-playground.md
[agda-releases]: https://github.com/agda/agda/releases
[agda-8205]: https://github.com/agda/agda/pull/8205
[agda-8756]: https://github.com/agda/agda/issues/8756
[agda-8809]: https://github.com/agda/agda/pull/8809
[agda-run-0906]: https://github.com/agda/agda/actions/runs/34001666617
[agda-run-0927]: https://github.com/agda/agda/actions/runs/36283005764
[agda-run-1004]: https://github.com/agda/agda/actions/runs/37167222096
[als-v8]: https://github.com/agda/agda-language-server/releases/tag/v8
[als-48]: https://github.com/agda/agda-language-server/pull/48
[als-package-yaml]: https://github.com/agda/agda-language-server/blob/master/package.yaml
[als-reactor]: https://github.com/agda/agda-language-server/blob/master/app/Reactor.hs
[stdlib-v24]: https://github.com/agda/agda-stdlib/releases/tag/v2.4
[stdlib-1b7f26af]: https://github.com/agda/agda-stdlib/commit/1b7f26af455caa57e9372cef50b4f4118a92bf81
[agda-web-plfa]: https://github.com/agda-web/plfa.github.io
[als-loader]: https://github.com/andy0130tw/vscode-als-wasm-loader/releases/tag/v0.8.5
[lean-lsp-mcp]: https://github.com/oOo0oOo/lean-lsp-mcp/releases/tag/v0.31.0
[lean-beam]: https://github.com/leanprover/lean-beam
[fro-roadmap]: https://lean-lang.org/fro/roadmap/y4-1/
[rocq-mcp]: https://github.com/LLM4Rocq/rocq-mcp
[pide-mcp]: https://github.com/kappelmann/isabelle-pide-mcp
[pide-preprint]: https://doi.org/10.5281/zenodo.21519364
[mcp-faezs]: https://github.com/faezs/agda-mcp
[mcp-dreamlinuxer]: https://github.com/DreamLinuxer/agda-mcp
[mcp-invariant]: https://github.com/InvariantHoldings/agda-mcp-server
[mcp-cliu238]: https://github.com/cliu238/agda-mcp-server
[mcp-broughjt]: https://github.com/broughjt/agda-mcp
[mcp-thiemann]: https://github.com/peterthiemann/agda-mcp
[mcp-spec]: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports
[aa-586]: https://github.com/ualib/agda-algebras/issues/586
[aa-587]: https://github.com/ualib/agda-algebras/pull/587
[aa-588]: https://github.com/ualib/agda-algebras/issues/588
